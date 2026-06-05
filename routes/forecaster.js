// routes/forecaster.js
const express      = require('express');
const router       = express.Router();
const auth         = require('../middlewares/auth');
const ExamForecast = require('../models/ExamForecast');
const Quiz         = require('../models/Quiz');

// Require the underlying pdf-parse lib directly to avoid the v2 test-fixture issue on Vercel
let pdfParse;
try {
  pdfParse = require('pdf-parse/lib/pdf-parse.js');
} catch (_) {
  try { pdfParse = require('pdf-parse'); } catch (_2) {}
}

const { GoogleGenerativeAI } = require('@google/generative-ai');
require('dotenv').config();

const GEMINI_KEYS = process.env.GEMINI_API_KEYS
  ? process.env.GEMINI_API_KEYS.split(',').map(k => k.trim()).filter(Boolean)
  : [];

let aiModel = null;
if (GEMINI_KEYS.length > 0) {
  try {
    const genAI = new GoogleGenerativeAI(GEMINI_KEYS[0]);
    aiModel = genAI.getGenerativeModel({
      model: 'gemini-2.5-flash',
      generationConfig: { temperature: 0.7, maxOutputTokens: 8192, responseMimeType: 'application/json' },
    });
    console.log('Forecaster AI model: ready');
  } catch (e) {
    console.error('Forecaster AI init error:', e.message);
  }
}

// Sanitise Gemini patterns to ensure Mongoose types are correct
function sanitisePatterns(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .map(p => ({
      topic:        String(p.topic || '').trim(),
      frequency:    Number.isFinite(parseInt(p.frequency)) ? parseInt(p.frequency) : 1,
      confidence:   ['High', 'Medium', 'Low'].includes(p.confidence) ? p.confidence : 'Medium',
      lastAppeared: String(p.lastAppeared || '').trim(),
    }))
    .filter(p => p.topic.length > 0);
}

// ─── GET /api/forecaster/health ───────────────────────────────────────────────
// Open endpoint — no auth needed. Shows whether AI key and pdf-parse are ready.
router.get('/health', async (req, res) => {
  let aiStatus = 'not initialized — GEMINI_API_KEYS missing or empty';
  if (aiModel) {
    try {
      const test = await aiModel.generateContent('Reply with exactly: {"ok":true}');
      const txt  = test.response.text().trim();
      JSON.parse(txt); // will throw if Gemini returned something unexpected
      aiStatus = 'ok';
    } catch (e) {
      aiStatus = `key error: ${e.message}`;
    }
  }
  res.json({
    pdfParse: !!pdfParse,
    ai:       aiStatus,
    keys:     GEMINI_KEYS.length,
  });
});

// ─── POST /api/forecaster/analyze ─────────────────────────────────────────────
router.post('/analyze', auth, async (req, res) => {
  try {
    if (!aiModel)
      return res.status(503).json({ error: 'AI analysis unavailable — check GEMINI_API_KEYS.' });

    if (!pdfParse)
      return res.status(503).json({ error: 'PDF parser unavailable on this server.' });

    const examSubject = (req.body?.examSubject || '').trim();
    if (!examSubject)
      return res.status(400).json({ error: 'Exam subject is required.' });

    if (!req.files || Object.keys(req.files).length === 0)
      return res.status(400).json({ error: 'Upload at least one past exam PDF.' });

    // Normalise to array regardless of how express-fileupload packages it
    const rawFiles = req.files.pdfs || Object.values(req.files)[0];
    const fileEntries = Array.isArray(rawFiles) ? rawFiles : [rawFiles];

    const uploadedFiles = [];
    const textChunks    = [];

    for (const file of fileEntries) {
      try {
        const parsed = await pdfParse(file.data);
        const text   = (parsed.text || '').trim();
        if (!text) {
          console.warn(`No text extracted from ${file.name}`);
          continue;
        }
        textChunks.push(`=== ${file.name} ===\n${text.slice(0, 15000)}`);
        uploadedFiles.push({ name: file.name, textLength: text.length });
      } catch (pdfErr) {
        console.warn(`pdf-parse failed for ${file.name}: ${pdfErr.message}`);
      }
    }

    if (textChunks.length === 0)
      return res.status(422).json({
        error: 'Could not extract text from the uploaded PDFs. Use text-based PDFs (not scanned images). If the file is scanned, copy-paste the text into a .txt file and rename it .pdf, or use the notes field instead.',
      });

    const combinedText = textChunks.join('\n\n').slice(0, 50000);

    const analysisPrompt = `You are an expert exam analyst. Analyse these past ${examSubject} exam papers.

${combinedText}

Identify:
1. Most frequently tested topics (count how many times each appears)
2. Years each topic appeared
3. Topics trending up recently
4. Common question structures

Return ONLY valid JSON (no markdown, no code fences):
{
  "analysisSummary": "2-3 sentence summary of exam patterns",
  "patterns": [
    {
      "topic": "Topic name",
      "frequency": 4,
      "confidence": "High",
      "lastAppeared": "2024"
    }
  ]
}

Rules for patterns:
- frequency MUST be an integer (count of appearances)
- confidence MUST be exactly "High", "Medium", or "Low"
- Return 8 to 15 patterns sorted by frequency descending`;

    let patterns        = [];
    let analysisSummary = '';

    try {
      const raw    = await aiModel.generateContent(analysisPrompt);
      const text   = raw.response.text().trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
      const parsed = JSON.parse(text);
      if (typeof parsed.analysisSummary === 'string') analysisSummary = parsed.analysisSummary;
      patterns = sanitisePatterns(parsed.patterns);
    } catch (aiErr) {
      console.error('Forecaster AI error:', aiErr.message);
      return res.status(500).json({ error: `AI analysis failed: ${aiErr.message}` });
    }

    let forecast;
    try {
      forecast = await ExamForecast.create({
        userId:           req.user.userId,
        examSubject,
        uploadedFiles,
        combinedText,
        analysisComplete: true,
        analysisSummary,
        patterns,
      });
    } catch (dbErr) {
      console.error('ExamForecast.create error:', dbErr.message);
      return res.status(500).json({ error: `Database error: ${dbErr.message}` });
    }

    res.json({
      success:         true,
      forecastId:      forecast._id,
      analysisSummary: forecast.analysisSummary,
      patterns:        forecast.patterns,
      filesProcessed:  uploadedFiles.length,
    });

  } catch (err) {
    console.error('Forecaster /analyze unexpected error:', err);
    res.status(500).json({ error: err.message || 'Analysis failed. Please try again.' });
  }
});

