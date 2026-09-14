// routes/forecaster.js
const express      = require('express');
const router       = express.Router();
const auth         = require('../middlewares/auth');
const ExamForecast = require('../models/ExamForecast');
const Quiz         = require('../models/Quiz');
const { gemini }   = require('../utils/ai');
const { getUserPlan, getPlanFeatures } = require('../utils/subscription');

// Middleware: only monthly_group and yearly_group can access the forecaster
async function requireForecasterAccess(req, res, next) {
  try {
    const plan     = await getUserPlan(req.user.userId);
    const features = getPlanFeatures(plan);
    if (!features.forecaster) {
      return res.status(403).json({
        error:    'plan_required',
        message:  'The Question Forecaster is available on all paid plans except Exam Mode.',
        required: 'weekly_group',
      });
    }
    next();
  } catch (err) {
    next(); // fail open so a DB error doesn't permanently lock users out
  }
}

const { extractPdfText, pdfParseAvailable } = require('../utils/pdfExtract');

console.log('[forecaster] pdfParse:', pdfParseAvailable() ? 'loaded' : 'UNAVAILABLE');
console.log('[forecaster] gemini ready:', gemini.ready);

// ── helpers ───────────────────────────────────────────────────────────────────
function sanitisePatterns(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .map(p => ({
      topic:        String(p.topic        || '').trim(),
      frequency:    Number.isFinite(Number(p.frequency)) ? Math.round(Number(p.frequency)) : 1,
      confidence:   ['High', 'Medium', 'Low'].includes(p.confidence) ? p.confidence : 'Medium',
      lastAppeared: String(p.lastAppeared || '').trim(),
    }))
    .filter(p => p.topic.length > 0)
    .slice(0, 15);
}

async function extractTextFromFiles(files) {
  if (!pdfParseAvailable()) throw new Error('PDF parser is not available on this server. Please paste your exam questions as text instead.');
  const chunks = [];
  const meta   = [];
  for (const file of files) {
    try {
      const text = (await extractPdfText(file.data)).trim();
      if (!text) { console.warn(`[forecaster] No text in ${file.name} (likely scanned image)`); continue; }
      chunks.push(`=== ${file.name} ===\n${text.slice(0, 30000)}`);
      meta.push({ name: file.name, textLength: text.length });
    } catch (e) {
      console.warn(`[forecaster] pdf-parse failed for ${file.name}: ${e.message}`);
    }
  }
  if (chunks.length === 0)
    throw new Error('Could not extract text from any uploaded PDF. The files may be scanned images. Please paste the exam questions as text instead.');
  return { chunks, meta };
}

// ── GET /api/forecaster/health (no auth) ─────────────────────────────────────
router.get('/health', async (req, res) => {
  let aiStatus = gemini.ready ? 'checking…' : 'not initialized — no API keys configured';
  if (gemini.ready) {
    try {
      await gemini.generateJSON('Return exactly: {"ok":true}', { maxOutputTokens: 20 });
      aiStatus = 'ok';
    } catch (e) { aiStatus = `error: ${e.message}`; }
  }
  res.json({ ai: aiStatus, pdfParse: pdfParseAvailable(), keys: gemini.keyCount });
});

