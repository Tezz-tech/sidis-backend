// routes/mausbot.js — "Mausbot": AI-assisted university project (final year
// project/thesis) writing. A student sets a topic + chapter plan (defaults
// to the standard 5-chapter format), then generates one chapter at a time —
// each one researched with real search grounding where possible, lightly
// revised for natural phrasing, and flagged for passages the student should
// personalize before submitting. A short quiz on each chapter gates moving
// to the next one for free-tier students (verifies real engagement, not
// just a content-generation button); paid-plan students skip that gate,
// same as every other paid-vs-free distinction in this app — no separate
// payment logic lives here. Fully resumable: nothing is generated upfront,
// so a student can come back and do one chapter at a time over many visits.
const express       = require('express');
const router         = express.Router();
const auth           = require('../middlewares/auth');
const PDFDocument    = require('pdfkit');
const MausbotSession = require('../models/MausbotSession');
const Quiz           = require('../models/Quiz');
const QuizResult     = require('../models/QuizResult');
const { gemini }     = require('../utils/ai');
const { getUserPlan, getPlanFeatures } = require('../utils/subscription');
const { DISCIPLINE_MCQ_INSTRUCTION } = require('../utils/disciplinePrompt');

const MAX_CHAPTERS = 15;
const QUIZ_PASS_THRESHOLD = 60; // percent

// ── Shared monthly quota — same pool as every other AI-generation feature ──
async function checkAndReportQuota(userId) {
  const plan     = await getUserPlan(userId);
  const features = await getPlanFeatures(plan);
  if (features.unlimitedQuizzes) return null;

  const monthStart = new Date();
  monthStart.setDate(1);
  monthStart.setHours(0, 0, 0, 0);
  const count = await Quiz.countDocuments({ userId, isAdminCreated: false, createdAt: { $gte: monthStart } });
  if (count >= features.aiQuizzesPerMonth) {
    return {
      error:   'monthly_limit_reached',
      message: `You've used all ${features.aiQuizzesPerMonth} AI generations for this month. Upgrade your plan for unlimited Mausbot chapters.`,
      limit:   features.aiQuizzesPerMonth, used: count,
    };
  }
  return null;
}

async function isPaidUser(userId) {
  const plan = await getUserPlan(userId);
  return plan !== 'free';
}

// ── POST /api/mausbot/create ──────────────────────────────────────────────────
// Body: { topic, fieldOfStudy, chapters: [{ number, title }] }. No AI call —
// just saves the plan. Chapters are generated on demand, one at a time.
router.post('/create', auth, async (req, res) => {
  try {
    const topic = (req.body?.topic || '').trim();
    const fieldOfStudy = (req.body?.fieldOfStudy || '').trim();
    const rawChapters = Array.isArray(req.body?.chapters) ? req.body.chapters : [];

    if (!topic) return res.status(400).json({ error: 'A project topic is required.' });
    if (!fieldOfStudy) return res.status(400).json({ error: 'Field of study is required.' });

    const chapters = rawChapters
      .map((c, i) => ({ number: i + 1, title: (c.title || '').trim() }))
      .filter(c => c.title);
    if (chapters.length === 0) return res.status(400).json({ error: 'At least one chapter title is required.' });
    if (chapters.length > MAX_CHAPTERS) return res.status(400).json({ error: `A project can have at most ${MAX_CHAPTERS} chapters.` });

    const session = await MausbotSession.create({
      userId: req.user.userId, topic, fieldOfStudy,
      chapters: chapters.map(c => ({ ...c, content: '', status: 'pending' })),
    });

    res.json({ success: true, id: session._id, title: session.topic, totalChapters: chapters.length });
  } catch (err) {
    console.error('[mausbot] /create error:', err.message);
    res.status(500).json({ error: `Unexpected error: ${err.message || 'unknown'}` });
  }
});

// ── GET /api/mausbot/sessions ─────────────────────────────────────────────────
router.get('/sessions', auth, async (req, res) => {
  try {
    const sessions = await MausbotSession.find({ userId: req.user.userId })
      .select('-chapters.content').sort({ createdAt: -1 }).lean();
    res.json({ success: true, sessions });
  } catch (err) {
    res.status(500).json({ error: `Failed to fetch Mausbot sessions: ${err.message}` });
  }
});

