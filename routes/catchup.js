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
const { resolveUploadedFiles } = require('../utils/blobFetch');
const mammoth        = require('mammoth');

const isDocx = (file) => (file.mimetype || '').includes('word') || /\.docx?$/i.test(file.name || '');

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
  const chunks = [];
  const meta   = [];
  for (const file of files) {
    try {
      let text;
      if (isDocx(file)) {
        text = (await mammoth.extractRawText({ buffer: file.data })).value.trim();
      } else {
        if (!pdfParseAvailable()) { console.warn(`[catchup] pdf-parse unavailable, skipping ${file.name}`); continue; }
        text = (await extractPdfText(file.data)).trim();
      }
      if (!text) { console.warn(`[catchup] No text in ${file.name} (likely scanned image)`); continue; }
      chunks.push(`=== ${file.name} ===\n${text.slice(0, 40000)}`);
      meta.push({ name: file.name, textLength: text.length });
    } catch (e) {
      console.warn(`[catchup] extraction failed for ${file.name}: ${e.message}`);
    }
  }
  if (chunks.length === 0)
    throw new Error('Could not extract text from any uploaded file. PDFs may be scanned images — please paste your class notes as text instead.');
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
    let pendingDocxText = ''; // set when vision mode also has .docx uploads — merged into combinedText once batch 0's transcript comes back

    // ── Path A: pasted text (JSON body) — always text-only, no images possible ─
    if (req.body?.pastedText?.trim()) {
      combinedText  = req.body.pastedText.trim().slice(0, 100000);
      uploadedFiles = [{ name: 'Pasted notes', textLength: combinedText.length }];

    // ── Path B: files — either legacy multipart (small files, under Vercel's
    // 4.5 MB function body limit) or direct-to-blob URLs (uploaded straight
    // from the browser to Vercel Blob, so they can be much larger) ──────────
    } else if ((req.files && Object.keys(req.files).length > 0) || (Array.isArray(req.body?.docUrls) && req.body.docUrls.length > 0)) {
      let fileList;
      try {
        fileList = await resolveUploadedFiles(req, { fileField: 'docs', urlField: 'docUrls' });
      } catch (fetchErr) {
        return res.status(422).json({ error: `Could not read an uploaded file: ${fetchErr.message}` });
      }

      // Word docs are text-native and Gemini's multimodal API can't read raw
      // .docx bytes as a "file" the way it reads PDFs/images — so they always
      // go through mammoth text extraction, even when 'vision' mode is on for
      // the other uploaded files.
      const docxFiles   = fileList.filter(isDocx);
      const visionable  = fileList.filter(f => !isDocx(f));
      let docxText = '';
      if (docxFiles.length > 0) {
        try {
          const { chunks } = await extractTextFromFiles(docxFiles);
          docxText = chunks.join('\n\n');
        } catch (extractErr) {
          return res.status(422).json({ error: extractErr.message });
        }
      }

      if (extractionMode === 'vision' && visionable.length > 0) {
        visionFiles     = visionable.map(f => ({ data: f.data, mimeType: f.mimetype || 'application/pdf' }));
        pendingDocxText = docxText;
        uploadedFiles = [
          ...visionable.map(f => ({ name: f.name, textLength: f.data.length })),
          ...docxFiles.map(f => ({ name: f.name, textLength: f.data.length })),
        ];
      } else {
        // Either plain text mode, or vision mode with nothing vision-capable
        // to send (all uploads were .docx) — extract everything as text.
        try {
          const nonDocx = visionable; // in this branch these are still PDFs, just not sent to vision
          const { chunks, meta } = nonDocx.length > 0 ? await extractTextFromFiles(nonDocx) : { chunks: [], meta: [] };
          combinedText  = [...(docxText ? [docxText] : []), ...chunks].join('\n\n').slice(0, 100000);
          uploadedFiles = [...docxFiles.map(f => ({ name: f.name, textLength: f.data.length })), ...meta];
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
    // Batched (like exam/quiz generation elsewhere) so a genuinely long,
    // multi-page document gets covered in full instead of capping out at
    // whatever a single AI call's output budget allows — each batch is told
    // what's already been covered and asked to keep going, not restart.
    const SUMMARY_MAX_CONCEPTS = 60;
    const SUMMARY_BATCH_SIZE   = 15;
    const SUMMARY_MAX_BATCHES  = 4; // 4 × 15 = 60

function buildSummaryPrompt(usingVisionFiles, askFor, coveredHeadings, includeMeta) {
      // Batch 0 in vision mode reads the raw PDF directly; every later batch
      // (and all of text mode) reasons over combinedText as plain text — by
      // then combinedText already holds the transcript from batch 0, so this
      // must be re-evaluated per call, never precomputed once up front.
      const materialSection = usingVisionFiles
        ? `The class material is attached as a PDF file — read all text AND any diagrams, charts, tables, photos, or images it contains.`
        : `Class material:\n${combinedText}`;
      return `You are an expert, encouraging tutor giving a student a complete, deep walkthrough of ${subject} material — either to catch up on a class they missed, or to thoroughly understand it before an exam.

${materialSection}

TASK: Teach this student EVERY distinct point in the material, thoroughly, covering ALL pages/sections — not just the first few or the headline ideas. Go through it as if running a full one-on-one tutoring session covering the WHOLE document from start to end, so they finish genuinely understanding all of it, not just the beginning.

Do NOT reduce this to a glossary of definitions. For each topic the material raises, actively scan for and separately teach EVERY dimension the material actually contains, not just "what it is":
- Definitions — what it IS
- Types/categories/classifications
- Causes, reasons, or factors that lead to or influence it
- Processes/steps — how it happens or how it's done
- Characteristics/features/properties
- Examples or case studies mentioned
- Advantages/disadvantages, pros/cons
- Comparisons or differences from related concepts
- Effects, consequences, or implications
- Exceptions, special conditions, or rules
A single topic in the material often has SEVERAL of these dimensions covered in the text — each one is its own separate teaching point, not a footnote to the definition. If the material explains, say, the types AND the causes of something, that is at least two keyConcepts entries, not one. Not every topic has every dimension — only extract the ones actually present in the material, but never stop at just the definition when more is there.

For every point, make it stick: use a vivid analogy, a real-world comparison, or a concrete worked example ("picture it like...", "for example...", "think of it as...") alongside the plain explanation — don't just restate facts, illustrate them.

If the material contains ANY calculations, formulas, numeric worked examples, or quantitative problems, you MUST explain them in full: show every step of the working, not just the formula or the final answer — walk through it the way a tutor would at a whiteboard. Never skip over or gloss past numeric/calculation content just because it's harder to explain in prose.
${coveredHeadings.length ? `\nAlready taught so far: ${coveredHeadings.join('; ')}. Do NOT repeat these — continue with the NEXT distinct points in the material that haven't been covered yet (keep working further into the document, including later pages/sections).` : ''}

Return ONLY valid JSON (no markdown, no extra text):
{${includeMeta ? `
  "overview": "2-3 sentence plain-language introduction to what this material covers and why it matters",` : ''}
  "keyConcepts": [
    { "heading": "Specific point name — e.g. 'Types of X', 'Causes of Y', 'How Z works', not just 'X' — the heading should say WHICH dimension of the topic this entry covers", "explanation": "A genuine teaching explanation, 3-6 sentences (longer if explaining a calculation — show full working, or if listing multiple types/factors — cover each one), including a vivid analogy or worked example — as if tutoring someone who's never seen this before" }
  ]${includeMeta ? `,
  "recap": "A short, memorable summary of the most important takeaways, written as a quick revision recap"${usingVisionFiles ? `,
  "transcript": "A thorough, detailed prose transcript of EVERYTHING in the material, start to end — all text content plus a full written description of every diagram, chart, table, or image (what it shows, its labels, what it demonstrates), and the COMPLETE working for every calculation or numeric example shown, not just the final figure. Detailed enough that someone who never saw the PDF could fully understand it from this transcript alone. This will be used later to generate quiz questions and flashcards, so be comprehensive and do not cut it short."` : ''}` : ''}
}

RULES:
- keyConcepts: write up to ${askFor} — but only if the material genuinely still has that many distinct, uncovered points left. Return fewer rather than pad with filler or repeat something already taught.
- If everything in the material has already been covered in "Already taught so far", return an EMPTY keyConcepts array — do NOT write a wrap-up/completion entry like "all material covered", that is not a real teaching point
- Every explanation must include an illustrative analogy or example, not just a restated fact
- Never collapse "what it is" + "its types" + "its causes" + "how it works" into one entry just to save space — split them into separate keyConcepts the way the material itself separates them
- Order them the way a tutor would actually teach them, building on what came before`;
    }

    let allConcepts = [];
    let overview = '', recap = '';
    let coveredHeadings = [];
    try {
      for (let batch = 0; batch < SUMMARY_MAX_BATCHES && allConcepts.length < SUMMARY_MAX_CONCEPTS; batch++) {
        const askFor = Math.min(SUMMARY_BATCH_SIZE, SUMMARY_MAX_CONCEPTS - allConcepts.length);
        const includeMeta = batch === 0;
        // Only the FIRST batch (when there are actual vision-capable files —
        // .docx never counts, even if the user had 'vision' toggled on)
        // needs the raw files; once we have a text transcript back, every
        // later batch just reasons over that text, same as text-mode uploads
        // always did.
        const usingVisionFiles = !!visionFiles && batch === 0;
        const prompt = buildSummaryPrompt(usingVisionFiles, askFor, coveredHeadings, includeMeta);

        const parsed = usingVisionFiles
          ? await gemini.generateJSONFromFiles(prompt, visionFiles, { maxOutputTokens: 8192, temperature: 0.5 })
          : await gemini.generateJSON(prompt, { maxOutputTokens: 8192, temperature: 0.5 });

        if (includeMeta) {
          overview = String(parsed.overview || '').trim();
          recap    = String(parsed.recap || '').trim();
          if (visionFiles) {
            const transcript = String(parsed.transcript || '').trim();
            if (!transcript) throw new Error('AI could not read this PDF — try the "Text Only" option or paste the notes instead.');
            combinedText = [transcript, pendingDocxText].filter(Boolean).join('\n\n').slice(0, 100000);
          }
        }

        const batchConcepts = Array.isArray(parsed.keyConcepts)
          ? parsed.keyConcepts
              .map(c => ({ heading: String(c.heading || '').trim(), explanation: String(c.explanation || '').trim() }))
              .filter(c => c.heading && c.explanation)
          : [];
        if (batchConcepts.length === 0) break; // material exhausted
        allConcepts.push(...batchConcepts);
        coveredHeadings.push(...batchConcepts.map(c => c.heading));
        if (batch > 0 && batchConcepts.length < askFor * 0.5) break;
      }
    } catch (aiErr) {
      console.error('[catchup] summary AI error:', aiErr.message);
      if (allConcepts.length === 0)
        return res.status(500).json({ error: `AI failed to summarise this material: ${aiErr.message}` });
      // Keep whatever earlier batches already produced rather than losing it all
    }

    const summary = {
      overview,
      keyConcepts: allConcepts.slice(0, SUMMARY_MAX_CONCEPTS),
      recap,
    };
    if (!summary.overview && summary.keyConcepts.length === 0)
      return res.status(500).json({ error: 'AI returned an empty summary — try again.' });

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
${session.combinedText.slice(0, 40000)}
${coveredTopics.length ? `\nQuestions already written covering: ${coveredTopics.join('; ')}. Do NOT repeat these — cover different sub-topics or angles still untested.` : ''}

RULES:
- Each question has exactly 4 options (A, B, C, D), one correct answer, plausible distractors
- correctAnswer is the 0-based index of the correct option
- Cover the material broadly and in depth — identify every distinct concept or section and test it, don't consolidate everything into a handful of broad questions
- If a question involves a calculation, the "explanation" MUST show the full step-by-step working that arrives at the correct option, not just state the formula or restate the answer

Return ONLY valid JSON:
{
  "questions": [
    { "question": "...", "options": ["A","B","C","D"], "correctAnswer": 0, "workingScratchpad": "for numeric/calculation questions: work the answer out step by step here AND independently recompute it once more to confirm — messy work-in-progress is fine in THIS field only, it is never shown to the student", "explanation": "the clean, final, confident explanation shown to the student — for calculation questions, show the full working leading to the answer; never mention the scratchpad or any earlier mistake", "topic": "specific sub-topic tested" }
  ]
}
CRITICAL for accuracy: for every numeric/calculation question, use "workingScratchpad" to verify the answer twice before settling on the 4 options — make sure exactly one option matches your verified answer exactly, and "explanation" must be derived strictly from that verified working, with zero hesitation or self-correction visible in it.
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

${session.combinedText.slice(0, 40000)}
${session.summary?.overview ? `\nSummary already given to the student: ${session.summary.overview}` : ''}
${historyText ? `\nConversation so far:\n${historyText}\n` : ''}
Student's new message: "${message.trim()}"

Answer their question clearly and helpfully, drawing only on the material above. If they seem to misunderstand something, gently correct it. If the question involves a calculation or numeric working, show the full step-by-step working, not just the final answer. Keep replies conversational, under 120 words (longer if walking through a calculation), no markdown headers.

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
${session.combinedText.slice(0, 40000)}`;

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
