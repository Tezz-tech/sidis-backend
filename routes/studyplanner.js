// routes/studyplanner.js
const express   = require('express');
const router    = express.Router();
const auth      = require('../middlewares/auth');
const StudyPlan = require('../models/StudyPlan');
const Quiz      = require('../models/Quiz');
const QuizResult = require('../models/QuizResult');

const { gemini, capText } = require('../utils/ai');
const { extractPdfText, pdfParseAvailable } = require('../utils/pdfExtract');

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

    if (gemini.ready) {
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
        const parsed = await gemini.generateJSON(prompt);
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
  console.log('[studyplanner] subject-material hit, planId:', req.params.planId, 'hasFile:', !!req.files?.pdf, 'bodyKeys:', Object.keys(req.body || {}));
  try {
    const plan = await StudyPlan.findOne({ _id: req.params.planId, userId: req.user.userId });
    if (!plan) return res.status(404).json({ error: 'Plan not found' });

    const subject = (req.body?.subject || '').trim();
    if (!subject) return res.status(400).json({ error: 'subject field is required' });

    // 'vision' sends the raw PDF straight to Gemini so diagrams/charts/images
    // are actually read, not just whatever text pdf-parse could pull out.
    // Defaults to 'text' so older cached frontend bundles keep working.
    const extractionMode = req.body?.extractionMode === 'vision' ? 'vision' : 'text';

    let extractedText = '';
    let fileName      = '';

    if (req.files?.pdf) {
      fileName = req.files.pdf.name || 'document.pdf';

      if (extractionMode === 'vision') {
        if (!gemini.ready) return res.status(503).json({ error: 'AI service is temporarily unavailable. Please try again shortly.' });
        const visionPrompt = `You are transcribing study material for a student. The material for "${subject}" is attached as a PDF file — read all text AND any diagrams, charts, tables, photos, or images it contains.

Produce a thorough, detailed prose transcript of everything in the material — all text content plus a full written description of every diagram, chart, table, or image (what it shows, its labels, and what it demonstrates) — detailed enough that someone who never saw the PDF could fully understand it from this transcript alone. This will be used to generate quiz questions later, so be comprehensive.

Return ONLY valid JSON: { "transcript": "..." }`;
        try {
          const parsed = await gemini.generateJSONFromFiles(
            visionPrompt,
            [{ data: req.files.pdf.data, mimeType: req.files.pdf.mimetype || 'application/pdf' }],
            { maxOutputTokens: 4096, temperature: 0.4 }
          );
          extractedText = String(parsed.transcript || '').trim();
          if (!extractedText) return res.status(422).json({ error: 'AI could not read this PDF. Try "Text Only" or paste the notes instead.' });
        } catch (aiErr) {
          console.error('PDF vision error:', aiErr.message);
          return res.status(422).json({ error: `AI failed to read this PDF: ${aiErr.message}` });
        }
      } else {
        if (!pdfParseAvailable()) return res.status(503).json({ error: 'PDF parser unavailable on this server.' });
        try {
          extractedText = (await extractPdfText(req.files.pdf.data)).trim();
          if (!extractedText)
            return res.status(422).json({ error: 'No text found in PDF. Use a text-based PDF or paste notes instead.' });
        } catch (pdfErr) {
          console.error('PDF parse error:', pdfErr.message);
          return res.status(422).json({ error: 'PDF parsing failed. Try pasting notes as text.' });
        }
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

    if (!gemini.ready)
      return res.status(503).json({ error: 'AI is temporarily unavailable. Please mark this session as done manually after reviewing the subject, or try again later.' });

    const examDate    = new Date(plan.examDate).toDateString();
    const sessionType = session.sessionType;
    const subject     = session.subject;
    const priority    = session.priority;
    const mcqCount    = sessionType === 'review' ? 8 : 12;

    // Check if user uploaded material for this subject
    const subjectMaterial = (plan.subjectMaterials || []).find(
      m => m.subject === subject && m.hasContent && m.notes?.trim()
    );

    let quizPrompt;
    if (subjectMaterial) {
      quizPrompt = `You are an expert exam question creator for ${subject}.
Based ONLY on the study material below, generate exactly ${mcqCount} multiple-choice questions.

Study Material:
${subjectMaterial.notes.slice(0, 7000)}

Rules:
- Every question must be directly traceable to the study material above
- Each question has exactly 4 options (A, B, C, D), one correct answer, and plausible distractors
- correctAnswer is the 0-based index of the correct option
- Include a brief explanation for the correct answer
- Difficulty: ${priority === 'high' ? 'hard — exam-level' : 'medium — solid understanding'}
- Do NOT generate essay or short-answer questions

Return ONLY valid JSON:
{
  "questions": [
    { "question": "...", "options": ["A","B","C","D"], "correctAnswer": 0, "explanation": "...", "topic": "specific sub-topic tested, e.g. 'Depreciation' not just the subject name" }
  ]
}`;
    } else {
      quizPrompt = `You are an expert exam question creator for ${subject}.
Generate exactly ${mcqCount} multiple-choice questions for a study session.

Context:
- Subject: ${subject}
- Exam: ${plan.examName} (${examDate})
- Session type: ${sessionType}
- Priority: ${priority}${priority === 'high' ? ' — focus on difficult/commonly examined topics' : ''}

Rules:
- Questions must test real subject knowledge at exam standard
- Each question has exactly 4 options, one correct answer, plausible distractors
- correctAnswer is the 0-based index (0–3)
- Include a concise explanation for the correct answer
- Do NOT generate essay or short-answer questions

Return ONLY valid JSON:
{
  "questions": [
    { "question": "...", "options": ["A","B","C","D"], "correctAnswer": 0, "explanation": "...", "topic": "specific sub-topic tested, e.g. 'Depreciation' not just the subject name" }
  ]
}`;
    }

    let generatedQuestions = [];
    try {
      const parsed = await gemini.generateJSON(quizPrompt);
      if (Array.isArray(parsed.questions)) generatedQuestions = parsed.questions;
    } catch (aiErr) {
      console.error('AI quiz error:', aiErr.message);
      return res.status(503).json({
        error: 'AI is temporarily unavailable. Please mark this session as done manually after reviewing the subject, or try again later.',
      });
    }

    if (generatedQuestions.length === 0)
      return res.status(500).json({ error: 'AI returned no questions. Please try again.' });

    const quizQuestions = generatedQuestions
      .filter(q => q.question && Array.isArray(q.options) && q.options.length >= 2)
      .map(q => ({
        question:      q.question,
        options:       q.options.slice(0, 4),
        correctAnswer: typeof q.correctAnswer === 'number' ? Math.min(q.correctAnswer, q.options.length - 1) : 0,
        modelAnswer:   '',
        explanation:   q.explanation || '',
        topic:         q.topic || '',
      }));

    const quizTitle = `${subject} — ${plan.examName} (${sessionType === 'review' ? 'Revision' : 'Practice'})`;
    const quiz = await Quiz.create({
      userId:         req.user.userId,
      title:          quizTitle,
      subject,
      difficulty:     priority === 'high' ? 'hard' : 'medium',
      timeLimit:      Math.max(15, Math.ceil(quizQuestions.length * 2)),
      numQuestions:   quizQuestions.length,
      questionType:   'mcq',
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

// ─── GET /api/study-planner/next-session ──────────────────────────────────────
// The single nearest due/overdue session across ALL of the user's plans —
// powers the dashboard's "what's next" hero so the student never has to dig
// through the full planner just to see what to do right now.
router.get('/next-session', auth, async (req, res) => {
  try {
    const plans = await StudyPlan.find({ userId: req.user.userId, generated: true }).lean();
    if (plans.length === 0) return res.json({ success: true, session: null, hasPlan: false });

    const todayStart = new Date();
    todayStart.setUTCHours(0, 0, 0, 0);

    let best = null; // most overdue/due-today session across all plans
    for (const plan of plans) {
      for (const s of plan.schedule) {
        if (s.completed) continue;
        const sessionDay = new Date(s.date);
        sessionDay.setUTCHours(0, 0, 0, 0);
        const isPast = sessionDay < todayStart;
        const isToday = sessionDay.getTime() === todayStart.getTime();
        if (!isPast && !isToday) continue; // only due/overdue — not future sessions
        if (!best || sessionDay < best.sessionDay) {
          best = { session: s, plan, isPast, isToday, sessionDay };
        }
      }
    }

    // Nothing due/overdue — fall back to the next upcoming session so the
    // hero can say "next up" instead of showing nothing.
    if (!best) {
      for (const plan of plans) {
        for (const s of plan.schedule) {
          if (s.completed) continue;
          const sessionDay = new Date(s.date);
          if (!best || sessionDay < best.sessionDay) {
            best = { session: s, plan, isPast: false, isToday: false, sessionDay };
          }
        }
      }
    }

    if (!best) return res.json({ success: true, session: null, hasPlan: true });

    res.json({
      success: true,
      hasPlan: true,
      session: {
        id: best.session._id,
        planId: best.plan._id,
        examName: best.plan.examName,
        subject: best.session.subject,
        topic: best.session.topic || '',
        sessionType: best.session.sessionType,
        durationMinutes: best.session.durationMinutes,
        priority: best.session.priority,
        notes: best.session.notes,
        date: best.session.date,
        isToday: best.isToday,
        isPast: best.isPast,
        quizId: best.session.quizId,
        quizTitle: best.session.quizTitle,
        autoGenerated: best.session.autoGenerated || false,
      },
    });
  } catch (err) {
    console.error('Next session error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ─── GET /api/study-planner/:planId ───────────────────────────────────────────
router.get('/:planId', auth, async (req, res) => {
  try {
    const plan = await StudyPlan.findOne({ _id: req.params.planId, userId: req.user.userId }).lean();
    if (!plan) return res.status(404).json({ error: 'Plan not found' });

    const now      = new Date();
    const todayStart = new Date(now);
    todayStart.setUTCHours(0, 0, 0, 0);
    const daysLeft = Math.max(0, Math.ceil((new Date(plan.examDate) - now) / 86400000));
    const total    = plan.schedule.length;
    const completed = plan.schedule.filter(s => s.completed).length;

    const enriched = {
      ...plan,
      daysLeft,
      total,
      completed,
      progress: total > 0 ? Math.round((completed / total) * 100) : 0,
      schedule: plan.schedule
        .map(s => {
          const sessionDay = new Date(s.date);
          sessionDay.setUTCHours(0, 0, 0, 0);
          return {
            ...s,
            isPast:  sessionDay < todayStart && !s.completed,
            isToday: sessionDay.getTime() === todayStart.getTime(),
          };
        })
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
