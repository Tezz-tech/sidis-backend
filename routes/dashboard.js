// routes/dashboard.js
const express = require('express');
const router = express.Router();
const auth = require('../middlewares/auth');
const User = require('../models/User');
const QuizResult = require('../models/QuizResult');
const Quiz = require('../models/Quiz');
const StudyPlan = require('../models/StudyPlan');
const FlashcardSet = require('../models/FlashcardSet');

const { gemini, capText } = require('../utils/ai');
const { resolveSpecificSubject } = require('../utils/subjectResolver');

// Build a quizId → specific-subject map for results tagged as "General"
async function buildQuizSubjectMap(results) {
  const ids = [...new Set(
    results
      .filter(r => !r.subjectTag || r.subjectTag === 'General')
      .map(r => r.quizId?.toString())
      .filter(Boolean)
  )];
  if (ids.length === 0) return {};
  const quizDocs = await Quiz.find({ _id: { $in: ids } }).select('title subject').lean();
  const map = {};
  for (const q of quizDocs) {
    map[q._id.toString()] = resolveSpecificSubject(q.subject, q.title);
  }
  return map;
}

function getResultSubject(r, quizSubjectMap) {
  if (r.subjectTag && r.subjectTag !== 'General') return r.subjectTag;
  return (quizSubjectMap[r.quizId?.toString()] || 'General');
}

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

    // Subject mastery — resolve "General" tags to specific academic subjects
    const quizSubjectMap = await buildQuizSubjectMap(results);
    const subjectMastery = {};
    for (const r of results) {
      const tag = getResultSubject(r, quizSubjectMap);
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

    // Subject mastery — resolve "General" tags to specific academic subjects
    const quizSubjectMap = await buildQuizSubjectMap(results);
    const subjectMap = {};
    const timeMap = {};
    for (const r of results) {
      const tag = getResultSubject(r, quizSubjectMap);
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

    // Study plan completion — nearest upcoming exam plan; neutral (50) if none yet
    const activePlan = await StudyPlan.findOne({ userId, examDate: { $gt: today } })
      .sort({ examDate: 1 }).lean();
    const planTotal = activePlan?.schedule?.length || 0;
    const planCompleted = activePlan?.schedule?.filter(s => s.completed).length || 0;
    const planProgress = planTotal > 0 ? Math.round((planCompleted / planTotal) * 100) : 50;

    // Flashcard mastery average across all of the user's sets; neutral (50) if none yet
    const flashcardSets = await FlashcardSet.find({ userId }).select('cards').lean();
    const allCards = flashcardSets.flatMap(s => s.cards || []);
    const flashcardMastery = allCards.length > 0
      ? Math.round(allCards.reduce((s, c) => s + (c.masteryLevel || 0), 0) / allCards.length)
      : 50;

    const READINESS_WEIGHTS = {
      quizPerformance: 0.35,
      accuracyTrend:   0.20,
      consistency:     0.15,
      streak:          0.10,
      planProgress:    0.10,
      flashcardMastery: 0.10,
    };
    const examReadiness = Math.round(
      READINESS_WEIGHTS.quizPerformance  * recentAvgScore +
      READINESS_WEIGHTS.accuracyTrend    * accuracyTrend +
      READINESS_WEIGHTS.consistency      * consistencyScore +
      READINESS_WEIGHTS.streak           * streakBonus +
      READINESS_WEIGHTS.planProgress     * planProgress +
      READINESS_WEIGHTS.flashcardMastery * flashcardMastery
    );

    const readinessBreakdown = [
      { factor: 'Quiz performance',  value: Math.round(recentAvgScore),  weight: READINESS_WEIGHTS.quizPerformance },
      { factor: 'Improvement trend', value: Math.round(accuracyTrend),   weight: READINESS_WEIGHTS.accuracyTrend },
      { factor: 'Consistency',       value: consistencyScore,            weight: READINESS_WEIGHTS.consistency },
      { factor: 'Streak',           value: streakBonus,                  weight: READINESS_WEIGHTS.streak },
      { factor: 'Study plan progress', value: planProgress,              weight: READINESS_WEIGHTS.planProgress },
      { factor: 'Flashcard mastery', value: flashcardMastery,            weight: READINESS_WEIGHTS.flashcardMastery },
    ];

    const reasonParts = [];
    reasonParts.push(recentAvgScore >= 75
      ? `a strong quiz average (${Math.round(recentAvgScore)}%)`
      : recentAvgScore >= 55
        ? `a moderate quiz average (${Math.round(recentAvgScore)}%)`
        : `a low quiz average (${Math.round(recentAvgScore)}%)`);
    if (activePlan) {
      reasonParts.push(planProgress >= 70
        ? `your study plan is ${planProgress}% complete`
        : `your study plan is only ${planProgress}% complete`);
    }
    if (allCards.length > 0) {
      reasonParts.push(`${flashcardMastery}% flashcard mastery`);
    }
    if (weakSubjects.length > 0) {
      reasonParts.push(weakSubjects.length > 1
        ? `${weakSubjects.length} weak subjects still need attention`
        : `1 weak subject still needs attention`);
    }
    const readinessReason = `You're ${examReadiness}% ready: ${reasonParts.join(', ')}.`;

    // User's stated interest subjects (passed from the SidIQ frontend after profiling)
    const userInterests = req.query.interests
      ? req.query.interests.split(',').map(s => s.trim()).filter(Boolean)
      : [];

    // Recommended quizzes — weak subjects take priority; fall back to interests; then random public
    const searchSubjects = weakSubjects.length > 0 ? weakSubjects : userInterests;
    const recommendedQuizzes = searchSubjects.length > 0
      ? await Quiz.find({
          subject: { $in: searchSubjects.map(s => new RegExp(s, 'i')) },
          isPublic: true
        }).limit(6).select('title subject numQuestions difficulty').lean()
      : await Quiz.find({ isPublic: true }).limit(6).select('title subject numQuestions difficulty').lean();

    // AI study tip
    let studyTip = "Keep practicing consistently to boost your exam readiness score!";
    if (weakSubjects.length > 0) {
      studyTip = `Focus on ${weakSubjects.join(', ')} — these are your weakest areas. Spending 20 minutes daily on targeted practice in these subjects can improve your score significantly.`;
    } else if (userInterests.length > 0) {
      studyTip = `Here are some ${userInterests.slice(0, 3).join(', ')} quizzes based on your interests. Complete them to start building your Sid IQ profile!`;
    } else if (strongSubjects.length > 0) {
      studyTip = `Great work on ${strongSubjects.join(', ')}! Maintain your momentum and challenge yourself with harder difficulty levels.`;
    }

    res.json({
      success: true,
      examReadiness,
      readinessBreakdown,
      readinessReason,
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

// ─── GET /api/dashboard/forecaster ────────────────────────────────────────────
router.get('/forecaster', auth, async (req, res) => {
  try {
    const userId = req.user.userId;
    const [user, results] = await Promise.all([
      User.findById(userId),
      QuizResult.find({ userId }).sort({ createdAt: -1 }),
    ]);
    if (!user) return res.status(404).json({ error: 'User not found' });

    if (results.length === 0) {
      return res.json({
        success: true,
        totalQuizzes: 0,
        learningSpeed: 'No Data',
        learningSpeedDesc: 'Take a few quizzes to unlock your personal forecast.',
        subjectAnalysis: [],
        forecastedTopics: [],
        weakSubjects: [],
        strongSubjects: [],
        aiInsight: null,
      });
    }

    // Build per-subject performance timeline
    const quizSubjectMap = await buildQuizSubjectMap(results);
    const subjectData    = {};

    for (const r of results) {
      const tag = getResultSubject(r, quizSubjectMap);
      if (!subjectData[tag]) subjectData[tag] = { scores: [], times: [] };
      subjectData[tag].scores.push(r.score || 0);
      if (r.timeSpent) subjectData[tag].times.push(r.timeSpent);
    }

    const subjectAnalysis = Object.entries(subjectData).map(([subject, data]) => {
      const avgScore = Math.round(data.scores.reduce((a, b) => a + b, 0) / data.scores.length);
      // trend: positive = improving (recent scores are higher than older ones)
      const trend = data.scores.length >= 2
        ? Math.round(data.scores[0] - data.scores[data.scores.length - 1])
        : 0;
      const avgTimeSec = data.times.length > 0
        ? Math.round(data.times.reduce((a, b) => a + b, 0) / data.times.length) : null;

      return {
        subject,
        avgScore,
        attempts:  data.scores.length,
        trend,
        improving: trend > 5,
        avgTimeSec,
        status:    avgScore >= 80 ? 'strong' : avgScore >= 60 ? 'moderate' : 'weak',
      };
    }).sort((a, b) => a.avgScore - b.avgScore);

    // Learning speed: compare recent 5 vs older 5
    let learningSpeed     = 'Average';
    let learningSpeedDesc = 'You improve at a steady, consistent pace.';
    if (results.length >= 3) {
      const recent   = results.slice(0, 5).map(r => r.score || 0);
      const older    = results.slice(5, 10).map(r => r.score || 0);
      if (older.length > 0) {
        const delta = (recent.reduce((a, b) => a + b, 0) / recent.length) -
                      (older.reduce((a, b) => a + b, 0) / older.length);
        if (delta >= 15) {
          learningSpeed     = 'Fast Learner';
          learningSpeedDesc = `Scores jumped ${Math.round(delta)}% — you absorb new material quickly!`;
        } else if (delta >= 5) {
          learningSpeed     = 'Steady Learner';
          learningSpeedDesc = 'Consistent, solid improvement — knowledge builds methodically.';
        } else if (delta < -5) {
          learningSpeed     = 'Needs Focus';
          learningSpeedDesc = 'Scores dipped recently. Review past topics before moving forward.';
        }
      }
    }

    // Exam forecaster
    const weakList = subjectAnalysis.filter(s => s.status === 'weak');
    const modList  = subjectAnalysis.filter(s => s.status === 'moderate');

    let forecastedTopics = [...weakList, ...modList].slice(0, 6).map(s => ({
      topic:       s.subject,
      confidence:  s.status === 'weak' ? 'High' : 'Medium',
      reason:      s.status === 'weak'
        ? `Low avg score (${s.avgScore}%) — examiners target weak areas`
        : `Moderate score (${s.avgScore}%) — small improvements yield big gains`,
      likelihood:  s.status === 'weak' ? 85 : 62,
    }));

    if (forecastedTopics.length === 0) {
      forecastedTopics = subjectAnalysis.slice(0, 3).map(s => ({
        topic:      s.subject + ' — Advanced',
        confidence: 'Low',
        reason:     `You score well (${s.avgScore}%) — challenge yourself with harder questions`,
        likelihood: 40,
      }));
    }

    // AI insight
    let aiInsight = null;
    if (gemini.ready && subjectAnalysis.length > 0) {
      try {
        const weakStr = weakList.map(s => `${s.subject}(${s.avgScore}%)`).join(', ') || 'none';
        const prompt  = `A student's quiz data: ${results.length} quizzes, learning speed "${learningSpeed}".
Weak subjects: ${weakStr}. Strong subjects: ${subjectAnalysis.filter(s => s.status === 'strong').map(s => s.subject).join(', ') || 'none'}.
Write 2 concise exam forecast insights (each max 20 words) tailored to this data.
Return JSON: { "insights": ["insight1", "insight2"] }`;

        const parsed = await gemini.generateJSON(prompt, { maxOutputTokens: 256 });
        if (parsed.insights && parsed.insights.length > 0) aiInsight = parsed.insights;
      } catch (_) {}
    }

    res.json({
      success: true,
      totalQuizzes: results.length,
      learningSpeed,
      learningSpeedDesc,
      subjectAnalysis,
      forecastedTopics,
      weakSubjects:   weakList.map(s => s.subject),
      strongSubjects: subjectAnalysis.filter(s => s.status === 'strong').map(s => s.subject),
      aiInsight,
    });
  } catch (error) {
    console.error('Forecaster error:', error);
    res.status(500).json({ success: false, error: 'Server error' });
  }
});

module.exports = router;
