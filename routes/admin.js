// routes/admin.js — COMPLETE & FIXED FOR ADMIN (Dec 03, 2025)
const express = require("express");
const router = express.Router();
const User = require("../models/User");
const Quiz = require("../models/Quiz");
const QuizResult = require("../models/QuizResult");
const FlashcardSet = require("../models/FlashcardSet");
const ActivityLog = require("../models/ActivityLog");
const PDFParser = require("pdf2json");
const mammoth = require("mammoth");

const { GoogleGenerativeAI } = require("@google/generative-ai");
require("dotenv").config();

const GEMINI_API_KEYS = process.env.GEMINI_API_KEYS
  ? process.env.GEMINI_API_KEYS.split(",").map(k => k.trim()).filter(Boolean)
  : [];

const PRIMARY_MODEL = "gemini-2.5-flash";
const FALLBACK_MODEL = "gemini-2.5-pro";

if (GEMINI_API_KEYS.length === 0) {
  console.error("GEMINI_API_KEYS not set in .env");
  process.exit(1);
}

// ==================== AI MANAGER (Shared) ====================
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
      console.log(`Admin AI Ready → Key #${this.currentIdx + 1} → ${PRIMARY_MODEL}`);
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

// ==================== USERS MANAGEMENT ====================

/* Get all users with stats */
router.get("/users", async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const skip = (page - 1) * limit;

    const users = await User.find()
      .select("-password")
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean();

    const total = await User.countDocuments();

    const enriched = await Promise.all(
      users.map(async (user) => {
        const quizCount = await Quiz.countDocuments({ userId: user._id });
        const quizResultCount = await QuizResult.countDocuments({ userId: user._id });
        const flashcardCount = await FlashcardSet.countDocuments({ userId: user._id });
        const avgScore = quizResultCount > 0
          ? Math.round(
              (await QuizResult.aggregate([
                { $match: { userId: user._id } },
                { $group: { _id: null, avg: { $avg: "$score" } } },
              ]))[0]?.avg || 0
            )
          : 0;

        return {
          id: user._id,
          fullName: user.fullName,
          email: user.email,
          isAdmin: user.isAdmin,
          createdAt: user.createdAt,
          lastLogin: user.lastLogin,
          lastActive: user.lastActive,
          isActive: user.isActive,
          stats: {
            quizzesCreated: quizCount,
            quizzesTaken: quizResultCount,
            flashcardsCreated: flashcardCount,
            averageScore: avgScore,
            totalScore: user.totalScore,
            hoursPracticed: user.hoursPracticed,
          },
        };
      })
    );

    res.json({
      success: true,
      users: enriched,
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    });
  } catch (err) {
    console.error("Fetch users error:", err);
    res.status(500).json({ error: "Failed to fetch users" });
  }
});

/* Get single user details with full history */
router.get("/users/:userId", async (req, res) => {
  try {
    const user = await User.findById(req.params.userId).select("-password");
    if (!user) return res.status(404).json({ error: "User not found" });

    const quizzes = await Quiz.find({ userId: user._id }).lean();
    const quizResults = await QuizResult.find({ userId: user._id }).lean();
    const flashcards = await FlashcardSet.find({ userId: user._id }).lean();
    const activities = await ActivityLog.find({ userId: user._id })
      .sort({ timestamp: -1 })
      .limit(50)
      .lean();

    res.json({
      success: true,
      user,
      quizzesCreated: quizzes.length,
      quizzesAttempted: quizResults.length,
      flashcardsCreated: flashcards.length,
      recentActivities: activities,
      quizzes: quizzes.map(q => ({
        id: q._id,
        title: q.title,
        subject: q.subject,
        numQuestions: q.numQuestions,
        createdAt: q.createdAt,
      })),
    });
  } catch (err) {
    res.status(500).json({ error: "Server error" });
  }
});

/* Get user activity logs */
router.get("/users/:userId/activity", async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const skip = (page - 1) * limit;

    const activities = await ActivityLog.find({ userId: req.params.userId })
      .sort({ timestamp: -1 })
      .skip(skip)
      .limit(limit)
      .lean();

    const total = await ActivityLog.countDocuments({ userId: req.params.userId });

    res.json({
      success: true,
      activities,
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    });
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch activity logs" });
  }
});

