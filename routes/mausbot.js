// routes/mausbot.js — backs the "SIDIS Seeds Agent" (internal name kept as
// "Mausbot" — this file, the model, and the /api/mausbot prefix are an
// implementation detail users never see). AI-assisted long-form academic
// help, one section at a time:
//   'project'    — final year project/thesis, chapter by chapter (original behavior)
//   'research'   — a standalone research paper, section by section
//   'essay'      — a single essay (almost always exactly one "chapter")
//   'assessment' — assignments / complex calculations: the student pastes
//                  or uploads the questions, the AI splits them into
//                  individual problems, then solves one at a time with full
//                  step-by-step workings (LaTeX math via MathText on the
//                  frontend)
// Each "chapter" is generated on demand, researched with real search
// grounding where possible (not for 'assessment' — see below), lightly
// revised for natural phrasing, and flagged for passages to personalize
// before submitting. A short quiz on each chapter gates the next one for
// free-tier students; paid students skip that gate entirely (reuses the
// same subscription system as the rest of the app — no separate payment
// flow here). Nothing generates upfront, so this is something to chip away
// at over many visits, exactly like AI Tutor's sections.
const express       = require('express');
const router         = express.Router();
const auth           = require('../middlewares/auth');
const mammoth        = require('mammoth');
const PDFDocument    = require('pdfkit');
const MausbotSession = require('../models/MausbotSession');
const Quiz           = require('../models/Quiz');
const QuizResult     = require('../models/QuizResult');
const { gemini }     = require('../utils/ai');
const { getUserPlan, getPlanFeatures } = require('../utils/subscription');
const { DISCIPLINE_MCQ_INSTRUCTION } = require('../utils/disciplinePrompt');
const { extractPdfText: extractPdfTextShared, pdfParseAvailable } = require('../utils/pdfExtract');
const { resolveUploadedFiles } = require('../utils/blobFetch');
const { extractUrlText } = require('../utils/urlExtract');

const MAX_CHAPTERS = 30;
const QUIZ_PASS_THRESHOLD = 60; // percent

const TASK_TYPES = ['project', 'research', 'essay', 'assessment'];
const sectionNoun = (taskType) => (taskType === 'assessment' ? 'Problem' : taskType === 'essay' ? 'Section' : 'Chapter');

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
      message: `You've used all ${features.aiQuizzesPerMonth} AI generations for this month. Upgrade your plan for unlimited Seeds Agent generations.`,
      limit:   features.aiQuizzesPerMonth, used: count,
    };
  }
  return null;
}

async function isPaidUser(userId) {
  const plan = await getUserPlan(userId);
  return plan !== 'free';
}

async function extractPdfText(buffer) {
  if (!pdfParseAvailable()) throw new Error('PDF parser is not available on this server. Please paste the content as text instead.');
  return extractPdfTextShared(buffer);
}

// Transcribes uploaded file(s) via Gemini vision — used whenever any file is
// an image (no text-extraction path exists for a photo) or the student
// explicitly flagged diagrams/handwriting worth reading. Generic over
// PDFs and images alike, unlike quizzes.js's PDF-only vision helper.
async function transcribeFilesVision(files) {
  const visionPrompt = `You are transcribing assignment/assessment material so it can be solved question by question. The material is attached as file(s) — read all text AND any diagrams, charts, tables, graphs, or handwriting they contain.

Produce a thorough, faithful transcript of every question/problem in the material, in the order they appear, including any diagram/graph/table content described in words where it matters for solving the problem. Keep mathematical notation exactly as written (e.g. "x^2 + 3x - 4 = 0").

Return ONLY valid JSON: { "transcript": "..." }`;
  const parsed = await gemini.generateJSONFromFiles(
    visionPrompt,
    files.map(f => ({ data: f.data, mimeType: f.mimetype || 'application/octet-stream' })),
    { maxOutputTokens: 8192, temperature: 0.3 }
  );
  return parsed.transcript || '';
}