// ── POST /api/forecaster/analyze ─────────────────────────────────────────────
// Accepts EITHER:
//   multipart: fields { examSubject } + files { pdfs }
//   JSON:      { examSubject, pastedText }
router.post('/analyze', auth, requireForecasterAccess, async (req, res) => {
  try {
    if (!gemini.ready)
      return res.status(503).json({ error: 'AI service is temporarily unavailable. Please try again shortly.' });

    const examSubject = (req.body?.examSubject || '').trim();
    if (!examSubject)
      return res.status(400).json({ error: 'Exam subject is required.' });

    // 'vision' sends the raw PDF(s) straight to Gemini so diagrams/charts in
    // past papers (graphs, circuit diagrams, labeled figures) are actually
    // read, not just whatever text pdf-parse could pull out. Defaults to
    // 'text' so older cached frontend bundles keep working.
    const extractionMode = req.body?.extractionMode === 'vision' ? 'vision' : 'text';

    let uploadedFiles = [];
    let combinedText  = '';
    let visionFiles   = null;

    // ── Path A: pasted text (JSON body) — always text-only ────────────────────
    if (req.body?.pastedText?.trim()) {
      combinedText  = req.body.pastedText.trim().slice(0, 60000);
      uploadedFiles = [{ name: 'Pasted text', textLength: combinedText.length }];

    // ── Path B: PDF upload (multipart) ───────────────────────────────────────
    } else if (req.files && Object.keys(req.files).length > 0) {
      const rawFiles = req.files.pdfs || Object.values(req.files)[0];
      const fileList = Array.isArray(rawFiles) ? rawFiles : [rawFiles];

      if (extractionMode === 'vision') {
        visionFiles   = fileList.map(f => ({ data: f.data, mimeType: f.mimetype || 'application/pdf' }));
        uploadedFiles = fileList.map(f => ({ name: f.name, textLength: f.data.length }));
      } else {
        try {
          const { chunks, meta } = await extractTextFromFiles(fileList);
          combinedText  = chunks.join('\n\n').slice(0, 60000);
          uploadedFiles = meta;
        } catch (extractErr) {
          return res.status(422).json({ error: extractErr.message });
        }
      }
    } else {
      return res.status(400).json({ error: 'Send either PDF files (field: pdfs) or a pastedText body field.' });
    }

    if (extractionMode === 'text' && !combinedText.trim())
      return res.status(422).json({ error: 'No usable text found. Please check your PDFs or paste the exam content directly.' });

    // ── AI analysis ───────────────────────────────────────────────────────────
    console.log(`[forecaster] Analysing ${examSubject} — ${extractionMode} mode, ${uploadedFiles.length} source(s)`);

    const contentSection = extractionMode === 'vision'
      ? `The past exam papers are attached as PDF file(s) — read all text AND any diagrams, charts, tables, or figures they contain.`
      : `CONTENT:\n${combinedText}`;

    const analysisPrompt = `You are an expert exam analyst preparing to help a student pass ${examSubject} at a genuinely professional/certification standard (e.g. ICAN-level). Thoroughly analyse ALL of the material below — every past question paper AND every examiner's report, marking scheme, or similar feedback document included, not just the first one. Do not skim; read every page provided before answering.

${contentSection}

TASK:
1. Identify the most frequently tested topics across every paper given.
2. If any examiner's report / marking guide / chief examiner's comments are present in the material, use them to judge the REAL expected depth, rigor, and common candidate failure points for each topic — not just that the topic was mentioned.
3. Capture that expected standard in "expectedStandard" so future mock questions can be pitched at the same real difficulty as the genuine exam, not a simplified version of it.

Return ONLY valid JSON (no markdown, no extra text):
{
  "analysisSummary": "One sentence summary of the main exam patterns.",
  "expectedStandard": "1-3 sentences on the real difficulty/depth expected, drawing on any examiner's report content found (expected computation depth, common mistakes penalized, how marks are actually awarded). If no examiner's report was provided, infer standard from the question phrasing itself.",
  "patterns": [
    { "topic": "Topic name", "frequency": 4, "confidence": "High", "lastAppeared": "2024" }
  ]
}

RULES:
- analysisSummary MUST be ONE sentence only, under 25 words
- expectedStandard: 1-3 sentences, be concrete (not "questions are hard" but what specifically makes them hard)
- frequency = integer count of how many times topic appeared
- confidence = exactly one of: "High", "Medium", "Low"
- Return 6 to 10 patterns, sorted by frequency descending
- Keep topic names concise (2-5 words max)`;

    let patterns         = [];
    let analysisSummary  = '';
    let expectedStandard = '';

    try {
      const parsed = extractionMode === 'vision'
        ? await gemini.generateJSONFromFiles(analysisPrompt, visionFiles, { maxOutputTokens: 8192, temperature: 0.4 })
        : await gemini.generateJSON(analysisPrompt, { maxOutputTokens: 8192, temperature: 0.4 });
      if (typeof parsed.analysisSummary === 'string' && parsed.analysisSummary) {
        analysisSummary = parsed.analysisSummary;
      }
      if (typeof parsed.expectedStandard === 'string' && parsed.expectedStandard) {
        expectedStandard = parsed.expectedStandard;
      }
      patterns = sanitisePatterns(parsed.patterns);
      if (patterns.length === 0) throw new Error('AI returned zero patterns — try uploading more content.');
    } catch (aiErr) {
      console.error('[forecaster] AI analysis error:', aiErr.message);
      return res.status(500).json({ error: `AI analysis failed: ${aiErr.message}` });
    }

    // ── Save to DB ────────────────────────────────────────────────────────────
    let forecast;
    try {
      forecast = await ExamForecast.create({
        userId: req.user.userId,
        examSubject,
        uploadedFiles,
        combinedText,
        analysisComplete: true,
        analysisSummary,
        expectedStandard,
        patterns,
      });
    } catch (dbErr) {
      console.error('[forecaster] DB create error:', dbErr.message);
      return res.status(500).json({ error: `Database error: ${dbErr.message}` });
    }

    console.log(`[forecaster] Created forecast ${forecast._id} with ${patterns.length} patterns`);

    res.json({
      success:          true,
      forecastId:       forecast._id,
      analysisSummary:  forecast.analysisSummary,
      expectedStandard: forecast.expectedStandard,
      patterns:         forecast.patterns,
      filesProcessed:   uploadedFiles.length,
    });

  } catch (err) {
    console.error('[forecaster] /analyze unexpected error:', err.message, err.stack?.split('\n')[1]);
    res.status(500).json({ error: `Unexpected error: ${err.message || 'unknown'}` });
  }
});

