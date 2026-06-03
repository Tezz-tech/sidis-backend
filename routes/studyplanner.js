// routes/studyplanner.js
const express = require('express');
const router  = express.Router();
const auth    = require('../middlewares/auth');
const StudyPlan = require('../models/StudyPlan');
const Quiz      = require('../models/Quiz');

const { GoogleGenerativeAI } = require('@google/generative-ai');
require('dotenv').config();

const GEMINI_KEYS = process.env.GEMINI_API_KEYS
  ? process.env.GEMINI_API_KEYS.split(',').map(k => k.trim()).filter(Boolean)
  : [];

let aiModel = null;
if (GEMINI_KEYS.length > 0) {
  try {
    const genAI = new GoogleGenerativeAI(GEMINI_KEYS[0]);
    aiModel = genAI.getGenerativeModel({
      model: 'gemini-2.5-flash',
      generationConfig: { temperature: 0.7, maxOutputTokens: 2048, responseMimeType: 'application/json' },
    });
  } catch (_) {}
}

// ─── POST /api/study-planner/create ───────────────────────────────────────────
router.post('/create', auth, async (req, res) => {
  try {
    const { examName, subject, examDate } = req.body;
    if (!examName || !subject || !examDate)
      return res.status(400).json({ error: 'examName, subject, and examDate are required' });

    const exam  = new Date(examDate);
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const daysUntilExam = Math.ceil((exam - today) / (1000 * 60 * 60 * 24));

    if (daysUntilExam < 1)
      return res.status(400).json({ error: 'Exam date must be in the future' });

    let topics = [];

    // Try AI-generated study schedule
    if (aiModel) {
      try {
        const topicCount = Math.min(daysUntilExam * 2, 25);
        const prompt = `You are an expert academic tutor. Create a complete study plan for:

Exam Name: ${examName}
Subject: ${subject}
Days until exam: ${daysUntilExam}
Today's date: ${today.toISOString().split('T')[0]}

Generate exactly ${topicCount} specific, actionable study topics. Rules:
- Topics must be specific subtopics, NOT just the subject name
- "high" priority = core exam topics (assign to first 60% of days)
- "medium" priority = important supporting topics (middle period)
- "low" priority = supplementary / revision topics (last 20% of days)
- estimatedHours: 0.5 to 3.0
- scheduledDate: spread evenly from today to 2 days before exam (YYYY-MM-DD format)
- notes: brief focus tip (max 15 words)

Return JSON: { "topics": [{ "name": "...", "priority": "high|medium|low", "estimatedHours": 1.5, "scheduledDate": "YYYY-MM-DD", "notes": "..." }] }`;

        const raw    = await aiModel.generateContent(prompt);
        const text   = raw.response.text().trim().replace(/^```json\s*|```$/gi, '').trim();
        const parsed = JSON.parse(text);

        if (parsed.topics && Array.isArray(parsed.topics)) {
          topics = parsed.topics.map(t => ({
            name:           String(t.name || 'Study Session').slice(0, 120),
            priority:       ['high', 'medium', 'low'].includes(t.priority) ? t.priority : 'medium',
            estimatedHours: Math.min(4, Math.max(0.5, parseFloat(t.estimatedHours) || 1)),
            scheduledDate:  new Date(t.scheduledDate || today),
            notes:          String(t.notes || '').slice(0, 200),
            completed:      false,
          }));
        }
      } catch (aiErr) {
        console.error('AI plan generation failed (non-fatal):', aiErr.message);
      }
    }

    // Fallback: rule-based schedule
    if (topics.length === 0) {
      const fallbackTopics = [
        { name: `Introduction & Foundations of ${subject}`,         priority: 'high',   estimatedHours: 2   },
        { name: `Core Concepts & Key Definitions`,                   priority: 'high',   estimatedHours: 2   },
        { name: `Fundamental Theories & Principles`,                 priority: 'high',   estimatedHours: 2.5 },
        { name: `Worked Examples & Problem Solving`,                 priority: 'high',   estimatedHours: 2   },
        { name: `Past Paper Questions — Section A`,                  priority: 'high',   estimatedHours: 2   },
        { name: `Past Paper Questions — Section B`,                  priority: 'high',   estimatedHours: 2   },
        { name: `Advanced Topics & Edge Cases`,                      priority: 'medium', estimatedHours: 1.5 },
        { name: `Common Exam Mistakes & How to Avoid Them`,          priority: 'medium', estimatedHours: 1   },
        { name: `Important Formulas, Dates & Key Facts`,             priority: 'medium', estimatedHours: 1.5 },
        { name: `Case Studies & Real-World Applications`,            priority: 'medium', estimatedHours: 1.5 },
        { name: `Practice Quiz — Full Set`,                          priority: 'high',   estimatedHours: 2   },
        { name: `Review Weak Areas Identified in Practice`,          priority: 'high',   estimatedHours: 2   },
        { name: `Supplementary Reading & Extra Examples`,            priority: 'low',    estimatedHours: 1   },
        { name: `Timed Mock Exam Under Exam Conditions`,             priority: 'high',   estimatedHours: 3   },
        { name: `Final Review & Summary Notes`,                      priority: 'high',   estimatedHours: 1.5 },
      ];

      const count       = Math.min(fallbackTopics.length, daysUntilExam);
      const daysPerStep = Math.max(1, Math.floor(daysUntilExam / count));

      topics = fallbackTopics.slice(0, count).map((t, i) => {
        const d = new Date(today);
        d.setDate(d.getDate() + i * daysPerStep);
        return { ...t, scheduledDate: d, notes: '', completed: false };
      });
    }

    const plan = await StudyPlan.create({
      userId:   req.user.userId,
      examName: examName.trim(),
      subject:  subject.trim(),
      examDate: exam,
      topics,
    });

    res.json({ success: true, plan });
  } catch (err) {
    console.error('Create study plan error:', err);
    res.status(500).json({ error: 'Failed to create study plan' });
  }
});