/* Toggle user active status */
router.patch("/users/:userId/toggle-active", async (req, res) => {
  try {
    const user = await User.findById(req.params.userId);
    if (!user) return res.status(404).json({ error: "User not found" });

    const newActive = !user.isActive;
    await User.updateOne({ _id: req.params.userId }, { $set: { isActive: newActive } });

    await ActivityLog.create({
      userId: req.user.userId,
      action: newActive ? "user_activated" : "user_deactivated",
      entityType: "user",
      entityId: user._id,
      details: { adminAction: true },
    });

    res.json({ success: true, message: `User ${newActive ? "activated" : "deactivated"}` });
  } catch (err) {
    res.status(500).json({ error: "Server error" });
  }
});

/* Make user admin */
router.patch("/users/:userId/make-admin", async (req, res) => {
  try {
    const user = await User.findById(req.params.userId);
    if (!user) return res.status(404).json({ error: "User not found" });

    await User.updateOne({ _id: req.params.userId }, { $set: { isAdmin: true } });

    await ActivityLog.create({
      userId: req.user.userId,
      action: "user_promoted_to_admin",
      entityType: "user",
      entityId: user._id,
    });

    res.json({ success: true, message: "User promoted to admin" });
  } catch (err) {
    res.status(500).json({ error: "Server error" });
  }
});

// ==================== QUIZ MANAGEMENT ====================

/* Get all quizzes (admin view) */
router.get("/quizzes", async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const skip = (page - 1) * limit;

    const quizzes = await Quiz.find()
      .populate("userId", "fullName email")
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean();

    const total = await Quiz.countDocuments();

    const enriched = await Promise.all(
      quizzes.map(async (quiz) => {
        const attempts = await QuizResult.countDocuments({ quizId: quiz._id });
        const avgScore = attempts > 0
          ? Math.round(
              (await QuizResult.aggregate([
                { $match: { quizId: quiz._id } },
                { $group: { _id: null, avg: { $avg: "$score" } } },
              ]))[0]?.avg || 0
            )
          : 0;

        return {
          id: quiz._id,
          title: quiz.title,
          subject: quiz.subject,
          difficulty: quiz.difficulty,
          creator: quiz.userId?.fullName || quiz.authorName || "Anonymous",
          creatorId: quiz.userId?._id || null,
          numQuestions: quiz.numQuestions,
          attempts,
          avgScore,
          createdAt: quiz.createdAt,
        };
      })
    );

    res.json({
      success: true,
      quizzes: enriched,
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    });
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch quizzes" });
  }
});

/* Create quiz as admin (manual) */
router.post("/quizzes", async (req, res) => {
  try {
    const { title, subject, difficulty = "medium", timeLimit = 30, questions } = req.body;

    if (!title || !subject || !Array.isArray(questions) || questions.length === 0) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    const validQuestions = questions.filter(q =>
      q.question && Array.isArray(q.options) && q.options.length === 4 && q.correctAnswer !== undefined
    );

    if (validQuestions.length === 0) {
      return res.status(400).json({ error: "No valid questions" });
    }

    const quiz = new Quiz({
      userId: null,
      authorName: "Admin",
      title: title.trim(),
      subject: subject.trim(),
      difficulty,
      timeLimit: parseInt(timeLimit),
      numQuestions: validQuestions.length,
      questions: validQuestions,
      isPublic: true,
      isAdminCreated: true,
    });

    await quiz.save();

    res.json({ success: true, id: quiz._id, message: "Quiz created manually" });
  } catch (err) {
    res.status(500).json({ error: "Failed to create quiz" });
  }
});

/* Update quiz (admin only) */
router.patch("/quizzes/:quizId", async (req, res) => {
  try {
    const { title, subject, difficulty, timeLimit, questions } = req.body;

    const quiz = await Quiz.findById(req.params.quizId);
    if (!quiz) return res.status(404).json({ error: "Quiz not found" });

    if (title) quiz.title = title;
    if (subject) quiz.subject = subject;
    if (difficulty) quiz.difficulty = difficulty;
    if (timeLimit) quiz.timeLimit = timeLimit;
    if (questions && Array.isArray(questions)) {
      quiz.questions = questions;
      quiz.numQuestions = questions.length;
    }

    await quiz.save();

    await ActivityLog.create({
      userId: req.user.userId,
      action: "admin_updated_quiz",
      entityType: "quiz",
      entityId: quiz._id,
    });

    res.json({ success: true, message: "Quiz updated successfully" });
  } catch (err) {
    res.status(500).json({ error: "Failed to update quiz" });
  }
});

