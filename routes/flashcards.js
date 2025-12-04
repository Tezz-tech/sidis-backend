// routes/flashcards.js — FINAL & FULLY WORKING (Nov 30, 2025)
const express = require("express");
const router = express.Router();
const auth = require("../middlewares/auth");
const FlashcardSet = require("../models/FlashcardSet");
const PDFParser = require("pdf2json");
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

// ==================== MODEL NAMES (Latest Nov 2025) ====================
const PRIMARY_MODEL = "gemini-2.5-flash";
const FALLBACK_MODEL = "gemini-2.5-pro";

// ==================== AI MANAGER (Same as Quiz Route) ====================
class AIManager {
  constructor(keys) {
    this.keys = keys;
    this.currentIdx = 0;
    this.models = new Map();
    this.initCurrentModel();
  }

  _getModel(key, modelName) {
    const genAI = new GoogleGenerativeAI(key);
    return genAI.getGenerativeModel({
      model: modelName,
      generationConfig: {
        temperature: 0.7,
        topK: 40,
        topP: 0.95,
        maxOutputTokens: 8192,
        responseMimeType: "application/json",
      },
    });
  }

  initCurrentModel() {
    const key = this.keys[this.currentIdx];
    try {
      const model = this._getModel(key, PRIMARY_MODEL);
      this.models.set(this.currentIdx, model);
      console.log(`Flashcard AI Ready → Key #${this.currentIdx + 1} → ${PRIMARY_MODEL}`);
    } catch (e) {
      console.warn(`Primary model failed. Trying fallback for key #${this.currentIdx + 1}`);
      this.models.set(this.currentIdx, this._getModel(key, FALLBACK_MODEL));
    }
  }

  getCurrentModel() {
    return this.models.get(this.currentIdx) ?? null;
  }

  async rotateIfNeeded(error) {
    if (this.keys.length <= 1) return null;
    const isRateLimit = error?.status === 429 || /quota|rate limit|429/i.test(error?.message || "");
    if (!isRateLimit) return null;

    console.warn(`Rate limit hit. Rotating key #${this.currentIdx + 1} → #${(this.currentIdx + 1) % this.keys.length + 1}`);
    this.currentIdx = (this.currentIdx + 1) % this.keys.length;
    this.initCurrentModel();
    return this.getCurrentModel();
  }
}

