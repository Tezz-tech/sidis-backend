// routes/quiz.js
const express = require("express");
const router = express.Router();
const auth = require("../middlewares/auth");
const Quiz = require("../models/Quiz");
const QuizResult = require("../models/QuizResult");
const PDFParser = require("pdf2json");
require("dotenv").config();

const { GoogleGenerativeAI } = require("@google/generative-ai");

/* --------------------------------------------------------------
   1. Load API keys (comma-separated list) from .env
   -------------------------------------------------------------- */
const GEMINI_API_KEYS = process.env.GEMINI_API_KEYS
  ? process.env.GEMINI_API_KEYS.split(",")
      .map(k => k.trim())
      .filter(Boolean)
  : [];

if (GEMINI_API_KEYS.length === 0) {
  console.error("GEMINI_API_KEYS is missing or empty in .env");
  process.exit(1);
}

/* --------------------------------------------------------------
   2. Model names
   -------------------------------------------------------------- */
const PRIMARY_MODEL = "gemini-1.5-flash";   // fast & capable
const FALLBACK_MODEL = "gemini-pro";

/* --------------------------------------------------------------
   3. AI Manager – key rotation + model caching
   -------------------------------------------------------------- */
class AIManager {
  constructor(keys) {
    this.keys = keys;
    this.currentIdx = 0;
    this.models = new Map();          // idx → GenerativeModel
    this.initCurrentModel();
  }

  initCurrentModel() {
    const key = this.keys[this.currentIdx];
    try {
      const genAI = new GoogleGenerativeAI(key);
      const model = genAI.getGenerativeModel({ model: PRIMARY_MODEL });
      this.models.set(this.currentIdx, model);
      console.log(`ISI AI → key #${this.currentIdx + 1} (primary ${PRIMARY_MODEL})`);
    } catch (e) {
      console.warn(`Primary model failed for key #${this.currentIdx + 1}, trying fallback...`);
      this.tryFallback();
    }
  }

  tryFallback() {
    const key = this.keys[this.currentIdx];
    try {
      const genAI = new GoogleGenerativeAI(key);
      const model = genAI.getGenerativeModel({ model: FALLBACK_MODEL });
      this.models.set(this.currentIdx, model);
      console.log(`ISI AI → key #${this.currentIdx + 1} (fallback ${FALLBACK_MODEL})`);
    } catch (e) {
      console.error(`All models failed for key #${this.currentIdx + 1}`);
      this.models.set(this.currentIdx, null);
    }
  }

  getCurrentModel() {
    return this.models.get(this.currentIdx) ?? null;
  }

  /** Returns a new model if rotation happened, otherwise null */
  async rotateIfNeeded(error) {
    const isRateLimit =
      error.status === 429 ||
      /quota/i.test(error.message) ||
      /RATE_LIMIT/i.test(error.message) ||
      /429/i.test(error.message);

    if (!isRateLimit || this.keys.length === 1) return null;

    console.warn(`ISI AI rate-limit on key #${this.currentIdx + 1}. Rotating...`);
    this.currentIdx = (this.currentIdx + 1) % this.keys.length;
    this.initCurrentModel();

    const newModel = this.getCurrentModel();
    if (!newModel) throw new Error("All API keys exhausted.");
    return newModel;
  }
}

/* --------------------------------------------------------------
   4. Initialise AI manager
   -------------------------------------------------------------- */
let aiManager;
try {
  aiManager = new AIManager(GEMINI_API_KEYS);
} catch (e) {
  console.error("Failed to initialise ISI AI:", e.message);
  process.exit(1);
}

/* --------------------------------------------------------------
   5. Helper
   -------------------------------------------------------------- */
const sleep = ms => new Promise(res => setTimeout(res, ms));

/* ==============================================================
   ROUTE: Generate Quiz from PDF
   ============================================================== */
