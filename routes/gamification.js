// routes/gamification.js
const express = require('express');
const router  = express.Router();
const auth    = require('../middlewares/auth');
const User    = require('../models/User');
const QuizResult = require('../models/QuizResult');
const Quiz    = require('../models/Quiz');
const {
  BADGE_DEFS, LEVEL_THRESHOLDS, POWERUP_COSTS,
  getLevelInfo, checkNewBadges, awardXP,
} = require('../utils/gamificationUtils');

const { GoogleGenerativeAI } = require('@google/generative-ai');
require('dotenv').config();

// AI setup (reuse keys from quizzes.js pattern)
const GEMINI_KEYS = process.env.GEMINI_API_KEYS
  ? process.env.GEMINI_API_KEYS.split(',').map(k => k.trim()).filter(Boolean)
  : [];

let aiModel = null;
if (GEMINI_KEYS.length > 0) {
  try {
    const genAI = new GoogleGenerativeAI(GEMINI_KEYS[0]);
    aiModel = genAI.getGenerativeModel({
      model: 'gemini-2.5-flash',
      generationConfig: { temperature: 0.9, maxOutputTokens: 512, responseMimeType: 'application/json' },
    });
  } catch (_) {}
}

// ─── GET /api/gamification/profile ────────────────────────────────────────────
router.get('/profile', auth, async (req, res) => {
  try {
    const userId = req.user.userId;
    const [user, results] = await Promise.all([
      User.findById(userId),
      QuizResult.find({ userId }),
    ]);
    if (!user) return res.status(404).json({ error: 'User not found' });

    const levelInfo  = getLevelInfo(user.xp || 0);
    const newBadges  = checkNewBadges(user, results);

    if (newBadges.length > 0 || user.level !== levelInfo.level) {
      if (newBadges.length > 0)
        user.badges = [...new Set([...(user.badges || []), ...newBadges])];
      user.level = levelInfo.level;
      await user.save();
    }

    const allBadges = Object.entries(BADGE_DEFS).map(([id, def]) => ({
      id,
      ...def,
      earned: (user.badges || []).includes(id),
    }));

    res.json({
      success:        true,
      xp:             user.xp || 0,
      level:          levelInfo.level,
      levelTitle:     levelInfo.title,
      levelProgress:  levelInfo.progress,
      xpInLevel:      levelInfo.xpInLevel,
      xpToNextLevel:  levelInfo.xpToNext,
      nextLevelTitle: levelInfo.nextTitle,
      badges:         user.badges || [],
      allBadges,
      newBadges,
      powerUps:       user.powerUps || { timeFreeze: 0, fiftyFifty: 0, hint: 0, doubleXP: 0 },
      currentStreak:  user.currentStreak || 0,
      totalWagersWon: user.totalWagersWon || 0,
      studyBuddyName: user.studyBuddyName || 'Siddy',
      activeWager:    user.activeWager || null,
      doubleXPActive: user.doubleXPActive || false,
    });
  } catch (err) {
    console.error('Gamification profile error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ─── POST /api/gamification/award-xp ──────────────────────────────────────────
router.post('/award-xp', auth, async (req, res) => {
  try {
    const { amount = 0, reason = '', score = null, timeSpent = 0, timeLimit = 0, quizId = null } = req.body;
    const userId = req.user.userId;

    const [user, results] = await Promise.all([
      User.findById(userId),
      QuizResult.find({ userId }),
    ]);
    if (!user) return res.status(404).json({ error: 'User not found' });

    const result = await awardXP(user, results, { baseXP: amount, reason, score, timeSpent, timeLimit, quizId });

    res.json({ success: true, ...result });
  } catch (err) {
    console.error('Award XP error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ─── POST /api/gamification/wager ─────────────────────────────────────────────
router.post('/wager', auth, async (req, res) => {
  try {
    const { quizId, wagerAmount } = req.body;
    if (!quizId || wagerAmount == null)
      return res.status(400).json({ error: 'quizId and wagerAmount are required' });

    const user = await User.findById(req.user.userId);
    if (!user) return res.status(404).json({ error: 'User not found' });

    const wager = Math.max(0, Math.floor(Number(wagerAmount)));
    if (wager > (user.xp || 0))
      return res.status(400).json({ error: `Insufficient XP. You have ${user.xp || 0} XP.` });

    user.activeWager = { quizId, wagerAmount: wager };
    await user.save();

    res.json({ success: true, wager: { quizId, wagerAmount: wager } });
  } catch (err) {
    console.error('Wager error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ─── GET /api/gamification/study-buddy ────────────────────────────────────────
router.get('/study-buddy', auth, async (req, res) => {
  try {
    const userId = req.user.userId;
    const [user, results] = await Promise.all([
      User.findById(userId),
      QuizResult.find({ userId }).sort({ createdAt: -1 }).limit(10),
    ]);
    if (!user) return res.status(404).json({ error: 'User not found' });

    const streak      = user.currentStreak || 0;
    const xp          = user.xp || 0;
    const level       = user.level || 1;
    const taken       = results.length;
    const avgScore    = taken > 0 ? Math.round(results.reduce((s, r) => s + r.score, 0) / taken) : 0;
    const buddyName   = user.studyBuddyName || 'Siddy';

    // Choose mood + message pool based on user state
    let mood = 'happy';
    let pool = [];

    if (taken === 0) {
      mood = 'encouraging';
      pool = [
        `Hey! I'm ${buddyName}, your study buddy! Take your first quiz and let's get this started! 🎯`,
        `Welcome! I'll be cheering for you every step of the way. Ready to begin? 💪`,
        `Your adventure starts with one quiz. Let's make it happen! 🚀`,
      ];
    } else if (streak >= 7) {
      mood = 'excited';
      pool = [
        `${streak} days in a row — you're UNSTOPPABLE! 🔥`,
        `I can't believe the streak you've got! ${streak} days! Keep going! ⚡`,
        `This dedication is LEGENDARY. ${streak} days and counting! 🌟`,
      ];
    } else if (streak >= 3) {
      mood = 'happy';
      pool = [
        `${streak}-day streak! You're building something special! 🌟`,
        `Consistency is your superpower right now. Day ${streak}! 💪`,
        `Don't break it now — ${streak} days and still going strong!`,
      ];
    } else if (avgScore >= 85) {
      mood = 'impressed';
      pool = [
        `Wow — ${avgScore}% average? You're seriously talented! 🏆`,
        `These scores are elite-level. Can we push for 100% today? 😄`,
        `Top-tier performance! Let's keep raising the bar! 📈`,
      ];
    } else if (avgScore < 55 && taken > 2) {
      mood = 'encouraging';
      pool = [
        `Every expert was once a beginner. You've got this! 💪`,
        `Struggle now, shine later. One more quiz will make a difference! ✨`,
        `I see real improvement ahead — don't give up! 🚀`,
      ];
    } else {
      mood = 'happy';
      pool = [
        `Looking good! Let's push for an even higher score today! 🎯`,
        `Consistency beats intensity — you're on the right track! 📈`,
        `Good job so far! Ready to tackle something harder? 💡`,
      ];
    }

    const message = pool[Math.floor(Math.random() * pool.length)];

    // Detect weak subjects for study tip
    const subjectMap = {};
    for (const r of results) {
      const tag = r.subjectTag || 'General';
      if (!subjectMap[tag]) subjectMap[tag] = { total: 0, count: 0 };
      subjectMap[tag].total += r.score || 0;
      subjectMap[tag].count++;
    }
    const weakSubjects = Object.entries(subjectMap)
      .filter(([, d]) => d.total / d.count < 60)
      .map(([s]) => s);

    let studyTip = null;
    if (weakSubjects.length > 0) {
      studyTip = `Focus on: ${weakSubjects.join(', ')} — these need the most attention right now!`;
    } else if (xp < 100) {
      studyTip = 'Complete a few more quizzes to hit your first XP milestone!';
    } else if (streak === 0 && taken > 0) {
      studyTip = 'Start a new streak today — even one quiz a day makes a huge difference!';
    } else if (level < 3) {
      studyTip = `You're a ${['', 'Novice', 'Apprentice', 'Scholar', 'Expert', 'Master', 'Elite', 'Legend'][level]} — keep earning XP to reach Scholar (300 XP)!`;
    }

    // Try AI-powered personalized motivation message
    let aiMotivation = null;
    if (aiModel && taken > 0) {
      try {
        const prompt = `You are ${buddyName}, a friendly digital study mascot for a student learning app called Sidis.
The student has: ${taken} quizzes taken, ${avgScore}% average score, ${streak}-day streak, ${xp} XP, Level ${level}.
${weakSubjects.length > 0 ? `Weak subjects: ${weakSubjects.join(', ')}.` : 'No notable weak subjects.'}

Write ONE short motivational message (2-3 sentences max) as ${buddyName} to this student. Be warm, encouraging, specific to their stats, and add one actionable tip. Keep it under 60 words.
Return JSON: { "message": "..." }`;

        const raw = await aiModel.generateContent(prompt);
        const text = raw.response.text().trim().replace(/^```json\s*|```$/gi, '').trim();
        const parsed = JSON.parse(text);
        if (parsed.message) aiMotivation = parsed.message;
      } catch (_) { /* AI optional — silently skip */ }
    }

    res.json({
      success:      true,
      name:         buddyName,
      mood,
      message:      aiMotivation || message,
      studyTip,
      xp,
      level,
      streak,
      avgScore,
      quizzesTaken: taken,
    });
  } catch (err) {
    console.error('Study buddy error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ─── GET /api/gamification/study-journey ──────────────────────────────────────
router.get('/study-journey', auth, async (req, res) => {
  try {
    const userId = req.user.userId;
    const [user, results] = await Promise.all([
      User.findById(userId),
      QuizResult.find({ userId }).sort({ createdAt: -1 }),
    ]);
    if (!user) return res.status(404).json({ error: 'User not found' });

    const taken    = results.length;
    const avgScore = taken > 0 ? Math.round(results.reduce((s, r) => s + r.score, 0) / taken) : 0;
    const xp       = user.xp || 0;
    const streak   = user.currentStreak || 0;
    const bestStr  = user.bestStreak    || 0;

    // Build recommended quiz for weak subjects
    const subjectMap = {};
    for (const r of results) {
      const tag = r.subjectTag || 'General';
      if (!subjectMap[tag]) subjectMap[tag] = { total: 0, count: 0 };
      subjectMap[tag].total += r.score || 0;
      subjectMap[tag].count++;
    }
    const weakSubjects = Object.entries(subjectMap).filter(([, d]) => d.total / d.count < 60).map(([s]) => s);

    let recommendedQuizzes = [];
    if (weakSubjects.length > 0) {
      recommendedQuizzes = await Quiz.find({
        subject: { $in: weakSubjects.map(s => new RegExp(s, 'i')) },
        isPublic: true,
      }).limit(3).select('title subject numQuestions difficulty').lean();
    }
    if (recommendedQuizzes.length === 0) {
      recommendedQuizzes = await Quiz.find({ isPublic: true })
        .limit(3).select('title subject numQuestions difficulty').lean();
    }

    // AI-powered personalised next step
    let aiNextStep = null;
    if (aiModel && taken > 0) {
      try {
        const prompt = `Student stats: ${taken} quizzes, ${avgScore}% avg, ${streak}-day streak, ${xp} XP.
${weakSubjects.length > 0 ? `Weak subjects: ${weakSubjects.join(', ')}.` : ''}
Suggest ONE concise actionable study step for this student (max 25 words).
Return JSON: { "step": "..." }`;
        const raw = await aiModel.generateContent(prompt);
        const text = raw.response.text().trim().replace(/^```json\s*|```$/gi, '').trim();
        const parsed = JSON.parse(text);
        if (parsed.step) aiNextStep = parsed.step;
      } catch (_) {}
    }

    const steps = [
      {
        id: 1, title: 'Take Your First Quiz',
        desc:      'Begin your learning adventure by completing one quiz.',
        xpReward:  20, type: 'quiz',
        completed: taken >= 1,
        link:      '/public-quizzes',
      },
      {
        id: 2, title: 'Score Above 70%',
        desc:      'Show understanding by hitting 70% or higher on a quiz.',
        xpReward:  30, type: 'performance',
        completed: results.some(r => r.score >= 70),
        link:      '/create-quiz',
      },
      {
        id: 3, title: 'Build a 3-Day Streak',
        desc:      'Study three consecutive days to build your habit.',
        xpReward:  50, type: 'streak',
        completed: streak >= 3 || bestStr >= 3,
        link:      '/public-quizzes',
      },
      {
        id: 4, title: 'Complete 5 Quizzes',
        desc:      'Explore multiple topics and subjects.',
        xpReward:  50, type: 'quiz',
        completed: taken >= 5,
        link:      '/public-quizzes',
      },
      {
        id: 5, title: 'Achieve 80% Average Score',
        desc:      'Maintain a strong average across your recent quizzes.',
        xpReward:  75, type: 'performance',
        completed: avgScore >= 80,
        link:      '/my-quizzes',
      },
      {
        id: 6, title: 'Win Your First XP Wager',
        desc:      'Wager XP on a quiz in Exam Mode and come out on top!',
        xpReward:  40, type: 'wager',
        completed: (user.totalWagersWon || 0) >= 1,
        link:      '/my-quizzes',
      },
      {
        id: 7, title: 'Reach Level 3 — Scholar',
        desc:      'Accumulate 300 XP to unlock Scholar status.',
        xpReward:  100, type: 'xp',
        completed: xp >= 300,
        link:      '/over',
      },
      {
        id: 8, title: 'Complete 25 Quizzes',
        desc:      'Become a truly dedicated learner.',
        xpReward:  100, type: 'quiz',
        completed: taken >= 25,
        link:      '/public-quizzes',
      },
      {
        id: 9, title: 'Score Perfect 100%',
        desc:      'Prove absolute mastery with a flawless quiz.',
        xpReward:  150, type: 'performance',
        completed: results.some(r => r.score === 100),
        link:      '/create-quiz',
      },
      {
        id: 10, title: 'Reach Level 5 — Master',
        desc:      'Accumulate 1 000 XP to achieve Master status.',
        xpReward:  200, type: 'xp',
        completed: (user.level || 1) >= 5,
        link:      '/over',
      },
    ];

    const completedSteps  = steps.filter(s => s.completed).length;
    const totalXPReward   = steps.reduce((s, st) => s + st.xpReward, 0);
    const earnedXPReward  = steps.filter(s => s.completed).reduce((s, st) => s + st.xpReward, 0);

    res.json({
      success:         true,
      steps,
      completedSteps,
      totalSteps:      steps.length,
      totalXPReward,
      earnedXPReward,
      journeyProgress: Math.round((completedSteps / steps.length) * 100),
      recommendedQuizzes: recommendedQuizzes.map(q => ({
        id: q._id, title: q.title, subject: q.subject,
        numQuestions: q.numQuestions, difficulty: q.difficulty,
      })),
      aiNextStep,
      weakSubjects,
    });
  } catch (err) {
    console.error('Study journey error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ─── POST /api/gamification/buy-powerup ───────────────────────────────────────
router.post('/buy-powerup', auth, async (req, res) => {
  try {
    const { powerUp } = req.body;
    if (!POWERUP_COSTS[powerUp])
      return res.status(400).json({ error: 'Invalid power-up type' });

    const user = await User.findById(req.user.userId);
    if (!user) return res.status(404).json({ error: 'User not found' });

    const cost = POWERUP_COSTS[powerUp];
    if ((user.xp || 0) < cost)
      return res.status(400).json({ error: `Need ${cost} XP. You have ${user.xp || 0}.` });

    user.xp -= cost;
    user.powerUps = user.powerUps || { timeFreeze: 0, fiftyFifty: 0, hint: 0, doubleXP: 0 };
    user.powerUps[powerUp] = (user.powerUps[powerUp] || 0) + 1;
    await user.save();

    res.json({
      success: true, powerUp,
      quantity: user.powerUps[powerUp],
      xpRemaining: user.xp,
    });
  } catch (err) {
    console.error('Buy power-up error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ─── POST /api/gamification/use-powerup ───────────────────────────────────────
router.post('/use-powerup', auth, async (req, res) => {
  try {
    const { powerUp } = req.body;
    const user = await User.findById(req.user.userId);
    if (!user) return res.status(404).json({ error: 'User not found' });

    user.powerUps = user.powerUps || { timeFreeze: 0, fiftyFifty: 0, hint: 0, doubleXP: 0 };
    if ((user.powerUps[powerUp] || 0) <= 0)
      return res.status(400).json({ error: 'No power-ups of this type available' });

    user.powerUps[powerUp] -= 1;
    if (powerUp === 'doubleXP') user.doubleXPActive = true;
    await user.save();

    res.json({
      success: true, powerUp,
      remaining: user.powerUps[powerUp],
      doubleXPActive: user.doubleXPActive || false,
    });
  } catch (err) {
    console.error('Use power-up error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ─── POST /api/gamification/name-buddy ────────────────────────────────────────
router.post('/name-buddy', auth, async (req, res) => {
  try {
    const { name } = req.body;
    if (!name || name.trim().length < 1 || name.trim().length > 20)
      return res.status(400).json({ error: 'Name must be 1–20 characters' });

    const user = await User.findById(req.user.userId);
    if (!user) return res.status(404).json({ error: 'User not found' });

    user.studyBuddyName = name.trim();
    await user.save();

    res.json({ success: true, name: user.studyBuddyName });
  } catch (err) {
    console.error('Name buddy error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ─── GET /api/gamification/badges ─────────────────────────────────────────────
router.get('/badges', auth, async (req, res) => {
  try {
    const user = await User.findById(req.user.userId);
    if (!user) return res.status(404).json({ error: 'User not found' });

    const allBadges = Object.entries(BADGE_DEFS).map(([id, def]) => ({
      id, ...def, earned: (user.badges || []).includes(id),
    }));

    res.json({ success: true, badges: user.badges || [], allBadges });
  } catch (err) {
    console.error('Badges error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ─── GET /api/gamification/motivation ─────────────────────────────────────────
// Returns a motivational insight / notification message
router.get('/motivation', auth, async (req, res) => {
  try {
    const userId = req.user.userId;
    const [user, results] = await Promise.all([
      User.findById(userId),
      QuizResult.find({ userId }).sort({ createdAt: -1 }).limit(5),
    ]);
    if (!user) return res.status(404).json({ error: 'User not found' });

    const streak   = user.currentStreak || 0;
    const xp       = user.xp || 0;
    const level    = user.level || 1;
    const taken    = results.length;
    const avgScore = taken > 0 ? Math.round(results.reduce((s, r) => s + r.score, 0) / taken) : 0;
    const { title: levelTitle } = getLevelInfo(xp);

    // Generate AI motivation if available
    let aiMessage = null;
    if (aiModel) {
      try {
        const prompt = `You are an AI coach for a student learning app called Sidis.
Student: ${taken} quizzes, ${avgScore}% avg score, ${streak}-day streak, ${xp} XP (Level ${level}: ${levelTitle}).
Write ONE motivational push-notification message (max 20 words). Be specific and inspiring.
Return JSON: { "title": "short title", "body": "message body" }`;

        const raw = await aiModel.generateContent(prompt);
        const text = raw.response.text().trim().replace(/^```json\s*|```$/gi, '').trim();
        const parsed = JSON.parse(text);
        if (parsed.title && parsed.body) aiMessage = parsed;
      } catch (_) {}
    }

    // Fallback pool
    const fallbackMessages = [
      { title: '🔥 Keep the streak alive!',  body: `Day ${streak || 1} — quiz now to protect your streak!` },
      { title: '⚡ XP is waiting',            body: `You're ${xp} XP into Level ${level}. Let's push further!` },
      { title: '🎯 Daily challenge',           body: 'Beat your last score and earn a streak bonus today!' },
      { title: '🚀 Level up is close!',        body: `Keep going — you're a ${levelTitle} on the rise!` },
      { title: '💡 Study smarter today',       body: 'Try Exam Mode and wager XP to earn even more rewards!' },
    ];

    const msg = aiMessage || fallbackMessages[Math.floor(Math.random() * fallbackMessages.length)];

    res.json({ success: true, notification: msg, xp, level, streak, levelTitle });
  } catch (err) {
    console.error('Motivation error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
