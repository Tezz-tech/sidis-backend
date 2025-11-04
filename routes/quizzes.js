// routes/quiz.js (or similar)
const express = require("express");
const router = express.Router();
const auth = require("../middlewares/auth");
const Quiz = require("../models/Quiz");
const QuizResult = require("../models/QuizResult");
const PDFParser = require("pdf2json");
require("dotenv").config();

// === GEMINI SETUP: Enhanced for Robustness ===
const { GoogleGenerativeAI } = require("@google/generative-ai");

if (!process.env.GEMINI_API_KEY) {
  console.error("GEMINI_API_KEY is missing in .env");
  process.exit(1);
}

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// Use a fallback model for setup in case the primary is unavailable
const PRIMARY_MODEL = "gemini-2.5-flash"; // A fast, capable model
const FALLBACK_MODEL = "gemini-pro";

let geminiModel;

try {
  geminiModel = genAI.getGenerativeModel({ model: PRIMARY_MODEL });
  console.log(`Using primary model: ${PRIMARY_MODEL}`);
} catch (error) {
  console.error(`Error setting up primary model ${PRIMARY_MODEL}:`, error.message);
  try {
    geminiModel = genAI.getGenerativeModel({ model: FALLBACK_MODEL });
    console.log(`Using fallback model: ${FALLBACK_MODEL}`);
  } catch (fallbackError) {
    console.error(`Error setting up fallback model ${FALLBACK_MODEL}:`, fallbackError.message);
    // If both fail, we let the route handler catch the uninitialized model
    geminiModel = null; 
  }
}

// === HELPER: Sleep for retry ===
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// === ROUTE: Generate Quiz from PDF (MEMORY STORAGE) ===
router.post("/generate-quiz", auth, async (req, res) => {
  // Check if model initialization failed
  if (!geminiModel) {
    return res.status(500).json({ error: "AI model not initialized. Check API key and service status." });
  }

  try {
    const { title, subject, numQuestions, difficulty, timeLimit } = req.body;
    const pdfFile = req.files?.pdfFile;

    // === Input Validation (Unchanged, already good) ===
    if (!pdfFile)
      return res.status(400).json({ error: "PDF file is required" });
    if (pdfFile.mimetype !== "application/pdf")
      return res.status(400).json({ error: "File must be a PDF" });
    if (pdfFile.size > 5 * 1024 * 1024)
      return res.status(400).json({ error: "File size exceeds 5MB limit" });

    // === Extract Text from PDF Buffer (Unchanged, already good) ===
    let pdfText = "";
    try {
      const pdfParser = new PDFParser();
      
      const pdfData = await new Promise((resolve, reject) => {
        pdfParser.on("pdfParser_dataError", (err) => reject(err));
        pdfParser.on("pdfParser_dataReady", (data) => resolve(data));
        pdfParser.parseBuffer(pdfFile.data);
      });

      for (const page of pdfData.Pages) {
        for (const text of page.Texts) {
          pdfText += decodeURIComponent(text.R[0].T) + " ";
        }
      }
    } catch (parseError) {
      console.error("PDF parsing error:", parseError);
      return res.status(400).json({
        error: "Failed to parse PDF. Please ensure it's a valid text-based PDF.",
      });
    }

    if (!pdfText.trim()) {
      return res.status(400).json({
        error: "No text found in PDF. Please upload a text-based PDF.",
      });
    }

    // === Generate Quiz with Gemini ===
    const contentToSend = pdfText.substring(0, 30000); // Limit content size to avoid hitting token limits for long PDFs
    
    const prompt = `Generate ${numQuestions} multiple-choice questions for a quiz on "${subject}" at ${difficulty} difficulty level based on the following content:\n\nEach question must have:\n- question (string)\n- options (array of exactly 4 strings)\n- correctAnswer (index 0-3)\n\nReturn ONLY a valid JSON array. No explanations. Example:\n[{"question":"What is 2+2?","options":["1","2","3","4"],"correctAnswer":3}]\n\nContent:\n${contentToSend}`;

    let rawResponse;
    let attempts = 0;
    const maxAttempts = 3;

    while (attempts < maxAttempts) {
      try {
        const result = await geminiModel.generateContent(prompt);
        rawResponse = result.response.text();
        break;
      } catch (geminiErr) {
        attempts++;
        
        // **FIX**: Enhanced retry logic for transient errors (429 Rate Limit and 503 Service Unavailable)
        const isTransientError = (
          geminiErr.message?.includes("quota") ||
          geminiErr.status === 429 ||
          geminiErr.status === 503
        );

        if (isTransientError && attempts < maxAttempts) {
          console.warn(`Gemini transient error (${geminiErr.status || 'rate limit'}). Retrying in ${attempts * 2}s...`);
          await sleep(attempts * 2000); // Exponential backoff
        } else {
          console.error("Gemini API permanent error or max retries reached:", geminiErr);
          // Changed status to 500 as 429 is only for rate limits, 500 is better for general failure.
          return res.status(500).json({
            error: `Gemini API error after ${attempts} attempts. Try again later or reduce complexity.`,
            details: geminiErr.message.substring(0, 150),
          });
        }
      }
    }

    if (!rawResponse) {
      return res.status(500).json({ error: "Failed to generate quiz after retries." });
    }

    // === Parse JSON Response (Unchanged, already good) ===
    let questions;
    try {
      const cleaned = rawResponse
        .replace(/^```json\s*/i, "")
        .replace(/```$/g, "")
        .trim();

      questions = JSON.parse(cleaned);

      if (!Array.isArray(questions)) throw new Error("Not an array");
      if (questions.length === 0) throw new Error("Empty questions");

      // Validate each question
      questions.forEach((q, i) => {
        if (!q.question || typeof q.question !== "string")
          throw new Error(`Question ${i}: missing text`);
        if (!Array.isArray(q.options) || q.options.length !== 4)
          throw new Error(`Question ${i}: must have 4 options`);
        if (
          !Number.isInteger(q.correctAnswer) ||
          q.correctAnswer < 0 ||
          q.correctAnswer > 3
        ) {
          throw new Error(`Question ${i}: invalid correctAnswer`);
        }
      });
    } catch (parseError) {
      console.warn("Invalid JSON from Gemini:", rawResponse);
      return res.status(500).json({
        error: "AI returned invalid quiz format. Try a smaller PDF or fewer questions.",
        debug: rawResponse.substring(0, 500),
      });
    }

    // === Save Quiz to DB (Unchanged, already good) ===
    const quiz = new Quiz({
      userId: req.user.userId,
      title,
      subject,
      difficulty,
      timeLimit: parseInt(timeLimit),
      numQuestions: parseInt(numQuestions),
      questions,
    });

    await quiz.save();

    return res.json({ 
      success: true,
      id: quiz._id,
      message: "Quiz generated successfully"
    });
  } catch (error) {
    console.error("Error generating quiz:", error);
    return res.status(500).json({ error: "Internal server error: " + error.message });
  }
});