/* Delete quiz (admin only) */
router.delete("/quizzes/:quizId", async (req, res) => {
  try {
    const quiz = await Quiz.findByIdAndDelete(req.params.quizId);
    if (!quiz) return res.status(404).json({ error: "Quiz not found" });

    await QuizResult.deleteMany({ quizId: req.params.quizId });

    await ActivityLog.create({
      userId: req.user.userId,
      action: "admin_deleted_quiz",
      entityType: "quiz",
      entityId: quiz._id,
      details: { title: quiz.title },
    });

    res.json({ success: true, message: "Quiz deleted successfully" });
  } catch (err) {
    res.status(500).json({ error: "Failed to delete quiz" });
  }
});

// ==================== FLASHCARD MANAGEMENT ====================

/* Get all flashcard sets (admin view) */
router.get("/flashcards", async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const skip = (page - 1) * limit;

    const sets = await FlashcardSet.find()
      .populate("userId", "fullName email")
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean();

    const total = await FlashcardSet.countDocuments();

    const enriched = sets.map(set => ({
      id: set._id,
      title: set.title,
      subject: set.subject,
      creator: set.userId?.fullName || set.authorName || "Anonymous",
      creatorId: set.userId?._id || null,
      cardCount: set.cards.length,
      createdAt: set.createdAt,
      lastStudied: set.lastStudied,
    }));

    res.json({
      success: true,
      flashcards: enriched,
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    });
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch flashcard sets" });
  }
});

/* Create flashcard set as admin (manual) */
router.post("/flashcards", async (req, res) => {
  try {
    const { title, subject, cards } = req.body;

    if (!title || !subject || !Array.isArray(cards) || cards.length === 0) {
      return res.status(400).json({ error: "Missing fields" });
    }

    const validCards = cards
      .map(c => ({ question: c.question?.trim(), answer: c.answer?.trim() }))
      .filter(c => c.question && c.answer);

    if (validCards.length === 0) {
      return res.status(400).json({ error: "No valid cards" });
    }

    const set = new FlashcardSet({
      userId: null,
      authorName: "Admin",
      title: title.trim(),
      subject: subject.trim(),
      cards: validCards.map(c => ({ ...c, masteryLevel: 0 })),
      isPublic: true,
      isAdminCreated: true,
    });

    await set.save();

    res.json({ success: true, id: set._id, message: "Flashcards created manually" });
  } catch (err) {
    res.status(500).json({ error: "Failed to create flashcards" });
  }
});

/* Update flashcard set (admin only) */
router.patch("/flashcards/:setId", async (req, res) => {
  try {
    const { title, subject, cards } = req.body;

    const set = await FlashcardSet.findById(req.params.setId);
    if (!set) return res.status(404).json({ error: "Flashcard set not found" });

    if (title) set.title = title;
    if (subject) set.subject = subject;
    if (cards && Array.isArray(cards)) {
      set.cards = cards.map(c => ({
        question: c.question,
        answer: c.answer,
        masteryLevel: c.masteryLevel || 0,
      }));
    }

    await set.save();

    await ActivityLog.create({
      userId: req.user.userId,
      action: "admin_updated_flashcards",
      entityType: "flashcard",
      entityId: set._id,
    });

    res.json({ success: true, message: "Flashcard set updated successfully" });
  } catch (err) {
    res.status(500).json({ error: "Failed to update flashcard set" });
  }
});

/* Delete flashcard set (admin only) */
router.delete("/flashcards/:setId", async (req, res) => {
  try {
    const set = await FlashcardSet.findByIdAndDelete(req.params.setId);
    if (!set) return res.status(404).json({ error: "Flashcard set not found" });

    await ActivityLog.create({
      userId: req.user.userId,
      action: "admin_deleted_flashcards",
      entityType: "flashcard",
      entityId: set._id,
      details: { title: set.title },
    });

    res.json({ success: true, message: "Flashcard set deleted successfully" });
  } catch (err) {
    res.status(500).json({ error: "Failed to delete flashcard set" });
  }
});

