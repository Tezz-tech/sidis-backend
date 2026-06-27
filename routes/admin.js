// routes/admin.js
const express = require("express");
const router = express.Router();
const User = require("../models/User");
const Quiz = require("../models/Quiz");
const QuizResult = require("../models/QuizResult");
const FlashcardSet = require("../models/FlashcardSet");
const ActivityLog = require("../models/ActivityLog");
const Subscription = require("../models/Subscription");
const PDFParser = require("pdf2json");
const mammoth = require("mammoth");

require("dotenv").config();
const { gemini, capText } = require("../utils/ai");

const PLAN_CONFIG = {
  exam_mode:          { name: 'Exam Mode',          amount: 700000,  durationDays: 3650 },
  weekly_individual:  { name: 'Weekly Individual',  amount: 550000,  durationDays: 7    },
  weekly_group:       { name: 'Weekly Group',       amount: 270000,  durationDays: 7    },
  monthly_individual: { name: 'Monthly Individual', amount: 1500000, durationDays: 30   },
  monthly_group:      { name: 'Monthly Group',      amount: 333400,  durationDays: 30   },
  yearly_individual:  { name: 'Yearly Individual',  amount: 5000000, durationDays: 365  },
  yearly_group:       { name: 'Yearly Group',       amount: 833300,  durationDays: 365  },
};

// ==================== USERS MANAGEMENT ====================

/* Get all users with stats + active subscription plan */
router.get("/users", async (req, res) => {
  try {
    const page  = parseInt(req.query.page)  || 1;
    const limit = parseInt(req.query.limit) || 10;
    const skip  = (page - 1) * limit;

    const [users, total] = await Promise.all([
      User.find().select("-password").sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
      User.countDocuments(),
    ]);

    const now = new Date();

    const enriched = await Promise.all(
      users.map(async (user) => {
        const [quizCount, quizResultCount, flashcardCount, activeSub, scoreAgg] = await Promise.all([
          Quiz.countDocuments({ userId: user._id }),
          QuizResult.countDocuments({ userId: user._id }),
          FlashcardSet.countDocuments({ userId: user._id }),
          Subscription.findOne({
            userId: user._id,
            status: 'active',
            $or: [{ expiresAt: null }, { expiresAt: { $gt: now } }],
          }).lean(),
          QuizResult.aggregate([
            { $match: { userId: user._id } },
            { $group: { _id: null, avg: { $avg: "$score" } } },
          ]),
        ]);

        return {
          id: user._id,
          fullName: user.fullName,
          email: user.email,
          phoneNumber: user.phoneNumber,
          isAdmin: user.isAdmin,
          createdAt: user.createdAt,
          lastLogin: user.lastLogin,
          lastActive: user.lastActive,
          isActive: user.isActive,
          stats: {
            quizzesCreated: quizCount,
            quizzesTaken: quizResultCount,
            flashcardsCreated: flashcardCount,
            averageScore: scoreAgg.length ? Math.round(scoreAgg[0].avg || 0) : 0,
            totalScore: user.totalScore,
            hoursPracticed: user.hoursPracticed,
            xp: user.xp,
            level: user.level,
            currentStreak: user.currentStreak,
          },
          subscription: activeSub ? {
            plan:     activeSub.plan,
            planName: activeSub.planName,
            status:   activeSub.status,
            expiresAt: activeSub.expiresAt,
            amount:   activeSub.amount,
          } : null,
        };
      })
    );

    res.json({ success: true, users: enriched, pagination: { page, limit, total, pages: Math.ceil(total / limit) } });
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

    const [quizzes, quizResults, flashcards, activities, subscriptions] = await Promise.all([
      Quiz.find({ userId: user._id }).lean(),
      QuizResult.find({ userId: user._id }).lean(),
      FlashcardSet.find({ userId: user._id }).lean(),
      ActivityLog.find({ userId: user._id }).sort({ timestamp: -1 }).limit(50).lean(),
      Subscription.find({ userId: user._id }).sort({ createdAt: -1 }).lean(),
    ]);

    res.json({
      success: true,
      user,
      quizzesCreated: quizzes.length,
      quizzesAttempted: quizResults.length,
      flashcardsCreated: flashcards.length,
      subscriptions,
      recentActivities: activities,
      quizzes: quizzes.map(q => ({
        id: q._id, title: q.title, subject: q.subject,
        numQuestions: q.numQuestions, createdAt: q.createdAt,
      })),
    });
  } catch (err) {
    res.status(500).json({ error: "Server error" });
  }
});

