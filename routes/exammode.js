// routes/exammode.js — standalone "Exam Mode": upload course material, AI
// walks the student through it step by step, then a conversational Q&A phase
// checks understanding, then a real timed Quiz gets generated and graded
// against the material — with pass/fail feedback and retake advice. Gated
// behind the Exam Mode plan and above (see requireExamModeAccess below).
const express         = require('express');
const router          = express.Router();
const auth            = require('../middlewares/auth');
const ExamModeSession = require('../models/ExamModeSession');
const Quiz            = require('../models/Quiz');
const QuizResult       = require('../models/QuizResult');
const { gemini }      = require('../utils/ai');
const { getUserPlan, getPlanFeatures } = require('../utils/subscription');
const { extractPdfText, pdfParseAvailable } = require('../utils/pdfExtract');

// Only Exam Mode and plans that already include it (see PLAN_FEATURES.examMode
// in utils/subscription.js — mirrors studyJourney's exact distribution).
async function requireExamModeAccess(req, res, next) {
  try {
    const plan     = await getUserPlan(req.user.userId);
    const features = getPlanFeatures(plan);
    if (!features.examMode) {
      return res.status(403).json({
        error:    'plan_required',
        message:  'Exam Mode is available on the Exam Mode plan and above.',
        required: 'exam_mode',
      });
    }
    next();
  } catch (err) {
    next(); // fail open so a DB error doesn't permanently lock users out
  }
}

// ── Shared monthly quota — same check/counter as POST /quizzes/generate-quiz
// and Study Catch-Up, so an exam-mode session and a manually-created AI quiz
// draw from the same pool. Only really bites free-tier-equivalent counting
// since access already requires a plan with unlimitedQuizzes true or the
// exam_mode plan's own 5/month allowance.
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
      message:  `You've used all ${features.aiQuizzesPerMonth} AI generations for this month. Upgrade your plan for unlimited Exam Mode sessions.`,
      limit:    features.aiQuizzesPerMonth,
      used:     count,
      planName: 'Exam Mode',
    };
  }
  return null;
}

async function extractTextFromFiles(files) {
  if (!pdfParseAvailable()) throw new Error('PDF parser is not available on this server. Please paste your material as text instead.');
  const chunks = [];
  const meta   = [];
  for (const file of files) {
    try {
      const text = (await extractPdfText(file.data)).trim();
      if (!text) { console.warn(`[exammode] No text in ${file.name} (likely scanned image)`); continue; }
      chunks.push(`=== ${file.name} ===\n${text.slice(0, 40000)}`);
      meta.push({ name: file.name, textLength: text.length });
    } catch (e) {
      console.warn(`[exammode] pdf-parse failed for ${file.name}: ${e.message}`);
    }
  }
  if (chunks.length === 0)
    throw new Error('Could not extract text from any uploaded file. The PDFs may be scanned images — please paste your material as text instead.');
  return { chunks, meta };
}

// Generates a fresh mixed MCQ+essay exam from a session's stored material —
// shared by both /generate-exam (first attempt) and /retake (regenerates new
// questions rather than reusing the identical quiz).
const MAX_EXAM_QUESTIONS = 60;
const EXAM_BATCH_SIZE    = 20;
const MAX_EXAM_BATCHES   = 3; // 3 × 20 = 60 — kept low since the whole
// request has to fit inside Vercel's 60s function timeout; fewer, larger
// batches beats more, smaller ones for total round-trip latency, and 20
// questions per call still comfortably fits the 8192-token output budget.