function buildSplitProblemsPrompt(rawText) {
  return `You are preparing a student's assignment/assessment for step-by-step solving, one question at a time.

Below is the raw assignment/assessment material (it may contain some noise from file extraction — ignore page numbers, headers, or footers that aren't part of a question):

"""
${rawText.slice(0, 30000)}
"""

Identify every distinct question/problem in it, in the order they appear. Each item's text should be the COMPLETE question exactly as given — every part, sub-part, piece of given data, and any diagram/table description needed to solve it. Do not shorten, solve, or editorialize.

Return ONLY valid JSON: { "problems": ["full text of question 1", "full text of question 2", ...] }`;
}

// ── POST /api/mausbot/create ──────────────────────────────────────────────────
// Body varies by taskType:
//   project/research — { taskType, topic, fieldOfStudy, chapters: [{ title }] }
//   essay             — { taskType, topic, fieldOfStudy, wordTarget }
//   assessment        — { taskType, fieldOfStudy, topic?, content? | url? | fileUrls?, extractionMode? }
// Only 'assessment' makes an AI call here (to split the material into
// individual problems) — every other type just saves the plan; chapters are
// generated on demand, one at a time.
router.post('/create', auth, async (req, res) => {
  try {
    const taskType = TASK_TYPES.includes(req.body?.taskType) ? req.body.taskType : 'project';
    const fieldOfStudy = (req.body?.fieldOfStudy || '').trim();
    if (!fieldOfStudy) return res.status(400).json({ error: 'Subject / field of study is required.' });

    if (taskType === 'project' || taskType === 'research') {
      const topic = (req.body?.topic || '').trim();
      if (!topic) return res.status(400).json({ error: taskType === 'research' ? 'A research topic is required.' : 'A project topic is required.' });

      const rawChapters = Array.isArray(req.body?.chapters) ? req.body.chapters : [];
      const chapters = rawChapters
        .map((c, i) => ({ number: i + 1, title: (c.title || '').trim() }))
        .filter(c => c.title);
      if (chapters.length === 0) return res.status(400).json({ error: 'Give at least one chapter a title.' });
      if (chapters.length > MAX_CHAPTERS) return res.status(400).json({ error: `A ${taskType} can have at most ${MAX_CHAPTERS} chapters.` });

      const session = await MausbotSession.create({
        userId: req.user.userId, taskType, topic, fieldOfStudy,
        chapters: chapters.map(c => ({ ...c, content: '', status: 'pending' })),
      });
      return res.json({ success: true, id: session._id, title: session.topic, totalChapters: chapters.length });
    }

    if (taskType === 'essay') {
      const topic = (req.body?.topic || '').trim();
      if (!topic) return res.status(400).json({ error: 'An essay title or question is required.' });
      const wordTarget = Math.min(5000, Math.max(300, parseInt(req.body?.wordTarget, 10) || 1000));

      const session = await MausbotSession.create({
        userId: req.user.userId, taskType, topic, fieldOfStudy, wordTarget,
        chapters: [{ number: 1, title: topic, content: '', status: 'pending' }],
      });
      return res.json({ success: true, id: session._id, title: session.topic, totalChapters: 1 });
    }

    // ── taskType === 'assessment' ────────────────────────────────────────────
    if (!gemini.ready) return res.status(503).json({ error: 'AI service is temporarily unavailable. Please try again shortly.' });

    let rawText = (req.body?.content || '').trim();

    if (!rawText && req.body?.url) {
      try { rawText = await extractUrlText(req.body.url); }
      catch (urlErr) { return res.status(400).json({ error: urlErr.message }); }
    }

    if (!rawText && Array.isArray(req.body?.fileUrls) && req.body.fileUrls.length > 0) {
      let files;
      try { files = await resolveUploadedFiles(req, { fileField: 'files', urlField: 'fileUrls' }); }
      catch (fetchErr) { return res.status(422).json({ error: `Could not read the uploaded file: ${fetchErr.message}` }); }
      if (files.length === 0) return res.status(400).json({ error: 'No files found.' });

      const wantsVision = req.body?.extractionMode === 'vision' || files.some(f => (f.mimetype || '').startsWith('image/'));
      if (wantsVision) {
        try { rawText = await transcribeFilesVision(files); }
        catch (visionErr) { return res.status(422).json({ error: `AI failed to read the uploaded file(s): ${visionErr.message}` }); }
      } else {
        try {
          for (const file of files) {
            if (file.mimetype === 'application/pdf') rawText += (await extractPdfText(file.data)) + '\n\n';
            else if ((file.mimetype || '').includes('word')) {
              const r = await mammoth.extractRawText({ buffer: file.data });
              rawText += r.value + '\n\n';
            }
          }
        } catch (extractErr) {
          return res.status(422).json({ error: 'Could not read one of the uploaded files. Try the "Has Images / Diagrams" option, or paste the text instead.' });
        }
      }
    }

    if (!rawText.trim()) return res.status(400).json({ error: 'Paste the questions, a URL, or upload a file first.' });

    let problems;
    try {
      const parsed = await gemini.generateJSON(buildSplitProblemsPrompt(rawText), { maxOutputTokens: 4096, temperature: 0.3 });
      problems = (Array.isArray(parsed.problems) ? parsed.problems : []).map(p => String(p || '').trim()).filter(Boolean);
    } catch (splitErr) {
      return res.status(500).json({ error: `Could not read the questions: ${splitErr.message}` });
    }
    if (problems.length === 0) return res.status(422).json({ error: 'Could not identify any questions in what you provided. Try pasting more clearly, or a clearer file.' });
    if (problems.length > MAX_CHAPTERS) problems = problems.slice(0, MAX_CHAPTERS);

    const topic = (req.body?.topic || '').trim() || 'Assessment';
    const session = await MausbotSession.create({
      userId: req.user.userId, taskType, topic, fieldOfStudy,
      chapters: problems.map((title, i) => ({ number: i + 1, title, content: '', status: 'pending' })),
    });
    res.json({ success: true, id: session._id, title: session.topic, totalChapters: problems.length });
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
    res.status(500).json({ error: `Failed to fetch Seeds Agent sessions: ${err.message}` });
  }
});

