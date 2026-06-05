// routes/studyplanner.js
const express   = require('express');
const router    = express.Router();
const auth      = require('../middlewares/auth');
const StudyPlan = require('../models/StudyPlan');
const Quiz      = require('../models/Quiz');
const QuizResult = require('../models/QuizResult');

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
      generationConfig: { temperature: 0.7, maxOutputTokens: 8192, responseMimeType: 'application/json' },
    });
  } catch (_) {}
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function addDays(date, n) {
  const d = new Date(date);
  d.setDate(d.getDate() + n);
  return d;
}

function formatDate(date) {
  return new Date(date).toISOString().split('T')[0];
}

// Fallback deterministic schedule when AI is unavailable
function buildFallbackSchedule(subjects, examDate, dailyHours) {
  const sessions = [];
  const today    = new Date();
  today.setHours(0, 0, 0, 0);
  const exam     = new Date(examDate);
  exam.setHours(0, 0, 0, 0);
  const days     = Math.max(1, Math.ceil((exam - today) / 86400000) - 1);

  const sessionsPerDay  = Math.max(1, Math.round(dailyHours / 1.5));
  const durationPerSession = Math.round((dailyHours * 60) / sessionsPerDay);
  let subjectIdx = 0;

  for (let d = 0; d < days; d++) {
    const date = addDays(today, d + 1);
    for (let s = 0; s < sessionsPerDay; s++) {
      const subject = subjects[subjectIdx % subjects.length];
      const isLast3Days = d >= days - 3;
      sessions.push({
        date,
        subject,
        durationMinutes: durationPerSession,
        sessionType: isLast3Days ? 'review' : 'quiz',
        priority:    isLast3Days ? 'high' : 'medium',
        notes: isLast3Days ? 'Final revision — focus on weak points' : '',
      });
      subjectIdx++;
    }
  }
  return sessions;
}

// ─── POST /api/study-planner/create ───────────────────────────────────────────
router.post('/create', auth, async (req, res) => {
  try {
    const { examName, examDate, subjects, dailyStudyHours } = req.body;
    if (!examName?.trim())
      return res.status(400).json({ error: 'Exam name is required' });
    if (!examDate)
      return res.status(400).json({ error: 'Exam date is required' });
    if (!Array.isArray(subjects) || subjects.filter(Boolean).length === 0)
      return res.status(400).json({ error: 'At least one subject is required' });
    if (new Date(examDate) <= new Date())
      return res.status(400).json({ error: 'Exam date must be in the future' });

    const plan = await StudyPlan.create({
      userId:          req.user.userId,
      examName:        examName.trim(),
      examDate:        new Date(examDate),
      subjects:        subjects.filter(s => s?.trim()).map(s => s.trim()),
      dailyStudyHours: Math.min(12, Math.max(0.5, parseFloat(dailyStudyHours) || 2)),
    });

    res.json({ success: true, plan });
  } catch (err) {
    console.error('Create plan error:', err);
    res.status(500).json({ error: 'Failed to create study plan' });
  }
});