router.post("/generate-quiz", auth, async (req, res) => {
  const currentModel = aiManager.getCurrentModel();
  if (!currentModel) {
    return res.status(500).json({ error: "ISI AI model not initialised." });
  }

  try {
    const { title, subject, numQuestions, difficulty, timeLimit } = req.body;
    const pdfFile = req.files?.pdfFile;

    /* ---------- Input validation ---------- */
    if (!pdfFile) return res.status(400).json({ error: "PDF file is required" });
    if (pdfFile.mimetype !== "application/pdf")
      return res.status(400).json({ error: "File must be a PDF" });
    if (pdfFile.size > 5 * 1024 * 1024)
      return res.status(400).json({ error: "File size exceeds 5 MB limit" });

    /* ---------- Extract text from PDF ---------- */
    let pdfText = "";
    try {
      const pdfParser = new PDFParser();
      const pdfData = await new Promise((resolve, reject) => {
        pdfParser.on("pdfParser_dataError", reject);
        pdfParser.on("pdfParser_dataReady", resolve);
        pdfParser.parseBuffer(pdfFile.data);
      });

      for (const page of pdfData.Pages) {
        for (const txt of page.Texts) {
          pdfText += decodeURIComponent(txt.R[0].T) + " ";
        }
      }
    } catch (e) {
      console.error("PDF parsing error:", e);
      return res.status(400).json({
        error: "Failed to parse PDF. Ensure it is a text-based PDF."
      });
    }

    if (!pdfText.trim())
      return res.status(400).json({ error: "No text found in PDF." });

    /* ---------- Build prompt ---------- */
    const content = pdfText.substring(0, 30_000); // avoid token overflow
    const prompt = `Generate ${numQuestions} multiple-choice questions for a quiz on "${subject}" at ${difficulty} difficulty level based on the following content:\n\n` +
      `Each question must have:\n- question (string)\n- options (array of exactly 4 strings)\n- correctAnswer (index 0-3)\n\n` +
      `Return ONLY a valid JSON array. No explanations.\n` +
      `Example:\n[{"question":"What is 2+2?","options":["1","2","3","4"],"correctAnswer":3}]\n\n` +
      `Content:\n${content}`;

    /* ---------- Call ISI AI with retries + key rotation ---------- */
    let rawResponse;
    let attempts = 0;
    const maxAttempts = 5;
    let model = currentModel;

    while (attempts < maxAttempts && model) {
      try {
        const result = await model.generateContent(prompt);
        rawResponse = result.response.text();
        break; // success
      } catch (err) {
        attempts++;
        console.warn(`ISI AI attempt ${attempts} failed:`, err.message.slice(0, 120));

        // try to rotate key
        const rotated = await aiManager.rotateIfNeeded(err);
        if (rotated) {
          model = rotated;
          attempts = 0;               // fresh attempt count for new key
          await sleep(1000);
          continue;
        }

        // transient back-off
        const transient = [429, 500, 503].includes(err.status) ||
          /quota|timeout/i.test(err.message);

        if (transient && attempts < maxAttempts) {
          const delay = Math.pow(2, attempts) * 1000;
          console.warn(`ISI AI transient error – retry in ${delay / 1000}s`);
          await sleep(delay);
        } else {
          break; // permanent failure
        }
      }
    }

    if (!rawResponse) {
      return res.status(500).json({
        error: "ISI AI failed to generate quiz after retries and key rotations.",
        suggestion: "Try later, reduce PDF size or number of questions."
      });
    }

    /* ---------- Parse JSON response ---------- */
    let questions;
    try {
      const cleaned = rawResponse
        .replace(/^```json\s*/i, "")
        .replace(/```$/g, "")
        .trim();

      questions = JSON.parse(cleaned);
      if (!Array.isArray(questions) || questions.length === 0)
        throw new Error("Empty or non-array response");

      questions.forEach((q, i) => {
        if (typeof q.question !== "string")
          throw new Error(`Q${i}: missing/invalid question`);
        if (!Array.isArray(q.options) || q.options.length !== 4)
          throw new Error(`Q${i}: must have exactly 4 options`);
        if (!Number.isInteger(q.correctAnswer) || q.correctAnswer < 0 || q.correctAnswer > 3)
          throw new Error(`Q${i}: invalid correctAnswer`);
      });
    } catch (e) {
      console.warn("ISI AI returned invalid JSON:", rawResponse.slice(0, 500));
      return res.status(500).json({
        error: "ISI AI returned invalid quiz format.",
        debug: rawResponse.slice(0, 500)
      });
    }

    /* ---------- Save quiz to DB ---------- */
    const quiz = new Quiz({
      userId: req.user.userId,
      title,
      subject,
      difficulty,
      timeLimit: parseInt(timeLimit, 10),
      numQuestions: parseInt(numQuestions, 10),
      questions
    });
    await quiz.save();

    return res.json({
      success: true,
      id: quiz._id,
      message: "Quiz generated successfully"
    });
  } catch (err) {
    console.error("Generate-quiz error:", err);
    return res.status(500).json({ error: "Internal server error: " + err.message });
  }
});

