// routes/quiz.js (fully fixed based on latest Google Gemini API docs - Nov 30, 2025)
const express = require("express");
const router = express.Router();
const auth = require("../middlewares/auth");
const Quiz = require("../models/Quiz");
const QuizResult = require("../models/QuizResult"); 
const PDFParser = require("pdf2json");
const mammoth = require("mammoth");
require("dotenv").config();

const { GoogleGenerativeAI } = require("@google/generative-ai");

// ==================== GEMINI API KEYS ====================
const GEMINI_API_KEYS = process.env.GEMINI_API_KEYS
  ? process.env.GEMINI_API_KEYS.split(",").map(k => k.trim()).filter(Boolean)
  : [];

if (GEMINI_API_KEYS.length === 0) {
  console.error("GEMINI_API_KEYS not set in .env");
  process.exit(1);
}

/* --------------------------------------------------------------
   CORRECT MODEL NAMES (Updated to latest stable as of Nov 2025)
   -------------------------------------------------------------- */
const PRIMARY_MODEL = "gemini-2.5-flash"; 
const FALLBACK_MODEL = "gemini-2.5-pro";

/* --------------------------------------------------------------
   3. AI Manager (Fixed for correct contents structure)
   -------------------------------------------------------------- */
class AIManager {
  constructor(keys) {
    this.keys = keys;
    this.currentIdx = 0;
    this.models = new Map();
    this.initCurrentModel();
  }

  // Helper to get the model with the right config
  _getModel(key, modelName) {
    const genAI = new GoogleGenerativeAI(key);
    return genAI.getGenerativeModel({
      model: modelName,
      generationConfig: {
        temperature: 0.7,
        topK: 40,
        topP: 0.95,
        maxOutputTokens: 8192,
        responseMimeType: "application/json", // Crucial for clean JSON output
      },
    });
  }

  initCurrentModel() {
    const key = this.keys[this.currentIdx];
    try {
      const model = this._getModel(key, PRIMARY_MODEL);
      this.models.set(this.currentIdx, model);
      console.log(`AI Ready → Key #${this.currentIdx + 1} → ${PRIMARY_MODEL}`);
    } catch (e) {
      console.warn(`Primary model failed initialization. Key #${this.currentIdx + 1}: ${e.message}`);
      this.models.set(this.currentIdx, null);
    }
  }

  tryFallback(key) {
    // This is called inside the loop when PRIMARY_MODEL fails (e.g., 404)
    return this._getModel(key, FALLBACK_MODEL);
  }

  getCurrentModel() {
    return this.models.get(this.currentIdx) ?? null;
  }

  async rotateIfNeeded(error) {
    if (this.keys.length <= 1) return null;

    const isRateLimit = error?.status === 429 ||
      /quota|rate limit|429/i.test(error?.message || "");

    if (!isRateLimit) return null;

    console.warn(`Rate limit hit. Rotating key #${this.currentIdx + 1} → #${(this.currentIdx + 2) % this.keys.length + 1}`);
    this.currentIdx = (this.currentIdx + 1) % this.keys.length;
    this.initCurrentModel();

    return this.getCurrentModel();
  }
}

