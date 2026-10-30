// routes/tutor.js — "AI Tutor": upload a note, AI reteaches it back section
// by section (like a one-on-one tutor), and after each section offers a
// quick quiz or flashcard check before unlocking the next section. Ends
// with an AI-generated exam/study readiness report and a recommended next
// step. Shares the same monthly AI-generation quota as quizzes/catch-up.
const express       = require('express');
const router        = express.Router();
const auth          = require('../middlewares/auth');
const TutorSession  = require('../models/TutorSession');
const Quiz          = require('../models/Quiz');
const QuizResult    = require('../models/QuizResult');
const FlashcardSet  = require('../models/FlashcardSet');
const { gemini }    = require('../utils/ai');
const { getUserPlan, getPlanFeatures } = require('../utils/subscription');
const { extractPdfText, pdfParseAvailable } = require('../utils/pdfExtract');
const { resolveUploadedFiles } = require('../utils/blobFetch');
const { DISCIPLINE_MCQ_INSTRUCTION } = require('../utils/disciplinePrompt');
const mammoth = require('mammoth');

const isDocx = (file) => (file.mimetype || '').includes('word') || /\.docx?$/i.test(file.name || '');

// ── Shared monthly quota — same pool as /quizzes/generate-quiz and Catch-Up ──
async function checkAndReportQuota(userId) {
  const plan     = await getUserPlan(userId);
  const features = await getPlanFeatures(plan);
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
      message:  `You've used all ${features.aiQuizzesPerMonth} AI generations for this month. Upgrade your plan for unlimited AI Tutor sessions.`,
      limit:    features.aiQuizzesPerMonth,
      used:     count,
      planName: plan === 'free' ? 'Free' : plan,
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
        if (!pdfParseAvailable()) { console.warn(`[tutor] pdf-parse unavailable, skipping ${file.name}`); continue; }
        text = (await extractPdfText(file.data)).trim();
      }
      if (!text) { console.warn(`[tutor] No text in ${file.name} (likely scanned image)`); continue; }
      chunks.push(`=== ${file.name} ===\n${text.slice(0, 40000)}`);
      meta.push({ name: file.name, textLength: text.length });
    } catch (e) {
      console.warn(`[tutor] extraction failed for ${file.name}: ${e.message}`);
    }
  }
  if (chunks.length === 0)
    throw new Error('Could not extract text from any uploaded file. PDFs may be scanned images — please paste your notes as text instead.');
  return { chunks, meta };
}