// ─── GET /api/study-planner/plans ─────────────────────────────────────────────
router.get('/plans', auth, async (req, res) => {
  try {
    const plans = await StudyPlan.find({ userId: req.user.userId })
      .sort({ createdAt: -1 }).lean();

    const enriched = plans.map(p => ({
      ...p,
      totalTopics:       p.topics.length,
      completedTopics:   p.topics.filter(t => t.completed).length,
      highPriorityCount: p.topics.filter(t => t.priority === 'high').length,
      daysUntilExam:     Math.max(0, Math.ceil((new Date(p.examDate) - new Date()) / (1000 * 60 * 60 * 24))),
    }));

    res.json({ success: true, plans: enriched });
  } catch (err) {
    console.error('Get plans error:', err);
    res.status(500).json({ error: 'Failed to fetch plans' });
  }
});

// ─── GET /api/study-planner/plan/:id ──────────────────────────────────────────
router.get('/plan/:id', auth, async (req, res) => {
  try {
    const plan = await StudyPlan.findOne({ _id: req.params.id, userId: req.user.userId }).lean();
    if (!plan) return res.status(404).json({ error: 'Plan not found' });

    const quizzes = await Quiz.find({
      subject: new RegExp(plan.subject, 'i'),
      isPublic: true,
    }).limit(6).select('title subject numQuestions difficulty').lean();

    res.json({
      success: true,
      plan: {
        ...plan,
        totalTopics:     plan.topics.length,
        completedTopics: plan.topics.filter(t => t.completed).length,
        daysUntilExam:   Math.max(0, Math.ceil((new Date(plan.examDate) - new Date()) / (1000 * 60 * 60 * 24))),
      },
      recommendedQuizzes: quizzes.map(q => ({
        id: q._id, title: q.title, subject: q.subject,
        numQuestions: q.numQuestions, difficulty: q.difficulty,
      })),
    });
  } catch (err) {
    console.error('Get plan error:', err);
    res.status(500).json({ error: 'Failed to fetch plan' });
  }
});

// ─── PATCH /api/study-planner/plan/:id/topic/:topicId ─────────────────────────
router.patch('/plan/:id/topic/:topicId', auth, async (req, res) => {
  try {
    const { completed } = req.body;
    const plan = await StudyPlan.findOne({ _id: req.params.id, userId: req.user.userId });
    if (!plan) return res.status(404).json({ error: 'Plan not found' });

    const topic = plan.topics.id(req.params.topicId);
    if (!topic) return res.status(404).json({ error: 'Topic not found' });

    topic.completed   = !!completed;
    topic.completedAt = completed ? new Date() : null;
    plan.updatedAt    = new Date();

    await plan.save();
    res.json({ success: true, topic });
  } catch (err) {
    console.error('Update topic error:', err);
    res.status(500).json({ error: 'Failed to update topic' });
  }
});

// ─── DELETE /api/study-planner/plan/:id ───────────────────────────────────────
router.delete('/plan/:id', auth, async (req, res) => {
  try {
    await StudyPlan.deleteOne({ _id: req.params.id, userId: req.user.userId });
    res.json({ success: true });
  } catch (err) {
    console.error('Delete plan error:', err);
    res.status(500).json({ error: 'Failed to delete plan' });
  }
});

module.exports = router;
