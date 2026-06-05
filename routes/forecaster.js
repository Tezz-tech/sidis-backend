// routes/forecaster.js — Exam Forecaster (upload past papers, analyse, generate mock exams)
const express      = require('express');
const router       = express.Router();
const auth         = require('../middlewares/auth');
const ExamForecast = require('../models/ExamForecast');
const Quiz         = require('../models/Quiz');

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
  } catch (_) {}
}

// ─── POST /api/forecaster/analyze ─────────────────────────────────────────────
// Accepts: multipart with up to 5 PDF files + body.examSubject
router.post('/analyze', auth, async (req, res) => {
  try {
    if (!aiModel)
      return res.status(503).json({ error: 'AI analysis unavailable. Check your API key configuration.' });

    const examSubject = req.body?.examSubject?.trim();
    if (!examSubject)
      return res.status(400).json({ error: 'Exam subject is required.' });

    if (!req.files || Object.keys(req.files).length === 0)
      return res.status(400).json({ error: 'Upload at least one past exam PDF.' });

    const pdfParse = require('pdf-parse');

    const fileEntries = Array.isArray(req.files.pdfs)
      ? req.files.pdfs
      : req.files.pdfs
        ? [req.files.pdfs]
        : Object.values(req.files);

    const uploadedFiles  = [];
    const textChunks     = [];
    let totalExtracted   = 0;

    for (const file of fileEntries) {
      try {
        const parsed = await pdfParse(file.data);
        const text   = (parsed.text || '').trim();
        if (!text) continue;
        const chunk = text.slice(0, 15000); // 15k chars per file cap
        textChunks.push(`=== File: ${file.name} ===\n${chunk}`);
        uploadedFiles.push({ name: file.name, textLength: text.length });
        totalExtracted += chunk.length;
      } catch (pdfErr) {
        console.warn(`PDF parse failed for ${file.name}:`, pdfErr.message);
      }
    }

    if (textChunks.length === 0)
      return res.status(422).json({ error: 'Could not extract text from the uploaded PDFs. Make sure they are text-based (not scanned images).' });

    const combinedText = textChunks.join('\n\n').slice(0, 60000);

    const analysisPrompt = `You are an expert exam analyst. Analyse these past exam papers for ${examSubject}.

${combinedText}

Task:
1. Identify the most frequently tested topics
2. Note how often each topic appears and in which years
3. Identify question patterns and structures
4. Flag topics trending upward (increasingly tested in recent years)

Return ONLY valid JSON:
{
  "analysisSummary": "2-3 sentence overall analysis of the exam papers",
  "patterns": [
    {
      "topic": "Topic name",
      "frequency": 4,
      "confidence": "High",
      "lastAppeared": "2024"
    }
  ]
}

Return between 8 and 15 patterns, sorted by frequency descending.`;

    let patterns = [];
    let analysisSummary = '';

    try {
      const raw    = await aiModel.generateContent(analysisPrompt);
      const text   = raw.response.text().trim().replace(/^```json\s*|```$/gi, '').trim();
      const parsed = JSON.parse(text);
      if (parsed.analysisSummary) analysisSummary = parsed.analysisSummary;
      if (Array.isArray(parsed.patterns)) patterns = parsed.patterns;
    } catch (aiErr) {
      console.error('AI analysis error:', aiErr.message);
      return res.status(500).json({ error: 'AI failed to analyse papers. Please try again.' });
    }

    const forecast = await ExamForecast.create({
      userId:          req.user.userId,
      examSubject,
      uploadedFiles,
      combinedText,
      analysisComplete: true,
      analysisSummary,
      patterns,
    });

    res.json({
      success:         true,
      forecastId:      forecast._id,
      analysisSummary: forecast.analysisSummary,
      patterns:        forecast.patterns,
      filesProcessed:  uploadedFiles.length,
    });
  } catch (err) {
    console.error('Analyze error:', err);
    res.status(500).json({ error: 'Analysis failed. Please try again.' });
  }
});

