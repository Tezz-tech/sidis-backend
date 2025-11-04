const express = require('express');
const router = express.Router();
const auth = require('../middlewares/auth');
const User = require('../models/User');
const Quiz = require('../models/Quiz');
const QuizResult = require('../models/QuizResult');

router.get('/', auth, async (req, res) => {
  try {
    const user = await User.findById(req.user.userId);
    const quizzes = await Quiz.find({ userId: req.user.userId });
    const results = await QuizResult.find({ userId: req.user.userId })
      .sort({ createdAt: -1 })
      .limit(5);

    const quizzesTaken = results.length;
    const averageScore = quizzesTaken > 0
      ? Math.round(results.reduce((sum, result) => sum + result.score, 0) / quizzesTaken)
      : 0;
    const hoursPracticed = results.reduce((sum, result) => sum + (result.timeSpent / 3600), 0);
    
    // Update user stats
    user.quizzesTaken = quizzesTaken;
    user.totalScore = results.reduce((sum, result) => sum + result.score, 0);
    user.hoursPracticed = hoursPracticed;
    await user.save();

    // Calculate rank (simple example: based on total score)
    const allUsers = await User.find().sort({ totalScore: -1 });
    const rank = allUsers.findIndex(u => u._id.toString() === user._id.toString()) + 1;

    const upcomingQuizzes = quizzes
      .filter(q => q.status === 'not-started')
      .map(q => ({
        subject: q.subject,
        date: q.createdAt.toISOString().split('T')[0],
        time: q.createdAt.toTimeString().split(' ')[0]
      }))
      .slice(0, 5);

    const recentResults = results.map(r => ({
      subject: quizzes.find(q => q._id.toString() === r.quizId.toString())?.subject,
      score: r.score,
      date: r.createdAt.toISOString().split('T')[0]
    }));

    res.json({
      quizzesTaken,
      averageScore,
      hoursPracticed,
      rank,
      upcomingQuizzes,
      recentResults
    });
  } catch (error) {
    res.status(500).json({ error: 'Error fetching dashboard data' });
  }
});

module.exports = router;
