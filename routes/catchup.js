// routes/catchup.js — "Study Catch-Up": upload material from a missed class,
// AI teaches it back (summary), then generates a real Quiz and FlashcardSet
// from the same material so the student can check their understanding.
// Free on every plan, throttled by the same shared monthly AI-generation
// quota used by /quizzes/generate-quiz (see the quota check below).
const express        = require('express');
const router         = express.Router();
const auth           = require('../middlewares/auth');
const CatchUpSession = require('../models/CatchUpSession');
const Quiz           = require('../models/Quiz');
const FlashcardSet   = require('../models/FlashcardSet');
const { gemini }     = require('../utils/ai');
const { getUserPlan, getPlanFeatures } = require('../utils/subscription');
const { extractPdfText, pdfParseAvailable } = require('../utils/pdfExtract');

// ── Shared monthly quota — same check/counter as POST /quizzes/generate-quiz,
// so a catch-up session and a manually-created AI quiz draw from the same
// pool. Free/exam_mode users get 5/month; every paid plan is unlimited.
async function checkAndReportQuota(userId) {
  const plan     = await getUserPlan(userId);
  const features = getPlanFeatures(plan);
  if (features.unlimitedQuizzes) return null;

  const monthStart = new Date();
  monthStart.setDate(1);
  monthStart.setHours(0, 0, 0, 0);
  const count = await Quiz.countDocuments({
    userId, isAdminCreated: false, createdAt: { $gte: monthStart },
  });
  if (count >= features.aiQuizzesPerMonth) {
    return {
      error:    'monthly_limit_reached',
      message:  `You've used all ${features.aiQuizzesPerMonth} AI generations for this month. Upgrade your plan for unlimited catch-up sessions and quizzes.`,
      limit:    features.aiQuizzesPerMonth,
      used:     count,
      planName: plan === 'free' ? 'Free' : 'Exam Mode',
    };
  }
  return null;
}

async function extractTextFromFiles(files) {
  if (!pdfParseAvailable()) throw new Error('PDF parser is not available on this server. Please paste your class notes as text instead.');
  const chunks = [];
  const meta   = [];
  for (const file of files) {
    try {
      const text = (await extractPdfText(file.data)).trim();
      if (!text) { console.warn(`[catchup] No text in ${file.name} (likely scanned image)`); continue; }
      chunks.push(`=== ${file.name} ===\n${text.slice(0, 8000)}`);
      meta.push({ name: file.name, textLength: text.length });
    } catch (e) {
      console.warn(`[catchup] pdf-parse failed for ${file.name}: ${e.message}`);
    }
  }
  if (chunks.length === 0)
    throw new Error('Could not extract text from any uploaded file. The PDFs may be scanned images — please paste your class notes as text instead.');
  return { chunks, meta };
}