// ─── POST /api/study-planner/:planId/generate-schedule ────────────────────────
router.post('/:planId/generate-schedule', auth, async (req, res) => {
  try {
    const plan = await StudyPlan.findOne({ _id: req.params.planId, userId: req.user.userId });
    if (!plan) return res.status(404).json({ error: 'Plan not found' });

    const today     = new Date();
    today.setHours(0, 0, 0, 0);
    const examDate  = new Date(plan.examDate);
    const daysLeft  = Math.max(1, Math.ceil((examDate - today) / 86400000) - 1);
    const subjects  = plan.subjects;

    // Fetch user's weak subjects from quiz history
    const results   = await QuizResult.find({ userId: req.user.userId }).lean();
    const bySubject = {};
    results.forEach(r => {
      if (!bySubject[r.subject]) bySubject[r.subject] = [];
      bySubject[r.subject].push(r.score);
    });
    const weakSubjects = subjects.filter(s => {
      const scores = bySubject[s];
      if (!scores || scores.length === 0) return false;
      const avg = scores.reduce((a, b) => a + b, 0) / scores.length;
      return avg < 60;
    });

    let sessions = [];

    if (aiModel) {
      const today_str = formatDate(today);
      const exam_str  = formatDate(examDate);

      const prompt = `You are an expert study planner. Create a daily study schedule.

Exam: "${plan.examName}"
Exam Date: ${exam_str}
Today: ${today_str}
Days Available: ${daysLeft}
Subjects to Cover: ${subjects.join(', ')}
Daily Study Hours: ${plan.dailyStudyHours}
Subjects needing extra focus (weak): ${weakSubjects.length > 0 ? weakSubjects.join(', ') : 'None identified yet'}

Rules:
- Create sessions from tomorrow (${formatDate(addDays(today, 1))}) through ${formatDate(addDays(examDate, -1))}
- Each day has ${Math.max(1, Math.round(plan.dailyStudyHours / 1.5))} session(s)
- Each session is ${Math.round((plan.dailyStudyHours * 60) / Math.max(1, Math.round(plan.dailyStudyHours / 1.5)))} minutes
- Weak subjects get ~30% more sessions than strong ones
- Last 3 days before exam: only "review" sessionType, priority "high"
- Do not repeat the same subject more than 2 consecutive days
- Cover ALL subjects at least once

Return ONLY valid JSON with no markdown:
{
  "sessions": [
    {
      "date": "YYYY-MM-DD",
      "subject": "Subject Name",
      "durationMinutes": 60,
      "sessionType": "quiz",
      "priority": "medium",
      "notes": "Optional focus note"
    }
  ]
}`;

      try {
        const raw  = await aiModel.generateContent(prompt);
        const text = raw.response.text().trim().replace(/^```json\s*|```$/gi, '').trim();
        const parsed = JSON.parse(text);
        if (Array.isArray(parsed.sessions) && parsed.sessions.length > 0) {
          sessions = parsed.sessions.map(s => ({
            date:            new Date(s.date),
            subject:         s.subject,
            durationMinutes: parseInt(s.durationMinutes) || 60,
            sessionType:     ['quiz','review','practice'].includes(s.sessionType) ? s.sessionType : 'quiz',
            priority:        ['high','medium','low'].includes(s.priority) ? s.priority : 'medium',
            notes:           s.notes || '',
          })).filter(s => !isNaN(s.date.getTime()) && subjects.includes(s.subject));
        }
      } catch (aiErr) {
        console.error('AI schedule error:', aiErr.message);
      }
    }

    // Fallback if AI failed or returned empty
    if (sessions.length === 0) {
      sessions = buildFallbackSchedule(subjects, plan.examDate, plan.dailyStudyHours);
    }

    plan.schedule  = sessions;
    plan.generated = true;
    plan.updatedAt = new Date();
    await plan.save();

    res.json({ success: true, plan });
  } catch (err) {
    console.error('Generate schedule error:', err);
    res.status(500).json({ error: 'Failed to generate schedule' });
  }
});

// ─── POST /api/study-planner/:planId/subject-material ─────────────────────────
// Upload PDF or paste notes for a specific subject. Accepts multipart (field: pdf)
// OR JSON { subject, notes }.
router.post('/:planId/subject-material', auth, async (req, res) => {
  try {
    const plan = await StudyPlan.findOne({ _id: req.params.planId, userId: req.user.userId });
    if (!plan) return res.status(404).json({ error: 'Plan not found' });

    const subject = (req.body?.subject || '').trim();
    if (!subject) return res.status(400).json({ error: 'subject field is required' });

    let extractedText = '';
    let fileName      = '';

    if (req.files?.pdf) {
      let pdfParse;
      try { pdfParse = require('pdf-parse/lib/pdf-parse.js'); } catch (_) {
        try { pdfParse = require('pdf-parse'); } catch (_2) {}
      }
      if (!pdfParse) return res.status(503).json({ error: 'PDF parser unavailable on this server.' });
      try {
        const parsed = await pdfParse(req.files.pdf.data);
        extractedText = (parsed.text || '').trim();
        fileName      = req.files.pdf.name || 'document.pdf';
        if (!extractedText)
          return res.status(422).json({ error: 'No text found in PDF. Use a text-based PDF or paste notes instead.' });
      } catch (pdfErr) {
        console.error('PDF parse error:', pdfErr.message);
        return res.status(422).json({ error: 'PDF parsing failed. Try pasting notes as text.' });
      }
    } else if (req.body?.notes?.trim()) {
      extractedText = req.body.notes.trim();
    } else {
      return res.status(400).json({ error: 'Send a PDF file (field: pdf) or a notes text body' });
    }

    // Upsert into subjectMaterials array
    if (!plan.subjectMaterials) plan.subjectMaterials = [];
    const idx = plan.subjectMaterials.findIndex(m => m.subject === subject);
    const entry = { subject, notes: extractedText.slice(0, 50000), fileName, hasContent: true };
    if (idx >= 0) plan.subjectMaterials[idx] = entry;
    else          plan.subjectMaterials.push(entry);

    plan.updatedAt = new Date();
    await plan.save();

    res.json({ success: true, subject, fileName, textLength: entry.notes.length });
  } catch (err) {
    console.error('Subject material error:', err);
    res.status(500).json({ error: 'Failed to save material' });
  }
});