/* Get user activity logs */
router.get("/users/:userId/activity", async (req, res) => {
  try {
    const page  = parseInt(req.query.page)  || 1;
    const limit = parseInt(req.query.limit) || 20;
    const skip  = (page - 1) * limit;

    const [activities, total] = await Promise.all([
      ActivityLog.find({ userId: req.params.userId }).sort({ timestamp: -1 }).skip(skip).limit(limit).lean(),
      ActivityLog.countDocuments({ userId: req.params.userId }),
    ]);

    res.json({ success: true, activities, pagination: { page, limit, total, pages: Math.ceil(total / limit) } });
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
    res.json({ success: true, message: `User ${newActive ? "activated" : "deactivated"}` });
  } catch (err) {
    res.status(500).json({ error: "Server error" });
  }
});

/* Promote user to admin */
router.patch("/users/:userId/make-admin", async (req, res) => {
  try {
    const user = await User.findById(req.params.userId);
    if (!user) return res.status(404).json({ error: "User not found" });
    await User.updateOne({ _id: req.params.userId }, { $set: { isAdmin: true } });
    res.json({ success: true, message: "User promoted to admin" });
  } catch (err) {
    res.status(500).json({ error: "Server error" });
  }
});

/* Delete user and all associated data */
router.delete("/users/:userId", async (req, res) => {
  try {
    const user = await User.findById(req.params.userId);
    if (!user) return res.status(404).json({ error: "User not found" });

    await Promise.all([
      Quiz.deleteMany({ userId: req.params.userId }),
      QuizResult.deleteMany({ userId: req.params.userId }),
      FlashcardSet.deleteMany({ userId: req.params.userId }),
      ActivityLog.deleteMany({ userId: req.params.userId }),
      Subscription.deleteMany({ userId: req.params.userId }),
      User.findByIdAndDelete(req.params.userId),
    ]);

    res.json({ success: true, message: "User and all their data permanently deleted" });
  } catch (err) {
    res.status(500).json({ error: "Failed to delete user" });
  }
});

// ==================== QUIZ MANAGEMENT ====================

/* Get all quizzes (admin view) */
router.get("/quizzes", async (req, res) => {
  try {
    const page  = parseInt(req.query.page)  || 1;
    const limit = parseInt(req.query.limit) || 10;
    const skip  = (page - 1) * limit;

    const [quizzes, total] = await Promise.all([
      Quiz.find().populate("userId", "fullName email").sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
      Quiz.countDocuments(),
    ]);

    const enriched = await Promise.all(
      quizzes.map(async (quiz) => {
        const [attempts, scoreAgg] = await Promise.all([
          QuizResult.countDocuments({ quizId: quiz._id }),
          QuizResult.aggregate([
            { $match: { quizId: quiz._id } },
            { $group: { _id: null, avg: { $avg: "$score" } } },
          ]),
        ]);
        return {
          id: quiz._id,
          title: quiz.title,
          subject: quiz.subject,
          difficulty: quiz.difficulty,
          creator: quiz.userId?.fullName || quiz.authorName || "Anonymous",
          creatorId: quiz.userId?._id || null,
          numQuestions: quiz.numQuestions,
          attempts,
          avgScore: scoreAgg.length ? Math.round(scoreAgg[0].avg || 0) : 0,
          createdAt: quiz.createdAt,
        };
      })
    );

    res.json({ success: true, quizzes: enriched, pagination: { page, limit, total, pages: Math.ceil(total / limit) } });
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch quizzes" });
  }
});