// ==================== ANALYTICS & INSIGHTS ====================

/* Dashboard summary stats */
router.get("/dashboard/stats", async (req, res) => {
  try {
    const totalUsers = await User.countDocuments();
    const totalQuizzes = await Quiz.countDocuments();
    const totalFlashcards = await FlashcardSet.countDocuments();
    const totalQuizResults = await QuizResult.countDocuments();

    const avgScore = totalQuizResults > 0
      ? Math.round(
          (await QuizResult.aggregate([
            { $group: { _id: null, avg: { $avg: "$score" } } },
          ]))[0]?.avg || 0
        )
      : 0;

    const activeUsers = await User.countDocuments({
      lastActive: { $gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) },
    });

    const recentActivities = await ActivityLog.find()
      .sort({ timestamp: -1 })
      .limit(10)
      .populate("userId", "fullName")
      .lean();

    res.json({
      success: true,
      stats: {
        totalUsers,
        activeUsers,
        totalQuizzes,
        totalFlashcards,
        totalQuizAttempts: totalQuizResults,
        averageScore: avgScore,
      },
      recentActivities: recentActivities.map(a => ({
        action: a.action,
        user: a.userId?.fullName || "System",
        timestamp: a.timestamp,
        details: a.details,
      })),
    });
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch dashboard stats" });
  }
});

/* Get all activity logs */
router.get("/activity-logs", async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const skip = (page - 1) * limit;

    const logs = await ActivityLog.find()
      .populate("userId", "fullName email")
      .sort({ timestamp: -1 })
      .skip(skip)
      .limit(limit)
      .lean();

    const total = await ActivityLog.countDocuments();

    res.json({
      success: true,
      logs,
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    });
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch activity logs" });
  }
});