// ── GET /api/mausbot/:id ───────────────────────────────────────────────────────
router.get('/:id', auth, async (req, res) => {
  try {
    const session = await MausbotSession.findOne({ _id: req.params.id, userId: req.user.userId }).lean();
    if (!session) return res.status(404).json({ error: 'Mausbot session not found.' });
    const paid = await isPaidUser(req.user.userId);
    res.json({ success: true, session, paid });
  } catch (err) {
    res.status(500).json({ error: `Failed to fetch Mausbot session: ${err.message}` });
  }
});

// ── DELETE /api/mausbot/:id ──────────────────────────────────────────────────
router.delete('/:id', auth, async (req, res) => {
  try {
    await MausbotSession.deleteOne({ _id: req.params.id, userId: req.user.userId });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: `Failed to delete: ${err.message}` });
  }
});

// ── Prompt builders ────────────────────────────────────────────────────────────
function buildChapterPrompt(session, chapter, priorSummary) {
  return `You are an expert academic research assistant helping a university student research and draft Chapter ${chapter.number} ("${chapter.title}") of their final year project.

Project topic: "${session.topic}"
Field of study: ${session.fieldOfStudy}
Full chapter plan: ${session.chapters.map(c => `${c.number}. ${c.title}`).join('; ')}
${priorSummary ? `\nWhat's already been written in earlier chapters — stay consistent with it, don't repeat it:\n${priorSummary}` : ''}

Write Chapter ${chapter.number} ("${chapter.title}") in full, as a genuine, well-researched academic chapter:
- Where the chapter calls for literature, evidence, or background facts, search for and cite real, verifiable, current sources — in-text citations in (Author, Year) format.
- Write with real academic depth and sub-structure (use "## Sub-heading" on its own line for sub-sections where appropriate), not a shallow overview.
- Keep the reasoning and voice that of a student author doing original analysis and synthesis — never copy a source's wording directly.
- Target roughly 1200-2000 words.

Write ONLY the chapter content itself (plain text, sub-headings as "## Sub-heading" on their own line) — no preamble, no meta-commentary, no "Here is Chapter X".`;
}

function buildRevisePrompt(chapterText) {
  return `You are an academic writing editor reviewing a student's draft chapter before they personalize and submit it.

Draft chapter:
${chapterText.slice(0, 20000)}

Do two things:
1. Lightly revise it for natural, varied sentence structure and phrasing — the kind of natural variation a careful human writer has — WITHOUT changing the facts, citations, or meaning, and without materially changing its length.
2. Identify up to 5 short passages (quote them EXACTLY as they appear in your revised text) that still read as generic, overly templated, or too close to how a source/textbook would phrase it. For each, give a one-sentence note on how the student should personalize it in their own words before submitting — this is an academic-integrity check, not optional polish.

Return ONLY valid JSON: { "revisedText": "...", "originalityNotes": [ { "passage": "...", "note": "..." } ] }`;
}

function buildQuizPrompt(chapter) {
  return `You are an expert examiner checking a student's understanding of a chapter they just had researched and drafted for their own project.

${DISCIPLINE_MCQ_INSTRUCTION}

Chapter ${chapter.number}: "${chapter.title}"
${chapter.content.slice(0, 20000)}

Generate 4 multiple-choice questions that check genuine understanding of THIS chapter's content (not trivia) — this confirms the student actually read and understood what was generated for them before moving on.

RULES:
- Each question has exactly 4 options (A, B, C, D), one correct answer, plausible distractors.
- correctAnswer is the 0-based index of the correct option.

Return ONLY valid JSON:
{ "questions": [ { "question": "...", "options": ["A","B","C","D"], "correctAnswer": 0, "explanation": "..." } ] }`;
}