// ── POST /api/catchup/create ──────────────────────────────────────────────────
// Accepts EITHER: multipart (fields: title, subject; files: docs) OR
// JSON: { title, subject, pastedText }
router.post('/create', auth, async (req, res) => {
  try {
    if (!gemini.ready)
      return res.status(503).json({ error: 'AI service is temporarily unavailable. Please try again shortly.' });

    const quotaError = await checkAndReportQuota(req.user.userId);
    if (quotaError) return res.status(403).json(quotaError);

    const title   = (req.body?.title   || '').trim();
    const subject = (req.body?.subject || '').trim();
    if (!title)   return res.status(400).json({ error: 'A title for this catch-up session is required.' });
    if (!subject) return res.status(400).json({ error: 'Subject is required.' });

    let uploadedFiles = [];
    let combinedText  = '';

    // ── Path A: pasted text (JSON body) ──────────────────────────────────────
    if (req.body?.pastedText?.trim()) {
      combinedText  = req.body.pastedText.trim().slice(0, 20000);
      uploadedFiles = [{ name: 'Pasted notes', textLength: combinedText.length }];

    // ── Path B: file upload (multipart) ──────────────────────────────────────
    } else if (req.files && Object.keys(req.files).length > 0) {
      const rawFiles = req.files.docs || Object.values(req.files)[0];
      const fileList = Array.isArray(rawFiles) ? rawFiles : [rawFiles];
      try {
        const { chunks, meta } = await extractTextFromFiles(fileList);
        combinedText  = chunks.join('\n\n').slice(0, 20000);
        uploadedFiles = meta;
      } catch (extractErr) {
        return res.status(422).json({ error: extractErr.message });
      }
    } else {
      return res.status(400).json({ error: 'Upload class documents (field: docs) or paste your notes as text.' });
    }

    if (!combinedText.trim())
      return res.status(422).json({ error: 'No usable text found. Please check your files or paste the class notes directly.' });

    // ── AI: teach the material back to the student ────────────────────────────
    const summaryPrompt = `You are an expert, encouraging tutor helping a student catch up on a ${subject} class they missed.

Class material:
${combinedText}

TASK: Teach this student the material as if they weren't there — clear, plain language, genuinely explanatory.

Return ONLY valid JSON (no markdown, no extra text):
{
  "overview": "2-3 sentence plain-language introduction to what this class covered and why it matters",
  "keyConcepts": [
    { "heading": "Concept name", "explanation": "Clear explanation in plain language, 2-4 sentences, as if teaching someone who's never seen this before" }
  ],
  "recap": "A short, memorable summary of the most important takeaways, written as a quick revision recap"
}

RULES:
- keyConcepts: 3 to 6 entries, covering the actual distinct concepts in the material
- Explanations must genuinely teach the concept, not just restate the heading
- Keep it focused and readable — no filler`;

    let summary;
    try {
      const parsed = await gemini.generateJSON(summaryPrompt, { maxOutputTokens: 2048, temperature: 0.5 });
      const keyConcepts = Array.isArray(parsed.keyConcepts)
        ? parsed.keyConcepts
            .map(c => ({ heading: String(c.heading || '').trim(), explanation: String(c.explanation || '').trim() }))
            .filter(c => c.heading && c.explanation)
            .slice(0, 8)
        : [];
      summary = {
        overview: String(parsed.overview || '').trim(),
        keyConcepts,
        recap:    String(parsed.recap || '').trim(),
      };
      if (!summary.overview && keyConcepts.length === 0)
        throw new Error('AI returned an empty summary — try again.');
    } catch (aiErr) {
      console.error('[catchup] summary AI error:', aiErr.message);
      return res.status(500).json({ error: `AI failed to summarise this material: ${aiErr.message}` });
    }

    const session = await CatchUpSession.create({
      userId: req.user.userId,
      title,
      subject,
      uploadedFiles,
      combinedText,
      summary,
    });

    res.json({
      success:   true,
      id:        session._id,
      title:     session.title,
      subject:   session.subject,
      summary:   session.summary,
      filesProcessed: uploadedFiles.length,
    });
  } catch (err) {
    console.error('[catchup] /create unexpected error:', err.message);
    res.status(500).json({ error: `Unexpected error: ${err.message || 'unknown'}` });
  }
});

// ── POST /api/catchup/:id/generate-quiz ───────────────────────────────────────
router.post('/:id/generate-quiz', auth, async (req, res) => {
  try {
    if (!gemini.ready)
      return res.status(503).json({ error: 'AI service is temporarily unavailable. Please try again shortly.' });

    const session = await CatchUpSession.findOne({ _id: req.params.id, userId: req.user.userId });
    if (!session) return res.status(404).json({ error: 'Catch-up session not found.' });

    if (session.quizId) {
      return res.json({ success: true, quizId: session.quizId, quizTitle: session.quizTitle, alreadyGenerated: true });
    }

    const quotaError = await checkAndReportQuota(req.user.userId);
    if (quotaError) return res.status(403).json(quotaError);

    const quizPrompt = `You are an expert exam question creator for ${session.subject}.
Based ONLY on the class material below, generate exactly 8 multiple-choice questions to check the student's understanding of what they missed.

Class Material:
${session.combinedText.slice(0, 7000)}

RULES:
- Each question has exactly 4 options (A, B, C, D), one correct answer, plausible distractors
- correctAnswer is the 0-based index of the correct option
- Include a brief explanation for the correct answer
- Cover the material broadly, not just one section

Return ONLY valid JSON:
{
  "questions": [
    { "question": "...", "options": ["A","B","C","D"], "correctAnswer": 0, "explanation": "...", "topic": "specific sub-topic tested" }
  ]
}`;

    let generatedQuestions = [];
    try {
      const parsed = await gemini.generateJSON(quizPrompt, { maxOutputTokens: 4096, temperature: 0.5 });
      if (Array.isArray(parsed.questions)) generatedQuestions = parsed.questions;
    } catch (aiErr) {
      console.error('[catchup] quiz AI error:', aiErr.message);
      return res.status(503).json({ error: 'AI is temporarily unavailable. Please try generating the quiz again in a moment.' });
    }

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

    if (quizQuestions.length === 0)
      return res.status(500).json({ error: 'AI returned no usable questions. Please try again.' });

    const quizTitle = `${session.title} — Catch-Up Quiz`;
    const quiz = await Quiz.create({
      userId:         req.user.userId,
      title:          quizTitle,
      subject:        session.subject,
      difficulty:     'medium',
      timeLimit:      Math.max(15, Math.ceil(quizQuestions.length * 2)),
      numQuestions:   quizQuestions.length,
      questionType:   'mcq',
      questions:      quizQuestions,
      isPublic:       false,
      isAdminCreated: false,
    });

    session.quizId    = quiz._id;
    session.quizTitle = quiz.title;
    session.updatedAt = new Date();
    await session.save();

    res.json({ success: true, quizId: quiz._id, quizTitle: quiz.title, numQuestions: quiz.numQuestions });
  } catch (err) {
    console.error('[catchup] generate-quiz error:', err.message);
    res.status(500).json({ error: `Quiz generation failed: ${err.message || 'unknown'}` });
  }
});