// ─── POST /api/forecaster/:forecastId/generate-mock-exam ──────────────────────
router.post('/:forecastId/generate-mock-exam', auth, async (req, res) => {
  try {
    if (!aiModel)
      return res.status(503).json({ error: 'AI generation unavailable.' });

    const forecast = await ExamForecast.findOne({ _id: req.params.forecastId, userId: req.user.userId });
    if (!forecast)  return res.status(404).json({ error: 'Forecast not found.' });
    if (!forecast.analysisComplete)
      return res.status(400).json({ error: 'Analysis not complete. Upload and analyse papers first.' });

    const topPatterns = forecast.patterns.slice(0, 8).map(p => p.topic).join(', ');

    const mockPrompt = `Create a mock exam for ${forecast.examSubject} based on these high-frequency topics: ${topPatterns}.

Generate:
- 10 MCQ (4 options each, one correct answer index 0-3)
- 5 short-answer/essay questions

Return ONLY valid JSON (no markdown):
{
  "questions": [
    {
      "type": "mcq",
      "question": "...",
      "options": ["A", "B", "C", "D"],
      "correctAnswer": 0,
      "explanation": "..."
    },
    {
      "type": "essay",
      "question": "...",
      "modelAnswer": "..."
    }
  ]
}`;

    let generatedQuestions = [];
    try {
      const raw    = await aiModel.generateContent(mockPrompt);
      const text   = raw.response.text().trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
      const parsed = JSON.parse(text);
      if (Array.isArray(parsed.questions)) generatedQuestions = parsed.questions;
    } catch (aiErr) {
      console.error('Mock exam AI error:', aiErr.message);
      return res.status(500).json({ error: `AI failed to generate mock exam: ${aiErr.message}` });
    }

    if (generatedQuestions.length === 0)
      return res.status(500).json({ error: 'AI returned no questions. Please try again.' });

    const mcq   = generatedQuestions.filter(q => q.type === 'mcq');
    const essay = generatedQuestions.filter(q => q.type === 'essay');
    const questionType = mcq.length > 0 && essay.length > 0 ? 'mixed' : mcq.length > 0 ? 'mcq' : 'essay';

    const quizQuestions = generatedQuestions.map(q => {
      if (q.type === 'mcq') return {
        question:      q.question,
        options:       Array.isArray(q.options) ? q.options.slice(0, 4) : [],
        correctAnswer: typeof q.correctAnswer === 'number' ? q.correctAnswer : 0,
        modelAnswer:   '',
        explanation:   q.explanation || '',
      };
      return {
        question:      q.question,
        options:       [],
        correctAnswer: null,
        modelAnswer:   q.modelAnswer || '',
        explanation:   '',
      };
    });

    const quiz = await Quiz.create({
      userId:         req.user.userId,
      title:          `${forecast.examSubject} — AI Mock Exam`,
      subject:        forecast.examSubject,
      difficulty:     'hard',
      timeLimit:      Math.max(30, Math.ceil(quizQuestions.length * 3)),
      numQuestions:   quizQuestions.length,
      questionType,
      questions:      quizQuestions,
      isPublic:       false,
      isAdminCreated: false,
    });

    forecast.mockExamQuizId = quiz._id;
    forecast.mockExamTitle  = quiz.title;
    forecast.updatedAt      = new Date();
    await forecast.save();

    res.json({ success: true, quizId: quiz._id, quizTitle: quiz.title, numQuestions: quiz.numQuestions });
  } catch (err) {
    console.error('generate-mock-exam error:', err);
    res.status(500).json({ error: err.message || 'Mock exam generation failed.' });
  }
});

