// routes/flashcards.js
const express = require("express");
const router = express.Router();
const auth = require("../middlewares/auth");
const FlashcardSet = require("../models/FlashcardSet");
require("dotenv").config();

// === GEMINI SETUP ===
const { GoogleGenerativeAI } = require("@google/generative-ai");

if (!process.env.GEMINI_API_KEY) {
  console.error("GEMINI_API_KEY is missing in .env");
  process.exit(1);
}

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// === MODEL CONFIGURATION ===
const MODEL_NAME = "gemini-2.5-flash"; 
const FALLBACK_MODEL_NAME = "gemini-pro";

let geminiModel;

try {
  geminiModel = genAI.getGenerativeModel({ model: MODEL_NAME });
  console.log(`Using primary model: ${MODEL_NAME}`);
} catch (error) {
  console.error(`Error setting up primary model ${MODEL_NAME}:`, error.message);
  try {
    geminiModel = genAI.getGenerativeModel({ model: FALLBACK_MODEL_NAME });
    console.log(`Using fallback model: ${FALLBACK_MODEL_NAME}`);
  } catch (fallbackError) {
    console.error(`Error setting up fallback model ${FALLBACK_MODEL_NAME}:`, fallbackError.message);
    throw new Error("Failed to initialize any working Gemini model.");
  }
}

// === PDF PARSING - Use pdf2json ===
const PDFParser = require("pdf2json");

// === HELPER: Sleep for retry ===
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/* ---------- GENERATE FROM PDF (MEMORY STORAGE) ---------- */
router.post("/generate-flashcards", auth, async (req, res) => {
  if (!geminiModel) {
    return res.status(500).json({ error: "AI model not initialized." });
  }

  try {
    const { title, subject } = req.body;
    const pdfFile = req.files?.pdfFile;

    // === Input Validation ===
    if (!pdfFile) return res.status(400).json({ error: "PDF file is required" });
    if (pdfFile.mimetype !== "application/pdf")
      return res.status(400).json({ error: "File must be a PDF" });
    if (pdfFile.size > 5 * 1024 * 1024)
      return res.status(400).json({ error: "File size exceeds 5MB limit" });

    // === Extract Text from PDF Buffer ===
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

    // === Generate Flashcards with Gemini ===
    const prompt = `Generate 10 flashcards from the following content for subject "${subject}".\n\nEach flashcard must have:\n- question (string)\n- answer (string)\n\nReturn ONLY a valid JSON array. No explanations. Example:\n[{"question":"Capital of France?","answer":"Paris"}]\n\nContent:\n${pdfText.substring(0, 30000)}`;

    let rawResponse;
    let attempts = 0;
    const maxAttempts = 3;

    while (attempts < maxAttempts) {
      try {
        const result = await geminiModel.generateContent(prompt);
        
        rawResponse = result.response.text();
        break; // Success, exit loop
      } catch (geminiErr) {
        attempts++;
        
        // Identify transient errors: Rate Limit (429/quota) or Service Unavailable (503)
        const isTransientError = (
          geminiErr.message?.includes("quota") || 
          geminiErr.status === 429 ||
          geminiErr.status === 503
        );

        if (isTransientError && attempts < maxAttempts) {
          console.warn(`Gemini transient error (${geminiErr.status || 'rate limit'}). Retrying in ${attempts * 2}s...`);
          await sleep(attempts * 2000); // Exponential backoff
        } else {
          // Permanently fail for non-transient errors (like 400, 404) or after max retries
          console.error("Gemini API error:", geminiErr);
          return res.status(500).json({
            error: "Gemini API error: " + geminiErr.message,
          });
        }
      }
    }

    if (!rawResponse) {
      return res.status(500).json({ error: "Failed to generate flashcards after retries." });
    }

    // === Parse JSON Response ===
    let cards;
    try {
      // Clean up markdown fences (```json) often included by the model
      const cleaned = rawResponse
        .replace(/^```json\s*/i, "")
        .replace(/```$/g, "")
        .trim();

      cards = JSON.parse(cleaned);

      if (!Array.isArray(cards) || cards.length === 0)
        throw new Error("Empty or invalid cards");

      // Validate each card structure
      cards.forEach((c, i) => {
        if (!c.question || typeof c.question !== "string")
          throw new Error(`Card ${i}: missing question`);
        if (!c.answer || typeof c.answer !== "string")
          throw new Error(`Card ${i}: missing answer`);
      });
    } catch (parseError) {
      console.warn("Invalid JSON from Gemini:", rawResponse);
      return res.status(500).json({
        error: "AI returned invalid flashcard format. Raw Response Debug: " + rawResponse.substring(0, 500),
        debug: rawResponse.substring(0, 500),
      });
    }

    // === Save to DB ===
    const flashcardSet = new FlashcardSet({
      userId: req.user.userId,
      title,
      subject,
      cards: cards.map((c) => ({
        question: c.question,
        answer: c.answer,
        masteryLevel: 0,
      })),
    });

    await flashcardSet.save();

    return res.json({ 
      success: true,
      id: flashcardSet._id,
      message: "Flashcards generated successfully" 
    });
  } catch (error) {
    console.error("Error generating flashcards:", error);
    return res.status(500).json({ 
      error: "Internal server error: " + error.message 
    });
  }
});