// ── POST /api/catchup/:id/generate-flashcards ─────────────────────────────────
router.post('/:id/generate-flashcards', auth, async (req, res) => {
  try {
    if (!gemini.ready)
      return res.status(503).json({ error: 'AI service is temporarily unavailable. Please try again shortly.' });

    const session = await CatchUpSession.findOne({ _id: req.params.id, userId: req.user.userId });
    if (!session) return res.status(404).json({ error: 'Catch-up session not found.' });

    if (session.flashcardSetId) {
      return res.json({ success: true, flashcardSetId: session.flashcardSetId, flashcardSetTitle: session.flashcardSetTitle, alreadyGenerated: true });
    }

    const cardsPrompt = `You are an expert flashcard creator. Generate 10 high-quality flashcards from this content.
Subject: ${session.subject}
Return ONLY a valid JSON array, no markdown:
[{"question":"...","answer":"...","topic":"the specific sub-topic this card tests, e.g. 'Depreciation' not just '${session.subject}'"}]
Content:
${session.combinedText.slice(0, 15000)}`;

    let cards = [];
    try {
      const parsed = await gemini.generateJSON(cardsPrompt, { maxOutputTokens: 2048, temperature: 0.5 });
      cards = Array.isArray(parsed) ? parsed : parsed?.cards || parsed?.flashcards || [];
    } catch (aiErr) {
      console.error('[catchup] flashcards AI error:', aiErr.message);
      return res.status(503).json({ error: 'AI is temporarily unavailable. Please try generating flashcards again in a moment.' });
    }

    cards = cards
      .map(c => ({ question: (c.question || '').trim(), answer: (c.answer || '').trim(), topic: (c.topic || '').trim() }))
      .filter(c => c.question && c.answer);

    if (cards.length === 0)
      return res.status(500).json({ error: 'AI returned no usable flashcards. Please try again.' });

    const setTitle = `${session.title} — Catch-Up Flashcards`;
    const flashcardSet = await FlashcardSet.create({
      userId:  req.user.userId,
      title:   setTitle,
      subject: session.subject,
      cards:   cards.map(c => ({ question: c.question, answer: c.answer, masteryLevel: 0, topic: c.topic })),
      isPublic: false,
    });

    session.flashcardSetId    = flashcardSet._id;
    session.flashcardSetTitle = flashcardSet.title;
    session.updatedAt         = new Date();
    await session.save();

    res.json({ success: true, flashcardSetId: flashcardSet._id, flashcardSetTitle: flashcardSet.title, count: cards.length });
  } catch (err) {
    console.error('[catchup] generate-flashcards error:', err.message);
    res.status(500).json({ error: `Flashcard generation failed: ${err.message || 'unknown'}` });
  }
});

// ── GET /api/catchup/sessions ──────────────────────────────────────────────────
router.get('/sessions', auth, async (req, res) => {
  try {
    const sessions = await CatchUpSession.find({ userId: req.user.userId })
      .select('-combinedText').sort({ createdAt: -1 }).lean();
    res.json({ success: true, sessions });
  } catch (err) {
    res.status(500).json({ error: `Failed to fetch catch-up sessions: ${err.message}` });
  }
});

// ── GET /api/catchup/:id ────────────────────────────────────────────────────────
router.get('/:id', auth, async (req, res) => {
  try {
    const session = await CatchUpSession
      .findOne({ _id: req.params.id, userId: req.user.userId })
      .select('-combinedText').lean();
    if (!session) return res.status(404).json({ error: 'Catch-up session not found.' });
    res.json({ success: true, session });
  } catch (err) {
    res.status(500).json({ error: `Failed to fetch catch-up session: ${err.message}` });
  }
});

// ── DELETE /api/catchup/:id ─────────────────────────────────────────────────────
// Deletes only the session record — any Quiz/FlashcardSet already generated
// from it stay, reachable via My Quizzes / My Flashcards regardless.
router.delete('/:id', auth, async (req, res) => {
  try {
    await CatchUpSession.deleteOne({ _id: req.params.id, userId: req.user.userId });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: `Failed to delete: ${err.message}` });
  }
});

module.exports = router;
