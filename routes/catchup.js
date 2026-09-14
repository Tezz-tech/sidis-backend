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

    // 'vision' sends the raw PDF(s) straight to Gemini so diagrams, charts,
    // and images are actually read, not just whatever text pdf-parse could
    // pull out. Defaults to 'text' so older cached frontend bundles (which
    // never send this field) keep working exactly as before.
    const extractionMode = req.body?.extractionMode === 'vision' ? 'vision' : 'text';

    let uploadedFiles = [];
    let combinedText  = '';
    let visionFiles   = null; // [{ data: Buffer, mimeType }] — only set in vision mode

    // ── Path A: pasted text (JSON body) — always text-only, no images possible ─
    if (req.body?.pastedText?.trim()) {
      combinedText  = req.body.pastedText.trim().slice(0, 20000);
      uploadedFiles = [{ name: 'Pasted notes', textLength: combinedText.length }];

    // ── Path B: file upload (multipart) ──────────────────────────────────────
    } else if (req.files && Object.keys(req.files).length > 0) {
      const rawFiles = req.files.docs || Object.values(req.files)[0];
      const fileList = Array.isArray(rawFiles) ? rawFiles : [rawFiles];

      if (extractionMode === 'vision') {
        visionFiles   = fileList.map(f => ({ data: f.data, mimeType: f.mimetype || 'application/pdf' }));
        uploadedFiles = fileList.map(f => ({ name: f.name, textLength: f.data.length }));
      } else {
        try {
          const { chunks, meta } = await extractTextFromFiles(fileList);
          combinedText  = chunks.join('\n\n').slice(0, 20000);
          uploadedFiles = meta;
        } catch (extractErr) {
          return res.status(422).json({ error: extractErr.message });
        }
      }
    } else {
      return res.status(400).json({ error: 'Upload class documents (field: docs) or paste your notes as text.' });
    }

    if (extractionMode === 'text' && !combinedText.trim())
      return res.status(422).json({ error: 'No usable text found. Please check your files or paste the class notes directly.' });

    // ── AI: teach the material back to the student ────────────────────────────
    // Vision mode also asks for a full prose transcript (including describing
    // diagrams/charts in words) — the later generate-quiz/generate-flashcards
    // steps are separate requests with no file re-upload, so they read
    // session.combinedText same as always; this is what makes that keep
    // working without needing the original files again.
    const materialSection = extractionMode === 'vision'
      ? `The class material is attached as a PDF file — read all text AND any diagrams, charts, tables, photos, or images it contains.`
      : `Class material:\n${combinedText}`;

    const summaryPrompt = `You are an expert, encouraging tutor giving a student a complete, deep walkthrough of ${subject} material — either to catch up on a class they missed, or to thoroughly understand it before an exam.

${materialSection}

TASK: Teach this student EVERY distinct point in the material, thoroughly — not just the 3-4 headline ideas. Go through it as if running a full one-on-one tutoring session covering the whole document, so they finish genuinely understanding it, not just aware of it exists.

For every point, make it stick: use a vivid analogy, a real-world comparison, or a concrete worked example ("picture it like...", "for example...", "think of it as...") alongside the plain explanation — don't just restate facts, illustrate them.

Return ONLY valid JSON (no markdown, no extra text):
{
  "overview": "2-3 sentence plain-language introduction to what this material covers and why it matters",
  "keyConcepts": [
    { "heading": "Concept name", "explanation": "A genuine teaching explanation, 3-6 sentences, including a vivid analogy or worked example — as if tutoring someone who's never seen this before" }
  ],
  "recap": "A short, memorable summary of the most important takeaways, written as a quick revision recap"${extractionMode === 'vision' ? `,
  "transcript": "A thorough, detailed prose transcript of everything in the material — all text content plus a full written description of every diagram, chart, table, or image (what it shows, its labels, and what it demonstrates) — detailed enough that someone who never saw the PDF could fully understand it from this transcript alone. This will be used later to generate quiz questions and flashcards, so be comprehensive."` : ''}
}

RULES:
- keyConcepts: cover EVERY distinct point/idea in the material — as many entries as genuinely needed (typically 10-25 for real course material), not a small curated highlight reel. Don't pad by splitting one idea into two just to inflate the count, and don't skip real content to stay short.
- Every explanation must include an illustrative analogy or example, not just a restated fact
- Order them the way a tutor would actually teach them, building on what came before`;

    let summary;
    try {
      const parsed = extractionMode === 'vision'
        ? await gemini.generateJSONFromFiles(summaryPrompt, visionFiles, { maxOutputTokens: 8192, temperature: 0.5 })
        : await gemini.generateJSON(summaryPrompt, { maxOutputTokens: 8192, temperature: 0.5 });
      const keyConcepts = Array.isArray(parsed.keyConcepts)
        ? parsed.keyConcepts
            .map(c => ({ heading: String(c.heading || '').trim(), explanation: String(c.explanation || '').trim() }))
            .filter(c => c.heading && c.explanation)
            .slice(0, 25)
        : [];
      summary = {
        overview: String(parsed.overview || '').trim(),
        keyConcepts,
        recap:    String(parsed.recap || '').trim(),
      };
      if (!summary.overview && keyConcepts.length === 0)
        throw new Error('AI returned an empty summary — try again.');

      if (extractionMode === 'vision') {
        combinedText = String(parsed.transcript || '').trim().slice(0, 20000);
        if (!combinedText) throw new Error('AI could not read this PDF — try the "Text Only" option or paste the notes instead.');
      }
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

// Batched MCQ generation so a catch-up quiz can genuinely run to 50+
// questions instead of a fixed handful — mirrors exammode.js's
// generateExamQuiz/buildExamPrompt pattern. Also reused by
// /:id/generate-more-questions to extend an existing quiz.
const QUIZ_MAX_QUESTIONS = 50;
const QUIZ_BATCH_SIZE    = 20;
const QUIZ_MAX_BATCHES   = 3; // 3 × 20 = 60, comfortably covers the 50 target
const ADD_QUESTIONS_MAX_PER_CALL = 40;

function buildCatchupQuizPrompt(session, askFor, coveredTopics) {
  return `You are an expert exam question creator for ${session.subject}.
Based ONLY on the class material below, generate multiple-choice questions to thoroughly check the student's understanding of what they missed.

Class Material:
${session.combinedText.slice(0, 12000)}
${coveredTopics.length ? `\nQuestions already written covering: ${coveredTopics.join('; ')}. Do NOT repeat these — cover different sub-topics or angles still untested.` : ''}

RULES:
- Each question has exactly 4 options (A, B, C, D), one correct answer, plausible distractors
- correctAnswer is the 0-based index of the correct option
- Include a brief explanation for the correct answer
- Cover the material broadly and in depth — identify every distinct concept or section and test it, don't consolidate everything into a handful of broad questions

Return ONLY valid JSON:
{
  "questions": [
    { "question": "...", "options": ["A","B","C","D"], "correctAnswer": 0, "explanation": "...", "topic": "specific sub-topic tested" }
  ]
}
Write up to ${askFor} questions — but only if the material genuinely supports that many distinct, non-repetitive questions. Return fewer rather than pad with filler.`;
}

function sanitiseCatchupQuestions(raw) {
  return raw
    .filter(q => q.question && Array.isArray(q.options) && q.options.length >= 2)
    .map(q => ({
      question:      q.question,
      options:       q.options.slice(0, 4),
      correctAnswer: typeof q.correctAnswer === 'number' ? Math.min(q.correctAnswer, q.options.length - 1) : 0,
      modelAnswer:   '',
      explanation:   q.explanation || '',
      topic:         q.topic || '',
    }));
}

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

    let allQuestions  = [];
    let coveredTopics = [];
    for (let batch = 0; batch < QUIZ_MAX_BATCHES && allQuestions.length < QUIZ_MAX_QUESTIONS; batch++) {
      const askFor = Math.min(QUIZ_BATCH_SIZE, QUIZ_MAX_QUESTIONS - allQuestions.length);
      const quizPrompt = buildCatchupQuizPrompt(session, askFor, coveredTopics);

      let batchRaw;
      try {
        const parsed = await gemini.generateJSON(quizPrompt, { maxOutputTokens: 8192, temperature: 0.5 });
        batchRaw = Array.isArray(parsed.questions) ? parsed.questions : [];
      } catch (aiErr) {
        console.error('[catchup] quiz AI error:', aiErr.message);
        if (allQuestions.length > 0) break;
        return res.status(503).json({ error: 'AI is temporarily unavailable. Please try generating the quiz again in a moment.' });
      }
      if (batchRaw.length === 0) break;
      allQuestions.push(...batchRaw);
      coveredTopics.push(...batchRaw.map(q => q.topic).filter(Boolean));
      if (batch > 0 && batchRaw.length < askFor * 0.5) break;
    }

    const quizQuestions = sanitiseCatchupQuestions(allQuestions).slice(0, QUIZ_MAX_QUESTIONS);

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

// ── POST /api/catchup/:id/generate-more-questions ─────────────────────────────
// Body: { count }. Appends more AI-generated questions to the session's
// existing catch-up quiz instead of it staying capped at the first batch —
// same "keep going indefinitely" pattern as Exam Mode's add-questions route.
router.post('/:id/generate-more-questions', auth, async (req, res) => {
  try {
    if (!gemini.ready)
      return res.status(503).json({ error: 'AI service is temporarily unavailable. Please try again shortly.' });

    const session = await CatchUpSession.findOne({ _id: req.params.id, userId: req.user.userId });
    if (!session)        return res.status(404).json({ error: 'Catch-up session not found.' });
    if (!session.quizId) return res.status(400).json({ error: 'Generate the quiz first before adding more questions.' });

    const quiz = await Quiz.findOne({ _id: session.quizId, userId: req.user.userId });
    if (!quiz) return res.status(404).json({ error: 'Catch-up quiz not found.' });

    const requestedCount = parseInt(req.body?.count, 10);
    if (!Number.isFinite(requestedCount) || requestedCount < 1)
      return res.status(400).json({ error: 'Specify how many more questions you want (count >= 1).' });

    const targetCount   = Math.min(requestedCount, ADD_QUESTIONS_MAX_PER_CALL);
    const coveredTopics = (quiz.questions || []).map(q => q.topic).filter(Boolean);

    let newRaw = [];
    for (let batch = 0; batch < QUIZ_MAX_BATCHES && newRaw.length < targetCount; batch++) {
      const askFor = Math.min(QUIZ_BATCH_SIZE, targetCount - newRaw.length);
      const quizPrompt = buildCatchupQuizPrompt(session, askFor, [...coveredTopics, ...newRaw.map(q => q.topic).filter(Boolean)]);

      let batchRaw;
      try {
        const parsed = await gemini.generateJSON(quizPrompt, { maxOutputTokens: 8192, temperature: 0.5 });
        batchRaw = Array.isArray(parsed.questions) ? parsed.questions : [];
      } catch (aiErr) {
        console.error('[catchup] generate-more-questions AI error:', aiErr.message);
        if (newRaw.length > 0) break;
        return res.status(500).json({ error: `AI failed to generate more questions: ${aiErr.message}` });
      }
      if (batchRaw.length === 0) break;
      newRaw.push(...batchRaw);
      if (batch > 0 && batchRaw.length < askFor * 0.5) break;
    }

    const newQuestions = sanitiseCatchupQuestions(newRaw).slice(0, targetCount);
    if (newQuestions.length === 0)
      return res.status(500).json({ error: 'AI could not generate further distinct questions from this material — it may already be thoroughly covered.' });

    quiz.questions.push(...newQuestions);
    quiz.numQuestions = quiz.questions.length;
    quiz.timeLimit     = Math.max(quiz.timeLimit || 0, Math.ceil(quiz.questions.length * 2));
    await quiz.save();

    res.json({ success: true, quizId: quiz._id, addedCount: newQuestions.length, numQuestions: quiz.numQuestions });
  } catch (err) {
    console.error('[catchup] generate-more-questions error:', err.message);
    res.status(500).json({ error: `Failed to add more questions: ${err.message || 'unknown'}` });
  }
});

// ── POST /api/catchup/:id/chat ─────────────────────────────────────────────────
// Conversational AI tutor grounded in this session's material — lets the
// student ask follow-up questions about what they missed, same pattern as
// Exam Mode's Q&A phase but without any "ready" gate (Catch-Up has no exam
// phase to unlock — it's just supplementary help alongside the quiz).
router.post('/:id/chat', auth, async (req, res) => {
  try {
    if (!gemini.ready)
      return res.status(503).json({ error: 'AI service is temporarily unavailable. Please try again shortly.' });

    const { message, history } = req.body;
    if (!message || !message.trim()) return res.status(400).json({ error: 'message is required' });

    const session = await CatchUpSession.findOne({ _id: req.params.id, userId: req.user.userId });
    if (!session) return res.status(404).json({ error: 'Catch-up session not found.' });

    const historyText = Array.isArray(history)
      ? history.slice(-6).map(h => `${h.role === 'user' ? 'Student' : 'Tutor'}: ${h.content}`).join('\n')
      : '';

    const prompt = `You are a patient, expert tutor helping a student catch up on ${session.subject} material they missed, grounded in this content:

${session.combinedText.slice(0, 7000)}
${session.summary?.overview ? `\nSummary already given to the student: ${session.summary.overview}` : ''}
${historyText ? `\nConversation so far:\n${historyText}\n` : ''}
Student's new message: "${message.trim()}"

Answer their question clearly and helpfully, drawing only on the material above. If they seem to misunderstand something, gently correct it. Keep replies conversational, under 120 words, no markdown headers.

Return ONLY valid JSON: { "reply": "..." }`;

    let reply;
    try {
      const parsed = await gemini.generateJSON(prompt, { maxOutputTokens: 800, temperature: 0.7 });
      reply = parsed.reply;
    } catch (aiErr) {
      console.error('[catchup] chat AI error:', aiErr.message);
      return res.status(500).json({ error: 'AI failed to respond. Try again.' });
    }
    if (!reply) return res.status(500).json({ error: 'AI returned an empty response.' });

    res.json({ success: true, reply });
  } catch (err) {
    console.error('[catchup] chat error:', err.message);
    res.status(500).json({ error: 'Server error' });
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