// ==================== ADMIN AI: Generate Quiz ====================
router.post("/quizzes/generate", async (req, res) => {
  let model = aiManager.getCurrentModel();
  if (!model) return res.status(500).json({ error: "AI service unavailable" });

  try {
    const {
      title = "Untitled Quiz",
      subject = "General",
      numQuestions = 15,
      difficulty = "medium",
      timeLimit = 30,
      content
    } = req.body;

    const file = req.files?.file;

    let extractedText = "";

    // 1. Pasted Text
    if (content && typeof content === "string" && content.trim().length > 150) {
      extractedText = content.trim();
    }
    // 2. File Upload (PDF or DOCX)
    else if (file) {
      const allowed = ["application/pdf", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"];
      if (!allowed.includes(file.mimetype)) {
        return res.status(400).json({ error: "Only PDF and DOCX allowed" });
      }
      if (file.size > 12 * 1024 * 1024) {
        return res.status(400).json({ error: "File must be under 12MB" });
      }

      if (file.mimetype === "application/pdf") {
        const pdfParser = new PDFParser();
        const data = await new Promise((resolve, reject) => {
          pdfParser.on("pdfParser_dataError", reject);
          pdfParser.on("pdfParser_dataReady", resolve);
          pdfParser.parseBuffer(file.data);
        });
        for (const page of data.Pages) {
          for (const text of page.Texts) {
            try {
              extractedText += decodeURIComponent(text.R[0].T) + " ";
            } catch {
              extractedText += " ";
            }
          }
        }
      } else {
        const result = await mammoth.extractRawText({ buffer: file.data });
        extractedText = result.value;
      }
    } else {
      return res.status(400).json({ error: "Provide either content or file" });
    }

    if (!extractedText.trim()) {
      return res.status(400).json({ error: "No readable text found" });
    }

    const safeText = extractedText.slice(0, 60_000);

    const prompt = `
Generate ${numQuestions} multiple-choice questions.
Subject: ${subject}
Difficulty: ${difficulty}

Output ONLY valid JSON array:
[
  {
    "question": "Text?",
    "options": ["A", "B", "C", "D"],
    "correctAnswer": 0
  }
]

Content:
${safeText}
    `.trim();

    let raw = "";
    let attempts = 0;
    while (attempts < 6) {
      try {
        const result = await model.generateContent(prompt);
        raw = result.response.text().trim();
        if (raw) break;
      } catch (err) {
        attempts++;
        console.warn(`Quiz attempt ${attempts} failed:`, err.message);

        if (err.message.includes("404") || attempts === 1) {
          model = aiManager._getModel(aiManager.keys[aiManager.currentIdx], FALLBACK_MODEL);
        }
        const rotated = await aiManager.rotateIfNeeded(err);
        if (rotated) { model = rotated; attempts = 0; }
        await sleep(2000 * attempts);
      }
    }

    if (!raw) return res.status(500).json({ error: "AI failed after retries" });

    let questions;
    try {
      questions = JSON.parse(raw);
      if (!Array.isArray(questions)) throw new Error();
      questions = questions
        .map(q => ({
          question: q.question?.trim(),
          options: Array.isArray(q.options) ? q.options.slice(0, 4) : [],
          correctAnswer: Number(q.correctAnswer)
        }))
        .filter(q => q.question && q.options.length === 4 && !isNaN(q.correctAnswer));
    } catch {
      return res.status(500).json({ error: "AI returned invalid JSON" });
    }

    if (questions.length === 0) {
      return res.status(500).json({ error: "No valid questions generated" });
    }

    const quiz = new Quiz({
      userId: null,
      authorName: "Admin",
      title: title.trim(),
      subject: subject.trim(),
      difficulty,
      timeLimit: parseInt(timeLimit),
      numQuestions: questions.length,
      questions,
      isPublic: true,
      isAdminCreated: true,
    });

    await quiz.save();

    res.json({
      success: true,
      id: quiz._id,
      message: "Quiz created successfully!",
      count: questions.length
    });

  } catch (err) {
    console.error("Admin generate quiz error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// ==================== ADMIN AI: Generate Flashcards ====================
router.post("/flashcards/generate", async (req, res) => {
  let model = aiManager.getCurrentModel();
  if (!model) return res.status(500).json({ error: "AI service unavailable" });

  try {
    const { title = "Untitled Flashcards", subject = "General", content } = req.body;
    const pdfFile = req.files?.pdfFile;

    let extractedText = "";

    if (content && typeof content === "string" && content.trim().length > 100) {
      extractedText = content.trim();
    } else if (pdfFile) {
      if (pdfFile.mimetype !== "application/pdf") {
        return res.status(400).json({ error: "Only PDF allowed" });
      }
      if (pdfFile.size > 5 * 1024 * 1024) {
        return res.status(400).json({ error: "PDF must be under 5MB" });
      }

      const pdfParser = new PDFParser();
      const data = await new Promise((resolve, reject) => {
        pdfParser.on("pdfParser_dataError", reject);
        pdfParser.on("pdfParser_dataReady", resolve);
        pdfParser.parseBuffer(pdfFile.data);
      });

      for (const page of data.Pages) {
        for (const text of page.Texts) {
          try {
            extractedText += decodeURIComponent(text.R[0].T) + " ";
          } catch {
            extractedText += " ";
          }
        }
      }
    } else {
      return res.status(400).json({ error: "Provide content or PDF" });
    }

    if (!extractedText.trim()) {
      return res.status(400).json({ error: "No text extracted" });
    }

    const safeText = extractedText.slice(0, 30_000);

    const prompt = `
Generate 12 high-quality flashcards.
Subject: ${subject}

Output ONLY valid JSON:
[
  {"question": "Term?", "answer": "Definition"}
]

Content:
${safeText}
    `.trim();

    let raw = "";
    let attempts = 0;
    while (attempts < 6) {
      try {
        const result = await model.generateContent(prompt);
        raw = result.response.text().trim();
        if (raw) break;
      } catch (err) {
        attempts++;
        const rotated = await aiManager.rotateIfNeeded(err);
        if (rotated) { model = rotated; attempts = 0; }
        await sleep(2000 * attempts);
      }
    }

    if (!raw) return res.status(500).json({ error: "AI failed" });

    let cards;
    try {
      const cleaned = raw.replace(/^```json\s*|```$/gi, "").trim();
      cards = JSON.parse(cleaned);
      if (!Array.isArray(cards)) throw new Error();
      cards = cards
        .map(c => ({ question: c.question?.trim(), answer: c.answer?.trim() }))
        .filter(c => c.question && c.answer);
    } catch {
      return res.status(500).json({ error: "Invalid flashcard format" });
    }

    if (cards.length === 0) {
      return res.status(500).json({ error: "No valid cards" });
    }

    const set = new FlashcardSet({
      userId: null,
      authorName: "Admin",
      title: title.trim(),
      subject: subject.trim(),
      cards: cards.map(c => ({ ...c, masteryLevel: 0 })),
      isPublic: true,
      isAdminCreated: true,
    });

    await set.save();

    res.json({
      success: true,
      id: set._id,
      message: "Flashcards created!",
      count: cards.length
    });

  } catch (err) {
    console.error("Admin generate flashcards error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// ==================== FINANCE SUMMARY ====================
router.get("/finance/summary", async (req, res) => {
  try {
    const totalUsers = await User.countDocuments();
    const activeUsers = await User.countDocuments({
      lastActive: { $gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) },
    });
    const totalQuizAttempts = await QuizResult.countDocuments();
    const totalQuizzes = await Quiz.countDocuments();
    const totalFlashcards = await FlashcardSet.countDocuments();

    // Daily activity for last 30 days
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const dailyActivity = await ActivityLog.aggregate([
      { $match: { timestamp: { $gte: thirtyDaysAgo } } },
      {
        $group: {
          _id: {
            $dateToString: { format: "%Y-%m-%d", date: "$timestamp" }
          },
          count: { $sum: 1 }
        }
      },
      { $sort: { _id: 1 } },
      { $limit: 30 }
    ]);

    // Top quiz subjects by attempt volume
    const topSubjects = await QuizResult.aggregate([
      {
        $lookup: {
          from: "quizzes",
          localField: "quizId",
          foreignField: "_id",
          as: "quiz"
        }
      },
      { $unwind: { path: "$quiz", preserveNullAndEmptyArrays: true } },
      {
        $group: {
          _id: "$quiz.subject",
          attempts: { $sum: 1 },
          avgScore: { $avg: "$score" }
        }
      },
      { $sort: { attempts: -1 } },
      { $limit: 8 }
    ]);

    res.json({
      success: true,
      summary: {
        totalUsers,
        activeUsers,
        totalQuizAttempts,
        totalQuizzes,
        totalFlashcards,
        engagementRate: totalUsers > 0 ? Math.round((activeUsers / totalUsers) * 100) : 0,
      },
      dailyActivity: dailyActivity.map(d => ({ date: d._id, count: d.count })),
      topSubjects: topSubjects.map(s => ({
        subject: s._id || "General",
        attempts: s.attempts,
        avgScore: Math.round(s.avgScore || 0),
      })),
    });
  } catch (err) {
    console.error("Finance summary error:", err);
    res.status(500).json({ error: "Failed to fetch finance summary" });
  }
});

// ==================== OPERATIONS HEALTH ====================
router.get("/operations/health", async (req, res) => {
  try {
    const [
      totalUsers,
      totalQuizzes,
      totalFlashcards,
      totalResults,
      totalLogs,
      recentErrors
    ] = await Promise.all([
      User.countDocuments(),
      Quiz.countDocuments(),
      FlashcardSet.countDocuments(),
      QuizResult.countDocuments(),
      ActivityLog.countDocuments(),
      ActivityLog.find({ action: { $regex: /error|fail/i } })
        .sort({ timestamp: -1 })
        .limit(5)
        .lean()
    ]);

    const dbStats = {
      users: totalUsers,
      quizzes: totalQuizzes,
      flashcards: totalFlashcards,
      quizResults: totalResults,
      activityLogs: totalLogs,
    };

    res.json({
      success: true,
      status: "healthy",
      uptime: Math.round(process.uptime()),
      memoryMB: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
      dbStats,
      recentErrors: recentErrors.map(e => ({
        action: e.action,
        timestamp: e.timestamp,
        details: e.details,
      })),
    });
  } catch (err) {
    console.error("Operations health error:", err);
    res.status(500).json({ error: "Failed to fetch operations health" });
  }
});

module.exports = router;