/* ==============================================================
   OTHER ROUTES (unchanged, just minor comment cleanup)
   ============================================================== */

/* List user's quiz sets */
router.get("/sets", auth, async (req, res) => {
  try {
    const quizzes = await Quiz.find({ userId: req.user.userId }).sort({ createdAt: -1 });
    const results = await QuizResult.find({ userId: req.user.userId }).select("quizId score");

    const map = {};
    results.forEach(r => (map[r.quizId] = r.score));

    const formatted = quizzes.map(q => ({
      id: q._id,
      title: q.title,
      subject: q.subject,
      difficulty: q.difficulty,
      timeLimit: q.timeLimit,
      numQuestions: q.numQuestions,
      score: map[q._id] ?? null,
      maxScore: 100,
      createdAt: q.createdAt,
      status: map[q._id] !== undefined ? "completed" : "pending"
    }));

    res.json({ success: true, quizzes: formatted });
  } catch (e) {
    console.error("Fetch sets error:", e);
    res.status(500).json({ error: "Error fetching quizzes" });
  }
});

/* Get single quiz */
router.get("/:id", auth, async (req, res) => {
  try {
    const quiz = await Quiz.findOne({ _id: req.params.id, userId: req.user.userId });
    if (!quiz) return res.status(404).json({ error: "Quiz not found" });
    res.json({ success: true, quiz });
  } catch (e) {
    console.error("Fetch quiz error:", e);
    res.status(500).json({ error: "Error fetching quiz" });
  }
});

/* Save quiz result */
router.post("/quiz-results", auth, async (req, res) => {
  try {
    const { quizId, score, answers, timeSpent } = req.body;
    const quiz = await Quiz.findOne({ _id: quizId, userId: req.user.userId });
    if (!quiz) return res.status(404).json({ error: "Quiz not found" });

    const result = new QuizResult({
      userId: req.user.userId,
      quizId,
      score,
      answers,
      timeSpent
    });
    await result.save();

    res.json({ success: true, message: "Quiz result saved successfully" });
  } catch (e) {
    console.error("Save result error:", e);
    res.status(500).json({ error: "Error saving quiz result" });
  }
});

/* Get result by quiz id */
router.get("/quiz-results/:quizId", auth, async (req, res) => {
  try {
    const result = await QuizResult.findOne({
      quizId: req.params.quizId,
      userId: req.user.userId
    });
    if (!result) return res.status(404).json({ error: "Result not found" });
    res.json({ success: true, result });
  } catch (e) {
    console.error("Fetch result error:", e);
    res.status(500).json({ error: "Server error" });
  }
});

/* Delete quiz + its results */
router.delete("/sets/:id", auth, async (req, res) => {
  try {
    const quiz = await Quiz.findOneAndDelete({
      _id: req.params.id,
      userId: req.user.userId
    });
    if (!quiz) return res.status(404).json({ error: "Quiz not found" });

    await QuizResult.deleteMany({ quizId: req.params.id });
    res.json({ success: true, message: "Quiz deleted successfully" });
  } catch (e) {
    console.error("Delete quiz error:", e);
    res.status(500).json({ error: "Error deleting quiz" });
  }
});

module.exports = router;