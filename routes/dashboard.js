// routes/dashboard.js
const express = require('express');
const router = express.Router();
const auth = require('../middlewares/auth');
const User = require('../models/User');
const QuizResult = require('../models/QuizResult');
const Quiz = require('../models/Quiz');

// Helper: check if two dates are on consecutive calendar days
function isConsecutiveDay(date1, date2) {
  const d1 = new Date(date1);
  const d2 = new Date(date2);
  d1.setHours(0, 0, 0, 0);
  d2.setHours(0, 0, 0, 0);
  const diff = Math.round((d2 - d1) / (1000 * 60 * 60 * 24));
  return diff === 1;
}

function isSameDay(date1, date2) {
  const d1 = new Date(date1);
  const d2 = new Date(date2);
  return d1.getFullYear() === d2.getFullYear() &&
    d1.getMonth() === d2.getMonth() &&
    d1.getDate() === d2.getDate();
}

router.get('/', auth, async (req, res) => {
  try {
    const userId = req.user.userId;

    const [user, results] = await Promise.all([
      User.findById(userId),
      QuizResult.find({ userId }).sort({ createdAt: -1 })
    ]);

    if (!user) return res.status(404).json({ error: "User not found" });

    const quizzesTaken = results.length;

    const totalScore = results.reduce((sum, r) => sum + (r.score || 0), 0);
    const averageScore = quizzesTaken > 0 ? Math.round(totalScore / quizzesTaken) : 0;

    // accuracy = same as averageScore since score = (correct/total)*100
    const accuracy = averageScore;

    const hoursPracticed = results.reduce((sum, r) => sum + (r.timeSpent || 0), 0) / 3600;

    // Streak logic
    const today = new Date();
    let currentStreak = user.currentStreak || 0;
    let bestStreak = user.bestStreak || 0;
    const lastQuizDate = user.lastQuizDate || null;

    if (quizzesTaken > 0) {
      if (lastQuizDate) {
        if (isSameDay(lastQuizDate, today)) {
          // already counted today, streak stays
        } else if (isConsecutiveDay(lastQuizDate, today)) {
          currentStreak += 1;
        } else {
          currentStreak = 1; // streak broken
        }
      } else {
        currentStreak = 1;
      }

      if (currentStreak > bestStreak) bestStreak = currentStreak;
    }

    // Weekly improvement: compare avg of last 5 vs previous 5
    let weeklyImprovement = 0;
    if (results.length >= 2) {
      const recent = results.slice(0, Math.min(5, results.length));
      const older = results.slice(Math.min(5, results.length), Math.min(10, results.length));
      const recentAvg = recent.reduce((s, r) => s + r.score, 0) / recent.length;
      const olderAvg = older.length > 0
        ? older.reduce((s, r) => s + r.score, 0) / older.length
        : recentAvg;
      weeklyImprovement = Math.round(recentAvg - olderAvg);
    }

    // Subject mastery
    const subjectMastery = {};
    for (const r of results) {
      const tag = r.subjectTag || 'General';
      if (!subjectMastery[tag]) subjectMastery[tag] = { total: 0, count: 0 };
      subjectMastery[tag].total += r.score || 0;
      subjectMastery[tag].count += 1;
    }
    const subjectMasteryAvg = {};
    for (const [subject, data] of Object.entries(subjectMastery)) {
      subjectMasteryAvg[subject] = Math.round(data.total / data.count);
    }
    const weakSubjects = Object.entries(subjectMasteryAvg)
      .filter(([, avg]) => avg < 60)
      .map(([s]) => s);
    const strongSubjects = Object.entries(subjectMasteryAvg)
      .filter(([, avg]) => avg >= 80)
      .map(([s]) => s);

    // Exam readiness score
    const recentAvgScore = results.slice(0, 5).reduce((s, r) => s + (r.score || 0), 0) /
      Math.max(1, Math.min(5, results.length));
    const accuracyTrend = weeklyImprovement > 0 ? Math.min(100, 50 + weeklyImprovement * 2) : Math.max(0, 50 + weeklyImprovement * 2);
    const daysSinceFirst = results.length > 0
      ? Math.max(1, Math.round((today - new Date(results[results.length - 1].createdAt)) / (1000 * 60 * 60 * 24)))
      : 1;
    const uniqueDays = new Set(results.map(r => new Date(r.createdAt).toDateString())).size;
    const consistencyScore = Math.round((uniqueDays / daysSinceFirst) * 100);
    const streakBonus = Math.min(100, currentStreak * 10);
    const examReadiness = Math.round(
      0.4 * recentAvgScore +
      0.3 * accuracyTrend +
      0.2 * consistencyScore +
      0.1 * streakBonus
    );

    // Update only the computed stats — use updateOne to bypass full-document
    // validation (avoids Mongoose 8.x cast errors on gamification Mixed fields)
    await User.updateOne(
      { _id: userId },
      {
        $set: {
          quizzesTaken,
          averageScore,
          totalScore,
          accuracy,
          hoursPracticed:    parseFloat(hoursPracticed.toFixed(1)),
          currentStreak,
          bestStreak,
          weeklyImprovement,
          lastQuizDate: results.length > 0 ? results[0].createdAt : (user.lastQuizDate || null),
        },
      }
    );

    // GLOBAL RANKING — isolated so a DB hiccup here never kills the dashboard
    let myRank = null, totalUsers = 0, myPercentile = 0;
    try {
      const leaderboard = await User.find({ quizzesTaken: { $gt: 0 } })
        .sort({ averageScore: -1, totalScore: -1 })
        .select('_id averageScore')
        .lean();

      const myRankIdx = leaderboard.findIndex(u => u._id.toString() === userId);
      myRank     = myRankIdx >= 0 ? myRankIdx + 1 : null;
      totalUsers = leaderboard.length;
      myPercentile = totalUsers > 0 && myRank
        ? Math.round(((totalUsers - myRank + 1) / totalUsers) * 100)
        : 0;
    } catch (rankErr) {
      console.error("Ranking query failed (non-fatal):", rankErr.message);
    }

    res.json({
      success: true,
      quizzesTaken,
      averageScore,
      accuracy,
      hoursPracticed: parseFloat(hoursPracticed.toFixed(1)),
      currentStreak,
      bestStreak,
      weeklyImprovement,
      examReadiness,
      subjectMastery: subjectMasteryAvg,
      weakSubjects,
      strongSubjects,
      myRank,
      myPercentile,
      totalUsers,
      recentResults: results.slice(0, 5).map(r => ({
        quizId: r.quizId,
        title: r.title || "Untitled Quiz",
        score: r.score,
        createdAt: r.createdAt
      }))
    });

  } catch (error) {
    console.error("Dashboard error:", error);
    res.status(500).json({ success: false, error: "Server error" });
  }
});

