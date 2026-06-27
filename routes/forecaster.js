// routes/forecaster.js
const express      = require('express');
const router       = express.Router();
const auth         = require('../middlewares/auth');
const ExamForecast = require('../models/ExamForecast');
const Quiz         = require('../models/Quiz');
const { gemini }   = require('../utils/ai');

// ── PDF parser (try lib path first to skip v2 test-fixture; fall back to main) ─
let pdfParse = null;
try       { pdfParse = require('pdf-parse/lib/pdf-parse.js'); }
catch (_) { try { pdfParse = require('pdf-parse'); } catch (_2) {} }

console.log('[forecaster] pdfParse:', pdfParse ? 'loaded' : 'UNAVAILABLE');
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
  if (!pdfParse) throw new Error('PDF parser is not available on this server. Please paste your exam questions as text instead.');
  const chunks = [];
  const meta   = [];
  for (const file of files) {
    try {
      const parsed = await pdfParse(file.data);
      const text   = (parsed.text || '').trim();
      if (!text) { console.warn(`[forecaster] No text in ${file.name} (likely scanned image)`); continue; }
      chunks.push(`=== ${file.name} ===\n${text.slice(0, 8000)}`);
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
  let aiStatus = gemini.ready ? 'checking…' : 'not initialized — GEMINI_API_KEYS missing';
  if (gemini.ready) {
    try {
      await gemini.generateJSON('Return exactly: {"ok":true}', { maxOutputTokens: 20 });
      aiStatus = 'ok';
    } catch (e) { aiStatus = `error: ${e.message}`; }
  }
  res.json({ ai: aiStatus, pdfParse: !!pdfParse, keys: gemini.keyCount });
});

// ── POST /api/forecaster/analyze ──────────────────────────────────────────────
// Accepts EITHER:
//   multipart: fields { examSubject } + files { pdfs }
//   JSON:      { examSubject, pastedText }
router.post('/analyze', auth, async (req, res) => {
  try {
    if (!gemini.ready)
      return res.status(503).json({ error: 'AI unavailable — GEMINI_API_KEYS not set in environment variables.' });

    const examSubject = (req.body?.examSubject || '').trim();
    if (!examSubject)
      return res.status(400).json({ error: 'Exam subject is required.' });

    let uploadedFiles = [];
    let combinedText  = '';

    // ── Path A: pasted text (JSON body) ──────────────────────────────────────
    if (req.body?.pastedText?.trim()) {
      combinedText  = req.body.pastedText.trim().slice(0, 20000);
      uploadedFiles = [{ name: 'Pasted text', textLength: combinedText.length }];

    // ── Path B: PDF upload (multipart) ───────────────────────────────────────
    } else if (req.files && Object.keys(req.files).length > 0) {
      const rawFiles = req.files.pdfs || Object.values(req.files)[0];
      const fileList = Array.isArray(rawFiles) ? rawFiles : [rawFiles];
      try {
        const { chunks, meta } = await extractTextFromFiles(fileList);
        combinedText  = chunks.join('\n\n').slice(0, 20000);
        uploadedFiles = meta;
      } catch (extractErr) {
        return res.status(422).json({ error: extractErr.message });
      }
    } else {
      return res.status(400).json({ error: 'Send either PDF files (field: pdfs) or a pastedText body field.' });
    }

    if (!combinedText.trim())
      return res.status(422).json({ error: 'No usable text found. Please check your PDFs or paste the exam content directly.' });

    // ── AI analysis ───────────────────────────────────────────────────────────
    console.log(`[forecaster] Analysing ${examSubject} — ${combinedText.length} chars, ${uploadedFiles.length} source(s)`);

    const analysisPrompt = `You are an expert exam analyst. Analyse these past ${examSubject} exam questions/papers.

CONTENT:
${combinedText}

TASK: Identify the most frequently tested topics.

Return ONLY valid JSON (no markdown, no extra text):
{
  "analysisSummary": "One sentence summary of the main exam patterns.",
  "patterns": [
    { "topic": "Topic name", "frequency": 4, "confidence": "High", "lastAppeared": "2024" }
  ]
}

RULES:
- analysisSummary MUST be ONE sentence only, under 25 words
- frequency = integer count of how many times topic appeared
- confidence = exactly one of: "High", "Medium", "Low"
- Return 6 to 10 patterns, sorted by frequency descending
- Keep topic names concise (2-5 words max)`;

    let patterns        = [];
    let analysisSummary = '';

    try {
      const parsed = await gemini.generateJSON(analysisPrompt, { maxOutputTokens: 8192, temperature: 0.4 });
      if (typeof parsed.analysisSummary === 'string' && parsed.analysisSummary) {
        analysisSummary = parsed.analysisSummary;
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
        patterns,
      });
    } catch (dbErr) {
      console.error('[forecaster] DB create error:', dbErr.message);
      return res.status(500).json({ error: `Database error: ${dbErr.message}` });
    }

    console.log(`[forecaster] Created forecast ${forecast._id} with ${patterns.length} patterns`);

    res.json({
      success:         true,
      forecastId:      forecast._id,
      analysisSummary: forecast.analysisSummary,
      patterns:        forecast.patterns,
      filesProcessed:  uploadedFiles.length,
    });

  } catch (err) {
    console.error('[forecaster] /analyze unexpected error:', err.message, err.stack?.split('\n')[1]);
    res.status(500).json({ error: `Unexpected error: ${err.message || 'unknown'}` });
  }
});