function buildExamPrompt(session, askFor, coveredTopics) {
  const material  = session.combinedText.slice(0, 40000);
  const qaContext = session.qaSummary ? session.qaSummary.slice(0, 3000) : '';
  const pastQuestions = session.pastQuestionsText ? session.pastQuestionsText.slice(0, 20000) : '';
  return `You are a ruthless, expert examiner setting an EXTREMELY HARD, in-depth, COMPREHENSIVE exam paper for ${session.subject} — the kind only a student with genuine mastery of the entire material can pass. Mix multiple-choice (objective) and short-answer/essay (theory) questions, in whatever proportion is conventional for this subject.

Base every question ONLY on the material below. Go deep: test application, edge cases, and understanding of WHY — not simple recall of facts stated verbatim. Avoid questions answerable by pattern-matching a sentence from the text; make the student actually reason.

Coverage matters as much as difficulty: identify every distinct concept, section, or sub-topic in the material and write at least one substantial question on each — don't consolidate multiple distinct ideas into a handful of broad questions just to keep the count low. For material covering several distinct topics, a properly thorough exam typically runs well into the double digits, not just a handful of questions.

If the material contains ANY calculations, formulas, or numeric worked examples, you MUST write questions that test them properly, and show the FULL step-by-step working in the answer — never skip, simplify away, or ignore calculation-based content just because it's harder to write a question about than prose facts.

Class material:
${material}
${pastQuestions ? `\nReal past exam questions for this subject were also provided below — study them closely and use them to forecast what's actually likely to be asked: match their real difficulty, phrasing style, question format, and which topics they emphasize most. Do not copy them verbatim, but let them shape the style and focus of the new exam.\n\n${pastQuestions}\n` : ''}
${qaContext ? `\nDuring study, the student and their tutor discussed the following — weight the exam toward areas that seemed weak or heavily discussed:\n${qaContext}` : ''}
${coveredTopics.length ? `\nQuestions have already been written covering: ${coveredTopics.join('; ')}. Do NOT repeat these — go deeper into the material or test different angles/sub-topics still untested.` : ''}

Return ONLY valid JSON:
{
  "questions": [
    { "type": "mcq", "question": "...", "options": ["A","B","C","D"], "correctAnswer": 0, "workingScratchpad": "for numeric/calculation MCQs only: work the answer out step by step here AND independently recompute it once more to confirm — messy work-in-progress is fine in THIS field only, it is never shown to the student", "explanation": "the clean, final, confident explanation shown to the student — for calculation questions, show the full working leading to the answer; never mention the scratchpad or any earlier mistake", "topic": "specific sub-topic" },
    { "type": "essay", "question": "...", "modelAnswer": "...", "explanation": "...", "topic": "specific sub-topic" }
  ]
}
CRITICAL for MCQ accuracy: for every numeric/calculation MCQ, use "workingScratchpad" to verify the answer twice before settling on the 4 options — make sure exactly one option matches your verified answer exactly, and "explanation" must be derived strictly from that verified working, with zero hesitation or self-correction visible in it.
Write up to ${askFor} questions — but ONLY if the material genuinely supports that many distinct, non-repetitive, in-depth questions. Return fewer rather than pad with filler or restate the same idea twice. correctAnswer is the 0-based index of the correct option, only for "mcq" questions.`;
}

// Generates up to MAX_EXAM_QUESTIONS in batches (rather than one huge
// request) so a genuinely deep exam doesn't risk truncating mid-response,
// and so each batch can be told what's already been asked to avoid
// repeating itself. Stops early once the material stops yielding enough
// genuinely new questions, rather than padding to hit a number.
async function generateExamQuiz(session) {
  let allQuestions   = [];
  let coveredTopics  = [];

  for (let batch = 0; batch < MAX_EXAM_BATCHES && allQuestions.length < MAX_EXAM_QUESTIONS; batch++) {
    const askFor = Math.min(EXAM_BATCH_SIZE, MAX_EXAM_QUESTIONS - allQuestions.length);
    const examPrompt = buildExamPrompt(session, askFor, coveredTopics);

    let batchRaw;
    try {
      const parsed = await gemini.generateJSON(examPrompt, { maxOutputTokens: 8192, temperature: 0.6 });
      batchRaw = Array.isArray(parsed.questions) ? parsed.questions : [];
    } catch (err) {
      if (allQuestions.length > 0) break; // keep whatever earlier batches already produced
      throw err;
    }

    if (batchRaw.length === 0) break; // material exhausted — nothing new to ask
    allQuestions.push(...batchRaw);
    coveredTopics.push(...batchRaw.map(q => q.topic).filter(Boolean));
    // Only apply the early-stop heuristic from the 2nd batch onward — a
    // cautious first batch is common even when there's genuinely more to
    // cover, and a follow-up round (now told what's already been asked)
    // often surfaces distinct angles the first pass missed.
    if (batch > 0 && batchRaw.length < askFor * 0.5) break;
  }

  const questions = allQuestions
    .map(q => {
      const isEssay = q.type === 'essay' || !Array.isArray(q.options) || q.options.length < 2;
      return isEssay
        ? {
            question:      String(q.question || '').trim(),
            modelAnswer:   String(q.modelAnswer || '').trim(),
            explanation:   String(q.explanation || '').trim(),
            options:       [],
            correctAnswer: null,
            topic:         String(q.topic || '').trim(),
          }
        : {
            question:      String(q.question || '').trim(),
            options:       q.options.slice(0, 4),
            correctAnswer: Number.isFinite(Number(q.correctAnswer)) ? Number(q.correctAnswer) : 0,
            explanation:   String(q.explanation || '').trim(),
            modelAnswer:   '',
            topic:         String(q.topic || '').trim(),
          };
    })
    .filter(q => q.question && (q.modelAnswer || (q.options.length === 4 && q.correctAnswer !== null)))
    .slice(0, MAX_EXAM_QUESTIONS);

  if (questions.length === 0) throw new Error('AI returned no usable exam questions.');

  const quizTitle = `${session.title} — Exam`;
  return Quiz.create({
    userId:         session.userId,
    title:          quizTitle,
    subject:        session.subject,
    difficulty:     'hard',
    timeLimit:      Math.max(20, Math.ceil(questions.length * 3)),
    numQuestions:   questions.length,
    questionType:   'mixed',
    questions,
    isPublic:       false,
    isAdminCreated: false,
  });
}

// Extends an EXISTING exam Quiz document with more questions off the same
// session material, rather than creating a new quiz — lets a student who
// finishes every generated question keep going indefinitely instead of the
// exam ending at a fixed count. No hard ceiling on total question count;
// each individual call is capped for latency/output-budget reasons only.
const ADD_QUESTIONS_MAX_PER_CALL = 40;

async function generateMoreExamQuestions(session, quiz, requestedCount) {
  const targetCount  = Math.max(1, Math.min(requestedCount, ADD_QUESTIONS_MAX_PER_CALL));
  const coveredTopics = (quiz.questions || []).map(q => q.topic).filter(Boolean);

  let newRaw = [];
  for (let batch = 0; batch < MAX_EXAM_BATCHES && newRaw.length < targetCount; batch++) {
    const askFor = Math.min(EXAM_BATCH_SIZE, targetCount - newRaw.length);
    const examPrompt = buildExamPrompt(session, askFor, [...coveredTopics, ...newRaw.map(q => q.topic).filter(Boolean)]);

    let batchRaw;
    try {
      const parsed = await gemini.generateJSON(examPrompt, { maxOutputTokens: 8192, temperature: 0.6 });
      batchRaw = Array.isArray(parsed.questions) ? parsed.questions : [];
    } catch (err) {
      if (newRaw.length > 0) break;
      throw err;
    }
    if (batchRaw.length === 0) break;
    newRaw.push(...batchRaw);
    if (batch > 0 && batchRaw.length < askFor * 0.5) break;
  }

  const newQuestions = newRaw
    .map(q => {
      const isEssay = q.type === 'essay' || !Array.isArray(q.options) || q.options.length < 2;
      return isEssay
        ? {
            question:      String(q.question || '').trim(),
            modelAnswer:   String(q.modelAnswer || '').trim(),
            explanation:   String(q.explanation || '').trim(),
            options:       [],
            correctAnswer: null,
            topic:         String(q.topic || '').trim(),
          }
        : {
            question:      String(q.question || '').trim(),
            options:       q.options.slice(0, 4),
            correctAnswer: Number.isFinite(Number(q.correctAnswer)) ? Number(q.correctAnswer) : 0,
            explanation:   String(q.explanation || '').trim(),
            modelAnswer:   '',
            topic:         String(q.topic || '').trim(),
          };
    })
    .filter(q => q.question && (q.modelAnswer || (q.options.length === 4 && q.correctAnswer !== null)))
    .slice(0, targetCount);

  if (newQuestions.length === 0) throw new Error('AI could not generate further distinct questions from this material — it may already be thoroughly covered.');

  quiz.questions.push(...newQuestions);
  quiz.numQuestions = quiz.questions.length;
  quiz.timeLimit    = Math.max(quiz.timeLimit || 0, Math.ceil(quiz.questions.length * 3));
  await quiz.save();
  return newQuestions.length;
}

// ── POST /api/exammode/create ─────────────────────────────────────────────────
// Accepts EITHER: multipart (fields: title, subject; files: docs) OR
// JSON: { title, subject, pastedText }
router.post('/create', auth, requireExamModeAccess, async (req, res) => {
  try {
    if (!gemini.ready)
      return res.status(503).json({ error: 'AI service is temporarily unavailable. Please try again shortly.' });

    const quotaError = await checkAndReportQuota(req.user.userId);
    if (quotaError) return res.status(403).json(quotaError);

    const title   = (req.body?.title   || '').trim();
    const subject = (req.body?.subject || '').trim();
    if (!title)   return res.status(400).json({ error: 'A title for this exam session is required.' });
    if (!subject) return res.status(400).json({ error: 'Subject is required.' });

    const extractionMode = req.body?.extractionMode === 'vision' ? 'vision' : 'text';

    let uploadedFiles = [];
    let combinedText  = '';
    let visionFiles   = null;

    if (req.body?.pastedText?.trim()) {
      combinedText  = req.body.pastedText.trim().slice(0, 100000);
      uploadedFiles = [{ name: 'Pasted notes', textLength: combinedText.length }];
    } else if (req.files && Object.keys(req.files).length > 0) {
      const rawFiles = req.files.docs || Object.values(req.files)[0];
      const fileList = Array.isArray(rawFiles) ? rawFiles : [rawFiles];

      if (extractionMode === 'vision') {
        visionFiles   = fileList.map(f => ({ data: f.data, mimeType: f.mimetype || 'application/pdf' }));
        uploadedFiles = fileList.map(f => ({ name: f.name, textLength: f.data.length }));
      } else {
        try {
          const { chunks, meta } = await extractTextFromFiles(fileList);
          combinedText  = chunks.join('\n\n').slice(0, 100000);
          uploadedFiles = meta;
        } catch (extractErr) {
          return res.status(422).json({ error: extractErr.message });
        }
      }
    } else {
      return res.status(400).json({ error: 'Upload course material (field: docs) or paste it as text.' });
    }

    if (extractionMode === 'text' && !combinedText.trim())
      return res.status(422).json({ error: 'No usable text found. Please check your files or paste the material directly.' });

    // ── Optional past exam papers — same "forecaster" idea as the standalone
    // Question Forecaster feature, folded directly into Exam Mode so the
    // final timed exam can be shaped by real past questions without a
    // separate session. Text-only (paste or PDF-text-extraction) regardless
    // of which mode the main material used, to keep this additive step simple.
    let pastQuestionsText  = '';
    let pastQuestionsFiles = [];
    if (req.body?.pastQuestionsText?.trim()) {
      pastQuestionsText  = req.body.pastQuestionsText.trim().slice(0, 30000);
      pastQuestionsFiles = [{ name: 'Pasted past questions', textLength: pastQuestionsText.length }];
    } else if (req.files?.pastQuestions) {
      const rawPQ  = req.files.pastQuestions;
      const pqList = Array.isArray(rawPQ) ? rawPQ : [rawPQ];
      try {
        const { chunks, meta } = await extractTextFromFiles(pqList);
        pastQuestionsText  = chunks.join('\n\n').slice(0, 30000);
        pastQuestionsFiles = meta;
      } catch (extractErr) {
        console.warn('[exammode] past-questions extraction failed, continuing without them:', extractErr.message);
      }
    }

    // Batched (like exam-question generation elsewhere) so a genuinely long
    // course document gets a COMPLETE, in-depth walkthrough instead of
    // capping out at whatever a single AI call's output budget allows —
    // each batch is told what's already been taught and told to keep going.
    const WALKTHROUGH_MAX_STEPS  = 30;
    const WALKTHROUGH_BATCH_SIZE = 8;
    const WALKTHROUGH_MAX_BATCHES = 4; // 4 × 8 = 32

    function buildWalkthroughPrompt(usingVisionFiles, askFor, coveredHeadings, includeMeta) {
      // Batch 0 in vision mode reads the raw PDF directly; every later batch
      // (and all of text mode) reasons over combinedText as plain text — by
      // then combinedText already holds the transcript from batch 0.
      const materialSection = usingVisionFiles
        ? `The course material is attached as a PDF file — read all text AND any diagrams, charts, tables, photos, or images it contains.`
        : `Course material:\n${combinedText}`;
      return `You are an expert tutor preparing a student for an exam on ${subject}.

${materialSection}

TASK: Break this material into a step-by-step teaching walkthrough — the way a tutor would cover it in order, one idea at a time, covering the ENTIRE material from start to end (all sections/pages), not just the opening portion. Each step should genuinely TEACH that piece (explain it like you're tutoring one-on-one, with enough detail that a student who never saw the source could learn it from this step alone) — never just restate the heading.

If the material contains ANY calculations, formulas, numeric worked examples, or quantitative problems, you MUST explain them in full: show every step of the working, not just the formula or the final answer — walk through it the way a tutor would at a whiteboard. Never skip over or gloss past numeric/calculation content just because it's harder to explain in prose.
${coveredHeadings.length ? `\nAlready taught so far: ${coveredHeadings.join('; ')}. Do NOT repeat these — continue with the NEXT distinct points in the material that haven't been covered yet (keep working further into the document).` : ''}

Return ONLY valid JSON (no markdown, no extra text):
{${includeMeta ? `
  "walkthroughIntro": "One short paragraph: what this material covers and what the student is about to learn",` : ''}
  "walkthrough": [
    { "heading": "Step topic", "explanation": "A genuine, tutor-style teaching explanation, 3-6 sentences (longer if explaining a calculation — show full working)" }
  ]${usingVisionFiles ? `,
  "transcript": "A thorough, detailed prose transcript of EVERYTHING in the material, start to end — all text content plus a full written description of every diagram, chart, table, or image (what it shows, its labels, what it demonstrates), and the COMPLETE working for every calculation or numeric example shown, not just the final figure. Detailed enough that someone who never saw the PDF could fully understand it from this transcript alone. Used later to generate the exam, so be comprehensive and do not cut it short."` : ''}
}

RULES:
- walkthrough: write up to ${askFor} steps — but only if the material genuinely still has that many distinct, uncovered points left. Return fewer rather than pad with filler or repeat something already taught.
- If everything in the material has already been covered in "Already taught so far", return an EMPTY walkthrough array — do NOT write a wrap-up/completion step like "all material covered", that is not a real teaching step
- Keep each step focused — one idea taught well, not several crammed together`;
    }

    let walkthrough = [];
    let walkthroughIntro = '';
    let coveredHeadings = [];
    try {
      for (let batch = 0; batch < WALKTHROUGH_MAX_BATCHES && walkthrough.length < WALKTHROUGH_MAX_STEPS; batch++) {
        const askFor = Math.min(WALKTHROUGH_BATCH_SIZE, WALKTHROUGH_MAX_STEPS - walkthrough.length);
        const includeMeta = batch === 0;
        const usingVisionFiles = extractionMode === 'vision' && batch === 0;
        const prompt = buildWalkthroughPrompt(usingVisionFiles, askFor, coveredHeadings, includeMeta);

        const parsed = usingVisionFiles
          ? await gemini.generateJSONFromFiles(prompt, visionFiles, { maxOutputTokens: 8192, temperature: 0.5 })
          : await gemini.generateJSON(prompt, { maxOutputTokens: 8192, temperature: 0.5 });

        if (includeMeta) {
          walkthroughIntro = String(parsed.walkthroughIntro || '').trim();
          if (extractionMode === 'vision') {
            combinedText = String(parsed.transcript || '').trim().slice(0, 100000);
            if (!combinedText) throw new Error('AI could not read this PDF — try the "Text Only" option or paste the notes instead.');
          }
        }

        const batchSteps = Array.isArray(parsed.walkthrough)
          ? parsed.walkthrough
              .map(s => ({ heading: String(s.heading || '').trim(), explanation: String(s.explanation || '').trim() }))
              .filter(s => s.heading && s.explanation)
          : [];
        if (batchSteps.length === 0) break; // material exhausted
        walkthrough.push(...batchSteps);
        coveredHeadings.push(...batchSteps.map(s => s.heading));
        if (batch > 0 && batchSteps.length < askFor * 0.5) break;
      }
    } catch (aiErr) {
      console.error('[exammode] walkthrough AI error:', aiErr.message);
      if (walkthrough.length === 0)
        return res.status(500).json({ error: `AI failed to build the walkthrough: ${aiErr.message}` });
      // Keep whatever earlier batches already produced rather than losing it all
    }

    walkthrough = walkthrough.slice(0, WALKTHROUGH_MAX_STEPS);
    if (walkthrough.length === 0)
      return res.status(500).json({ error: 'AI returned an empty walkthrough — try again.' });

    const session = await ExamModeSession.create({
      userId: req.user.userId,
      title,
      subject,
      uploadedFiles,
      combinedText,
      pastQuestionsFiles,
      pastQuestionsText,
      walkthroughIntro,
      walkthrough,
    });

    res.json({
      success:              true,
      id:                    session._id,
      title:                 session.title,
      subject:               session.subject,
      walkthroughIntro:      session.walkthroughIntro,
      walkthrough:           session.walkthrough,
      filesProcessed:        uploadedFiles.length,
      pastQuestionsProcessed: pastQuestionsFiles.length,
    });
  } catch (err) {
    console.error('[exammode] /create unexpected error:', err.message);
    res.status(500).json({ error: `Unexpected error: ${err.message || 'unknown'}` });
  }
});

// ── POST /api/exammode/:id/qa-chat ────────────────────────────────────────────
// Conversational Q&A grounded in the session's material — same ephemeral,
// client-held-history pattern as /gamification/tutor-chat. Not subject to
// that route's daily message cap: this chat is core to a feature that's
// already gated behind a paid plan, not a bonus widget.
router.post('/:id/qa-chat', auth, requireExamModeAccess, async (req, res) => {
  try {
    if (!gemini.ready)
      return res.status(503).json({ error: 'AI service is temporarily unavailable. Please try again shortly.' });

    const { message, history } = req.body;
    if (!message || !message.trim()) return res.status(400).json({ error: 'message is required' });

    const session = await ExamModeSession.findOne({ _id: req.params.id, userId: req.user.userId });
    if (!session) return res.status(404).json({ error: 'Exam session not found.' });

    const historyText = Array.isArray(history)
      ? history.slice(-6).map(h => `${h.role === 'user' ? 'Student' : 'Tutor'}: ${h.content}`).join('\n')
      : '';

    const prompt = `You are an expert exam-prep tutor running a Q&A study session with a student on ${session.subject}, grounded in this material:

${session.combinedText.slice(0, 40000)}
${historyText ? `\nConversation so far:\n${historyText}\n` : ''}
Student's new message: "${message.trim()}"

Your job: question the student on the material (don't just answer whatever they ask — actively test their understanding), give honest feedback on their answers, and correct misunderstandings. If a calculation is involved, show the full step-by-step working, not just the final answer. Once they've engaged substantively across several exchanges and seem to genuinely understand the material, start naturally offering to move to the timed exam. Keep replies conversational, under 100 words (longer if walking through a calculation), no markdown headers.

Return ONLY valid JSON: { "reply": "...", "readyForExam": true or false }
readyForExam should only be true once real understanding has been demonstrated across the conversation — never on the very first message.`;

    let reply, readyForExam = false;
    try {
      const parsed = await gemini.generateJSON(prompt, { maxOutputTokens: 800, temperature: 0.7 });
      reply = parsed.reply;
      readyForExam = parsed.readyForExam === true;
    } catch (aiErr) {
      console.error('[exammode] qa-chat AI error:', aiErr.message);
      return res.status(500).json({ error: 'AI failed to respond. Try again.' });
    }
    if (!reply) return res.status(500).json({ error: 'AI returned an empty response.' });

    res.json({ success: true, reply, readyForExam });
  } catch (err) {
    console.error('[exammode] qa-chat error:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── POST /api/exammode/:id/generate-exam ──────────────────────────────────────
router.post('/:id/generate-exam', auth, requireExamModeAccess, async (req, res) => {
  try {
    if (!gemini.ready)
      return res.status(503).json({ error: 'AI service is temporarily unavailable. Please try again shortly.' });

    const session = await ExamModeSession.findOne({ _id: req.params.id, userId: req.user.userId });
    if (!session) return res.status(404).json({ error: 'Exam session not found.' });

    const quotaError = await checkAndReportQuota(req.user.userId);
    if (quotaError) return res.status(403).json(quotaError);

    const { qaHistory } = req.body;
    const qaSummary = Array.isArray(qaHistory)
      ? qaHistory.slice(-20).map(h => `${h.role === 'user' ? 'Student' : 'Tutor'}: ${h.content}`).join('\n').slice(0, 4000)
      : '';
    session.qaSummary = qaSummary;

    let quiz;
    try {
      quiz = await generateExamQuiz(session);
    } catch (aiErr) {
      console.error('[exammode] generate-exam AI error:', aiErr.message);
      return res.status(500).json({ error: `AI failed to generate the exam: ${aiErr.message}` });
    }

    session.quizId    = quiz._id;
    session.quizTitle = quiz.title;
    session.phase      = 'exam';
    session.updatedAt  = new Date();
    await session.save();

    res.json({ success: true, quizId: quiz._id, quizTitle: quiz.title, numQuestions: quiz.numQuestions });
  } catch (err) {
    console.error('[exammode] generate-exam error:', err.message);
    res.status(500).json({ error: `Exam generation failed: ${err.message || 'unknown'}` });
  }
});

// ── POST /api/exammode/:id/retake ─────────────────────────────────────────────
// Regenerates a fresh exam (new questions from the same material + prior
// qaSummary) rather than reusing the identical quiz — discourages rote
// memorization of the specific questions from a failed attempt.
router.post('/:id/retake', auth, requireExamModeAccess, async (req, res) => {
  try {
    if (!gemini.ready)
      return res.status(503).json({ error: 'AI service is temporarily unavailable. Please try again shortly.' });

    const session = await ExamModeSession.findOne({ _id: req.params.id, userId: req.user.userId });
    if (!session) return res.status(404).json({ error: 'Exam session not found.' });

    const quotaError = await checkAndReportQuota(req.user.userId);
    if (quotaError) return res.status(403).json(quotaError);

    let quiz;
    try {
      quiz = await generateExamQuiz(session);
    } catch (aiErr) {
      console.error('[exammode] retake AI error:', aiErr.message);
      return res.status(500).json({ error: `AI failed to generate a new exam: ${aiErr.message}` });
    }

    session.quizId    = quiz._id;
    session.quizTitle = quiz.title;
    session.phase      = 'exam';
    session.updatedAt  = new Date();
    await session.save();

    res.json({ success: true, quizId: quiz._id, quizTitle: quiz.title, numQuestions: quiz.numQuestions });
  } catch (err) {
    console.error('[exammode] retake error:', err.message);
    res.status(500).json({ error: `Retake generation failed: ${err.message || 'unknown'}` });
  }
});

// ── POST /api/exammode/:id/add-questions ───────────────────────────────────────
// Body: { count }. Appends more AI-generated questions to the session's
// CURRENT quiz (in progress or just finished) instead of ending the exam at
// a fixed count — lets the student keep going as long as they want.
router.post('/:id/add-questions', auth, requireExamModeAccess, async (req, res) => {
  try {
    if (!gemini.ready)
      return res.status(503).json({ error: 'AI service is temporarily unavailable. Please try again shortly.' });

    const session = await ExamModeSession.findOne({ _id: req.params.id, userId: req.user.userId });
    if (!session)          return res.status(404).json({ error: 'Exam session not found.' });
    if (!session.quizId)   return res.status(400).json({ error: 'Generate the exam first before adding more questions.' });

    const quiz = await Quiz.findOne({ _id: session.quizId, userId: req.user.userId });
    if (!quiz) return res.status(404).json({ error: 'Exam quiz not found.' });

    const requestedCount = parseInt(req.body?.count, 10);
    if (!Number.isFinite(requestedCount) || requestedCount < 1)
      return res.status(400).json({ error: 'Specify how many more questions you want (count >= 1).' });

    let addedCount;
    try {
      addedCount = await generateMoreExamQuestions(session, quiz, requestedCount);
    } catch (aiErr) {
      console.error('[exammode] add-questions AI error:', aiErr.message);
      return res.status(500).json({ error: aiErr.message || 'AI failed to generate more questions.' });
    }

    res.json({ success: true, quizId: quiz._id, addedCount, numQuestions: quiz.numQuestions });
  } catch (err) {
    console.error('[exammode] add-questions error:', err.message);
    res.status(500).json({ error: `Failed to add more questions: ${err.message || 'unknown'}` });
  }
});

// ── POST /api/exammode/:id/report-result ──────────────────────────────────────
// Called by TakeQuiz.jsx right after it saves the QuizResult, so this session
// picks up the score, decides pass/fail, and (if failed) gets AI retake advice
// grounded in the attempt's actual weak topics.
router.post('/:id/report-result', auth, async (req, res) => {
  try {
    const { quizResultId } = req.body;
    if (!quizResultId) return res.status(400).json({ error: 'quizResultId is required' });

    const session = await ExamModeSession.findOne({ _id: req.params.id, userId: req.user.userId });
    if (!session) return res.status(404).json({ error: 'Exam session not found.' });

    const result = await QuizResult.findOne({ _id: quizResultId, userId: req.user.userId });
    if (!result || !session.quizId || result.quizId.toString() !== session.quizId.toString())
      return res.status(404).json({ error: 'Result not found for this exam session.' });

    const passed = result.score >= session.passThreshold;

    // Per-topic time spent — joins timePerQuestion (by index) onto
    // topicBreakdown (which already carries topic + correctness per
    // question). "Slow" is relative to this attempt's own average, so it
    // adapts to exam length rather than using a fixed second count.
    const times = result.timePerQuestion || [];
    const avgTime = times.length ? times.reduce((s, t) => s + (t || 0), 0) / times.length : 0;
    const timeAnalysis = (result.topicBreakdown || [])
      .filter(t => t.topic && Number.isFinite(times[t.questionIndex]))
      .map(t => ({
        topic:          t.topic,
        avgTimeSeconds: Math.round(times[t.questionIndex]),
        correct:        t.correct,
        slow:           avgTime > 0 && times[t.questionIndex] > avgTime * 1.5,
      }));
    // A topic that was slow to answer even when correct is still worth
    // flagging — slow-but-right usually means shaky, not solid, understanding.
    const needsWork = timeAnalysis.filter(t => !t.correct || t.slow);

    let retakeAdvice = '';

    if ((!passed || needsWork.length > 0) && gemini.ready) {
      const wrongTopics = [...new Set(timeAnalysis.filter(t => !t.correct).map(t => t.topic))];
      const slowTopics   = [...new Set(timeAnalysis.filter(t => t.correct && t.slow).map(t => t.topic))];
      const advicePrompt = `A student scored ${result.score}% on their ${session.subject} exam (${passed ? `passed — needed ${session.passThreshold}%` : `needed ${session.passThreshold}% to pass`}).
${wrongTopics.length ? `Topics they answered incorrectly: ${wrongTopics.join(', ')}.` : ''}
${slowTopics.length ? `Topics they took much longer than average to answer, even though they got them right (a sign of shaky rather than solid understanding): ${slowTopics.join(', ')}.` : ''}

Write ${passed ? 'encouraging feedback on what to reinforce even though they passed' : 'encouraging, specific retake advice: what to review before trying again, and how to approach it'}. Under 100 words, no markdown headers.
Return ONLY valid JSON: { "advice": "..." }`;
      try {
        const parsed = await gemini.generateJSON(advicePrompt, { maxOutputTokens: 250, temperature: 0.6 });
        retakeAdvice = String(parsed.advice || '').trim();
      } catch (aiErr) {
        console.error('[exammode] retake-advice AI error (non-fatal):', aiErr.message);
      }
    }

    session.attempts.push({ quizResultId: result._id, score: result.score, passed, retakeAdvice, timeAnalysis });
    session.phase     = 'completed';
    session.updatedAt = new Date();
    await session.save();

    res.json({ success: true, passed, score: result.score, passThreshold: session.passThreshold, retakeAdvice, timeAnalysis });
  } catch (err) {
    console.error('[exammode] report-result error:', err.message);
    res.status(500).json({ error: `Failed to report result: ${err.message || 'unknown'}` });
  }
});

// ── GET /api/exammode/sessions ─────────────────────────────────────────────────
router.get('/sessions', auth, requireExamModeAccess, async (req, res) => {
  try {
    const sessions = await ExamModeSession.find({ userId: req.user.userId })
      .select('-combinedText -pastQuestionsText').sort({ createdAt: -1 }).lean();
    res.json({ success: true, sessions });
  } catch (err) {
    res.status(500).json({ error: `Failed to fetch exam sessions: ${err.message}` });
  }
});

// ── GET /api/exammode/:id ───────────────────────────────────────────────────────
router.get('/:id', auth, requireExamModeAccess, async (req, res) => {
  try {
    const session = await ExamModeSession
      .findOne({ _id: req.params.id, userId: req.user.userId })
      .select('-combinedText -pastQuestionsText').lean();
    if (!session) return res.status(404).json({ error: 'Exam session not found.' });
    res.json({ success: true, session });
  } catch (err) {
    res.status(500).json({ error: `Failed to fetch exam session: ${err.message}` });
  }
});

// ── DELETE /api/exammode/:id ────────────────────────────────────────────────────
// Deletes only the session record — any Quiz already generated from it stays,
// reachable via My Quizzes regardless.
router.delete('/:id', auth, async (req, res) => {
  try {
    await ExamModeSession.deleteOne({ _id: req.params.id, userId: req.user.userId });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: `Failed to delete: ${err.message}` });
  }
});

module.exports = router;