// ── POST /api/mausbot/:id/chapter/:index/generate ───────────────────────────
router.post('/:id/chapter/:index/generate', auth, async (req, res) => {
  try {
    if (!gemini.ready)
      return res.status(503).json({ error: 'AI service is temporarily unavailable. Please try again shortly.' });

    const session = await MausbotSession.findOne({ _id: req.params.id, userId: req.user.userId });
    if (!session) return res.status(404).json({ error: 'Mausbot session not found.' });

    const idx = parseInt(req.params.index, 10);
    const chapter = session.chapters[idx];
    if (!chapter) return res.status(400).json({ error: 'Invalid chapter index.' });
    if (chapter.status === 'ready') return res.json({ success: true, alreadyGenerated: true, chapter });

    if (idx > 0) {
      const prior = session.chapters[idx - 1];
      const paid = await isPaidUser(req.user.userId);
      if (prior.status !== 'ready')
        return res.status(400).json({ error: `Generate Chapter ${prior.number} first.` });
      if (!paid && !prior.quizPassed)
        return res.status(403).json({ error: `Pass the Chapter ${prior.number} quiz first to unlock Chapter ${chapter.number}.`, quizGateLocked: true });
    }

    const quotaError = await checkAndReportQuota(req.user.userId);
    if (quotaError) return res.status(403).json(quotaError);

    const priorSummary = session.chapters
      .slice(0, idx)
      .filter(c => c.status === 'ready')
      .map(c => `Chapter ${c.number} (${c.title}): ${c.content.slice(0, 500)}...`)
      .join('\n\n');

    // 1. Research + write (grounded where possible)
    let draft;
    try {
      draft = await gemini.generateGroundedText(buildChapterPrompt(session, chapter, priorSummary), { maxOutputTokens: 8192, temperature: 0.6 });
    } catch (aiErr) {
      console.error('[mausbot] chapter generation AI error:', aiErr.message);
      return res.status(500).json({ error: `AI failed to research and write this chapter: ${aiErr.message}` });
    }
    if (!draft?.text) return res.status(500).json({ error: 'AI returned an empty chapter. Please try again.' });

    // 2. Originality + natural-phrasing revision pass
    let revised = { revisedText: draft.text, originalityNotes: [] };
    try {
      const parsed = await gemini.generateJSON(buildRevisePrompt(draft.text), { maxOutputTokens: 8192, temperature: 0.5 });
      if (parsed.revisedText) {
        revised = {
          revisedText: parsed.revisedText,
          originalityNotes: Array.isArray(parsed.originalityNotes)
            ? parsed.originalityNotes.map(n => ({ passage: String(n.passage || '').trim(), note: String(n.note || '').trim() })).filter(n => n.passage && n.note).slice(0, 5)
            : [],
        };
      }
    } catch (reviseErr) {
      console.warn('[mausbot] originality/style pass failed, keeping raw draft:', reviseErr.message);
      // Non-fatal — the chapter still has real content even if this pass fails.
    }

    chapter.content           = revised.revisedText;
    chapter.originalityNotes  = revised.originalityNotes;
    chapter.styleRevised      = revised.revisedText !== draft.text;
    chapter.sources           = draft.sources || [];
    chapter.grounded          = !!draft.grounded;
    chapter.status            = 'ready';

    // 3. Quiz — the gate for the next chapter
    try {
      const quizParsed = await gemini.generateJSON(buildQuizPrompt(chapter), { maxOutputTokens: 2048, temperature: 0.5 });
      const questions = (Array.isArray(quizParsed.questions) ? quizParsed.questions : [])
        .filter(q => q.question && Array.isArray(q.options) && q.options.length >= 2)
        .map(q => ({
          question: q.question, options: q.options.slice(0, 4),
          correctAnswer: typeof q.correctAnswer === 'number' ? Math.min(q.correctAnswer, q.options.length - 1) : 0,
          modelAnswer: '', explanation: q.explanation || '', topic: chapter.title,
        }));
      if (questions.length > 0) {
        const quiz = await Quiz.create({
          userId: req.user.userId, title: `${session.topic} — Chapter ${chapter.number} Check`,
          subject: session.fieldOfStudy, difficulty: 'medium',
          timeLimit: Math.max(10, Math.ceil(questions.length * 1.5)),
          numQuestions: questions.length, questionType: 'mcq', questions,
          isPublic: false, isAdminCreated: false,
        });
        chapter.quizId = quiz._id;
      }
    } catch (quizErr) {
      console.warn('[mausbot] chapter quiz generation failed (chapter still saved):', quizErr.message);
    }

    session.currentChapterIndex = Math.max(session.currentChapterIndex, idx);
    await session.save();

    res.json({ success: true, chapter });
  } catch (err) {
    console.error('[mausbot] chapter generate error:', err.message);
    res.status(500).json({ error: `Unexpected error: ${err.message || 'unknown'}` });
  }
});