/* ---------- MANUAL CREATION ---------- */
router.post("/create-flashcards-manual", auth, async (req, res) => {
  try {
    const { title, subject, cards } = req.body;
    
    if (!title || !subject || !Array.isArray(cards)) {
      return res.status(400).json({ error: "Title, subject, and cards array are required" });
    }
    
    if (cards.length === 0) {
      return res.status(400).json({ error: "At least one flashcard is required" });
    }
    
    if (cards.some((c) => !c.question?.trim() || !c.answer?.trim())) {
      return res.status(400).json({ error: "All cards must have both question and answer" });
    }

    const set = new FlashcardSet({
      userId: req.user.userId,
      title,
      subject,
      cards: cards.map((c) => ({
        question: c.question.trim(),
        answer: c.answer.trim(),
        masteryLevel: 0,
      })),
    });
    
    await set.save();
    
    res.json({ 
      success: true,
      id: set._id,
      message: "Flashcards created successfully" 
    });
  } catch (err) {
    console.error("Error creating manual flashcards:", err);
    res.status(500).json({ error: "Failed to save flashcards" });
  }
});

/* ---------- LIST SETS ---------- */
router.get("/sets", auth, async (req, res) => {
  try {
    const sets = await FlashcardSet.find({ userId: req.user.userId })
      .sort({ createdAt: -1 })
      .lean();

    const formatted = sets.map((s) => {
      const known = s.cards.filter((c) => c.masteryLevel >= 80).length;
      const total = s.cards.length;
      let status = "not-started";
      
      if (s.lastStudied) {
        status = known === total ? "completed" : "in-progress";
      }

      return {
        id: s._id,
        title: s.title,
        subject: s.subject,
        cardCount: total,
        known,
        progress: { known, total },
        masteryLevel: s.masteryLevel || 0,
        status,
        createdAt: s.createdAt,
        lastStudied: s.lastStudied,
      };
    });

    res.json({
      success: true,
      sets: formatted
    });
  } catch (err) {
    console.error("Error fetching flashcard sets:", err);
    res.status(500).json({ error: "Failed to fetch flashcard sets" });
  }
});

/* ---------- GET ONE SET ---------- */
router.get("/sets/:id", auth, async (req, res) => {
  try {
    const set = await FlashcardSet.findOne({
      _id: req.params.id,
      userId: req.user.userId,
    });
    
    if (!set) {
      return res.status(404).json({ error: "Flashcard set not found" });
    }
    
    res.json({
      success: true,
      set: set
    });
  } catch (err) {
    console.error("Error fetching flashcard set:", err);
    res.status(500).json({ error: "Server error while fetching flashcard set" });
  }
});

/* ---------- DELETE SET ---------- */
router.delete("/sets/:id", auth, async (req, res) => {
  try {
    const set = await FlashcardSet.findOneAndDelete({
      _id: req.params.id,
      userId: req.user.userId,
    });
    
    if (!set) {
      return res.status(404).json({ error: "Flashcard set not found" });
    }
    
    res.json({ 
      success: true,
      message: "Flashcard set deleted successfully" 
    });
  } catch (err) {
    console.error("Error deleting flashcard set:", err);
    res.status(500).json({ error: "Failed to delete flashcard set" });
  }
});

/* ---------- STUDY PROGRESS ---------- */
router.post("/sets/:id/study", auth, async (req, res) => {
  try {
    const { cardId, known } = req.body;
    
    if (typeof known !== 'boolean') {
      return res.status(400).json({ error: "Known field is required and must be boolean" });
    }

    const set = await FlashcardSet.findOne({
      _id: req.params.id,
      userId: req.user.userId,
    });
    
    if (!set) {
      return res.status(404).json({ error: "Flashcard set not found" });
    }

    const card = set.cards.id(cardId);
    if (!card) {
      return res.status(404).json({ error: "Card not found in this set" });
    }

    // Update mastery level
    card.masteryLevel = Math.min(100, Math.max(0, card.masteryLevel + (known ? 15 : -10)));
    set.lastStudied = new Date();
    
    // Calculate overall mastery level for the set
    const totalMastery = set.cards.reduce((sum, c) => sum + c.masteryLevel, 0);
    set.masteryLevel = Math.round(totalMastery / set.cards.length);

    await set.save();
    
    res.json({ 
      success: true,
      message: "Study progress updated",
      masteryLevel: card.masteryLevel,
      setMasteryLevel: set.masteryLevel
    });
  } catch (err) {
    console.error("Error updating study progress:", err);
    res.status(500).json({ error: "Failed to update study progress" });
  }
});

module.exports = router;