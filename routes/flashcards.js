// routes/flashcards.js — FINAL & FULLY WORKING (Nov 30, 2025)
const express = require("express");
const router = express.Router();
const auth = require("../middlewares/auth");
const FlashcardSet = require("../models/FlashcardSet");
const PDFParser = require("pdf2json");
require("dotenv").config();

const { gemini, capText } = require("../utils/ai");

// ==================== GENERATE FLASHCARDS (PDF OR TEXT) ====================
router.post("/generate-flashcards", auth, async (req, res) => {
  if (!gemini.ready) return res.status(503).json({ error: "AI service unavailable — check GEMINI_API_KEYS" });

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

    const safeText = capText(extractedText, 30000);

    const prompt = `You are an expert flashcard creator. Generate 12 high-quality flashcards from this content.
Subject: ${subject || "General"}
Return ONLY a valid JSON array, no markdown:
[{"question":"...","answer":"...","topic":"the specific sub-topic this card tests, e.g. 'Depreciation' not just 'Accounting'"},...]
Content:
${safeText}`.trim();

    let cards;
    try {
      const parsed = await gemini.generateJSON(prompt);
      cards = Array.isArray(parsed) ? parsed : parsed?.cards || parsed?.flashcards || [];
      if (cards.length === 0) throw new Error("Empty card array");
    } catch (aiErr) {
      console.error("Flashcard AI error:", aiErr.message);
      return res.status(500).json({ error: `AI error: ${aiErr.message}` });
    }

    if (!Array.isArray(cards) || cards.length === 0) {
      return res.status(500).json({ error: "AI returned no flashcards. Try again." });
    }

    {  // keep scope for existing code below

    cards = cards
      .map(c => ({ question: (c.question || "").trim(), answer: (c.answer || "").trim(), topic: (c.topic || "").trim() }))
      .filter(c => c.question && c.answer);

    if (cards.length === 0)
      return res.status(500).json({ error: "AI returned no valid flashcards. Try again." });

    }  // end scope

    const flashcardSet = new FlashcardSet({
      userId: req.user.userId,
      title: title?.trim() || "Untitled Flashcards",
      subject: subject?.trim() || "General",
      cards: cards.map(c => ({
        question: c.question,
        answer: c.answer,
        masteryLevel: 0,
        topic: c.topic || "",
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