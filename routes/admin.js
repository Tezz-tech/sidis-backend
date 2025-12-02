const express = require("express");
const router = express.Router();
const auth = require("../middlewares/auth");
const adminAuth = require("../middlewares/adminAuth");
const User = require("../models/User");
const Quiz = require("../models/Quiz");
const QuizResult = require("../models/QuizResult");
const FlashcardSet = require("../models/FlashcardSet");
const ActivityLog = require("../models/ActivityLog");

const { GoogleGenerativeAI } = require("@google/generative-ai");
require("dotenv").config();

const GEMINI_API_KEYS = process.env.GEMINI_API_KEYS
  ? process.env.GEMINI_API_KEYS.split(",").map(k => k.trim()).filter(Boolean)
  : [];

const PRIMARY_MODEL = "gemini-2.5-flash";
const FALLBACK_MODEL = "gemini-2.5-pro";

// Enforce admin on all admin routes
router.use(auth, adminAuth);

// --- Lightweight AI helper (tries keys sequentially, fallback model on 1st key failure) ---
async function generateWithGemini(prompt) {
  if (!GEMINI_API_KEYS.length) {
    throw new Error("No Gemini API keys configured");
  }

  for (let i = 0; i < GEMINI_API_KEYS.length; i++) {
    const key = GEMINI_API_KEYS[i];
    try {
      const genAI = new GoogleGenerativeAI(key);
      let model;
      try {
        model = genAI.getGenerativeModel({
          model: PRIMARY_MODEL,
          generationConfig: {
            temperature: 0.7,
            topK: 40,
            topP: 0.95,
            maxOutputTokens: 8192,
            responseMimeType: "application/json",
          },
        });
      } catch (e) {
        // try fallback for this key
        model = genAI.getGenerativeModel({
          model: FALLBACK_MODEL,
          generationConfig: {
            temperature: 0.7,
            maxOutputTokens: 8192,
            responseMimeType: "application/json",
          },
        });
      }

      const result = await model.generateContent(prompt);
      const raw = result?.response?.text?.().trim?.() ?? result?.response ?? "";
      if (!raw) throw new Error("Empty response from AI");
      return raw;
    } catch (err) {
      // Try next key
      console.warn(`Gemini key #${i + 1} failed: ${err.message}`);
      continue;
    }
  }

  throw new Error("All Gemini keys failed");
}

// ==================== USERS MANAGEMENT ====================