// === REST OF THE ROUTES (List Sets, Get Single, Save Result, Get Result, Delete Quiz) ===
// NOTE: These routes are functional and remain unchanged.

// === ROUTE: List User's Quiz Sets ===
router.get("/sets", auth, async (req, res) => {
  try {
    const quizzes = await Quiz.find({ userId: req.user.userId }).sort({
      createdAt: -1,
    });
    const results = await QuizResult.find({ userId: req.user.userId }).select(
      "quizId score"
    );

    const resultMap = {};
    results.forEach((r) => {
      resultMap[r.quizId] = r.score;
    });

    const formatted = quizzes.map((q) => ({
      id: q._id,
      title: q.title,
      subject: q.subject,
      difficulty: q.difficulty,
      timeLimit: q.timeLimit,
      numQuestions: q.numQuestions,
      score: resultMap[q._id] || null,
      maxScore: 100,
      createdAt: q.createdAt,
      status: resultMap[q._id] !== undefined ? "completed" : "pending",
    }));

    res.json({
      success: true,
      quizzes: formatted
    });
  } catch (error) {
    console.error("Error fetching quiz sets:", error);
    res.status(500).json({ error: "Error fetching quizzes" });
  }
});

// === ROUTE: Get Single Quiz ===
router.get("/:id", auth, async (req, res) => {
  try {
    const quiz = await Quiz.findOne({
      _id: req.params.id,
      userId: req.user.userId,
    });
    if (!quiz) return res.status(404).json({ error: "Quiz not found" });
    
    res.json({
      success: true,
      quiz: quiz
    });
  } catch (error) {
    console.error("Error fetching quiz:", error);
    res.status(500).json({ error: "Error fetching quiz" });
  }
});

// === ROUTE: Save Quiz Result ===
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
      timeSpent,
    });
    await result.save();

    // The status update logic seems slightly out of place here, as the result being saved implies completion.
    // However, if the Quiz model tracks status, this is fine to keep.
    // quiz.status = "completed"; 
    // await quiz.save(); 

    res.json({ 
      success: true,
      message: "Quiz result saved successfully" 
    });
  } catch (error) {
    console.error("Error saving quiz result:", error);
    res.status(500).json({ error: "Error saving quiz result" });
  }
});

// === GET Quiz Result by Quiz ID ===
router.get("/quiz-results/:quizId", auth, async (req, res) => {
  try {
    const result = await QuizResult.findOne({
      quizId: req.params.quizId,
      userId: req.user.userId,
    });
    if (!result) return res.status(404).json({ error: "Result not found" });
    
    res.json({
      success: true,
      result: result
    });
  } catch (error) {
    console.error("Error fetching result:", error);
    res.status(500).json({ error: "Server error" });
  }
});

// === ROUTE: Delete Quiz ===
router.delete("/sets/:id", auth, async (req, res) => {
  try {
    const quiz = await Quiz.findOneAndDelete({
      _id: req.params.id,
      userId: req.user.userId,
    });
    if (!quiz) return res.status(404).json({ error: "Quiz not found" });

    // Also delete associated results
    await QuizResult.deleteMany({ quizId: req.params.id });
    
    res.json({ 
      success: true,
      message: "Quiz deleted successfully" 
    });
  } catch (error) {
    console.error("Error deleting quiz:", error);
    res.status(500).json({ error: "Error deleting quiz" });
  }
});

module.exports = router;