/* Create quiz as admin (manual) */
router.post("/quizzes", async (req, res) => {
  try {
    const { title, subject, difficulty = "medium", timeLimit = 30, questions } = req.body;
    if (!title || !subject || !Array.isArray(questions) || questions.length === 0)
      return res.status(400).json({ error: "Missing required fields" });

    const validQuestions = questions.filter(q =>
      q.question && Array.isArray(q.options) && q.options.length === 4 && q.correctAnswer !== undefined
    );
    if (validQuestions.length === 0)
      return res.status(400).json({ error: "No valid questions" });

    const quiz = new Quiz({
      userId: null, authorName: "Admin",
      title: title.trim(), subject: subject.trim(),
      difficulty, timeLimit: parseInt(timeLimit),
      numQuestions: validQuestions.length, questions: validQuestions,
      isPublic: true, isAdminCreated: true,
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

    if (title)    quiz.title      = title;
    if (subject)  quiz.subject    = subject;
    if (difficulty) quiz.difficulty = difficulty;
    if (timeLimit)  quiz.timeLimit  = timeLimit;
    if (questions && Array.isArray(questions)) {
      quiz.questions    = questions;
      quiz.numQuestions = questions.length;
    }
    await quiz.save();
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
    res.json({ success: true, message: "Quiz deleted successfully" });
  } catch (err) {
    res.status(500).json({ error: "Failed to delete quiz" });
  }
});

// ==================== FLASHCARD MANAGEMENT ====================

/* Get all flashcard sets (admin view) */
router.get("/flashcards", async (req, res) => {
  try {
    const page  = parseInt(req.query.page)  || 1;
    const limit = parseInt(req.query.limit) || 10;
    const skip  = (page - 1) * limit;

    const [sets, total] = await Promise.all([
      FlashcardSet.find().populate("userId", "fullName email").sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
      FlashcardSet.countDocuments(),
    ]);

    res.json({
      success: true,
      flashcards: sets.map(set => ({
        id: set._id, title: set.title, subject: set.subject,
        creator: set.userId?.fullName || set.authorName || "Anonymous",
        creatorId: set.userId?._id || null,
        cardCount: set.cards.length, createdAt: set.createdAt,
        lastStudied: set.lastStudied,
      })),
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
    if (!title || !subject || !Array.isArray(cards) || cards.length === 0)
      return res.status(400).json({ error: "Missing fields" });

    const validCards = cards
      .map(c => ({ question: c.question?.trim(), answer: c.answer?.trim() }))
      .filter(c => c.question && c.answer);
    if (validCards.length === 0)
      return res.status(400).json({ error: "No valid cards" });

    const set = new FlashcardSet({
      userId: null, authorName: "Admin",
      title: title.trim(), subject: subject.trim(),
      cards: validCards.map(c => ({ ...c, masteryLevel: 0 })),
      isPublic: true, isAdminCreated: true,
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

    if (title)   set.title   = title;
    if (subject) set.subject = subject;
    if (cards && Array.isArray(cards)) {
      set.cards = cards.map(c => ({ question: c.question, answer: c.answer, masteryLevel: c.masteryLevel || 0 }));
    }
    await set.save();
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
    res.json({ success: true, message: "Flashcard set deleted successfully" });
  } catch (err) {
    res.status(500).json({ error: "Failed to delete flashcard set" });
  }
});

// ==================== SUBSCRIPTION MANAGEMENT ====================

/* GET /admin/subscriptions — paginated list with user info */
router.get("/subscriptions", async (req, res) => {
  try {
    const page   = parseInt(req.query.page)  || 1;
    const limit  = parseInt(req.query.limit) || 15;
    const skip   = (page - 1) * limit;
    const status = req.query.status;
    const plan   = req.query.plan;

    const query = {};
    if (status && status !== 'all') query.status = status;
    if (plan   && plan   !== 'all') query.plan   = plan;

    const [subs, total] = await Promise.all([
      Subscription.find(query)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .populate('userId', 'fullName email')
        .lean(),
      Subscription.countDocuments(query),
    ]);

    res.json({
      success: true,
      subscriptions: subs.map(s => ({
        id:          s._id,
        user: {
          id:       s.userId?._id || null,
          fullName: s.userId?.fullName || 'Unknown',
          email:    s.userId?.email   || 'N/A',
        },
        plan:        s.plan,
        planName:    s.planName,
        status:      s.status,
        amount:      s.amount,
        amountNGN:   (s.amount / 100).toLocaleString('en-NG'),
        isGroup:     s.isGroup,
        reference:   s.paystackReference,
        transactionId: s.paystackTransactionId,
        startDate:   s.startDate,
        expiresAt:   s.expiresAt,
        createdAt:   s.createdAt,
      })),
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    });
  } catch (err) {
    console.error("Fetch subscriptions error:", err);
    res.status(500).json({ error: "Failed to fetch subscriptions" });
  }
});

/* GET /admin/subscriptions/stats — aggregated revenue and plan breakdown */
router.get("/subscriptions/stats", async (req, res) => {
  try {
    const now       = new Date();
    const thisMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const lastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);

    const [
      total, active, pending, expired,
      totalRevenueAgg, monthlyRevenueAgg, lastMonthRevenueAgg,
      planDistribution, recentPayments,
    ] = await Promise.all([
      Subscription.countDocuments(),
      Subscription.countDocuments({
        status: 'active',
        $or: [{ expiresAt: null }, { expiresAt: { $gt: now } }],
      }),
      Subscription.countDocuments({ status: 'pending' }),
      Subscription.countDocuments({ status: { $in: ['expired', 'cancelled'] } }),
      Subscription.aggregate([
        { $match: { status: 'active' } },
        { $group: { _id: null, total: { $sum: '$amount' } } },
      ]),
      Subscription.aggregate([
        { $match: { status: 'active', startDate: { $gte: thisMonth } } },
        { $group: { _id: null, total: { $sum: '$amount' } } },
      ]),
      Subscription.aggregate([
        { $match: { status: 'active', startDate: { $gte: lastMonth, $lt: thisMonth } } },
        { $group: { _id: null, total: { $sum: '$amount' } } },
      ]),
      Subscription.aggregate([
        { $match: { status: 'active' } },
        { $group: { _id: '$plan', count: { $sum: 1 }, revenue: { $sum: '$amount' }, planName: { $first: '$planName' } } },
        { $sort: { revenue: -1 } },
      ]),
      Subscription.find({ status: 'active' })
        .sort({ startDate: -1 })
        .limit(8)
        .populate('userId', 'fullName email')
        .lean(),
    ]);

    const totalRev   = totalRevenueAgg[0]?.total || 0;
    const monthlyRev = monthlyRevenueAgg[0]?.total || 0;
    const lastMonRev = lastMonthRevenueAgg[0]?.total || 0;
    const growth = lastMonRev > 0 ? Math.round(((monthlyRev - lastMonRev) / lastMonRev) * 100) : 0;

    res.json({
      success: true,
      stats: {
        total, active, pending, expired,
        totalRevenue:   totalRev,
        totalRevenueNGN: (totalRev / 100).toLocaleString('en-NG'),
        monthlyRevenue:  monthlyRev,
        monthlyRevenueNGN: (monthlyRev / 100).toLocaleString('en-NG'),
        revenueGrowth: growth,
      },
      planDistribution: planDistribution.map(p => ({
        plan:       p._id,
        planName:   p.planName,
        count:      p.count,
        revenue:    p.revenue,
        revenueNGN: Math.round(p.revenue / 100).toLocaleString('en-NG'),
      })),
      recentPayments: recentPayments.map(s => ({
        id:       s._id,
        user:     s.userId?.fullName || 'Unknown',
        email:    s.userId?.email    || 'N/A',
        planName: s.planName,
        amount:   s.amount / 100,
        date:     s.startDate || s.createdAt,
      })),
    });
  } catch (err) {
    console.error("Subscription stats error:", err);
    res.status(500).json({ error: "Failed to fetch subscription stats" });
  }
});

/* PATCH /admin/subscriptions/:id/cancel */
router.patch("/subscriptions/:id/cancel", async (req, res) => {
  try {
    const sub = await Subscription.findById(req.params.id);
    if (!sub) return res.status(404).json({ error: "Subscription not found" });
    sub.status = 'cancelled';
    await sub.save();
    res.json({ success: true, message: "Subscription cancelled" });
  } catch (err) {
    res.status(500).json({ error: "Failed to cancel subscription" });
  }
});

/* PATCH /admin/subscriptions/:id/activate — manually activate or extend */
router.patch("/subscriptions/:id/activate", async (req, res) => {
  try {
    const sub = await Subscription.findById(req.params.id);
    if (!sub) return res.status(404).json({ error: "Subscription not found" });

    const planCfg = PLAN_CONFIG[sub.plan];
    const days    = req.body.durationDays || planCfg?.durationDays || 30;
    const now     = new Date();

    sub.status    = 'active';
    sub.startDate = sub.startDate || now;
    sub.expiresAt = new Date(now.getTime() + days * 86400 * 1000);
    await sub.save();
    res.json({ success: true, message: "Subscription activated", subscription: sub });
  } catch (err) {
    res.status(500).json({ error: "Failed to activate subscription" });
  }
});

// ==================== ANALYTICS & DASHBOARD STATS ====================

/* Dashboard summary stats — includes subscription data */
router.get("/dashboard/stats", async (req, res) => {
  try {
    const now       = new Date();
    const thisMonth = new Date(now.getFullYear(), now.getMonth(), 1);

    const [
      totalUsers, totalQuizzes, totalFlashcards, totalQuizResults,
      activeUsers, activeSubscriptions, totalSubscriptions,
      totalRevenueAgg, monthlyRevenueAgg,
      recentActivities,
    ] = await Promise.all([
      User.countDocuments(),
      Quiz.countDocuments(),
      FlashcardSet.countDocuments(),
      QuizResult.countDocuments(),
      User.countDocuments({ lastActive: { $gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) } }),
      Subscription.countDocuments({ status: 'active', $or: [{ expiresAt: null }, { expiresAt: { $gt: now } }] }),
      Subscription.countDocuments(),
      Subscription.aggregate([{ $match: { status: 'active' } }, { $group: { _id: null, total: { $sum: '$amount' } } }]),
      Subscription.aggregate([
        { $match: { status: 'active', startDate: { $gte: thisMonth } } },
        { $group: { _id: null, total: { $sum: '$amount' } } },
      ]),
      ActivityLog.find().sort({ timestamp: -1 }).limit(10).populate("userId", "fullName").lean(),
    ]);

    const scoreAgg = totalQuizResults > 0
      ? await QuizResult.aggregate([{ $group: { _id: null, avg: { $avg: "$score" } } }])
      : [];

    res.json({
      success: true,
      stats: {
        totalUsers,
        activeUsers,
        totalQuizzes,
        totalFlashcards,
        totalQuizAttempts: totalQuizResults,
        averageScore: scoreAgg.length ? Math.round(scoreAgg[0].avg || 0) : 0,
        activeSubscriptions,
        totalSubscriptions,
        totalRevenue:    totalRevenueAgg[0]?.total   || 0,
        monthlyRevenue:  monthlyRevenueAgg[0]?.total  || 0,
      },
      recentActivities: recentActivities.map(a => ({
        action:    a.action,
        user:      a.userId?.fullName || "System",
        timestamp: a.timestamp,
        details:   a.details,
      })),
    });
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch dashboard stats" });
  }
});

/* Get all activity logs */
router.get("/activity-logs", async (req, res) => {
  try {
    const page  = parseInt(req.query.page)  || 1;
    const limit = parseInt(req.query.limit) || 20;
    const skip  = (page - 1) * limit;

    const [logs, total] = await Promise.all([
      ActivityLog.find().populate("userId", "fullName email").sort({ timestamp: -1 }).skip(skip).limit(limit).lean(),
      ActivityLog.countDocuments(),
    ]);

    res.json({ success: true, logs, pagination: { page, limit, total, pages: Math.ceil(total / limit) } });
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch activity logs" });
  }
});

// ==================== ADMIN AI: Generate Quiz ====================
router.post("/quizzes/generate", async (req, res) => {
  if (!gemini.ready) return res.status(503).json({ error: "AI service unavailable — check GEMINI_API_KEYS" });

  try {
    const { title = "Untitled Quiz", subject = "General", numQuestions = 15, difficulty = "medium", timeLimit = 30, content } = req.body;
    const file = req.files?.file;
    let extractedText = "";

    if (content && typeof content === "string" && content.trim().length > 150) {
      extractedText = content.trim();
    } else if (file) {
      const allowed = ["application/pdf", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"];
      if (!allowed.includes(file.mimetype)) return res.status(400).json({ error: "Only PDF and DOCX allowed" });
      if (file.size > 12 * 1024 * 1024) return res.status(400).json({ error: "File must be under 12MB" });

      if (file.mimetype === "application/pdf") {
        const pdfParser = new PDFParser();
        const data = await new Promise((resolve, reject) => {
          pdfParser.on("pdfParser_dataError", reject);
          pdfParser.on("pdfParser_dataReady", resolve);
          pdfParser.parseBuffer(file.data);
        });
        for (const page of data.Pages) {
          for (const text of page.Texts) {
            try { extractedText += decodeURIComponent(text.R[0].T) + " "; } catch { extractedText += " "; }
          }
        }
      } else {
        const result = await mammoth.extractRawText({ buffer: file.data });
        extractedText = result.value;
      }
    } else {
      return res.status(400).json({ error: "Provide either content or file" });
    }

    if (!extractedText.trim()) return res.status(400).json({ error: "No readable text found" });

    const safeText = capText(extractedText, 60000);
    const prompt = `Generate ${numQuestions} multiple-choice questions.\nSubject: ${subject}. Difficulty: ${difficulty}.\nReturn ONLY a valid JSON array, no markdown:\n[{"question":"...","options":["A","B","C","D"],"correctAnswer":0}]\nContent:\n${safeText}`.trim();

    let questions;
    try {
      const parsed = await gemini.generateJSON(prompt);
      questions = (Array.isArray(parsed) ? parsed : parsed?.questions || [])
        .map(q => ({
          question: q.question?.trim(),
          options:  Array.isArray(q.options) ? q.options.slice(0, 4) : [],
          correctAnswer: Number(q.correctAnswer),
        }))
        .filter(q => q.question && q.options.length === 4 && !isNaN(q.correctAnswer));
    } catch (aiErr) {
      console.error("Admin quiz AI error:", aiErr.message);
      return res.status(500).json({ error: `AI error: ${aiErr.message}` });
    }

    if (questions.length === 0) return res.status(500).json({ error: "No valid questions generated" });

    const quiz = new Quiz({
      userId: null, authorName: "Admin",
      title: title.trim(), subject: subject.trim(),
      difficulty, timeLimit: parseInt(timeLimit),
      numQuestions: questions.length, questions,
      isPublic: true, isAdminCreated: true,
    });
    await quiz.save();
    res.json({ success: true, id: quiz._id, message: "Quiz created successfully!", count: questions.length });
  } catch (err) {
    console.error("Admin generate quiz error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// ==================== ADMIN AI: Generate Flashcards ====================
router.post("/flashcards/generate", async (req, res) => {
  if (!gemini.ready) return res.status(503).json({ error: "AI service unavailable — check GEMINI_API_KEYS" });

  try {
    const { title = "Untitled Flashcards", subject = "General", content } = req.body;
    const pdfFile = req.files?.pdfFile;
    let extractedText = "";

    if (content && typeof content === "string" && content.trim().length > 100) {
      extractedText = content.trim();
    } else if (pdfFile) {
      if (pdfFile.mimetype !== "application/pdf") return res.status(400).json({ error: "Only PDF allowed" });
      if (pdfFile.size > 5 * 1024 * 1024) return res.status(400).json({ error: "PDF must be under 5MB" });

      const pdfParser = new PDFParser();
      const data = await new Promise((resolve, reject) => {
        pdfParser.on("pdfParser_dataError", reject);
        pdfParser.on("pdfParser_dataReady", resolve);
        pdfParser.parseBuffer(pdfFile.data);
      });
      for (const page of data.Pages) {
        for (const text of page.Texts) {
          try { extractedText += decodeURIComponent(text.R[0].T) + " "; } catch { extractedText += " "; }
        }
      }
    } else {
      return res.status(400).json({ error: "Provide content or PDF" });
    }

    if (!extractedText.trim()) return res.status(400).json({ error: "No text extracted" });

    const safeText = capText(extractedText, 30000);
    const prompt = `Generate 12 high-quality flashcards for ${subject}.\nReturn ONLY a valid JSON array, no markdown:\n[{"question":"Term?","answer":"Definition"}]\nContent:\n${safeText}`.trim();

    let cards;
    try {
      const parsed = await gemini.generateJSON(prompt);
      cards = (Array.isArray(parsed) ? parsed : parsed?.cards || [])
        .map(c => ({ question: c.question?.trim(), answer: c.answer?.trim() }))
        .filter(c => c.question && c.answer);
    } catch (aiErr) {
      return res.status(500).json({ error: `AI error: ${aiErr.message}` });
    }

    if (cards.length === 0) return res.status(500).json({ error: "No valid flashcards generated" });

    const set = new FlashcardSet({
      userId: null, authorName: "Admin",
      title: title.trim(), subject: subject.trim(),
      cards: cards.map(c => ({ ...c, masteryLevel: 0 })),
      isPublic: true, isAdminCreated: true,
    });
    await set.save();
    res.json({ success: true, id: set._id, message: "Flashcards created!", count: cards.length });
  } catch (err) {
    console.error("Admin generate flashcards error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// ==================== FINANCE SUMMARY ====================
router.get("/finance/summary", async (req, res) => {
  try {
    const now       = new Date();
    const thisMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const lastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

    const [
      totalUsers, activeUsers, totalQuizAttempts, totalQuizzes, totalFlashcards,
      activeSubscriptions, totalSubscriptions,
      totalRevenueAgg, monthlyRevenueAgg, lastMonthRevenueAgg,
      planDistribution, dailyActivity, topSubjects, recentPayments,
    ] = await Promise.all([
      User.countDocuments(),
      User.countDocuments({ lastActive: { $gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) } }),
      QuizResult.countDocuments(),
      Quiz.countDocuments(),
      FlashcardSet.countDocuments(),
      Subscription.countDocuments({ status: 'active', $or: [{ expiresAt: null }, { expiresAt: { $gt: now } }] }),
      Subscription.countDocuments(),
      Subscription.aggregate([{ $match: { status: 'active' } }, { $group: { _id: null, total: { $sum: '$amount' } } }]),
      Subscription.aggregate([
        { $match: { status: 'active', startDate: { $gte: thisMonth } } },
        { $group: { _id: null, total: { $sum: '$amount' } } },
      ]),
      Subscription.aggregate([
        { $match: { status: 'active', startDate: { $gte: lastMonth, $lt: thisMonth } } },
        { $group: { _id: null, total: { $sum: '$amount' } } },
      ]),
      Subscription.aggregate([
        { $match: { status: 'active' } },
        { $group: { _id: '$plan', count: { $sum: 1 }, revenue: { $sum: '$amount' }, planName: { $first: '$planName' } } },
        { $sort: { revenue: -1 } },
      ]),
      ActivityLog.aggregate([
        { $match: { timestamp: { $gte: thirtyDaysAgo } } },
        { $group: { _id: { $dateToString: { format: "%Y-%m-%d", date: "$timestamp" } }, count: { $sum: 1 } } },
        { $sort: { _id: 1 } }, { $limit: 30 },
      ]),
      QuizResult.aggregate([
        { $lookup: { from: "quizzes", localField: "quizId", foreignField: "_id", as: "quiz" } },
        { $unwind: { path: "$quiz", preserveNullAndEmptyArrays: true } },
        { $group: { _id: "$quiz.subject", attempts: { $sum: 1 }, avgScore: { $avg: "$score" } } },
        { $sort: { attempts: -1 } }, { $limit: 8 },
      ]),
      Subscription.find({ status: 'active' })
        .sort({ startDate: -1 }).limit(10)
        .populate('userId', 'fullName email').lean(),
    ]);

    const totalRev   = totalRevenueAgg[0]?.total   || 0;
    const monthlyRev = monthlyRevenueAgg[0]?.total  || 0;
    const lastMonRev = lastMonthRevenueAgg[0]?.total || 0;
    const revenueGrowth = lastMonRev > 0 ? Math.round(((monthlyRev - lastMonRev) / lastMonRev) * 100) : 0;

    res.json({
      success: true,
      summary: {
        totalUsers, activeUsers, totalQuizAttempts, totalQuizzes, totalFlashcards,
        engagementRate: totalUsers > 0 ? Math.round((activeUsers / totalUsers) * 100) : 0,
        activeSubscriptions, totalSubscriptions,
        totalRevenue:    totalRev,
        monthlyRevenue:  monthlyRev,
        revenueGrowth,
      },
      planDistribution: planDistribution.map(p => ({
        plan: p._id, planName: p.planName,
        count: p.count, revenue: p.revenue,
      })),
      recentPayments: recentPayments.map(s => ({
        user:     s.userId?.fullName || 'Unknown',
        email:    s.userId?.email    || 'N/A',
        planName: s.planName,
        amount:   s.amount,
        date:     s.startDate || s.createdAt,
        status:   s.status,
      })),
      dailyActivity: dailyActivity.map(d => ({ date: d._id, count: d.count })),
      topSubjects: topSubjects.map(s => ({
        subject:  s._id || "General",
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
      totalUsers, totalQuizzes, totalFlashcards, totalResults, totalLogs, totalSubscriptions, recentErrors,
    ] = await Promise.all([
      User.countDocuments(),
      Quiz.countDocuments(),
      FlashcardSet.countDocuments(),
      QuizResult.countDocuments(),
      ActivityLog.countDocuments(),
      Subscription.countDocuments(),
      ActivityLog.find({ action: { $regex: /error|fail/i } }).sort({ timestamp: -1 }).limit(5).lean(),
    ]);

    res.json({
      success: true,
      status: "healthy",
      uptime: Math.round(process.uptime()),
      memoryMB: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
      dbStats: {
        users: totalUsers, quizzes: totalQuizzes, flashcards: totalFlashcards,
        quizResults: totalResults, activityLogs: totalLogs, subscriptions: totalSubscriptions,
      },
      recentErrors: recentErrors.map(e => ({ action: e.action, timestamp: e.timestamp, details: e.details })),
    });
  } catch (err) {
    console.error("Operations health error:", err);
    res.status(500).json({ error: "Failed to fetch operations health" });
  }
});

// ==================== CONTACT MESSAGES ====================
const ContactMessage = require('../models/ContactMessage');

router.get('/contact-messages', async (req, res) => {
  try {
    const messages = await ContactMessage.find().sort({ createdAt: -1 }).lean();
    res.json({ success: true, messages, unread: messages.filter(m => !m.read).length });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch messages' });
  }
});

router.patch('/contact-messages/:id/read', async (req, res) => {
  try {
    await ContactMessage.findByIdAndUpdate(req.params.id, { read: true });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to mark as read' });
  }
});

router.delete('/contact-messages/:id', async (req, res) => {
  try {
    await ContactMessage.findByIdAndDelete(req.params.id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete message' });
  }
});

module.exports = router;