// Dedicated rankings endpoint
router.get('/rankings', auth, async (req, res) => {
  try {
    const userId = req.user.userId;

    const leaderboard = await User.find({ quizzesTaken: { $gt: 0 } })
      .sort({ averageScore: -1, totalScore: -1 })
      .select('_id averageScore totalScore quizzesTaken fullName')
      .lean();

    const myRankIdx = leaderboard.findIndex(u => u._id.toString() === userId);
    const myRank = myRankIdx >= 0 ? myRankIdx + 1 : null;
    const totalUsers = leaderboard.length;
    const myPercentile = totalUsers > 0 && myRank
      ? Math.round(((totalUsers - myRank + 1) / totalUsers) * 100)
      : 0;

    res.json({
      success: true,
      myRank,
      myPercentile,
      totalUsers,
      leaderboard: leaderboard.slice(0, 10).map((u, i) => ({
        rank: i + 1,
        name: u.fullName,
        averageScore: u.averageScore,
        quizzesTaken: u.quizzesTaken,
      }))
    });
  } catch (error) {
    console.error("Rankings error:", error);
    res.status(500).json({ success: false, error: "Failed to load rankings" });
  }
});

// Sid IQ endpoint — performance profile + recommendations
router.get('/sid-iq', auth, async (req, res) => {
  try {
    const userId = req.user.userId;

    const [user, results] = await Promise.all([
      User.findById(userId),
      QuizResult.find({ userId }).sort({ createdAt: -1 })
    ]);

    if (!user) return res.status(404).json({ error: "User not found" });

    // Subject mastery
    const subjectMap = {};
    const timeMap = {};
    for (const r of results) {
      const tag = r.subjectTag || 'General';
      if (!subjectMap[tag]) subjectMap[tag] = { total: 0, count: 0 };
      subjectMap[tag].total += r.score || 0;
      subjectMap[tag].count += 1;

      if (r.timePerQuestion && r.timePerQuestion.length > 0) {
        if (!timeMap[tag]) timeMap[tag] = { total: 0, count: 0 };
        const avgTime = r.timePerQuestion.reduce((a, b) => a + b, 0) / r.timePerQuestion.length;
        timeMap[tag].total += avgTime;
        timeMap[tag].count += 1;
      }
    }

    const subjectMastery = {};
    for (const [s, d] of Object.entries(subjectMap)) {
      subjectMastery[s] = Math.round(d.total / d.count);
    }
    const weakSubjects = Object.entries(subjectMastery).filter(([, v]) => v < 60).map(([s]) => s);
    const strongSubjects = Object.entries(subjectMastery).filter(([, v]) => v >= 80).map(([s]) => s);

    const avgTimePerSubject = {};
    for (const [s, d] of Object.entries(timeMap)) {
      avgTimePerSubject[s] = Math.round(d.total / d.count);
    }

    // Exam readiness
    const quizzesTaken = results.length;
    const recentAvgScore = results.slice(0, 5).reduce((s, r) => s + (r.score || 0), 0) / Math.max(1, Math.min(5, quizzesTaken));
    const weeklyImprovement = user.weeklyImprovement || 0;
    const accuracyTrend = weeklyImprovement > 0 ? Math.min(100, 50 + weeklyImprovement * 2) : Math.max(0, 50 + weeklyImprovement * 2);
    const today = new Date();
    const daysSinceFirst = results.length > 0
      ? Math.max(1, Math.round((today - new Date(results[results.length - 1].createdAt)) / (1000 * 60 * 60 * 24)))
      : 1;
    const uniqueDays = new Set(results.map(r => new Date(r.createdAt).toDateString())).size;
    const consistencyScore = Math.round((uniqueDays / daysSinceFirst) * 100);
    const streakBonus = Math.min(100, (user.currentStreak || 0) * 10);
    const examReadiness = Math.round(
      0.4 * recentAvgScore +
      0.3 * accuracyTrend +
      0.2 * consistencyScore +
      0.1 * streakBonus
    );

    // Recommended quizzes on weak subjects
    const recommendedQuizzes = weakSubjects.length > 0
      ? await Quiz.find({
          subject: { $in: weakSubjects.map(s => new RegExp(s, 'i')) },
          isPublic: true
        }).limit(5).select('title subject numQuestions difficulty').lean()
      : await Quiz.find({ isPublic: true }).limit(5).select('title subject numQuestions difficulty').lean();

    // AI study tip — generated from weak subjects if available
    let studyTip = "Keep practicing consistently to boost your exam readiness score!";
    if (weakSubjects.length > 0) {
      studyTip = `Focus on ${weakSubjects.join(', ')} — these are your weakest areas. Spending 20 minutes daily on targeted practice in these subjects can improve your score significantly.`;
    } else if (strongSubjects.length > 0) {
      studyTip = `Great work on ${strongSubjects.join(', ')}! Maintain your momentum and challenge yourself with harder difficulty levels.`;
    }

    res.json({
      success: true,
      examReadiness,
      subjectMastery,
      weakSubjects,
      strongSubjects,
      avgTimePerSubject,
      currentStreak: user.currentStreak || 0,
      bestStreak: user.bestStreak || 0,
      quizzesTaken,
      studyTip,
      recommendedQuizzes: recommendedQuizzes.map(q => ({
        id: q._id,
        title: q.title,
        subject: q.subject,
        numQuestions: q.numQuestions,
        difficulty: q.difficulty,
      }))
    });
  } catch (error) {
    console.error("Sid IQ error:", error);
    res.status(500).json({ success: false, error: "Server error" });
  }
});

module.exports = router;