const MOCK_EXAM_MAX_QUESTIONS = 40; // professional/certification-exam length ceiling
const MOCK_EXAM_BATCH_SIZE    = 20;
const MOCK_EXAM_MAX_BATCHES   = 2; // 2 × 20 = 40 — stays well inside Vercel's 60s limit

// ── POST /api/forecaster/:forecastId/generate-mock-exam ──────────────────────
// Body (all optional): { topics: string[], numQuestions: number }
// topics defaults to every pattern found during analysis; numQuestions
// defaults to 20, capped at MOCK_EXAM_MAX_QUESTIONS.
router.post('/:forecastId/generate-mock-exam', auth, requireForecasterAccess, async (req, res) => {
  try {
    if (!gemini.ready)
      return res.status(503).json({ error: 'AI service is temporarily unavailable. Please try again shortly.' });

    const forecast = await ExamForecast.findOne({ _id: req.params.forecastId, userId: req.user.userId });
    if (!forecast)              return res.status(404).json({ error: 'Forecast not found.' });
    if (!forecast.analysisComplete)
      return res.status(400).json({ error: 'Analyse papers first before generating a mock exam.' });

    const allTopics = (forecast.patterns || []).map(p => p.topic).filter(Boolean);
    const requestedTopics = Array.isArray(req.body?.topics)
      ? req.body.topics.filter(t => allTopics.includes(t))
      : [];
    const topics = requestedTopics.length > 0 ? requestedTopics : allTopics;
    if (topics.length === 0) return res.status(400).json({ error: 'No topics available to build a mock exam from — analyse past papers first.' });

    const requestedCount = parseInt(req.body?.numQuestions, 10);
    const targetCount = Number.isFinite(requestedCount) && requestedCount > 0
      ? Math.min(requestedCount, MOCK_EXAM_MAX_QUESTIONS)
      : 20;

    // The real past-paper text (and any examiner's report content pasted or
    // uploaded alongside it) — this is what lets the mock exam genuinely
    // match the source material's actual standard, instead of inventing
    // generic questions from a bare topic-name list.
    const sourceMaterial = (forecast.combinedText || '').slice(0, 40000);

    let allQuestions  = [];
    let coveredTopics = [];
    for (let batch = 0; batch < MOCK_EXAM_MAX_BATCHES && allQuestions.length < targetCount; batch++) {
      const askFor = Math.min(MOCK_EXAM_BATCH_SIZE, targetCount - allQuestions.length);
      const mockPrompt = `You are a professional examiner setting a mock ${forecast.examSubject} exam at the same rigor as a real professional/certification exam (e.g. ICAN-standard) — extremely hard, testing genuine application and reasoning, not simple recall.

${sourceMaterial ? `Here is the actual source material — real past exam papers and/or examiner's reports for this subject. Study it closely: match its real difficulty, phrasing style, and depth, and draw directly on the specific content, figures, and scenarios in it wherever relevant, not just the topic names.\n\n${sourceMaterial}\n` : ''}
Analysis summary: ${forecast.analysisSummary || 'Not available.'}
${forecast.expectedStandard ? `Expected real-exam standard (from examiner's report / paper analysis) — your questions MUST match this depth, not a simplified version of it: ${forecast.expectedStandard}\n` : ''}
ONLY write questions on these exact topics — the student deliberately selected only these, so do NOT write a question on any other topic even if it also appears in the source material below: ${topics.join(', ')}
${coveredTopics.length ? `\nQuestions already written this session covering: ${coveredTopics.join('; ')}. Do not repeat these — cover different angles or sub-topics within the SAME allowed topic list above.` : ''}

Mix multiple-choice (objective) and short-answer/essay (theory) questions, in whatever proportion is conventional for a real ${forecast.examSubject} exam.

Return ONLY valid JSON (no markdown, no extra text):
{
  "questions": [
    { "type": "mcq", "question": "...", "options": ["A","B","C","D"], "correctAnswer": 0, "workingScratchpad": "for numeric MCQs: do your full computation here, including a second independent recomputation to double-check — messy work-in-progress, false starts, and self-corrections are fine in THIS field only, it is never shown to the student", "explanation": "the short, clean, confident, FINAL explanation shown to the student — written as if you always knew the answer, never mentioning the scratchpad or any earlier mistake", "topic": "specific sub-topic tested, e.g. 'Depreciation'" },
    { "type": "essay", "question": "...", "modelAnswer": "...", "topic": "specific sub-topic tested" }
  ]
}

CRITICAL for MCQ accuracy: for every numeric/computational MCQ, use "workingScratchpad" to work the answer out step by step AND independently recompute it a second time to confirm both attempts agree — before writing the 4 options, make sure exactly one of them equals the value you actually verified in the scratchpad (not an earlier draft of it). "explanation" must be derived strictly from your final, verified scratchpad answer, contain zero hesitation or recomputation, and never say things like "closest answer" — if the options and your verified answer don't match, fix the options, don't rationalize the mismatch into the explanation.
Write up to ${askFor} questions — but only if the material and the allowed topics genuinely support that many distinct, non-repetitive, hard questions. Return fewer rather than pad with filler.`;

      let batchRaw;
      try {
        const parsed = await gemini.generateJSON(mockPrompt, { maxOutputTokens: 8192, temperature: 0.6 });
        batchRaw = Array.isArray(parsed.questions) ? parsed.questions : [];
      } catch (aiErr) {
        console.error('[forecaster] mock exam AI error:', aiErr.message);
        if (allQuestions.length > 0) break;
        return res.status(500).json({ error: `AI failed to generate mock exam: ${aiErr.message}` });
      }
      if (batchRaw.length === 0) break;
      allQuestions.push(...batchRaw);
      coveredTopics.push(...batchRaw.map(q => q.topic).filter(Boolean));
      if (batch > 0 && batchRaw.length < askFor * 0.5) break;
    }

    if (allQuestions.length === 0)
      return res.status(500).json({ error: 'AI returned no usable questions.' });

    const mcq   = allQuestions.filter(q => q.type === 'mcq');
    const essay = allQuestions.filter(q => q.type === 'essay');
    const questionType = mcq.length > 0 && essay.length > 0 ? 'mixed' : mcq.length > 0 ? 'mcq' : 'essay';

    const quizQuestions = allQuestions
      .slice(0, targetCount)
      .map(q =>
        q.type === 'mcq'
          ? { question: q.question, options: (q.options || []).slice(0, 4), correctAnswer: Number(q.correctAnswer) || 0, modelAnswer: '', explanation: q.explanation || '', topic: q.topic || '' }
          : { question: q.question, options: [], correctAnswer: null, modelAnswer: q.modelAnswer || '', explanation: '', topic: q.topic || '' }
      );

    const quiz = await Quiz.create({
      userId: req.user.userId, title: `${forecast.examSubject} — AI Mock Exam`,
      subject: forecast.examSubject, difficulty: 'hard',
      timeLimit: Math.max(30, quizQuestions.length * 3),
      numQuestions: quizQuestions.length, questionType,
      questions: quizQuestions, isPublic: false, isAdminCreated: false,
    });

    forecast.mockExamQuizId = quiz._id;
    forecast.mockExamTitle  = quiz.title;
    forecast.updatedAt      = new Date();
    await forecast.save();

    res.json({ success: true, quizId: quiz._id, quizTitle: quiz.title, numQuestions: quiz.numQuestions });
  } catch (err) {
    console.error('[forecaster] generate-mock-exam error:', err.message);
    res.status(500).json({ error: `Mock exam generation failed: ${err.message || 'unknown'}` });
  }
});

// ── POST /api/forecaster/:forecastId/after-attempt ───────────────────────────
router.post('/:forecastId/after-attempt', auth, async (req, res) => {
  try {
    if (!gemini.ready) return res.status(503).json({ error: 'AI service is temporarily unavailable. Please try again shortly.' });

    const { score, regenerate } = req.body;
    const forecast = await ExamForecast.findOne({ _id: req.params.forecastId, userId: req.user.userId });
    if (!forecast) return res.status(404).json({ error: 'Forecast not found.' });

    // Only count this as a new mock-exam attempt when it actually is one.
    // The frontend's "Regenerate" / "Generate AI Forecast" buttons call this
    // same endpoint to re-run the AI forecast without a fresh attempt — they
    // pass regenerate:true so the attempts counter shown in the UI doesn't
    // get inflated by re-generating text alone.
    if (!regenerate) {
      forecast.attempts++;
      if (typeof score === 'number') forecast.lastScore = score;
    }
    const effectiveScore = regenerate ? forecast.lastScore : score;

    const topTopics = (forecast.patterns || []).slice(0, 8).map(p => p.topic).join(', ');
    const forecastPrompt = `AI exam forecaster for ${forecast.examSubject}.
Student mock score: ${effectiveScore ?? 'unknown'}%. Top past-paper topics: ${topTopics}.
Analysis: ${forecast.analysisSummary || 'Not available.'}

Predict the 5-8 most likely exam topics and give 3 preparation tips.
Return ONLY valid JSON (no markdown):
{
  "forecastedTopics": [{ "topic": "...", "likelihood": 85, "reason": "...", "confidence": "High" }],
  "preparationAdvice": ["Tip 1","Tip 2","Tip 3"]
}
likelihood = integer 0-100. confidence = exactly "High", "Medium", or "Low".`;

    let forecastedTopics  = [];
    let preparationAdvice = [];
    try {
      const parsed = await gemini.generateJSON(forecastPrompt, { maxOutputTokens: 1024, temperature: 0.5 });
      if (Array.isArray(parsed.forecastedTopics)) {
        forecastedTopics = parsed.forecastedTopics.map(t => ({
          topic:      String(t.topic      || ''),
          likelihood: Number.isFinite(Number(t.likelihood)) ? Math.round(Number(t.likelihood)) : 50,
          reason:     String(t.reason     || ''),
          confidence: ['High','Medium','Low'].includes(t.confidence) ? t.confidence : 'Medium',
        }));
      }
      if (Array.isArray(parsed.preparationAdvice)) preparationAdvice = parsed.preparationAdvice.map(String);
    } catch (aiErr) {
      console.error('[forecaster] after-attempt AI error:', aiErr.message);
    }

    forecast.forecastedTopics  = forecastedTopics;
    forecast.preparationAdvice = preparationAdvice;
    forecast.updatedAt         = new Date();
    await forecast.save();

    res.json({ success: true, forecastedTopics, preparationAdvice });
  } catch (err) {
    console.error('[forecaster] after-attempt error:', err.message);
    res.status(500).json({ error: `Forecast failed: ${err.message || 'unknown'}` });
  }
});

// ── GET /api/forecaster/my-forecasts ─────────────────────────────────────────
router.get('/my-forecasts', auth, requireForecasterAccess, async (req, res) => {
  try {
    const forecasts = await ExamForecast.find({ userId: req.user.userId })
      .select('-combinedText').sort({ createdAt: -1 }).lean();
    res.json({ success: true, forecasts });
  } catch (err) {
    res.status(500).json({ error: `Failed to fetch forecasts: ${err.message}` });
  }
});

// ── GET /api/forecaster/:forecastId ──────────────────────────────────────────
router.get('/:forecastId', auth, async (req, res) => {
  try {
    const forecast = await ExamForecast
      .findOne({ _id: req.params.forecastId, userId: req.user.userId })
      .select('-combinedText').lean();
    if (!forecast) return res.status(404).json({ error: 'Forecast not found.' });
    res.json({ success: true, forecast });
  } catch (err) {
    res.status(500).json({ error: `Failed to fetch forecast: ${err.message}` });
  }
});

// ── DELETE /api/forecaster/:forecastId ───────────────────────────────────────
router.delete('/:forecastId', auth, async (req, res) => {
  try {
    await ExamForecast.deleteOne({ _id: req.params.forecastId, userId: req.user.userId });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: `Failed to delete: ${err.message}` });
  }
});

module.exports = router;