const aiManager = new AIManager(GEMINI_API_KEYS);
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ==================== MAIN ROUTE: Generate Quiz ====================
router.post("/generate-quiz", auth, async (req, res) => {
  let model = aiManager.getCurrentModel();
  if (!model) return res.status(500).json({ error: "AI service unavailable" });

  try {
    const { title, subject, numQuestions = 10, difficulty = "medium", timeLimit = 30, content } = req.body;
    const file = req.files?.file;

    let extractedText = "";

    // --- TEXT EXTRACTION ---
    if (content && typeof content === "string" && content.trim().length > 50) {
      extractedText = content.trim();
    } else if (file) {
      const allowedTypes = [
        "application/pdf",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
      ];

      if (!allowedTypes.includes(file.mimetype)) {
        return res.status(400).json({ error: "Only PDF and DOCX files are allowed" });
      }

      if (file.size > 10 * 1024 * 1024) {
        return res.status(400).json({ error: "File too large (max 10MB)" });
      }

      if (file.mimetype === "application/pdf") {
        const pdfParser = new PDFParser();
        const pdfData = await new Promise((resolve, reject) => {
          pdfParser.on("pdfParser_dataError", err => reject(err));
          pdfParser.on("pdfParser_dataReady", data => resolve(data));
          pdfParser.parseBuffer(file.data);
        });

        for (const page of pdfData.Pages) {
          for (const text of page.Texts) {
            // FIX: Use try/catch for decodeURIComponent to prevent 'URI malformed' crash
            try {
              extractedText += decodeURIComponent(text.R[0].T) + " ";
            } catch (e) {
              console.warn("PDF decoding warning (URI malformed), skipping malformed text chunk.");
              extractedText += " "; 
            }
          }
        }
      } else if (file.mimetype.includes("word")) {
        const result = await mammoth.extractRawText({ buffer: file.data });
        extractedText = result.value;
      }
    } else {
      return res.status(400).json({ error: "Please provide either a file or paste text content" });
    }

    if (!extractedText.trim()) {
      return res.status(400).json({ error: "No readable text found in file." });
    }

    // --- AI GENERATION ---
    const safeContent = extractedText.slice(0, 60_000); 

    const prompt = `
      You are a teacher creating a multiple-choice quiz.
      Subject: ${subject || "General"}
      Difficulty: ${difficulty}
      Count: ${numQuestions} questions

      Based strictly on the text provided below, generate a JSON array of questions.
      
      Output Format (JSON Only):
      [
        {
          "question": "Question text here?",
          "options": ["Option A", "Option B", "Option C", "Option D"],
          "correctAnswer": 0
        }
      ]
      Note: correctAnswer is the index (0-3) of the correct string in options.

      Text to generate from:
      ${safeContent}
    `;

    let rawResponse = "";
    let attempts = 0;
    
    // Retry Loop
    while (attempts < 6) { // Increased attempts for robustness
      try {
        // FIXED: Correct contents structure per latest docs - string for single-turn
        const result = await model.generateContent(prompt);
        
        // FIXED: Use result.response.text() for the output
        rawResponse = result.response.text().trim(); 
        
        if (rawResponse) {
             break; // Success
        } else {
             throw new Error("Empty response from AI.");
        }
      } catch (err) {
        attempts++;
        console.warn(`Attempt ${attempts} failed:`, err.message);

        // Handle 404 (Model Not Found) or initial failure
        if (err.message.includes("404 Not Found") || attempts === 1) {
            console.log(`Model 404'd or failed. Attempting Fallback Model (${FALLBACK_MODEL})...`);
            
            try {
                // Set the model to fallback for subsequent attempts
                model = aiManager.tryFallback(aiManager.keys[aiManager.currentIdx]);
            } catch (fallbackError) {
                 console.error("Fallback model initialization failed:", fallbackError.message);
                 break; // Stop retrying if fallback fails to initialize
            }
            await sleep(2000); 
            continue; 
        }

        const rotated = await aiManager.rotateIfNeeded(err);
        if (rotated) {
          model = rotated;
          attempts = 0; // Reset attempts on successful key rotation
          await sleep(2000);
        } else if (err.status >= 500 || err.status === 429 || attempts < 6) {
           await sleep(2000 * attempts);
        } else {
            break; // Break on unrecoverable error
        }
      }
    }

    if (!rawResponse) {
      return res.status(500).json({ error: "Failed to generate quiz after multiple attempts. Check API key and content." });
    }

    // --- PARSING ---
    let questions;
    try {
      questions = JSON.parse(rawResponse);

      if (!Array.isArray(questions)) throw new Error("AI did not return an array");
      
      // Validate structure
      questions = questions.map(q => ({
          question: q.question,
          options: q.options,
          correctAnswer: Number(q.correctAnswer)
      })).filter(q => q.question && q.options && q.options.length === 4);

    } catch (e) {
      console.error("JSON Parse Error:", e.message);
      
      // FIX: Ensure rawResponse is a string before calling .slice for debugging
      const debugSlice = typeof rawResponse === 'string' ? rawResponse.slice(0, 500) : "Response was not a string.";
      console.log("Raw Response was:", debugSlice);

      return res.status(500).json({ error: "AI response was malformed. Try again or simplify input." });
    }

    // Save to DB
    const quiz = new Quiz({
      userId: req.user.userId,
      title: title?.trim() || "Untitled Quiz",
      subject: subject?.trim() || "General",
      difficulty,
      timeLimit: parseInt(timeLimit),
      numQuestions: questions.length,
      questions
    });

    await quiz.save();

    res.json({
      success: true,
      id: quiz._id,
      message: "Quiz generated successfully!"
    });

  } catch (err) {
    console.error("Generate quiz error:", err);
    res.status(500).json({ error: "Server error: " + err.message });
  }
});

/* ==============================================================
   OTHER ROUTES: Quiz Management (unchanged)
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
    
    // Check if quiz exists
    const quiz = await Quiz.findOne({ _id: quizId, userId: req.user.userId });
    if (!quiz) return res.status(404).json({ error: "Quiz not found" });

    // Save result
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