// ─── POST /api/forecaster/:forecastId/after-attempt ───────────────────────────
router.post('/:forecastId/after-attempt', auth, async (req, res) => {
  try {
    if (!aiModel)
      return res.status(503).json({ error: 'AI forecast unavailable.' });

    const { score } = req.body;
    const forecast = await ExamForecast.findOne({ _id: req.params.forecastId, userId: req.user.userId });
    if (!forecast) return res.status(404).json({ error: 'Forecast not found.' });

    forecast.attempts++;
    if (typeof score === 'number') forecast.lastScore = score;

    const topPatterns = forecast.patterns.slice(0, 10).map(p => p.topic).join(', ');

    const forecastPrompt = `You are an AI exam forecaster for ${forecast.examSubject}.
Student's mock score: ${score ?? 'unknown'}%
High-frequency past-paper topics: ${topPatterns}
Analysis: ${forecast.analysisSummary}

Predict which topics are MOST LIKELY on the real exam and give preparation advice.

Return ONLY valid JSON (no markdown):
{
  "forecastedTopics": [
    { "topic": "Topic name", "likelihood": 85, "reason": "Reason", "confidence": "High" }
  ],
  "preparationAdvice": ["Advice 1", "Advice 2", "Advice 3"]
}

Rules: likelihood is an integer 0-100, confidence is exactly "High", "Medium", or "Low".
Return 5-8 topics sorted by likelihood descending.`;

    let forecastedTopics  = [];
    let preparationAdvice = [];

    try {
      const raw    = await aiModel.generateContent(forecastPrompt);
      const text   = raw.response.text().trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
      const parsed = JSON.parse(text);
      if (Array.isArray(parsed.forecastedTopics))  forecastedTopics  = parsed.forecastedTopics.map(t => ({
        topic:      String(t.topic || ''),
        likelihood: Number.isFinite(parseInt(t.likelihood)) ? parseInt(t.likelihood) : 50,
        reason:     String(t.reason || ''),
        confidence: ['High', 'Medium', 'Low'].includes(t.confidence) ? t.confidence : 'Medium',
      }));
      if (Array.isArray(parsed.preparationAdvice)) preparationAdvice = parsed.preparationAdvice.map(String);
    } catch (aiErr) {
      console.error('after-attempt AI error:', aiErr.message);
    }

    forecast.forecastedTopics  = forecastedTopics;
    forecast.preparationAdvice = preparationAdvice;
    forecast.updatedAt         = new Date();
    await forecast.save();

    res.json({ success: true, forecastedTopics, preparationAdvice });
  } catch (err) {
    console.error('after-attempt error:', err);
    res.status(500).json({ error: err.message || 'Failed to generate forecast.' });
  }
});

// ─── GET /api/forecaster/my-forecasts ─────────────────────────────────────────
router.get('/my-forecasts', auth, async (req, res) => {
  try {
    const forecasts = await ExamForecast
      .find({ userId: req.user.userId })
      .select('-combinedText')
      .sort({ createdAt: -1 })
      .lean();
    res.json({ success: true, forecasts });
  } catch (err) {
    console.error('my-forecasts error:', err);
    res.status(500).json({ error: 'Failed to fetch forecasts' });
  }
});

// ─── GET /api/forecaster/:forecastId ──────────────────────────────────────────
router.get('/:forecastId', auth, async (req, res) => {
  try {
    const forecast = await ExamForecast
      .findOne({ _id: req.params.forecastId, userId: req.user.userId })
      .select('-combinedText')
      .lean();
    if (!forecast) return res.status(404).json({ error: 'Forecast not found.' });
    res.json({ success: true, forecast });
  } catch (err) {
    console.error('get-forecast error:', err);
    res.status(500).json({ error: 'Failed to fetch forecast' });
  }
});

// ─── DELETE /api/forecaster/:forecastId ───────────────────────────────────────
router.delete('/:forecastId', auth, async (req, res) => {
  try {
    await ExamForecast.deleteOne({ _id: req.params.forecastId, userId: req.user.userId });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete forecast' });
  }
});

module.exports = router;