// ── POST /api/mausbot/:id/chapter/:index/check-quiz ─────────────────────────
// Called when the student returns from taking the chapter's quiz (reuses
// the normal /quiz/:id flow entirely, same as AI Tutor's section quizzes) —
// looks up their best recent attempt and marks the chapter unlocked if they
// passed. Non-destructive to retake: calling this again just re-checks.
router.post('/:id/chapter/:index/check-quiz', auth, async (req, res) => {
  try {
    const session = await MausbotSession.findOne({ _id: req.params.id, userId: req.user.userId });
    if (!session) return res.status(404).json({ error: 'Mausbot session not found.' });

    const idx = parseInt(req.params.index, 10);
    const chapter = session.chapters[idx];
    if (!chapter) return res.status(400).json({ error: 'Invalid chapter index.' });
    if (!chapter.quizId) return res.status(400).json({ error: 'No quiz generated for this chapter yet.' });

    const best = await QuizResult.findOne({ userId: req.user.userId, quizId: chapter.quizId }).sort({ score: -1 });
    const passed = !!best && best.score >= QUIZ_PASS_THRESHOLD;
    if (passed && !chapter.quizPassed) {
      chapter.quizPassed = true;
      await session.save();
    }

    res.json({ success: true, passed, score: best?.score ?? null, threshold: QUIZ_PASS_THRESHOLD });
  } catch (err) {
    res.status(500).json({ error: `Failed to check quiz status: ${err.message}` });
  }
});

// ── GET /api/mausbot/:id/download ───────────────────────────────────────────
// Builds the PDF fresh on every request from the already-stored chapter
// text — nothing is persisted as a binary, so there's no extra storage to
// manage and the document always reflects the latest content.
router.get('/:id/download', auth, async (req, res) => {
  try {
    const session = await MausbotSession.findOne({ _id: req.params.id, userId: req.user.userId }).lean();
    if (!session) return res.status(404).json({ error: 'Mausbot session not found.' });

    const allReady = session.chapters.every(c => c.status === 'ready');
    if (!allReady) return res.status(400).json({ error: 'Generate every chapter before downloading.' });

    const paid = await isPaidUser(req.user.userId);
    if (!paid) {
      const unpassed = session.chapters.find(c => !c.quizPassed);
      if (unpassed) return res.status(403).json({ error: `Pass the Chapter ${unpassed.number} quiz before downloading, or upgrade your plan to skip the quiz gate.`, quizGateLocked: true });
    }

    if (!session.pdfGeneratedAt) {
      await MausbotSession.updateOne({ _id: session._id }, { $set: { pdfGeneratedAt: new Date(), status: 'completed' } });
    }

    const filename = `${session.topic.replace(/[^a-z0-9]+/gi, '_').slice(0, 60) || 'project'}.pdf`;
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

    const doc = new PDFDocument({ margin: 60, size: 'A4', info: { Title: session.topic } });
    doc.pipe(res);

    // Title page
    doc.font('Helvetica-Bold').fontSize(22).text(session.topic, { align: 'center' });
    doc.moveDown(2);
    doc.font('Helvetica').fontSize(13).text(`A Project Report Submitted in the Field of ${session.fieldOfStudy}`, { align: 'center' });
    doc.moveDown(1);
    doc.fontSize(11).fillColor('#555').text(new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' }), { align: 'center' });
    doc.fillColor('#000');

    // Table of contents
    doc.addPage();
    doc.font('Helvetica-Bold').fontSize(18).text('Table of Contents');
    doc.moveDown(1);
    session.chapters.forEach(c => {
      doc.font('Helvetica').fontSize(12).text(`Chapter ${c.number}: ${c.title}`);
      doc.moveDown(0.3);
    });

    // Chapters
    const allSources = [];
    session.chapters.forEach(c => {
      doc.addPage();
      doc.font('Helvetica-Bold').fontSize(16).text(`Chapter ${c.number}: ${c.title}`);
      doc.moveDown(1);
      (c.content || '').split('\n').forEach(line => {
        const trimmed = line.trim();
        if (!trimmed) { doc.moveDown(0.5); return; }
        if (trimmed.startsWith('## ')) {
          doc.font('Helvetica-Bold').fontSize(13).text(trimmed.slice(3));
          doc.moveDown(0.4);
        } else {
          doc.font('Helvetica').fontSize(11).text(trimmed, { align: 'justify' });
          doc.moveDown(0.5);
        }
      });
      (c.sources || []).forEach(s => allSources.push(s));
    });

    // References
    const uniqueSources = Array.from(new Map(allSources.map(s => [s.url, s])).values());
    if (uniqueSources.length > 0) {
      doc.addPage();
      doc.font('Helvetica-Bold').fontSize(16).text('References');
      doc.moveDown(1);
      uniqueSources.forEach(s => {
        doc.font('Helvetica').fontSize(10).fillColor('#1a5fb4').text(s.title || s.url, { link: s.url, underline: true });
        doc.fillColor('#000').moveDown(0.4);
      });
    }

    doc.end();
  } catch (err) {
    console.error('[mausbot] download error:', err.message);
    if (!res.headersSent) res.status(500).json({ error: `Failed to generate PDF: ${err.message}` });
  }
});

module.exports = router;
