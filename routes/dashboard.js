// routes/dashboard.js - FINAL WORKING VERSION
const express = require('express');
const router = express.Router();
const auth = require('../middlewares/auth');
const User = require('../models/User');
const QuizResult = require('../models/QuizResult');

router.get('/', auth, async (req, res) => {
  try {
    const userId = req.user.userId;

    const [user, results] = await Promise.all([
      User.findById(userId),
      QuizResult.find({ userId }).sort({ createdAt: -1 })
    ]);

    if (!user) return res.status(404).json({ error: "User not found" });

    const quizzesTaken = results.length;

    const totalScore = results.reduce((sum, r) => sum + (r.score || 0), 0);
    const averageScore = quizzesTaken > 0 ? Math.round(totalScore / quizzesTaken) : 0;

    const totalQuestionsAnswered = results.reduce((sum, r) => sum + (r.correctAnswers + r.wrongAnswers), 0);
    const totalCorrect = results.reduce((sum, r) => sum + r.correctAnswers, 0);
    const accuracy = totalQuestionsAnswered > 0 
      ? Math.round((totalCorrect / totalQuestionsAnswered) * 100) 
      : 0;

    const hoursPracticed = results.reduce((sum, r) => sum + (r.timeSpent || 0), 0) / 3600;

    // Update user document
    user.quizzesTaken = quizzesTaken;
    user.averageScore = averageScore;
    user.totalScore = totalScore;
    user.accuracy = accuracy;
    user.hoursPracticed = parseFloat(hoursPracticed.toFixed(1));
    user.currentStreak = user.currentStreak || 0;
    user.bestStreak = user.bestStreak || 0;
    user.weeklyImprovement = user.weeklyImprovement || 0;

    await user.save();

    // GLOBAL RANKING
    const leaderboard = await User.find({ quizzesTaken: { $gt: 0 } })
      .sort({ averageScore: -1, totalScore: -1 })
      .select('_id averageScore')
      .lean();

    const myRank = leaderboard.findIndex(u => u._id.toString() === userId) + 1;
    const totalUsers = leaderboard.length;
    const myPercentile = totalUsers > 0 
      ? Math.round(((totalUsers - myRank + 1) / totalUsers) * 100)
      : 0;

    res.json({
      success: true,
      quizzesTaken,
      averageScore,
      accuracy,
      hoursPracticed: parseFloat(hoursPracticed.toFixed(1)),
      currentStreak: user.currentStreak || 0,
      bestStreak: user.bestStreak || 0,
      weeklyImprovement: user.weeklyImprovement || 0,

      // For ranking
      myRank,
      myPercentile,
      totalUsers,

      // Recent results (for future use)
      recentResults: results.slice(0, 5).map(r => ({
        quizId: r.quizId,
        title: r.title || "Untitled Quiz",
        score: r.score,
        createdAt: r.createdAt
      }))
    });

  } catch (error) {
    console.error("Dashboard error:", error);
    res.status(500).json({ success: false, error: "Server error" });
  }
});

// Dedicated rankings endpoint (used by frontend)
router.get('/rankings', auth, async (req, res) => {
  try {
    const userId = req.user.userId;

    const leaderboard = await User.find({ quizzesTaken: { $gt: 0 } })
      .sort({ averageScore: -1, totalScore: -1 })
      .select('_id averageScore totalScore quizzesTaken')
      .lean();

    const myRank = leaderboard.findIndex(u => u._id.toString() === userId) + 1;
    const totalUsers = leaderboard.length;
    const myPercentile = totalUsers > 0 
      ? Math.round(((totalUsers - myRank + 1) / totalUsers) * 100)
      : 0;

    res.json({
      success: true,
      myRank,
      myPercentile,
      totalUsers
    });
  } catch (error) {
    console.error("Rankings error:", error);
    res.status(500).json({ success: false, error: "Failed to load rankings" });
  }
});

module.exports = router;