// ── POST /api/tutor/create ────────────────────────────────────────────────────
// Accepts EITHER: multipart (fields: title, subject; files: docs) OR
// JSON: { title, subject, pastedText }. Same upload/extraction shapes as
// Study Catch-Up, including direct-to-blob doc URLs and vision mode.
router.post('/create', auth, async (req, res) => {
  try {
    if (!gemini.ready)
      return res.status(503).json({ error: 'AI service is temporarily unavailable. Please try again shortly.' });

    const quotaError = await checkAndReportQuota(req.user.userId);
    if (quotaError) return res.status(403).json(quotaError);

    const title   = (req.body?.title   || '').trim();
    const subject = (req.body?.subject || '').trim();
    if (!title)   return res.status(400).json({ error: 'A title for this tutor session is required.' });
    if (!subject) return res.status(400).json({ error: 'Subject is required.' });

    const extractionMode = req.body?.extractionMode === 'vision' ? 'vision' : 'text';

    let uploadedFiles = [];
    let combinedText  = '';
    let visionFiles   = null;
    let pendingDocxText = '';

    if (req.body?.pastedText?.trim()) {
      combinedText  = req.body.pastedText.trim().slice(0, 100000);
      uploadedFiles = [{ name: 'Pasted notes', textLength: combinedText.length }];
    } else if ((req.files && Object.keys(req.files).length > 0) || (Array.isArray(req.body?.docUrls) && req.body.docUrls.length > 0)) {
      let fileList;
      try {
        fileList = await resolveUploadedFiles(req, { fileField: 'docs', urlField: 'docUrls' });
      } catch (fetchErr) {
        return res.status(422).json({ error: `Could not read an uploaded file: ${fetchErr.message}` });
      }

      const docxFiles  = fileList.filter(isDocx);
      const visionable = fileList.filter(f => !isDocx(f));
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
        try {
          const { chunks, meta } = visionable.length > 0 ? await extractTextFromFiles(visionable) : { chunks: [], meta: [] };
          combinedText  = [...(docxText ? [docxText] : []), ...chunks].join('\n\n').slice(0, 100000);
          uploadedFiles = [...docxFiles.map(f => ({ name: f.name, textLength: f.data.length })), ...meta];
        } catch (extractErr) {
          return res.status(422).json({ error: extractErr.message });
        }
      }
    } else {
      return res.status(400).json({ error: 'Upload a note (field: docs) or paste it as text.' });
    }

    if (extractionMode === 'text' && !combinedText.trim())
      return res.status(422).json({ error: 'No usable text found. Please check your file or paste the note directly.' });

    // ── AI: split the material into a sequence of teachable sections ──────────
    // No artificial ceiling that would force the AI to compress/summarize a
    // long document into too few sections — a genuinely long note (a full
    // chapter, a 40-page lecture deck) should produce as many sections as it
    // takes to cover EVERY point, even 30-60+. MAX_SECTIONS exists only as a
    // sane outer bound against a pathological/runaway response, not a target.
    const MAX_SECTIONS   = 60;
    const BATCH_SIZE     = 10;
    const MAX_BATCHES    = 7; // 7 x 10 = 70, comfortably covers MAX_SECTIONS

    function buildSectionsPrompt(usingVisionFiles, askFor, coveredHeadings, includeMeta) {
      const materialSection = usingVisionFiles
        ? `The note is attached as a PDF file — read all text AND any diagrams, charts, tables, photos, or images it contains.`
        : `Note content:\n${combinedText}`;
      return `You are a brilliant, encouraging one-on-one tutor reteaching a student their own notes, like a great private tutor going through material with them from scratch, covering it in FULL from start to end — never a shortened or summarized version.

${materialSection}

TASK: Break this note into an ordered sequence of digestible TEACHING SECTIONS the student will go through one at a time, covering the ENTIRE document — every page, every topic, start to finish — not just the first few pages or the headline ideas. Each section is a self-contained mini-lesson that thoroughly reteaches ONE distinct point, not a glossary entry: a real explanation with an analogy or worked example, as if tutoring someone seeing this for the first time.

Do NOT compress this into a handful of broad sections. For each topic the material raises, actively scan for and give a SEPARATE section to EVERY dimension the material actually contains, not just "what it is":
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
A single topic in the material often has SEVERAL of these dimensions covered in the text — each one is its own separate section, not a footnote folded into a bigger one. If the material explains, say, the types AND the causes of something, that is at least two sections, not one. Not every topic has every dimension — only make a section for the ones actually present in the material, but never skip or merge points just to keep the section count low. A long, detailed document SHOULD produce many sections (30, 40, even 60+) — that is correct and expected, not a problem to avoid.

If the material contains ANY calculations, formulas, numeric worked examples, or quantitative problems, give them their own section(s) and explain them in full: show every step of the working, not just the formula or the final answer.
${coveredHeadings.length ? `\nAlready written so far: ${coveredHeadings.join('; ')}. Do NOT repeat these — continue with the NEXT distinct, uncovered points in the material (keep working further into the document, including later pages/sections — do not restart from the beginning or re-summarize what's already covered).` : ''}

Return ONLY valid JSON (no markdown, no extra text):
{${includeMeta ? `
  "overview": "2-3 sentence plain-language introduction to what this note covers",` : ''}
  "sections": [
    { "heading": "Specific section title that names WHICH dimension of the topic this covers — e.g. 'Types of X', 'Causes of Y', 'How Z Works', not just 'X'", "explanation": "A genuine, thorough teaching explanation (4-8 sentences, longer if explaining a calculation or listing multiple types/factors — cover each one) with a vivid analogy or worked example — as if tutoring someone who's never seen this before. If it involves a calculation, show the full step-by-step working." }
  ]${includeMeta ? `,
  "transcript": "A thorough, detailed prose transcript of EVERYTHING in the material, start to end — all text content plus a full written description of every diagram, chart, table, or image (what it shows, its labels, what it demonstrates), and the COMPLETE working for every calculation shown. Used later to generate section quizzes/flashcards, so be comprehensive and do not cut it short."` : ''}
}

RULES:
- Write up to ${askFor} sections this batch — but only if the material genuinely still has that many distinct, uncovered points left. Return fewer rather than pad with filler or repeat something already taught.
- If everything in the material has already been covered in "Already written so far", return an EMPTY sections array — do NOT write a wrap-up/completion section like "summary" or "all topics covered", that is not a real teaching point.
- Never collapse "what it is" + "its types" + "its causes" + "how it works" into one section just to save space — split them into separate sections the way the material itself separates them.
- Order sections the way a tutor would actually teach them, building on what came before.`;
    }

    let allSections = [];
    let overview = '';
    let coveredHeadings = [];
    try {
      for (let batch = 0; batch < MAX_BATCHES && allSections.length < MAX_SECTIONS; batch++) {
        const askFor = Math.min(BATCH_SIZE, MAX_SECTIONS - allSections.length);
        const includeMeta = batch === 0;
        const usingVisionFiles = !!visionFiles && batch === 0;
        const prompt = buildSectionsPrompt(usingVisionFiles, askFor, coveredHeadings, includeMeta);

        const parsed = usingVisionFiles
          ? await gemini.generateJSONFromFiles(prompt, visionFiles, { maxOutputTokens: 8192, temperature: 0.5 })
          : await gemini.generateJSON(prompt, { maxOutputTokens: 8192, temperature: 0.5 });

        if (includeMeta) {
          overview = String(parsed.overview || '').trim();
          if (visionFiles) {
            const transcript = String(parsed.transcript || '').trim();
            if (!transcript) throw new Error('AI could not read this file — try the "Text Only" option or paste the note instead.');
            combinedText = [transcript, pendingDocxText].filter(Boolean).join('\n\n').slice(0, 100000);
          }
        }

        const batchSections = Array.isArray(parsed.sections)
          ? parsed.sections
              .map(s => ({ heading: String(s.heading || '').trim(), explanation: String(s.explanation || '').trim() }))
              .filter(s => s.heading && s.explanation)
          : [];
        if (batchSections.length === 0) break;
        allSections.push(...batchSections);
        coveredHeadings.push(...batchSections.map(s => s.heading));
        if (batch > 0 && batchSections.length < askFor * 0.5) break;
      }
    } catch (aiErr) {
      console.error('[tutor] sections AI error:', aiErr.message);
      if (allSections.length === 0)
        return res.status(500).json({ error: `AI failed to break down this note: ${aiErr.message}` });
    }

    if (allSections.length === 0)
      return res.status(500).json({ error: 'AI returned no usable sections — try again.' });

    const session = await TutorSession.create({
      userId:   req.user.userId,
      title,
      subject,
      uploadedFiles,
      combinedText,
      overview,
      sections: allSections.slice(0, MAX_SECTIONS).map(s => ({ ...s, read: false, quizId: null, flashcardSetId: null })),
    });

    res.json({
      success:      true,
      id:           session._id,
      title:        session.title,
      subject:      session.subject,
      overview:     session.overview,
      totalSections: session.sections.length,
      filesProcessed: uploadedFiles.length,
    });
  } catch (err) {
    console.error('[tutor] /create unexpected error:', err.message);
    res.status(500).json({ error: `Unexpected error: ${err.message || 'unknown'}` });
  }
});

// ── GET /api/tutor/sessions ───────────────────────────────────────────────────
router.get('/sessions', auth, async (req, res) => {
  try {
    const sessions = await TutorSession.find({ userId: req.user.userId })
      .select('-combinedText -sections.explanation').sort({ createdAt: -1 }).lean();
    const now = new Date();
    const withDue = sessions.map(s => ({
      ...s,
      dueForReviewCount: (s.sections || []).filter(sec => sec.reviewDueAt && new Date(sec.reviewDueAt) <= now).length,
    }));
    res.json({ success: true, sessions: withDue });
  } catch (err) {
    res.status(500).json({ error: `Failed to fetch tutor sessions: ${err.message}` });
  }
});

// ── GET /api/tutor/:id ─────────────────────────────────────────────────────────
router.get('/:id', auth, async (req, res) => {
  try {
    const session = await TutorSession.findOne({ _id: req.params.id, userId: req.user.userId })
      .select('-combinedText').lean();
    if (!session) return res.status(404).json({ error: 'Tutor session not found.' });
    res.json({ success: true, session });
  } catch (err) {
    res.status(500).json({ error: `Failed to fetch tutor session: ${err.message}` });
  }
});

// ── DELETE /api/tutor/:id ───────────────────────────────────────────────────────
router.delete('/:id', auth, async (req, res) => {
  try {
    await TutorSession.deleteOne({ _id: req.params.id, userId: req.user.userId });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: `Failed to delete: ${err.message}` });
  }
});

// Learn -> Understand -> Recall -> Practice -> Review. The fixed cadence a
// section's spaced reviews are due on: first review 1 day after Learn, then
// 3 days after that, then 7 days after that — "later that day/next day /
// a few days later / the following week". Index 0 is used when a section is
// first marked read; after completing review N (reviewStage becomes N),
// REVIEW_INTERVALS_DAYS[N] schedules the next one.
const REVIEW_INTERVALS_DAYS = [1, 3, 7];

// ── POST /api/tutor/:id/section/:index/complete ─────────────────────────────
// Marks a section read (Learn) and advances the pointer, starting its Review
// clock. No AI call — purely bookkeeping, called the moment the student
// finishes reading a section (before they decide whether to take the
// quiz/flashcard check).
router.post('/:id/section/:index/complete', auth, async (req, res) => {
  try {
    const session = await TutorSession.findOne({ _id: req.params.id, userId: req.user.userId });
    if (!session) return res.status(404).json({ error: 'Tutor session not found.' });

    const idx = parseInt(req.params.index, 10);
    if (!Number.isInteger(idx) || idx < 0 || idx >= session.sections.length)
      return res.status(400).json({ error: 'Invalid section index.' });

    const section = session.sections[idx];
    section.read = true;
    if (!section.reviewDueAt && section.reviewStage === 0) {
      section.reviewDueAt = new Date(Date.now() + REVIEW_INTERVALS_DAYS[0] * 86400000);
    }
    session.currentSectionIndex = Math.max(session.currentSectionIndex, Math.min(idx + 1, session.sections.length - 1));
    const allRead = session.sections.every(s => s.read);
    if (allRead) session.status = 'completed';
    await session.save();

    res.json({
      success: true,
      allRead,
      nextIndex: idx + 1 < session.sections.length ? idx + 1 : null,
      reviewDueAt: section.reviewDueAt,
    });
  } catch (err) {
    res.status(500).json({ error: `Failed to update section: ${err.message}` });
  }
});

// ── POST /api/tutor/:id/section/:index/recall ───────────────────────────────
// Recall — the student writes what they remember WITHOUT looking back at the
// section (closed-book), and the AI checks it against the real content.
// Distinct from the Understand chat, which happens with the material still
// on screen. Never required to move on, just tracked for the stage tracker.
router.post('/:id/section/:index/recall', auth, async (req, res) => {
  try {
    if (!gemini.ready)
      return res.status(503).json({ error: 'AI service is temporarily unavailable. Please try again shortly.' });

    const attempt = (req.body?.attempt || '').trim();
    if (!attempt) return res.status(400).json({ error: 'Write what you remember first.' });

    const session = await TutorSession.findOne({ _id: req.params.id, userId: req.user.userId });
    if (!session) return res.status(404).json({ error: 'Tutor session not found.' });

    const idx = parseInt(req.params.index, 10);
    const section = session.sections[idx];
    if (!section) return res.status(400).json({ error: 'Invalid section index.' });

    const prompt = `A student just tried to recall this section from memory, WITHOUT looking at the material — this tests real retention, not recognition ("recognition feels like knowing — recall proves it").

Section: "${section.heading}"
Actual content: ${section.explanation}

What the student wrote from memory: "${attempt.slice(0, 3000)}"

Give quick, encouraging feedback: what they got right, and specifically what they missed or got wrong, naming the actual point so they can close the gap — don't just say "you missed some details." Keep it short (3-5 sentences).

Return ONLY valid JSON: { "verdict": "strong" | "partial" | "weak", "feedback": "..." }`;

    let parsed;
    try {
      parsed = await gemini.generateJSON(prompt, { maxOutputTokens: 500, temperature: 0.5 });
    } catch (aiErr) {
      console.error('[tutor] recall AI error:', aiErr.message);
      return res.status(500).json({ error: 'AI failed to check your recall. Try again.' });
    }
    if (!parsed.feedback) return res.status(500).json({ error: 'AI returned an empty response.' });

    section.recallDone = true;
    section.lastRecallAttempt = attempt.slice(0, 2000);
    await session.save();

    res.json({ success: true, verdict: parsed.verdict || 'partial', feedback: parsed.feedback });
  } catch (err) {
    console.error('[tutor] recall error:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── POST /api/tutor/:id/section/:index/review-complete ─────────────────────
// Review — marks one spaced-review pass done for this section and schedules
// the next one (or clears the due date once the 3-pass cycle is finished).
router.post('/:id/section/:index/review-complete', auth, async (req, res) => {
  try {
    const session = await TutorSession.findOne({ _id: req.params.id, userId: req.user.userId });
    if (!session) return res.status(404).json({ error: 'Tutor session not found.' });

    const idx = parseInt(req.params.index, 10);
    const section = session.sections[idx];
    if (!section) return res.status(400).json({ error: 'Invalid section index.' });

    const nextStage = Math.min(3, (section.reviewStage || 0) + 1);
    section.reviewStage = nextStage;
    section.reviewDueAt = nextStage < 3
      ? new Date(Date.now() + REVIEW_INTERVALS_DAYS[nextStage] * 86400000)
      : null;
    await session.save();

    res.json({ success: true, reviewStage: section.reviewStage, reviewDueAt: section.reviewDueAt });
  } catch (err) {
    res.status(500).json({ error: `Failed to update review: ${err.message}` });
  }
});

// ── POST /api/tutor/:id/section/:index/chat ─────────────────────────────────
// Conversational comprehension check, grounded in just this one section —
// same "AI opens with a question, student responds" pattern as Catch-Up and
// Exam Mode's Q&A phase. Deliberately ephemeral (not persisted server-side,
// same as those two) — the frontend fires `start` fresh each time a section
// is opened, so reopening a section later always begins with a new check
// rather than replaying a stale conversation.
router.post('/:id/section/:index/chat', auth, async (req, res) => {
  try {
    if (!gemini.ready)
      return res.status(503).json({ error: 'AI service is temporarily unavailable. Please try again shortly.' });

    const { message, history, start } = req.body;
    if (!start && (!message || !message.trim())) return res.status(400).json({ error: 'message is required' });

    const session = await TutorSession.findOne({ _id: req.params.id, userId: req.user.userId });
    if (!session) return res.status(404).json({ error: 'Tutor session not found.' });

    const idx = parseInt(req.params.index, 10);
    const section = session.sections[idx];
    if (!section) return res.status(400).json({ error: 'Invalid section index.' });

    const historyText = Array.isArray(history)
      ? history.slice(-6).map(h => `${h.role === 'user' ? 'Student' : 'Tutor'}: ${h.content}`).join('\n')
      : '';

    const prompt = start
      ? `You are a patient, expert tutor turning information into real understanding with a student on ONE section they just read — not testing recall yet, that comes later. The goal right now is Feynman-style: can they explain it simply, in their own words, and do they understand WHY it works?

Subject: ${session.subject}
Section: "${section.heading}"
${section.explanation}

This is the very first message — nothing from the student to respond to yet. Open by asking ONE genuinely good question that pushes them to explain this section back in their own words or explain WHY it works, not just recite it (not trivial recall — something that checks real understanding). You may add one short, warm sentence before it, but get to the question quickly.

Return ONLY valid JSON: { "reply": "..." }`
      : `You are a patient, expert tutor helping a student understand ONE section of their notes.

Subject: ${session.subject}
Section: "${section.heading}"
${section.explanation}
${historyText ? `\nConversation so far:\n${historyText}\n` : ''}
Student's new message: "${message.trim()}"

Respond to their message, drawing only on this section — answer if they asked something, correct them gently if they misunderstood, give feedback if they just answered a question of yours — THEN ask another question yourself so they always have something of yours to answer rather than being left to think of their own. If a calculation is involved, show the full step-by-step working, not just the final answer. No markdown headers.

Match your length to the question: a quick/direct question gets a short, direct answer (1-3 sentences) plus your next question — don't pad it out. When they ask for an explanation, say "explain", "why", "I don't get it", or ask something genuinely conceptual, go as deep and thorough as the topic needs, but still follow it with your next question once you're done.

Return ONLY valid JSON: { "reply": "..." }`;

    let reply;
    try {
      const parsed = await gemini.generateJSON(prompt, { maxOutputTokens: 1200, temperature: 0.7 });
      reply = parsed.reply;
    } catch (aiErr) {
      console.error('[tutor] section chat AI error:', aiErr.message);
      return res.status(500).json({ error: 'AI failed to respond. Try again.' });
    }
    if (!reply) return res.status(500).json({ error: 'AI returned an empty response.' });

    res.json({ success: true, reply });
  } catch (err) {
    console.error('[tutor] section chat error:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── Shared section quiz/flashcard generation ─────────────────────────────────
function buildSectionQuizPrompt(session, section, askFor) {
  return `You are an expert exam question creator for ${session.subject}.
Based ONLY on this specific section of a student's notes, generate a short multiple-choice check of their understanding.

${DISCIPLINE_MCQ_INSTRUCTION}

Section: "${section.heading}"
${section.explanation}

RULES:
- Each question has exactly 4 options (A, B, C, D), one correct answer, plausible distractors
- correctAnswer is the 0-based index of the correct option
- Test ONLY this section's content, not the wider note

Return ONLY valid JSON:
{ "questions": [ { "question": "...", "options": ["A","B","C","D"], "correctAnswer": 0, "explanation": "..." } ] }
Write up to ${askFor} questions — but only if the section genuinely supports that many distinct questions.`;
}

router.post('/:id/section/:index/quiz', auth, async (req, res) => {
  try {
    if (!gemini.ready)
      return res.status(503).json({ error: 'AI service is temporarily unavailable. Please try again shortly.' });

    const session = await TutorSession.findOne({ _id: req.params.id, userId: req.user.userId });
    if (!session) return res.status(404).json({ error: 'Tutor session not found.' });

    const idx = parseInt(req.params.index, 10);
    const section = session.sections[idx];
    if (!section) return res.status(400).json({ error: 'Invalid section index.' });

    if (section.quizId) {
      return res.json({ success: true, quizId: section.quizId, alreadyGenerated: true });
    }

    let raw;
    try {
      const parsed = await gemini.generateJSON(buildSectionQuizPrompt(session, section, 5), { maxOutputTokens: 4096, temperature: 0.5 });
      raw = Array.isArray(parsed.questions) ? parsed.questions : [];
    } catch (aiErr) {
      console.error('[tutor] section quiz AI error:', aiErr.message);
      return res.status(503).json({ error: 'AI is temporarily unavailable. Please try again in a moment.' });
    }

    const questions = raw
      .filter(q => q.question && Array.isArray(q.options) && q.options.length >= 2)
      .map(q => ({
        question:      q.question,
        options:       q.options.slice(0, 4),
        correctAnswer: typeof q.correctAnswer === 'number' ? Math.min(q.correctAnswer, q.options.length - 1) : 0,
        modelAnswer:   '',
        explanation:   q.explanation || '',
        topic:         section.heading,
      }));
    if (questions.length === 0)
      return res.status(500).json({ error: 'AI returned no usable questions. Please try again.' });

    const quiz = await Quiz.create({
      userId:         req.user.userId,
      title:          `${session.title} — ${section.heading}`,
      subject:        session.subject,
      difficulty:     'medium',
      timeLimit:      Math.max(10, Math.ceil(questions.length * 1.5)),
      numQuestions:   questions.length,
      questionType:   'mcq',
      questions,
      isPublic:       false,
      isAdminCreated: false,
    });

    section.quizId = quiz._id;
    await session.save();

    res.json({ success: true, quizId: quiz._id, numQuestions: quiz.numQuestions });
  } catch (err) {
    console.error('[tutor] section quiz error:', err.message);
    res.status(500).json({ error: `Quiz generation failed: ${err.message || 'unknown'}` });
  }
});

router.post('/:id/section/:index/flashcards', auth, async (req, res) => {
  try {
    if (!gemini.ready)
      return res.status(503).json({ error: 'AI service is temporarily unavailable. Please try again shortly.' });

    const session = await TutorSession.findOne({ _id: req.params.id, userId: req.user.userId });
    if (!session) return res.status(404).json({ error: 'Tutor session not found.' });

    const idx = parseInt(req.params.index, 10);
    const section = session.sections[idx];
    if (!section) return res.status(400).json({ error: 'Invalid section index.' });

    if (section.flashcardSetId) {
      return res.json({ success: true, flashcardSetId: section.flashcardSetId, alreadyGenerated: true });
    }

    const prompt = `You are an expert flashcard creator. Generate 5 high-quality flashcards from this section of a student's notes.
Subject: ${session.subject}
Section: "${section.heading}"
${section.explanation}
Return ONLY a valid JSON array, no markdown:
[{"question":"...","answer":"..."}]`;

    let cards = [];
    try {
      const parsed = await gemini.generateJSON(prompt, { maxOutputTokens: 1024, temperature: 0.5 });
      cards = Array.isArray(parsed) ? parsed : parsed?.cards || parsed?.flashcards || [];
    } catch (aiErr) {
      console.error('[tutor] section flashcards AI error:', aiErr.message);
      return res.status(503).json({ error: 'AI is temporarily unavailable. Please try again in a moment.' });
    }

    cards = cards
      .map(c => ({ question: (c.question || '').trim(), answer: (c.answer || '').trim() }))
      .filter(c => c.question && c.answer);
    if (cards.length === 0)
      return res.status(500).json({ error: 'AI returned no usable flashcards. Please try again.' });

    const flashcardSet = await FlashcardSet.create({
      userId:  req.user.userId,
      title:   `${session.title} — ${section.heading}`,
      subject: session.subject,
      cards:   cards.map(c => ({ question: c.question, answer: c.answer, masteryLevel: 0, topic: section.heading })),
      isPublic: false,
      sourceText: section.explanation,
    });

    section.flashcardSetId = flashcardSet._id;
    await session.save();

    res.json({ success: true, flashcardSetId: flashcardSet._id, count: cards.length });
  } catch (err) {
    console.error('[tutor] section flashcards error:', err.message);
    res.status(500).json({ error: `Flashcard generation failed: ${err.message || 'unknown'}` });
  }
});

// ── POST /api/tutor/:id/readiness ───────────────────────────────────────────
// Final exam/study readiness report once every section has been read —
// combines how much was covered with how well any section quizzes went.
router.post('/:id/readiness', auth, async (req, res) => {
  try {
    const session = await TutorSession.findOne({ _id: req.params.id, userId: req.user.userId });
    if (!session) return res.status(404).json({ error: 'Tutor session not found.' });

    const quizIds = session.sections.map(s => s.quizId).filter(Boolean);
    const results = quizIds.length > 0
      ? await QuizResult.find({ userId: req.user.userId, quizId: { $in: quizIds } }).sort({ createdAt: -1 }).lean()
      : [];
    // Best (most recent) result per quiz, in case a section quiz was retaken.
    const bestByQuiz = new Map();
    for (const r of results) {
      const key = r.quizId.toString();
      if (!bestByQuiz.has(key)) bestByQuiz.set(key, r);
    }
    const scores = [...bestByQuiz.values()].map(r => r.score);
    const avgScore = scores.length > 0 ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) : null;
    const sectionsRead = session.sections.filter(s => s.read).length;
    const coveragePct  = Math.round((sectionsRead / session.sections.length) * 100);

    let readiness;
    if (gemini.ready) {
      try {
        const prompt = `A student just finished an AI Tutor walkthrough of their own notes on "${session.subject}" (${session.title}).
Coverage: ${sectionsRead}/${session.sections.length} sections read (${coveragePct}%).
${avgScore !== null ? `Section quiz checks taken: ${scores.length}, average score ${avgScore}%.` : 'They did not take any section quiz checks.'}

Write a short, encouraging exam/study readiness assessment.
Return ONLY valid JSON: { "score": 0-100 overall readiness, "summary": "2-3 sentences on where they stand", "recommendation": "1-2 sentences on the single best next action (e.g. retake weak section quizzes, take a full practice exam, move to the next topic)" }`;
        const parsed = await gemini.generateJSON(prompt, { maxOutputTokens: 512, temperature: 0.6 });
        readiness = {
          score: typeof parsed.score === 'number' ? Math.max(0, Math.min(100, Math.round(parsed.score))) : (avgScore ?? coveragePct),
          summary: String(parsed.summary || '').trim(),
          recommendation: String(parsed.recommendation || '').trim(),
        };
      } catch (aiErr) {
        console.error('[tutor] readiness AI error (falling back):', aiErr.message);
      }
    }
    if (!readiness) {
      const score = avgScore !== null ? Math.round((avgScore + coveragePct) / 2) : coveragePct;
      readiness = {
        score,
        summary: `You've read ${sectionsRead} of ${session.sections.length} sections (${coveragePct}% coverage)${avgScore !== null ? ` with an average section-quiz score of ${avgScore}%` : ''}.`,
        recommendation: scores.length < session.sections.length
          ? 'Take the quick quiz check on any section you skipped, then revisit the ones you scored lowest on.'
          : 'Try a full practice exam next to confirm you can apply this under time pressure.',
      };
    }

    session.readiness = readiness;
    session.status = 'completed';
    await session.save();

    res.json({ success: true, readiness, sectionsRead, totalSections: session.sections.length, avgScore });
  } catch (err) {
    console.error('[tutor] readiness error:', err.message);
    res.status(500).json({ error: `Failed to compute readiness: ${err.message || 'unknown'}` });
  }
});

module.exports = router;
