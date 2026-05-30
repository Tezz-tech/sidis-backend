// routes/dashboard.js
const express = require('express');
const router = express.Router();
const auth = require('../middlewares/auth');
const User = require('../models/User');
const QuizResult = require('../models/QuizResult');
const Quiz = require('../models/Quiz');

// ── Subject resolver ──────────────────────────────────────────────────────────
// Maps a quiz title/subject to a specific academic topic so "General" is never
// shown as the topic name in the Sid IQ profile.
const SUBJECT_KEYWORDS = [
  // STEM
  ['Mathematics',     ['math', 'mathemat', 'calculus', 'algebra', 'geometry', 'trigonometry', 'arithmetic', 'number', 'equation', 'statistics', 'probability', 'maths']],
  ['Calculus',        ['calculus', 'differential', 'integral', 'derivative', 'limit']],
  ['Statistics',      ['statistic', 'probability', 'distribution', 'regression', 'hypothesis']],
  ['Algebra',         ['algebra', 'polynomial', 'quadratic', 'linear equation']],
  ['Biology',         ['biology', 'cell', 'genetics', 'evolution', 'ecology', 'organism', 'photosynthesis', 'mitosis', 'anatomy', 'physiology', 'microbiology']],
  ['Chemistry',       ['chemistry', 'chemical', 'periodic', 'atom', 'molecule', 'reaction', 'organic', 'inorganic', 'compound', 'element', 'bonding']],
  ['Physics',         ['physics', 'force', 'motion', 'energy', 'wave', 'optics', 'electricity', 'magnetism', 'quantum', 'mechanics', 'thermodynamic']],
  ['Computer Science',['computer', 'programming', 'algorithm', 'data structure', 'software', 'coding', 'python', 'javascript', 'database', 'network', 'cybersecurity', 'machine learning', 'ai ', 'artificial intelligence']],
  // Business & Finance
  ['Accounting',      ['accounting', 'ledger', 'journal', 'debit', 'credit', 'balance sheet', 'income statement', 'audit', 'tax', 'bookkeeping', 'financial statement']],
  ['Finance',         ['finance', 'investment', 'portfolio', 'stock', 'bond', 'market', 'valuation', 'asset', 'liability', 'capital', 'cash flow', 'banking']],
  ['Economics',       ['economics', 'microeconom', 'macroeconom', 'supply', 'demand', 'gdp', 'inflation', 'fiscal', 'monetary policy', 'trade']],
  ['Business Studies',['business', 'management', 'marketing', 'entrepreneur', 'strategy', 'organisation', 'operations', 'hrm', 'human resource']],
  // Social Sciences
  ['Psychology',      ['psychology', 'behaviour', 'behavior', 'cognitive', 'mental', 'freud', 'piaget', 'stimulus', 'response', 'therapy', 'emotion', 'personality']],
  ['Sociology',       ['sociology', 'society', 'social structure', 'culture', 'institution', 'deviance', 'stratification', 'norms', 'values']],
  ['Philosophy',      ['philosophy', 'ethics', 'logic', 'metaphysics', 'epistemology', 'plato', 'aristotle', 'kant', 'moral']],
  ['History',         ['history', 'historical', 'war', 'revolution', 'empire', 'civilization', 'colonial', 'century', 'ancient', 'medieval', 'modern history']],
  ['Geography',       ['geography', 'climate', 'continent', 'ecosystem', 'population', 'urbanization', 'map', 'physical geography', 'human geography']],
  ['Political Science',['politic', 'government', 'democracy', 'constitution', 'election', 'parliament', 'legislation', 'policy', 'international relations']],
  // Languages & Humanities
  ['English',         ['english', 'grammar', 'comprehension', 'essay writing', 'literature', 'shakespeare', 'novel', 'poetry', 'prose', 'language arts']],
  ['Literature',      ['literature', 'novel', 'short story', 'poetry', 'drama', 'theme', 'character', 'plot', 'symbolism']],
  // Health & Medicine
  ['Medicine',        ['medicine', 'medical', 'disease', 'diagnosis', 'pharmacology', 'pathology', 'clinical', 'drug', 'symptom', 'treatment']],
  ['Nursing',         ['nursing', 'patient care', 'ward', 'clinical', 'nurse', 'healthcare', 'medication']],
  ['Anatomy',         ['anatomy', 'bone', 'muscle', 'organ', 'tissue', 'skeletal', 'cardiovascular', 'nervous system']],
  // Law
  ['Law',             ['law', 'legal', 'contract', 'tort', 'criminal', 'constitution', 'court', 'statute', 'case study', 'judicial']],
];

function resolveSpecificSubject(subject, title) {
  // If the saved subject is already specific, use it
  if (subject && subject.trim() && subject.trim().toLowerCase() !== 'general') {
    return subject.trim();
  }
  const text = ((subject || '') + ' ' + (title || '')).toLowerCase();
  for (const [name, keywords] of SUBJECT_KEYWORDS) {
    if (keywords.some(k => text.includes(k))) return name;
  }
  // Fall back to first 2–3 meaningful words from the title
  const words = (title || '')
    .replace(/[^a-zA-Z\s]/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(w => w.length > 3 && !['quiz', 'test', 'exam', 'chapter', 'unit', 'part', 'with', 'from', 'your', 'this', 'that'].includes(w.toLowerCase()));
  if (words.length > 0) return words.slice(0, 2).map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
  return 'General';
}

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
