// routes/flashcards.js — FINAL & FULLY WORKING (Nov 30, 2025)
const express = require("express");
const router = express.Router();
const auth = require("../middlewares/auth");
const FlashcardSet = require("../models/FlashcardSet");
const FlashcardProgress = require("../models/FlashcardProgress");
const { extractPdfText, pdfParseAvailable } = require("../utils/pdfExtract");
const { resolveUploadedFiles } = require("../utils/blobFetch");
const { extractUrlText } = require("../utils/urlExtract");
const { escapeRegExp } = require("../utils/subjectResolver");
require("dotenv").config();

const { gemini, capText } = require("../utils/ai");

// ==================== GENERATE FLASHCARDS (PDF OR TEXT) ====================
router.post("/generate-flashcards", auth, async (req, res) => {
  if (!gemini.ready) return res.status(503).json({ error: "AI service is temporarily unavailable. Please try again shortly." });

  try {
    const { title, subject, content, url } = req.body;
    // 'vision' sends the raw PDF straight to Gemini so diagrams/charts/images
    // are actually read, not just whatever text pdf-parse could pull out.
    const extractionMode = req.body?.extractionMode === "vision" ? "vision" : "text";

    let pdfFile;
    try {
      const files = await resolveUploadedFiles(req, { fileField: "pdfFile", urlField: "pdfUrls" });
      pdfFile = files[0];
    } catch (fetchErr) {
      return res.status(422).json({ error: `Could not read the uploaded file: ${fetchErr.message}` });
    }

    let extractedText = "";
    let useVision = false;

    // 1. URL (priority — explicit source over a vaguer pasted-text fallback)
    if (url && typeof url === "string" && url.trim()) {
      try {
        extractedText = await extractUrlText(url);
      } catch (urlErr) {
        return res.status(400).json({ error: urlErr.message });
      }
    }
    // 2. PASTED TEXT
    else if (content && typeof content === "string" && content.trim().length > 100) {
      extractedText = content.trim();
    }
    // 3. PDF UPLOAD
    else if (pdfFile) {
      if (pdfFile.mimetype !== "application/pdf") {
        return res.status(400).json({ error: "Only PDF files are allowed" });
      }
      if (pdfFile.data.length > 10 * 1024 * 1024) {
        return res.status(400).json({ error: "PDF must be under 10MB" });
      }

      if (extractionMode === "vision") {
        useVision = true;
      } else {
        if (!pdfParseAvailable()) return res.status(503).json({ error: "PDF parser unavailable on this server. Please paste your notes as text instead." });
        try {
          extractedText = await extractPdfText(pdfFile.data);
        } catch (extractErr) {
          console.error("PDF parse error:", extractErr.message);
          return res.status(422).json({ error: "PDF parsing failed. Try the \"Has Images / Diagrams\" option, or paste the text instead." });
        }
      }
    } else {
      return res.status(400).json({ error: "Please provide pasted text, a URL, or upload a PDF" });
    }

    if (!useVision && !extractedText.trim()) {
      return res.status(400).json({ error: "No readable text found in your input" });
    }

    const safeText = capText(extractedText, 30000);

    const prompt = `You are an expert flashcard creator. Generate 12 high-quality flashcards from this content.
Subject: ${subject || "General"}
Return ONLY a valid JSON array, no markdown:
[{"question":"...","answer":"...","topic":"the specific sub-topic this card tests, e.g. 'Depreciation' not just 'Accounting'"},...]
${useVision ? "The content is attached as a PDF file — read all text AND any diagrams, charts, tables, or images it contains." : `Content:\n${safeText}`}`.trim();

    let cards;
    try {
      const parsed = useVision
        ? await gemini.generateJSONFromFiles(prompt, [{ data: pdfFile.data, mimeType: pdfFile.mimetype || "application/pdf" }])
        : await gemini.generateJSON(prompt);
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
      sourceText: useVision ? "" : safeText,
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
        topic: c.topic?.trim() || "",
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

// ==================== ADD MORE CARDS ====================
// Appends new, non-duplicate cards to an existing set — grounded in the
// set's stored sourceText when available (sets generated from a PDF/pasted
// text), falling back to subject + existing card topics for manually-
// created sets or vision-mode uploads (which never had a text transcript).
const ADD_CARDS_MAX_PER_CALL = 30;

router.post("/sets/:id/add-cards", auth, async (req, res) => {
  if (!gemini.ready) return res.status(503).json({ error: "AI service is temporarily unavailable. Please try again shortly." });

  try {
    const set = await FlashcardSet.findOne({ _id: req.params.id, userId: req.user.userId });
    if (!set) return res.status(404).json({ error: "Set not found" });

    const requestedCount = parseInt(req.body?.count, 10);
    const targetCount = Math.min(Number.isFinite(requestedCount) && requestedCount > 0 ? requestedCount : 10, ADD_CARDS_MAX_PER_CALL);

    const existingTopics = set.cards.map(c => c.topic).filter(Boolean);
    const existingQuestions = set.cards.map(c => c.question).filter(Boolean);

    const prompt = set.sourceText
      ? `You are an expert flashcard creator. Generate ${targetCount} NEW high-quality flashcards from this content — grounded strictly in the material below, not generic facts about the subject.
Subject: ${set.subject}
Content:
${capText(set.sourceText, 30000)}
${existingTopics.length ? `\nCards already made covering: ${existingTopics.join('; ')}. Do NOT repeat these — cover different sub-topics or angles still untested in the material.` : ''}
Return ONLY a valid JSON array, no markdown:
[{"question":"...","answer":"...","topic":"the specific sub-topic this card tests"}]`
      : `You are an expert flashcard creator. Generate ${targetCount} NEW high-quality flashcards for the subject "${set.subject}".
${existingQuestions.length ? `Cards that already exist in this set (do NOT repeat these or anything too similar):\n${existingQuestions.slice(0, 40).map(q => `- ${q}`).join('\n')}` : ''}
Return ONLY a valid JSON array, no markdown:
[{"question":"...","answer":"...","topic":"the specific sub-topic this card tests"}]`;

    let cards;
    try {
      const parsed = await gemini.generateJSON(prompt, { maxOutputTokens: 4096, temperature: 0.6 });
      cards = Array.isArray(parsed) ? parsed : parsed?.cards || parsed?.flashcards || [];
    } catch (aiErr) {
      console.error("Add cards AI error:", aiErr.message);
      return res.status(500).json({ error: `AI failed to generate more cards: ${aiErr.message}` });
    }

    cards = cards
      .map(c => ({ question: (c.question || "").trim(), answer: (c.answer || "").trim(), topic: (c.topic || "").trim() }))
      .filter(c => c.question && c.answer)
      .slice(0, targetCount);

    if (cards.length === 0)
      return res.status(500).json({ error: "AI could not generate further distinct cards. Please try again." });

    set.cards.push(...cards.map(c => ({ question: c.question, answer: c.answer, masteryLevel: 0, topic: c.topic })));
    await set.save();

    res.json({ success: true, addedCount: cards.length, totalCards: set.cards.length, cards: set.cards });
  } catch (err) {
    console.error("Add cards error:", err);
    res.status(500).json({ error: err.message || "Failed to add more cards" });
  }
});

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

    // Search matches across the ENTIRE public collection (title or subject),
    // not just the currently-loaded page.
    const search = (req.query.search || "").trim();
    const searchFilter = search
      ? { $or: [
          { title:   { $regex: escapeRegExp(search), $options: "i" } },
          { subject: { $regex: escapeRegExp(search), $options: "i" } },
        ] }
      : {};

    // Fetch ALL flashcard sets (no isPublic filter)
    const [sets, total] = await Promise.all([
      FlashcardSet.find(searchFilter)  // Removed: isPublic: true
        .select("title subject cards createdAt lastStudied authorName")
        .populate("userId", "fullName")
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),

      FlashcardSet.countDocuments(searchFilter)  // Removed: isPublic: true
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
    const set = await FlashcardSet.findById(req.params.id).populate("userId", "fullName").lean();
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

    // $inc alone already gives the right behavior on upsert — Mongo creates
    // the field starting from 0 when the document doesn't exist yet, so
    // there's no need for a separate $setOnInsert here. Combining
    // $setOnInsert and $inc on the SAME field is rejected by MongoDB outright
    // (ConflictingUpdateOperators, error code 40) — every study action on a
    // shared/public set was failing because of this.
    const progress = await FlashcardProgress.findOneAndUpdate(
      { userId: req.user.userId, setId, cardId },
      {
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