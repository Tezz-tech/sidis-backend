// routes/flashcards.js
const express = require("express");
const router = express.Router();
const auth = require("../middlewares/auth");
const FlashcardSet = require("../models/FlashcardSet");
require("dotenv").config();

const { GoogleGenerativeAI } = require("@google/generative-ai");
const PDFParser = require("pdf2json");

/* --------------------------------------------------------------
   1. Load API keys from .env (comma-separated)
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
const PRIMARY_MODEL = "gemini-1.5-flash";
const FALLBACK_MODEL = "gemini-pro";

/* --------------------------------------------------------------
   3. AI Manager – key rotation + model caching
   -------------------------------------------------------------- */
class AIManager {
  constructor(keys) {
    this.keys = keys;
    this.currentIdx = 0;
    this.models = new Map();
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
   ROUTE: Generate Flashcards from PDF
   ============================================================== */
router.post("/generate-flashcards", auth, async (req, res) => {
  const currentModel = aiManager.getCurrentModel();
  if (!currentModel) {
    return res.status(500).json({ error: "ISI AI model not initialized." });
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
        pdfParser.on("pdfParser_dataError", reject);
        pdfParser.on("pdfParser_dataReady", resolve);
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

    // === Generate Flashcards with ISI AI ===
    const content = pdfText.substring(0, 30_000);
    const prompt = `Generate 10 flashcards from the following content for subject "${subject}".\n\n` +
      `Each flashcard must have:\n- question (string)\n- answer (string)\n\n` +
      `Return ONLY a valid JSON array. No explanations.\n` +
      `Example:\n[{"question":"Capital of France?","answer":"Paris"}]\n\n` +
      `Content:\n${content}`;

    let rawResponse;
    let attempts = 0;
    const maxAttempts = 5;
    let model = currentModel;

    while (attempts < maxAttempts && model) {
      try {
        const result = await model.generateContent(prompt);
        rawResponse = result.response.text();
        break;
      } catch (err) {
        attempts++;
        console.warn(`ISI AI attempt ${attempts} failed:`, err.message.slice(0, 120));

        const rotated = await aiManager.rotateIfNeeded(err);
        if (rotated) {
          model = rotated;
          attempts = 0;
          await sleep(1000);
          continue;
        }

        const transient = [429, 500, 503].includes(err.status) ||
          /quota|timeout/i.test(err.message);

        if (transient && attempts < maxAttempts) {
          const delay = Math.pow(2, attempts) * 1000;
          console.warn(`ISI AI transient error – retry in ${delay / 1000}s`);
          await sleep(delay);
        } else {
          break;
        }
      }
    }

    if (!rawResponse) {
      return res.status(500).json({
        error: "ISI AI failed to generate flashcards after retries and key rotations.",
        suggestion: "Try again later or use a smaller PDF."
      });
    }

    // === Parse JSON Response ===
    let cards;
    try {
      const cleaned = rawResponse
        .replace(/^```json\s*/i, "")
        .replace(/```$/g, "")
        .trim();

      cards = JSON.parse(cleaned);

      if (!Array.isArray(cards) || cards.length === 0)
        throw new Error("Empty or invalid cards");

      cards.forEach((c, i) => {
        if (typeof c.question !== "string" || !c.question.trim())
          throw new Error(`Card ${i}: missing/invalid question`);
        if (typeof c.answer !== "string" || !c.answer.trim())
          throw new Error(`Card ${i}: missing/invalid answer`);
      });
    } catch (parseError) {
      console.warn("ISI AI returned invalid JSON:", rawResponse.slice(0, 500));
      return res.status(500).json({
        error: "ISI AI returned invalid flashcard format.",
        debug: rawResponse.slice(0, 500)
      });
    }

    // === Save to DB ===
    const flashcardSet = new FlashcardSet({
      userId: req.user.userId,
      title,
      subject,
      cards: cards.map(c => ({
        question: c.question.trim(),
        answer: c.answer.trim(),
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

/* ==============================================================
   OTHER ROUTES (unchanged, just cleaned up)
   ============================================================== */

/* Manual creation */
router.post("/create-flashcards-manual", auth, async (req, res) => {
  try {
    const { title, subject, cards } = req.body;

    if (!title || !subject || !Array.isArray(cards) || cards.length === 0) {
      return res.status(400).json({ error: "Title, subject, and non-empty cards array are required" });
    }

    if (cards.some(c => !c.question?.trim() || !c.answer?.trim())) {
      return res.status(400).json({ error: "All cards must have non-empty question and answer" });
    }

    const set = new FlashcardSet({
      userId: req.user.userId,
      title,
      subject,
      cards: cards.map(c => ({
        question: c.question.trim(),
        answer: c.answer.trim(),
        masteryLevel: 0,
      })),
    });

    await set.save();

    res.json({ success: true, id: set._id, message: "Flashcards created successfully" });
  } catch (err) {
    console.error("Error creating manual flashcards:", err);
    res.status(500).json({ error: "Failed to save flashcards" });
  }
});

/* List sets */
router.get("/sets", auth, async (req, res) => {
  try {
    const sets = await FlashcardSet.find({ userId: req.user.userId })
      .sort({ createdAt: -1 })
      .lean();

    const formatted = sets.map(s => {
      const known = s.cards.filter(c => c.masteryLevel >= 80).length;
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

    res.json({ success: true, sets: formatted });
  } catch (err) {
    console.error("Error fetching flashcard sets:", err);
    res.status(500).json({ error: "Failed to fetch flashcard sets" });
  }
});

/* Get one set */
router.get("/sets/:id", auth, async (req, res) => {
  try {
    const set = await FlashcardSet.findOne({ _id: req.params.id, userId: req.user.userId });
    if (!set) return res.status(404).json({ error: "Flashcard set not found" });
    res.json({ success: true, set });
  } catch (err) {
    console.error("Error fetching flashcard set:", err);
    res.status(500).json({ error: "Server error while fetching flashcard set" });
  }
});

/* Delete set */
router.delete("/sets/:id", auth, async (req, res) => {
  try {
    const set = await FlashcardSet.findOneAndDelete({ _id: req.params.id, userId: req.user.userId });
    if (!set) return res.status(404).json({ error: "Flashcard set not found" });
    res.json({ success: true, message: "Flashcard set deleted successfully" });
  } catch (err) {
    console.error("Error deleting flashcard set:", err);
    res.status(500).json({ error: "Failed to delete flashcard set" });
  }
});

/* Study progress */
router.post("/sets/:id/study", auth, async (req, res) => {
  try {
    const { cardId, known } = req.body;
    if (typeof known !== "boolean") {
      return res.status(400).json({ error: "known field must be boolean" });
    }

    const set = await FlashcardSet.findOne({ _id: req.params.id, userId: req.user.userId });
    if (!set) return res.status(404).json({ error: "Flashcard set not found" });

    const card = set.cards.id(cardId);
    if (!card) return res.status(404).json({ error: "Card not found in this set" });

    card.masteryLevel = Math.min(100, Math.max(0, card.masteryLevel + (known ? 15 : -10)));
    set.lastStudied = new Date();

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