// ─── POST /api/forecaster/:forecastId/generate-mock-exam ──────────────────────
router.post('/:forecastId/generate-mock-exam', auth, async (req, res) => {
  try {
    if (!aiModel)
      return res.status(503).json({ error: 'AI generation unavailable.' });

    const forecast = await ExamForecast.findOne({ _id: req.params.forecastId, userId: req.user.userId });
    if (!forecast) return res.status(404).json({ error: 'Forecast not found.' });
    if (!forecast.analysisComplete)
      return res.status(400).json({ error: 'Analysis not complete. Upload and analyse papers first.' });

    const topPatterns = forecast.patterns.slice(0, 8).map(p => p.topic).join(', ');

    const mockPrompt = `You are creating a mock exam for ${forecast.examSubject} based on pattern analysis.

Identified high-frequency topics: ${topPatterns}

Generate a mock exam with:
- 10 MCQ questions (4 options each, one correct)
- 5 short-answer/essay questions

Rules:
- Questions must mirror the pattern and style of real exam questions for ${forecast.examSubject}
- Prioritize the high-frequency topics identified above
- Include 1-2 current-affairs-related questions relevant to ${forecast.examSubject}
- Vary difficulty: ~4 easy, ~4 medium, ~4 hard MCQs; essays should require paragraph-length answers

Return ONLY valid JSON:
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
      const text   = raw.response.text().trim().replace(/^```json\s*|```$/gi, '').trim();
      const parsed = JSON.parse(text);
      if (Array.isArray(parsed.questions)) generatedQuestions = parsed.questions;
    } catch (aiErr) {
      console.error('Mock exam AI error:', aiErr.message);
      return res.status(500).json({ error: 'AI failed to generate mock exam. Please try again.' });
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

    const quizTitle = `${forecast.examSubject} — AI Mock Exam`;
    const quiz = await Quiz.create({
      userId:         req.user.userId,
      title:          quizTitle,
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

    res.json({
      success:    true,
      quizId:     quiz._id,
      quizTitle:  quiz.title,
      numQuestions: quiz.numQuestions,
    });
  } catch (err) {
    console.error('Generate mock exam error:', err);
    res.status(500).json({ error: 'Mock exam generation failed. Please try again.' });
  }
});

// ─── POST /api/forecaster/:forecastId/after-attempt ──────────────────────────
// Call this after the user completes the mock exam with their score
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

    const forecastPrompt = `You are an expert AI exam forecaster for ${forecast.examSubject}.

Student's mock exam score: ${score ?? 'unknown'}%
High-frequency topics identified from past papers: ${topPatterns}
Analysis summary: ${forecast.analysisSummary}

Based on the pattern analysis and the student's performance:
1. Predict which topics are MOST LIKELY to appear on the actual upcoming exam
2. Give specific preparation advice for last-minute study

Return ONLY valid JSON:
{
  "forecastedTopics": [
    {
      "topic": "Topic name",
      "likelihood": 85,
      "reason": "Reason this is likely to appear",
      "confidence": "High"
    }
  ],
  "preparationAdvice": [
    "Specific advice 1",
    "Specific advice 2",
    "Specific advice 3"
  ]
}

Return 5-8 forecasted topics sorted by likelihood descending. Confidence must be High, Medium, or Low.`;

    let forecastedTopics   = [];
    let preparationAdvice  = [];

    try {
      const raw    = await aiModel.generateContent(forecastPrompt);
      const text   = raw.response.text().trim().replace(/^```json\s*|```$/gi, '').trim();
      const parsed = JSON.parse(text);
      if (Array.isArray(parsed.forecastedTopics)) forecastedTopics  = parsed.forecastedTopics;
      if (Array.isArray(parsed.preparationAdvice)) preparationAdvice = parsed.preparationAdvice;
    } catch (aiErr) {
      console.error('Forecast AI error:', aiErr.message);
    }

    forecast.forecastedTopics  = forecastedTopics;
    forecast.preparationAdvice = preparationAdvice;
    forecast.updatedAt         = new Date();
    await forecast.save();

    res.json({ success: true, forecastedTopics, preparationAdvice });
  } catch (err) {
    console.error('After-attempt error:', err);
    res.status(500).json({ error: 'Failed to generate forecast. Please try again.' });
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
    console.error('Get forecasts error:', err);
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
    console.error('Get forecast error:', err);
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