const aiManager = new AIManager(GEMINI_API_KEYS);
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ==================== GENERATE FLASHCARDS (PDF OR TEXT) ====================
router.post("/generate-flashcards", auth, async (req, res) => {
  let model = aiManager.getCurrentModel();
  if (!model) return res.status(500).json({ error: "AI service unavailable" });

  try {
    const { title, subject, content } = req.body;
    const pdfFile = req.files?.pdfFile;

    let extractedText = "";

    // 1. PASTED TEXT (priority)
    if (content && typeof content === "string" && content.trim().length > 100) {
      extractedText = content.trim();
    }
    // 2. PDF UPLOAD
    else if (pdfFile) {
      if (pdfFile.mimetype !== "application/pdf") {
        return res.status(400).json({ error: "Only PDF files are allowed" });
      }
      if (pdfFile.size > 5 * 1024 * 1024) {
        return res.status(400).json({ error: "PDF must be under 5MB" });
      }

      const pdfParser = new PDFParser();
      const pdfData = await new Promise((resolve, reject) => {
        pdfParser.on("pdfParser_dataError", reject);
        pdfParser.on("pdfParser_dataReady", resolve);
        pdfParser.parseBuffer(pdfFile.data);
      });

      for (const page of pdfData.Pages) {
        for (const text of page.Texts) {
          try {
            extractedText += decodeURIComponent(text.R[0].T) + " ";
          } catch (e) {
            extractedText += " ";
          }
        }
      }
    } else {
      return res.status(400).json({ error: "Please provide either pasted text or upload a PDF" });
    }

    if (!extractedText.trim()) {
      return res.status(400).json({ error: "No readable text found in your input" });
    }

    const safeText = extractedText.slice(0, 30_000);

    const prompt = `
You are an expert flashcard creator. Generate 12 high-quality flashcards from this content.

Subject: ${subject || "General"}
Output ONLY a valid JSON array. No explanations.

Format:
[
  {"question": "What is photosynthesis?", "answer": "Process by which plants convert sunlight into energy"},
  ...
]

Content:
${safeText}
    `.trim();

    let rawResponse = "";
    let attempts = 0;

    while (attempts < 6) {
      try {
        const result = await model.generateContent(prompt);
        rawResponse = result.response.text().trim();
        if (rawResponse) break;
      } catch (err) {
        attempts++;
        console.warn(`Flashcard AI attempt ${attempts} failed:`, err.message);

        if (err.message.includes("404") || attempts === 1) {
          model = aiManager._getModel(aiManager.keys[aiManager.currentIdx], FALLBACK_MODEL);
          await sleep(2000);
          continue;
        }

        const rotated = await aiManager.rotateIfNeeded(err);
        if (rotated) {
          model = rotated;
          attempts = 0;
          await sleep(2000);
        } else if (err.status >= 500 || err.status === 429) {
          await sleep(2000 * attempts);
        } else {
          break;
        }
      }
    }

    if (!rawResponse) {
      return res.status(500).json({ error: "AI failed to generate flashcards after multiple attempts" });
    }

    let cards;
    try {
      const cleaned = rawResponse.replace(/^```json\s*|```$/gi, "").trim();
      cards = JSON.parse(cleaned);

      if (!Array.isArray(cards) || cards.length === 0) {
        throw new Error("Empty or invalid response");
      }

      cards = cards.map(c => ({
        question: (c.question || "").trim(),
        answer: (c.answer || "").trim(),
      })).filter(c => c.question && c.answer);

      if (cards.length === 0) throw new Error("No valid cards generated");
    } catch (e) {
      console.log("Raw AI response:", rawResponse.slice(0, 500));
      return res.status(500).json({ error: "AI returned invalid flashcard format" });
    }

    const flashcardSet = new FlashcardSet({
      userId: req.user.userId,
      title: title?.trim() || "Untitled Flashcards",
      subject: subject?.trim() || "General",
      cards: cards.map(c => ({
        question: c.question,
        answer: c.answer,
        masteryLevel: 0,
      })),
    });

    await flashcardSet.save();

    res.json({
      success: true,
      id: flashcardSet._id,
      message: "Flashcards generated successfully!",
      count: cards.length
    });

  } catch (err) {
    console.error("Generate flashcards error:", err);
    res.status(500).json({ error: err.message || "Failed to generate flashcards" });
  }
});

// ==================== MANUAL CREATION ====================
router.post("/create-flashcards-manual", auth, async (req, res) => {
  try {
    const { title, subject, cards } = req.body;

    if (!title?.trim() || !subject?.trim()) {
      return res.status(400).json({ error: "Title and subject are required" });
    }
    if (!Array.isArray(cards) || cards.length === 0) {
      return res.status(400).json({ error: "At least one card is required" });
    }
    if (cards.some(c => !c.question?.trim() || !c.answer?.trim())) {
      return res.status(400).json({ error: "All cards must have question and answer" });
    }

    const set = new FlashcardSet({
      userId: req.user.userId,
      title: title.trim(),
      subject: subject.trim(),
      cards: cards.map(c => ({
        question: c.question.trim(),
        answer: c.answer.trim(),
        masteryLevel: 0,
      })),
    });

    await set.save();

    res.json({ success: true, id: set._id, message: "Manual flashcards created!" });
  } catch (err) {
    console.error("Manual flashcard error:", err);
    res.status(500).json({ error: "Failed to save flashcards" });
  }
});

// ==================== LIST SETS ====================
router.get("/sets", auth, async (req, res) => {
  try {
    const sets = await FlashcardSet.find({ userId: req.user.userId })
      .sort({ createdAt: -1 })
      .lean();

    const formatted = sets.map(s => {
      const known = s.cards.filter(c => c.masteryLevel >= 80).length;
      const total = s.cards.length;
      const progress = total > 0 ? Math.round((known / total) * 100) : 0;

      return {
        id: s._id,
        title: s.title,
        subject: s.subject,
        cardCount: total,
        knownCards: known,
        progress,
        status: s.lastStudied ? (known === total ? "completed" : "in-progress") : "not-started",
        createdAt: s.createdAt,
        lastStudied: s.lastStudied || null,
      };
    });

    res.json({ success: true, sets: formatted });
  } catch (err) {
    console.error("Fetch sets error:", err);
    res.status(500).json({ error: "Failed to fetch flashcard sets" });
  }
});