// ── POST /api/forecaster/:forecastId/generate-mock-exam ──────────────────────
router.post('/:forecastId/generate-mock-exam', auth, async (req, res) => {
  try {
    if (!gemini.ready)
      return res.status(503).json({ error: 'AI unavailable — check GEMINI_API_KEYS.' });

    const forecast = await ExamForecast.findOne({ _id: req.params.forecastId, userId: req.user.userId });
    if (!forecast)              return res.status(404).json({ error: 'Forecast not found.' });
    if (!forecast.analysisComplete)
      return res.status(400).json({ error: 'Analyse papers first before generating a mock exam.' });

    const topTopics = (forecast.patterns || []).slice(0, 8).map(p => p.topic).join(', ') || 'General topics';

    const mockPrompt = `Create a mock ${forecast.examSubject} exam.
Topics to cover: ${topTopics}

Generate exactly 8 MCQ and 4 essay questions (12 total).
Return ONLY valid JSON (no markdown, no extra text):
{
  "questions": [
    { "type": "mcq", "question": "...", "options": ["A","B","C","D"], "correctAnswer": 0, "explanation": "One sentence." },
    { "type": "essay", "question": "...", "modelAnswer": "One sentence model answer." }
  ]
}

STRICT RULES:
- explanation: ONE sentence only
- modelAnswer: ONE sentence only
- options: exactly 4 short strings each`;

    let generated = [];
    try {
      const parsed = await gemini.generateJSON(mockPrompt, { maxOutputTokens: 8192, temperature: 0.6 });
      if (Array.isArray(parsed.questions)) generated = parsed.questions;
      if (generated.length === 0) throw new Error('AI returned empty questions array.');
    } catch (aiErr) {
      console.error('[forecaster] mock exam AI error:', aiErr.message);
      return res.status(500).json({ error: `AI failed to generate mock exam: ${aiErr.message}` });
    }

    const mcq   = generated.filter(q => q.type === 'mcq');
    const essay = generated.filter(q => q.type === 'essay');
    const questionType = mcq.length > 0 && essay.length > 0 ? 'mixed' : mcq.length > 0 ? 'mcq' : 'essay';

    const quizQuestions = generated.map(q =>
      q.type === 'mcq'
        ? { question: q.question, options: (q.options || []).slice(0, 4), correctAnswer: Number(q.correctAnswer) || 0, modelAnswer: '', explanation: q.explanation || '' }
        : { question: q.question, options: [], correctAnswer: null, modelAnswer: q.modelAnswer || '', explanation: '' }
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
    if (!gemini.ready) return res.status(503).json({ error: 'AI unavailable.' });

    const { score } = req.body;
    const forecast = await ExamForecast.findOne({ _id: req.params.forecastId, userId: req.user.userId });
    if (!forecast) return res.status(404).json({ error: 'Forecast not found.' });

    forecast.attempts++;
    if (typeof score === 'number') forecast.lastScore = score;

    const topTopics = (forecast.patterns || []).slice(0, 8).map(p => p.topic).join(', ');
    const forecastPrompt = `AI exam forecaster for ${forecast.examSubject}.
Student mock score: ${score ?? 'unknown'}%. Top past-paper topics: ${topTopics}.
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
router.get('/my-forecasts', auth, async (req, res) => {
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