// ─── POST /api/study-planner/:planId/session/:sessionId/start ─────────────────
// Generates (or retrieves) a quiz for this session and returns its ID.
// If the subject has uploaded material, questions are based on that material.
router.post('/:planId/session/:sessionId/start', auth, async (req, res) => {
  try {
    const plan = await StudyPlan.findOne({ _id: req.params.planId, userId: req.user.userId });
    if (!plan) return res.status(404).json({ error: 'Plan not found' });

    const session = plan.schedule.id(req.params.sessionId);
    if (!session) return res.status(404).json({ error: 'Session not found' });

    // Return existing quiz if already generated
    if (session.quizId) {
      return res.json({ success: true, quizId: session.quizId, quizTitle: session.quizTitle });
    }

    if (!aiModel)
      return res.status(503).json({ error: 'AI generation unavailable. Check API key configuration.' });

    const examDate    = new Date(plan.examDate).toDateString();
    const sessionType = session.sessionType;
    const subject     = session.subject;
    const priority    = session.priority;
    const mcqCount    = sessionType === 'review' ? 8 : 10;
    const essayCount  = sessionType === 'review' ? 3 : 4;

    // Check if user uploaded material for this subject
    const subjectMaterial = (plan.subjectMaterials || []).find(
      m => m.subject === subject && m.hasContent && m.notes?.trim()
    );

    let quizPrompt;
    if (subjectMaterial) {
      // Material-based: questions come directly from uploaded notes/PDF
      quizPrompt = `You are an expert exam question creator for ${subject}.
Based ONLY on the study material provided below, generate ${mcqCount} MCQ questions and ${essayCount} short-answer questions.

Study Material:
${subjectMaterial.notes.slice(0, 7000)}

Rules:
- Every question must be directly traceable to the study material above
- MCQ: exactly 4 options, one correct answer, plausible distractors
- Short-answer: 2–4 sentence model answers drawn from the material
- Difficulty: ${priority === 'high' ? 'hard — exam-level' : 'medium — solid understanding'}
- Session type: ${sessionType}

Return ONLY valid JSON:
{
  "questions": [
    { "type": "mcq", "question": "...", "options": ["A","B","C","D"], "correctAnswer": 0, "explanation": "..." },
    { "type": "essay", "question": "...", "modelAnswer": "..." }
  ]
}`;
    } else {
      // Generic: no material uploaded, use subject knowledge
      quizPrompt = `You are an expert exam question creator for ${subject}.
Generate ${mcqCount} MCQ questions and ${essayCount} short-answer questions for a study session.

Context:
- Subject: ${subject}
- Exam: ${plan.examName} (${examDate})
- Session type: ${sessionType}
- Priority: ${priority} ${priority === 'high' ? '— focus on difficult/commonly examined topics' : ''}

Rules:
- Questions must test real subject knowledge (not trivial)
- MCQ: exactly 4 options, one correct answer
- Short-answer: 2–4 sentence model answers
- Match difficulty to an actual exam paper for this subject

Return ONLY valid JSON:
{
  "questions": [
    { "type": "mcq", "question": "...", "options": ["A","B","C","D"], "correctAnswer": 0, "explanation": "..." },
    { "type": "essay", "question": "...", "modelAnswer": "..." }
  ]
}`;
    } // end else (no material)

    let generatedQuestions = [];
    try {
      const raw   = await aiModel.generateContent(quizPrompt);
      const text  = raw.response.text().trim().replace(/^```json\s*|```$/gi, '').trim();
      const parsed = JSON.parse(text);
      if (Array.isArray(parsed.questions)) generatedQuestions = parsed.questions;
    } catch (aiErr) {
      console.error('AI quiz error:', aiErr.message);
      return res.status(500).json({ error: 'AI failed to generate quiz. Please try again.' });
    }

    if (generatedQuestions.length === 0)
      return res.status(500).json({ error: 'AI returned no questions. Please try again.' });

    const mcq   = generatedQuestions.filter(q => q.type === 'mcq');
    const essay = generatedQuestions.filter(q => q.type === 'essay');
    const questionType = mcq.length > 0 && essay.length > 0 ? 'mixed' : mcq.length > 0 ? 'mcq' : 'essay';

    const quizQuestions = generatedQuestions.map(q => {
      if (q.type === 'mcq') return {
        question:      q.question,
        options:       Array.isArray(q.options) ? q.options.slice(0, 4) : [],
        correctAnswer: typeof q.correctAnswer === 'number' ? q.correctAnswer : 0,
        modelAnswer:   '',
        explanation:   q.explanation || '',
      };
      return {
        question:      q.question,
        options:       [],
        correctAnswer: null,
        modelAnswer:   q.modelAnswer || '',
        explanation:   '',
      };
    });

    const quizTitle = `${subject} — ${plan.examName} (${sessionType === 'review' ? 'Revision' : 'Practice'})`;
    const quiz = await Quiz.create({
      userId:         req.user.userId,
      title:          quizTitle,
      subject,
      difficulty:     priority === 'high' ? 'hard' : 'medium',
      timeLimit:      Math.max(15, Math.ceil(quizQuestions.length * 2.5)),
      numQuestions:   quizQuestions.length,
      questionType,
      questions:      quizQuestions,
      isPublic:       false,
      isAdminCreated: false,
    });

    session.quizId    = quiz._id;
    session.quizTitle = quiz.title;
    plan.updatedAt    = new Date();
    await plan.save();

    res.json({ success: true, quizId: quiz._id, quizTitle: quiz.title });
  } catch (err) {
    console.error('Start session error:', err);
    res.status(500).json({ error: 'Failed to start session' });
  }
});