// ==================== GET ONE SET ====================
// GET ONE SET — /flashcards/sets/:id (private)
router.get("/sets/:id", auth, async (req, res) => {
  try {
    const set = await FlashcardSet.findOne({ 
      _id: req.params.id, 
      userId: req.user.userId 
    }).lean();

    if (!set) return res.status(404).json({ error: "Flashcard set not found" });

    // Fetch user's personal progress for this set
    const progressRecords = await FlashcardProgress.find({
      userId: req.user.userId,
      setId: set._id
    }).lean();

    const progressMap = {};
    progressRecords.forEach(p => {
      progressMap[p.cardId.toString()] = p.masteryLevel;
    });

    // Merge progress into cards
    const cardsWithProgress = set.cards.map(card => ({
      ...card,
      masteryLevel: progressMap[card._id.toString()] ?? card.masteryLevel ?? 0
    }));

    res.json({ 
      success: true, 
      set: {
        ...set,
        cards: cardsWithProgress
      }
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

// ==================== DELETE SET ====================
router.delete("/sets/:id", auth, async (req, res) => {
  try {
    const set = await FlashcardSet.findOneAndDelete({ _id: req.params.id, userId: req.user.userId });
    if (!set) return res.status(404).json({ error: "Set not found" });
    res.json({ success: true, message: "Flashcard set deleted" });
  } catch (err) {
    res.status(500).json({ error: "Failed to delete" });
  }
});

// ==================== UPDATE STUDY PROGRESS ====================
router.post("/sets/:id/study", auth, async (req, res) => {
  try {
    const { cardId, known } = req.body;
    const set = await FlashcardSet.findOne({ 
      _id: req.params.id, 
      userId: req.user.userId 
    });

    if (!set) return res.status(404).json({ error: "Set not found" });

    const card = set.cards.id(cardId);
    if (!card) return res.status(404).json({ error: "Card not found" });

    card.masteryLevel = Math.min(100, Math.max(0, card.masteryLevel + (known ? 20 : -15)));
    set.lastStudied = new Date();
    await set.save();

    // Also sync to FlashcardProgress (optional, for consistency)
    await FlashcardProgress.updateOne(
      { userId: req.user.userId, setId: set._id, cardId },
      { masteryLevel: card.masteryLevel, lastStudied: new Date() },
      { upsert: true }
    );

    res.json({ success: true, masteryLevel: card.masteryLevel });
  } catch (err) {
    res.status(500).json({ error: "Failed to update" });
  }
});

const FlashcardProgress = require("../models/FlashcardProgress"); // <-- new model file

// ==================== PUBLIC FLASHCARD ROUTES ====================

/* ============================================================== */
/* PUBLIC: create flashcard set without JWT (optional authorName)*/
/* This route does NOT use auth middleware intentionally.         */
/* ============================================================== */
router.post("/public/create", async (req, res) => {
  try {
    const { title, subject, cards, authorName } = req.body;
    if (!title || !subject || !Array.isArray(cards) || cards.length === 0) {
      return res.status(400).json({ error: "Missing required fields: title, subject, cards" });
    }
    const validCards = cards.filter(c => c.question && c.answer);
    if (validCards.length === 0) return res.status(400).json({ error: "No valid cards provided" });

    const set = new FlashcardSet({
      userId: null,
      authorName: authorName?.trim() || null,
      title: title.trim(),
      subject: subject.trim(),
      cards: validCards.map(c => ({ question: c.question.trim(), answer: c.answer.trim(), masteryLevel: 0 }))
    });

    await set.save();

    res.status(201).json({ success: true, id: set._id, message: "Public flashcard set created" });
  } catch (err) {
    console.error("Public create flashcards error:", err);
    res.status(500).json({ error: "Failed to create public flashcard set" });
  }
});

/* List all flashcard sets (public) */
// Remove auth from public sets route
router.get("/public/sets", async (req, res) => {  // Removed: auth
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 20));
    const skip = (page - 1) * limit;

    // Fetch ALL flashcard sets (no isPublic filter)
    const [sets, total] = await Promise.all([
      FlashcardSet.find({})  // Removed: isPublic: true
        .select("title subject cards createdAt lastStudied authorName")
        .populate("userId", "fullName")
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),

      FlashcardSet.countDocuments({})  // Removed: isPublic: true
    ]);

    const formatted = sets.map(s => ({
      id: s._id,
      title: s.title,
      subject: s.subject,
      creator: s.userId?.fullName || s.authorName || "Anonymous",
      cardCount: s.cards.length,
      createdAt: s.createdAt,
      lastStudied: s.lastStudied,
    }));

    res.json({
      success: true,
      sets: formatted,
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit)
      }
    });
  } catch (err) {
    console.error("Fetch public flashcard sets error:", err);
    res.status(500).json({ 
      success: false, 
      error: "Failed to fetch public flashcard sets" 
    });
  }
});