/* Get all users with stats */
router.get("/users", auth, async (req, res) => {
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
            quizzesToaken: quizResultCount,
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
router.get("/users/:userId", auth, async (req, res) => {
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
router.get("/users/:userId/activity", auth, async (req, res) => {
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
router.patch("/users/:userId/toggle-active", auth, async (req, res) => {
  try {
    const user = await User.findById(req.params.userId);
    if (!user) return res.status(404).json({ error: "User not found" });

    user.isActive = !user.isActive;
    await user.save();

    await ActivityLog.create({
      userId: req.user.userId,
      action: user.isActive ? "user_activated" : "user_deactivated",
      entityType: "user",
      entityId: user._id,
      details: { adminAction: true },
    });

    res.json({ success: true, message: `User ${user.isActive ? "activated" : "deactivated"}` });
  } catch (err) {
    res.status(500).json({ error: "Server error" });
  }
});

/* Make user admin */
router.patch("/users/:userId/make-admin", auth, async (req, res) => {
  try {
    const user = await User.findById(req.params.userId);
    if (!user) return res.status(404).json({ error: "User not found" });

    user.isAdmin = true;
    await user.save();

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
router.get("/quizzes", auth, async (req, res) => {
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
          creator: quiz.userId.fullName,
          creatorId: quiz.userId._id,
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

/* Create quiz as admin (for specific user or global) */
router.post("/quizzes", auth, async (req, res) => {
  try {
    const { title, subject, difficulty, timeLimit, questions, assignToUserId } = req.body;

    if (!title || !subject || !Array.isArray(questions) || questions.length === 0) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    const quiz = new Quiz({
      userId: assignToUserId || req.user.userId,
      title,
      subject,
      difficulty: difficulty || "medium",
      timeLimit: timeLimit || 30,
      numQuestions: questions.length,
      questions,
      isAdminCreated: true,
    });

    await quiz.save();

    await ActivityLog.create({
      userId: req.user.userId,
      action: "admin_created_quiz",
      entityType: "quiz",
      entityId: quiz._id,
      details: { title, subject },
    });

    res.json({ success: true, id: quiz._id, message: "Quiz created successfully" });
  } catch (err) {
    res.status(500).json({ error: "Failed to create quiz" });
  }
});

/* Update quiz (admin only) */
router.patch("/quizzes/:quizId", auth, async (req, res) => {
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
router.delete("/quizzes/:quizId", auth, async (req, res) => {
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
router.get("/flashcards", auth, async (req, res) => {
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
      creator: set.userId.fullName,
      creatorId: set.userId._id,
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

/* Create flashcard set as admin */
router.post("/flashcards", auth, async (req, res) => {
  try {
    const { title, subject, cards, assignToUserId } = req.body;

    if (!title || !subject || !Array.isArray(cards) || cards.length === 0) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    const set = new FlashcardSet({
      userId: assignToUserId || req.user.userId,
      title,
      subject,
      cards: cards.map(c => ({
        question: c.question,
        answer: c.answer,
        masteryLevel: 0,
      })),
      isAdminCreated: true,
    });

    await set.save();

    await ActivityLog.create({
      userId: req.user.userId,
      action: "admin_created_flashcards",
      entityType: "flashcard",
      entityId: set._id,
      details: { title, subject },
    });

    res.json({ success: true, id: set._id, message: "Flashcard set created successfully" });
  } catch (err) {
    res.status(500).json({ error: "Failed to create flashcard set" });
  }
});

/* Update flashcard set (admin only) */
router.patch("/flashcards/:setId", auth, async (req, res) => {
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
router.delete("/flashcards/:setId", auth, async (req, res) => {
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
router.get("/dashboard/stats", auth, async (req, res) => {
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
        user: a.userId.fullName,
        timestamp: a.timestamp,
        details: a.details,
      })),
    });
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch dashboard stats" });
  }
});

/* Get all activity logs */
router.get("/activity-logs", auth, async (req, res) => {
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

// ----------------- ADMIN AI: Generate Quiz -----------------
router.post("/quizzes/generate", async (req, res) => {
  try {
    const { title, subject = "General", numQuestions = 10, difficulty = "medium", timeLimit = 30, content, assignToUserId } = req.body;

    if (!content || typeof content !== "string" || content.trim().length < 50) {
      return res.status(400).json({ error: "Please provide 'content' (pasted text) of sufficient length" });
    }

    const safeContent = content.trim().slice(0, 60_000);
    const prompt = `
You are an expert teacher. Generate ${numQuestions} multiple-choice questions based strictly on the content below.
Subject: ${subject}
Difficulty: ${difficulty}

Output ONLY a valid JSON array with this shape:
[
  { "question": "Question text?", "options": ["A","B","C","D"], "correctAnswer": 0 }
]

Content:
${safeContent}
    `.trim();

    let raw;
    try {
      raw = await generateWithGemini(prompt);
    } catch (e) {
      console.error("AI generation failed:", e);
      return res.status(500).json({ error: "AI generation failed" });
    }

    let questions;
    try {
      questions = JSON.parse(raw);
      if (!Array.isArray(questions) || questions.length === 0) throw new Error("Invalid format");
      // Basic validation/normalize
      questions = questions.map(q => ({
        question: q.question,
        options: Array.isArray(q.options) ? q.options.slice(0,4) : [],
        correctAnswer: Number(q.correctAnswer)
      })).filter(q => q.question && q.options && q.options.length === 4);
      if (questions.length === 0) throw new Error("No valid questions");
    } catch (e) {
      console.error("Parse AI quiz error:", e);
      return res.status(500).json({ error: "Failed to parse AI output" });
    }

    const quiz = new Quiz({
      userId: assignToUserId || req.user.userId,
      authorName: req.user.fullName || null,
      title: title?.trim() || "Untitled Quiz (AI)",
      subject,
      difficulty,
      timeLimit: parseInt(timeLimit, 10),
      numQuestions: questions.length,
      questions,
      isAdminCreated: true,
      isPublic: true
    });

    await quiz.save();

    await ActivityLog.create({
      userId: req.user.userId,
      action: "admin_ai_generated_quiz",
      entityType: "quiz",
      entityId: quiz._id,
      details: { title: quiz.title, subject }
    });

    res.status(201).json({ success: true, id: quiz._id, message: "AI generated quiz created" });
  } catch (err) {
    console.error("Admin generate quiz error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// ----------------- ADMIN AI: Generate Flashcards -----------------
router.post("/flashcards/generate", async (req, res) => {
  try {
    const { title, subject = "General", content, assignToUserId } = req.body;

    if (!content || typeof content !== "string" || content.trim().length < 50) {
      return res.status(400).json({ error: "Please provide 'content' (pasted text) of sufficient length" });
    }

    const safeContent = content.trim().slice(0, 30_000);
    const prompt = `
You are an expert flashcard creator. Generate 12 high-quality flashcards from the content below.
Subject: ${subject}
Output ONLY a valid JSON array of {"question": "...", "answer": "..."}.

Content:
${safeContent}
    `.trim();

    let raw;
    try {
      raw = await generateWithGemini(prompt);
    } catch (e) {
      console.error("AI generation failed:", e);
      return res.status(500).json({ error: "AI generation failed" });
    }

    let cards;
    try {
      const cleaned = typeof raw === "string" ? raw.replace(/^```json\s*|```$/gi, "").trim() : raw;
      cards = JSON.parse(cleaned);
      if (!Array.isArray(cards) || cards.length === 0) throw new Error("Invalid format");
      cards = cards.map(c => ({ question: (c.question || "").trim(), answer: (c.answer || "").trim() }))
                   .filter(c => c.question && c.answer);
      if (cards.length === 0) throw new Error("No valid cards");
    } catch (e) {
      console.error("Parse AI flashcards error:", e);
      return res.status(500).json({ error: "Failed to parse AI output" });
    }

    const set = new FlashcardSet({
      userId: assignToUserId || req.user.userId,
      authorName: req.user.fullName || null,
      title: title?.trim() || "Untitled Flashcards (AI)",
      subject,
      cards: cards.map(c => ({ question: c.question, answer: c.answer, masteryLevel: 0 })),
      isAdminCreated: true,
      isPublic: true
    });

    await set.save();

    await ActivityLog.create({
      userId: req.user.userId,
      action: "admin_ai_generated_flashcards",
      entityType: "flashcard",
      entityId: set._id,
      details: { title: set.title, subject }
    });

    res.status(201).json({ success: true, id: set._id, message: "AI generated flashcard set created", count: cards.length });
  } catch (err) {
    console.error("Admin generate flashcards error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// Ensure we export an Express router (compatible with require('./routes/admin'))
module.exports = typeof module.exports === 'object' && module.exports !== null && module.exports.router
  ? module.exports.router
  : (module.exports = router);
