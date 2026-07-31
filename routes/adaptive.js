// routes/adaptive.js — adaptive learning insights + the daily automatic sweep
const express      = require('express');
const router       = express.Router();
const auth         = require('../middlewares/auth');
const TopicMastery = require('../models/TopicMastery');
const StudyPlan    = require('../models/StudyPlan');
const QuizResult   = require('../models/QuizResult');
const Quiz         = require('../models/Quiz');
const {
  detectWeakPatterns, runAdaptiveCycle, needsAdaptiveAction,
} = require('../utils/adaptiveEngine');

// ─── GET /api/adaptive/insights ────────────────────────────────────────────────
// Weak topics + the feed of automatic actions already taken. Powers the
// "Sid IQ" page's topic-level (not just subject-level) weak-spot list.
router.get('/insights', auth, async (req, res) => {
  try {
    const topics = await TopicMastery.find({ userId: req.user.userId })
      .sort({ masteryScore: 1 })
      .lean();

    const weakTopics = topics
      .filter(t => t.status === 'weak' || t.consecutiveMisses >= 2)
      .map(t => ({
        subject: t.subject,
        topic: t.topic,
        masteryScore: t.masteryScore,
        consecutiveMisses: t.consecutiveMisses,
        status: t.status,
        easyDigest: t.easyDigest || null,
      }));

    const autoActions = topics
      .filter(t => t.lastAutoActionAt)
      .sort((a, b) => new Date(b.lastAutoActionAt) - new Date(a.lastAutoActionAt))
      .slice(0, 10)
      .map(t => ({
        subject: t.subject,
        topic: t.topic,
        takenAt: t.lastAutoActionAt,
        quizId: t.lastPracticeQuizId,
        quizTitle: t.lastPracticeQuizTitle,
        planPatched: t.lastPlanPatched,
        message: `We noticed repeated mistakes on ${t.topic} — ${
          t.lastPracticeQuizTitle ? `added "${t.lastPracticeQuizTitle}"` : 'prepared extra practice'
        }${t.lastPlanPatched ? ' and added a session to tomorrow\'s study plan' : ''}.`,
      }));

    res.json({ success: true, weakTopics, autoActions });
  } catch (err) {
    console.error('Adaptive insights error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ─── GET /api/adaptive/review-mistakes ─────────────────────────────────────────
// The student's recent wrong MCQ answers, grouped by topic, so the dashboard's
// action plan can say "Review 12 incorrect questions in Depreciation" with a
// real count and link straight to them — no new data model, just re-joining
// QuizResult.topicBreakdown against the source Quiz.questions.
router.get('/review-mistakes', auth, async (req, res) => {
  try {
    const userId = req.user.userId;
    const results = await QuizResult.find({ userId, 'topicBreakdown.0': { $exists: true } })
      .sort({ createdAt: -1 })
      .limit(30)
      .lean();

    if (results.length === 0) return res.json({ success: true, topics: [], totalMistakes: 0 });

    const quizIds = [...new Set(results.map(r => r.quizId?.toString()).filter(Boolean))];
    const quizzes = await Quiz.find({ _id: { $in: quizIds } }).select('title questions').lean();
    const quizMap = {};
    for (const q of quizzes) quizMap[q._id.toString()] = q;

    const byTopic = {};
    for (const r of results) {
      const quiz = quizMap[r.quizId?.toString()];
      if (!quiz) continue;
      for (const entry of r.topicBreakdown || []) {
        if (entry.correct) continue;
        const q = quiz.questions[entry.questionIndex];
        if (!q) continue;
        const key = entry.topic || entry.subject || 'General';
        if (!byTopic[key]) byTopic[key] = { subject: entry.subject || 'General', topic: key, questions: [] };
        if (byTopic[key].questions.length >= 10) continue; // cap per topic — keep the payload light
        byTopic[key].questions.push({
          quizId: r.quizId,
          quizTitle: quiz.title,
          questionIndex: entry.questionIndex,
          question: q.question,
          options: q.options,
          correctAnswer: q.correctAnswer,
          explanation: q.explanation || '',
          answeredAt: r.createdAt,
        });
      }
    }

    const topics = Object.values(byTopic)
      .map(t => ({ ...t, count: t.questions.length }))
      .sort((a, b) => b.count - a.count);
    const totalMistakes = topics.reduce((s, t) => s + t.count, 0);

    res.json({ success: true, topics, totalMistakes });
  } catch (err) {
    console.error('Review mistakes error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ─── /api/adaptive/daily-sweep ──────────────────────────────────────────────
// Vercel Cron target — runs once a day so weak-topic detection and study-plan
// patching happen even if the student never opens the app. Not tied to any
// user session, so it's protected by a shared secret instead of JWT auth.
// Vercel Cron Jobs call this with GET; POST is kept for manual testing.
async function dailySweep(req, res) {
  const provided = req.headers['x-cron-secret'] || req.headers['authorization']?.replace(/^Bearer\s+/i, '') || req.query.secret;
  if (!process.env.CRON_SECRET || provided !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const userIds = await StudyPlan.distinct('userId', {
      generated: true,
      examDate: { $gt: new Date() },
    });

    let usersProcessed = 0;
    let actionsRun = 0;

    for (const userId of userIds) {
      const stale = await detectWeakPatterns(userId);
      if (stale.length === 0) continue;
      usersProcessed++;
      for (const topicDoc of stale) {
        if (!needsAdaptiveAction(topicDoc)) continue;
        await runAdaptiveCycle(userId, topicDoc.subject, topicDoc.topic);
        actionsRun++;
      }
    }

    res.json({ success: true, usersScanned: userIds.length, usersProcessed, actionsRun });
  } catch (err) {
    console.error('Daily sweep error:', err);
    res.status(500).json({ error: 'Server error' });
  }
}

router.get('/daily-sweep', dailySweep);
router.post('/daily-sweep', dailySweep);

module.exports = router;