// ─── POST /api/study-planner/:planId/session/:sessionId/complete ───────────────
router.post('/:planId/session/:sessionId/complete', auth, async (req, res) => {
  try {
    const { score } = req.body;
    const plan = await StudyPlan.findOne({ _id: req.params.planId, userId: req.user.userId });
    if (!plan) return res.status(404).json({ error: 'Plan not found' });

    const session = plan.schedule.id(req.params.sessionId);
    if (!session) return res.status(404).json({ error: 'Session not found' });

    session.completed   = true;
    session.completedAt = new Date();
    if (typeof score === 'number') session.score = score;
    plan.updatedAt = new Date();
    await plan.save();

    res.json({ success: true });
  } catch (err) {
    console.error('Complete session error:', err);
    res.status(500).json({ error: 'Failed to mark session complete' });
  }
});

// ─── PATCH /api/study-planner/:planId/session/:sessionId ──────────────────────
router.patch('/:planId/session/:sessionId', auth, async (req, res) => {
  try {
    const { date, durationMinutes, notes } = req.body;
    const plan = await StudyPlan.findOne({ _id: req.params.planId, userId: req.user.userId });
    if (!plan) return res.status(404).json({ error: 'Plan not found' });

    const session = plan.schedule.id(req.params.sessionId);
    if (!session) return res.status(404).json({ error: 'Session not found' });

    if (date)            session.date            = new Date(date);
    if (durationMinutes) session.durationMinutes = parseInt(durationMinutes);
    if (notes !== undefined) session.notes       = notes;
    plan.updatedAt = new Date();
    await plan.save();

    res.json({ success: true });
  } catch (err) {
    console.error('Update session error:', err);
    res.status(500).json({ error: 'Failed to update session' });
  }
});

// ─── GET /api/study-planner/plans ─────────────────────────────────────────────
router.get('/plans', auth, async (req, res) => {
  try {
    const plans = await StudyPlan.find({ userId: req.user.userId }).sort({ createdAt: -1 }).lean();
    const enriched = plans.map(p => {
      const total     = p.schedule.length;
      const completed = p.schedule.filter(s => s.completed).length;
      const today     = new Date();
      const daysLeft  = Math.max(0, Math.ceil((new Date(p.examDate) - today) / 86400000));
      return { ...p, total, completed, daysLeft, progress: total > 0 ? Math.round((completed / total) * 100) : 0 };
    });
    res.json({ success: true, plans: enriched });
  } catch (err) {
    console.error('Get plans error:', err);
    res.status(500).json({ error: 'Failed to fetch plans' });
  }
});

// ─── GET /api/study-planner/:planId ───────────────────────────────────────────
router.get('/:planId', auth, async (req, res) => {
  try {
    const plan = await StudyPlan.findOne({ _id: req.params.planId, userId: req.user.userId }).lean();
    if (!plan) return res.status(404).json({ error: 'Plan not found' });

    const today    = new Date();
    const daysLeft = Math.max(0, Math.ceil((new Date(plan.examDate) - today) / 86400000));
    const total    = plan.schedule.length;
    const completed = plan.schedule.filter(s => s.completed).length;

    const enriched = {
      ...plan,
      daysLeft,
      total,
      completed,
      progress: total > 0 ? Math.round((completed / total) * 100) : 0,
      schedule: plan.schedule
        .map(s => ({
          ...s,
          isPast:   new Date(s.date) < today && !s.completed,
          isToday:  new Date(s.date).toDateString() === today.toDateString(),
        }))
        .sort((a, b) => new Date(a.date) - new Date(b.date)),
    };

    res.json({ success: true, plan: enriched });
  } catch (err) {
    console.error('Get plan error:', err);
    res.status(500).json({ error: 'Failed to fetch plan' });
  }
});

// ─── DELETE /api/study-planner/:planId ────────────────────────────────────────
router.delete('/:planId', auth, async (req, res) => {
  try {
    await StudyPlan.deleteOne({ _id: req.params.planId, userId: req.user.userId });
    res.json({ success: true });
  } catch (err) {
    console.error('Delete plan error:', err);
    res.status(500).json({ error: 'Failed to delete plan' });
  }
});

module.exports = router;