/* ============================================================== */
/* PUBLIC: Get any flashcard set by ID (full cards OK)            */
/* ============================================================== */
// PUBLIC: Get set with user progress
router.get("/public/sets/:id", async (req, res) => {
  try {
    const set = await FlashcardSet.findById(req.params.id).lean();
    if (!set) return res.status(404).json({ success: false, error: "Not found" });

    let cardsWithProgress = [...set.cards];

    // If user is logged in, load their personal progress
    if (req.user?.userId) {
      const progressRecords = await FlashcardProgress.find({
        userId: req.user.userId,
        setId: set._id
      }).lean();

      const progressMap = {};
      progressRecords.forEach(p => {
        progressMap[p.cardId.toString()] = p.masteryLevel;
      });

      cardsWithProgress = set.cards.map(card => ({
        ...card,
        masteryLevel: progressMap[card._id.toString()] ?? card.masteryLevel ?? 0
      }));
    }

    res.json({
      success: true,
      set: {
        ...set,
        cards: cardsWithProgress,
        creator: set.userId?.fullName || set.authorName || "Anonymous"
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: "Server error" });
  }
});

/* Record study progress for a public set */
router.post("/public/sets/:id/study", auth, async (req, res) => {
  try {
    const { cardId, known } = req.body;
    const setId = req.params.id;

    // Remove isPublic filter
    const set = await FlashcardSet.findOne({ _id: setId }).lean();  // Removed: isPublic: true
    if (!set) return res.status(404).json({ 
      success: false,
      error: "Set not found" 
    });

    const card = set.cards.find(c => c._id.toString() === cardId);
    if (!card) return res.status(404).json({ 
      success: false,
      error: "Card not found" 
    });

    const delta = known ? 20 : -15;

    const progress = await FlashcardProgress.findOneAndUpdate(
      { userId: req.user.userId, setId, cardId },
      {
        $setOnInsert: { masteryLevel: 0 },
        $inc: { masteryLevel: delta },
        $set: { lastStudied: new Date() }
      },
      { upsert: true, new: true }
    );

    progress.masteryLevel = Math.min(100, Math.max(0, progress.masteryLevel));
    await progress.save();

    res.json({ 
      success: true, 
      masteryLevel: progress.masteryLevel 
    });
  } catch (err) {
    console.error("Study progress error:", err);
    res.status(500).json({ 
      success: false,
      error: "Failed to record progress" 
    });
  }
});

/* Get user's personal progress on a public set */
router.get("/public/sets/:id/progress", auth, async (req, res) => {
  try {
    const progress = await FlashcardProgress.find({
      userId: req.user.userId,
      setId: req.params.id
    }).lean();

    const map = {};
    progress.forEach(p => {
      map[p.cardId] = {
        masteryLevel: p.masteryLevel,
        lastStudied: p.lastStudied
      };
    });

    res.json({ 
      success: true, 
      progress: map 
    });
  } catch (err) {
    console.error("Fetch progress error:", err);
    res.status(500).json({ 
      success: false,
      error: "Failed to fetch progress" 
    });
  }
});

module.exports = router;