// ── GET /api/mausbot/:id ───────────────────────────────────────────────────────
router.get('/:id', auth, async (req, res) => {
  try {
    const session = await MausbotSession.findOne({ _id: req.params.id, userId: req.user.userId }).lean();
    if (!session) return res.status(404).json({ error: 'Seeds Agent session not found.' });
    const paid = await isPaidUser(req.user.userId);
    res.json({ success: true, session, paid });
  } catch (err) {
    res.status(500).json({ error: `Failed to fetch Seeds Agent session: ${err.message}` });
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
  const kind = session.taskType === 'research' ? 'research paper' : 'final year project';
  const topicLabel = session.taskType === 'research' ? 'Research topic' : 'Project topic';
  return `You are an expert academic research assistant helping a university student research and draft Chapter ${chapter.number} ("${chapter.title}") of their ${kind}.

${topicLabel}: "${session.topic}"
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

function buildEssayPrompt(session) {
  return `You are an expert academic writing assistant helping a student write an essay.

Essay title/question: "${session.topic}"
Subject: ${session.fieldOfStudy}
Target length: approximately ${session.wordTarget || 1000} words.

Write the complete essay:
- A clear introduction that states the thesis/argument, a well-developed body with logical paragraphing, and a strong conclusion.
- Where the essay calls for evidence or examples, search for and cite real, verifiable, current sources — in-text citations in (Author, Year) format where the subject calls for it; omit citations entirely if the subject/style doesn't call for them (e.g. a purely reflective or creative essay).
- Use "## Sub-heading" on its own line only if the essay genuinely benefits from section headings (longer essays) — a short essay can be continuous prose with no headings at all.
- Keep the reasoning and voice that of a student author doing original thinking — never copy a source's wording directly.

Write ONLY the essay content itself (plain text, "## Sub-heading" only where used) — no preamble, no meta-commentary, no "Here is the essay".`;
}

function buildSolutionPrompt(session, chapter) {
  return `You are an expert tutor solving an assignment/assessment question for a student in ${session.fieldOfStudy}.

Question:
${chapter.title}

Solve it fully and rigorously:
- Show every step of your working clearly, in order — never skip steps or jump straight to the answer.
- Use LaTeX math notation for any mathematical expression: wrap inline math in single dollar signs (e.g. $x^2 + 3x - 4 = 0$) and larger/display equations in double dollar signs (e.g. $$\\frac{-b \\pm \\sqrt{b^2-4ac}}{2a}$$).
- If the question has multiple parts (a, b, c...), solve each part separately under its own "## Part (a)" style sub-heading.
- End with a clearly labeled "## Final Answer" section stating the final result(s) plainly.

Write ONLY the worked solution itself (plain text, "## Sub-heading" on its own line for parts/sections) — no preamble, no "Here is the solution".`;
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

function buildQuizPrompt(chapter, taskType) {
  const framing = taskType === 'assessment'
    ? 'a problem that was just solved for them'
    : taskType === 'essay'
    ? 'an essay that was just written for them'
    : 'a chapter they just had researched and drafted for their own project';

  return `You are an expert examiner checking a student's understanding of ${framing}.

${DISCIPLINE_MCQ_INSTRUCTION}

${chapter.title}
${chapter.content.slice(0, 20000)}

Generate 4 multiple-choice questions that check genuine understanding of THIS content (not trivia) — this confirms the student actually engaged with what was generated for them before moving on.

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
    if (!session) return res.status(404).json({ error: 'Seeds Agent session not found.' });
    const taskType = session.taskType || 'project';

    const idx = parseInt(req.params.index, 10);
    const chapter = session.chapters[idx];
    if (!chapter) return res.status(400).json({ error: 'Invalid chapter index.' });
    if (chapter.status === 'ready') return res.json({ success: true, alreadyGenerated: true, chapter });

    if (idx > 0) {
      const prior = session.chapters[idx - 1];
      const paid = await isPaidUser(req.user.userId);
      if (prior.status !== 'ready')
        return res.status(400).json({ error: `Generate ${sectionNoun(taskType)} ${prior.number} first.` });
      if (!paid && !prior.quizPassed)
        return res.status(403).json({ error: `Pass the ${sectionNoun(taskType)} ${prior.number} quiz first to unlock ${sectionNoun(taskType)} ${chapter.number}.`, quizGateLocked: true });
    }

    const quotaError = await checkAndReportQuota(req.user.userId);
    if (quotaError) return res.status(403).json(quotaError);

    const priorSummary = session.chapters
      .slice(0, idx)
      .filter(c => c.status === 'ready')
      .map(c => `Chapter ${c.number} (${c.title}): ${c.content.slice(0, 500)}...`)
      .join('\n\n');

    // 1. Research + write/solve (grounded where real citations make sense —
    // never for 'assessment', where searching the web for "the answer" to a
    // self-contained problem would just introduce unreliable noise).
    let draft;
    try {
      if (taskType === 'assessment') {
        const text = await gemini.generateText(buildSolutionPrompt(session, chapter), { maxOutputTokens: 8192, temperature: 0.3 });
        draft = { text, sources: [], grounded: false };
      } else if (taskType === 'essay') {
        draft = await gemini.generateGroundedText(buildEssayPrompt(session), { maxOutputTokens: 8192, temperature: 0.6 });
      } else {
        draft = await gemini.generateGroundedText(buildChapterPrompt(session, chapter, priorSummary), { maxOutputTokens: 8192, temperature: 0.6 });
      }
    } catch (aiErr) {
      console.error('[mausbot] chapter generation AI error:', aiErr.message);
      return res.status(500).json({ error: `AI failed to generate this ${sectionNoun(taskType).toLowerCase()}: ${aiErr.message}` });
    }
    if (!draft?.text) return res.status(500).json({ error: `AI returned an empty ${sectionNoun(taskType).toLowerCase()}. Please try again.` });

    // 2. Originality + natural-phrasing revision pass — skipped for
    // 'assessment': rewording a worked calculation risks corrupting the
    // math/LaTeX, and "originality" isn't the concern for a solved problem.
    let revised = { revisedText: draft.text, originalityNotes: [] };
    if (taskType !== 'assessment') {
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
    }

    chapter.content           = revised.revisedText;
    chapter.originalityNotes  = revised.originalityNotes;
    chapter.styleRevised      = revised.revisedText !== draft.text;
    chapter.sources           = draft.sources || [];
    chapter.grounded          = !!draft.grounded;
    chapter.status            = 'ready';

    // 3. Quiz — the gate for the next chapter
    try {
      const quizParsed = await gemini.generateJSON(buildQuizPrompt(chapter, taskType), { maxOutputTokens: 2048, temperature: 0.5 });
      const questions = (Array.isArray(quizParsed.questions) ? quizParsed.questions : [])
        .filter(q => q.question && Array.isArray(q.options) && q.options.length >= 2)
        .map(q => ({
          question: q.question, options: q.options.slice(0, 4),
          correctAnswer: typeof q.correctAnswer === 'number' ? Math.min(q.correctAnswer, q.options.length - 1) : 0,
          modelAnswer: '', explanation: q.explanation || '', topic: chapter.title.slice(0, 200),
        }));
      if (questions.length > 0) {
        const quiz = await Quiz.create({
          userId: req.user.userId, title: `${session.topic} — ${sectionNoun(taskType)} ${chapter.number} Check`,
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
    if (!session) return res.status(404).json({ error: 'Seeds Agent session not found.' });

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
    if (!session) return res.status(404).json({ error: 'Seeds Agent session not found.' });
    const taskType = session.taskType || 'project';

    const allReady = session.chapters.every(c => c.status === 'ready');
    if (!allReady) return res.status(400).json({ error: `Generate every ${sectionNoun(taskType).toLowerCase()} before downloading.` });

    const paid = await isPaidUser(req.user.userId);
    if (!paid) {
      const unpassed = session.chapters.find(c => !c.quizPassed);
      if (unpassed) return res.status(403).json({ error: `Pass the ${sectionNoun(taskType)} ${unpassed.number} quiz before downloading, or upgrade your plan to skip the quiz gate.`, quizGateLocked: true });
    }

    if (!session.pdfGeneratedAt) {
      await MausbotSession.updateOne({ _id: session._id }, { $set: { pdfGeneratedAt: new Date(), status: 'completed' } });
    }

    const filename = `${session.topic.replace(/[^a-z0-9]+/gi, '_').slice(0, 60) || 'document'}.pdf`;
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

    const doc = new PDFDocument({ margin: 60, size: 'A4', info: { Title: session.topic } });
    doc.pipe(res);

    const SUBTITLE_BY_TYPE = {
      project:    `A Project Report Submitted in the Field of ${session.fieldOfStudy}`,
      research:   `A Research Paper in the Field of ${session.fieldOfStudy}`,
      essay:      `An Essay — ${session.fieldOfStudy}`,
      assessment: `Worked Solutions — ${session.fieldOfStudy}`,
    };

    // Title page
    doc.font('Helvetica-Bold').fontSize(22).text(session.topic, { align: 'center' });
    doc.moveDown(2);
    doc.font('Helvetica').fontSize(13).text(SUBTITLE_BY_TYPE[taskType] || SUBTITLE_BY_TYPE.project, { align: 'center' });
    doc.moveDown(1);
    doc.fontSize(11).fillColor('#555').text(new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' }), { align: 'center' });
    doc.fillColor('#000');

    // Table of contents — assessment lists bare "Problem N" since the title
    // IS the full question text, too long to usefully list here.
    doc.addPage();
    doc.font('Helvetica-Bold').fontSize(18).text('Table of Contents');
    doc.moveDown(1);
    session.chapters.forEach(c => {
      const label = taskType === 'assessment' ? `Problem ${c.number}` : `Chapter ${c.number}: ${c.title}`;
      doc.font('Helvetica').fontSize(12).text(label);
      doc.moveDown(0.3);
    });

    // Chapters / problems
    const allSources = [];
    session.chapters.forEach(c => {
      doc.addPage();
      if (taskType === 'assessment') {
        doc.font('Helvetica-Bold').fontSize(16).text(`Problem ${c.number}`);
        doc.moveDown(0.6);
        doc.font('Helvetica-Oblique').fontSize(11).text(c.title, { align: 'left' });
        doc.moveDown(0.8);
        doc.font('Helvetica-Bold').fontSize(12).text('Solution');
        doc.moveDown(0.4);
      } else {
        doc.font('Helvetica-Bold').fontSize(16).text(`Chapter ${c.number}: ${c.title}`);
        doc.moveDown(1);
      }
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
