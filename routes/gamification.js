// routes/gamification.js
const express = require('express');
const router  = express.Router();
const auth    = require('../middlewares/auth');
const User    = require('../models/User');
const QuizResult = require('../models/QuizResult');
const Quiz    = require('../models/Quiz');
const TopicMastery = require('../models/TopicMastery');
const StudyPlan = require('../models/StudyPlan');
const { getUserPlan, getPlanFeatures } = require('../utils/subscription');
const {
  BADGE_DEFS, LEVEL_THRESHOLDS, POWERUP_COSTS,
  getLevelInfo, checkNewBadges, awardXP,
} = require('../utils/gamificationUtils');

const { gemini } = require('../utils/ai');

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
      const update = { $set: { level: levelInfo.level } };
      if (newBadges.length > 0) update.$addToSet = { badges: { $each: newBadges } };
      await User.updateOne({ _id: userId }, update);
      // Keep in-memory user in sync for the response below
      user.level  = levelInfo.level;
      if (newBadges.length > 0)
        user.badges = [...new Set([...(user.badges || []), ...newBadges])];
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

    await User.updateOne(
      { _id: req.user.userId },
      { $set: { activeWager: { quizId, wagerAmount: wager } } }
    );

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
    if (gemini.ready && taken > 0) {
      try {
        const prompt = `You are ${buddyName}, a friendly digital study mascot for a student learning app called Sidis.
The student has: ${taken} quizzes taken, ${avgScore}% average score, ${streak}-day streak, ${xp} XP, Level ${level}.
${weakSubjects.length > 0 ? `Weak subjects: ${weakSubjects.join(', ')}.` : 'No notable weak subjects.'}

Write ONE short motivational message (2-3 sentences max) as ${buddyName} to this student. Be warm, encouraging, specific to their stats, and add one actionable tip. Keep it under 60 words.
Return JSON: { "message": "..." }`;

        const parsed = await gemini.generateJSON(prompt, { maxOutputTokens: 256 });
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
    if (gemini.ready && taken > 0) {
      try {
        const prompt = `Student stats: ${taken} quizzes, ${avgScore}% avg, ${streak}-day streak, ${xp} XP.
${weakSubjects.length > 0 ? `Weak subjects: ${weakSubjects.join(', ')}.` : ''}
Suggest ONE concise actionable study step for this student (max 25 words).
Return JSON: { "step": "..." }`;
        const parsed = await gemini.generateJSON(prompt, { maxOutputTokens: 128 });
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

    // Use atomic $inc so Mixed-type powerUps field is actually persisted
    await User.updateOne(
      { _id: req.user.userId },
      { $inc: { xp: -cost, [`powerUps.${powerUp}`]: 1 } }
    );

    res.json({
      success:     true,
      powerUp,
      quantity:    (user.powerUps?.[powerUp] || 0) + 1,
      xpRemaining: (user.xp || 0) - cost,
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

    const powerUps = user.powerUps || { timeFreeze: 0, fiftyFifty: 0, hint: 0, doubleXP: 0 };
    if ((powerUps[powerUp] || 0) <= 0)
      return res.status(400).json({ error: 'No power-ups of this type available' });

    const updateOp = {
      $inc: { [`powerUps.${powerUp}`]: -1 },
    };
    if (powerUp === 'doubleXP') updateOp.$set = { doubleXPActive: true };
    await User.updateOne({ _id: req.user.userId }, updateOp);

    res.json({
      success:        true,
      powerUp,
      remaining:      (powerUps[powerUp] || 0) - 1,
      doubleXPActive: powerUp === 'doubleXP' ? true : (user.doubleXPActive || false),
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

    await User.updateOne(
      { _id: req.user.userId },
      { $set: { studyBuddyName: name.trim() } }
    );

    res.json({ success: true, name: name.trim() });
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
    if (gemini.ready) {
      try {
        const prompt = `You are an AI coach for a student learning app called Sidis.
Student: ${taken} quizzes, ${avgScore}% avg score, ${streak}-day streak, ${xp} XP (Level ${level}: ${levelTitle}).
Write ONE motivational push-notification message (max 20 words). Be specific and inspiring.
Return JSON: { "title": "short title", "body": "message body" }`;

        const parsed = await gemini.generateJSON(prompt, { maxOutputTokens: 128 });
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

// ─── POST /api/gamification/spin-discount ─────────────────────────────────────
const SPIN_COST = 50; // XP per spin
const DISCOUNT_WHEEL = [
  { label: '5% Off',  value: 5,  rarity: 'common',    weight: 35, emoji: '🎁' },
  { label: '10% Off', value: 10, rarity: 'uncommon',  weight: 28, emoji: '🎀' },
  { label: '15% Off', value: 15, rarity: 'rare',      weight: 20, emoji: '🎊' },
  { label: '20% Off', value: 20, rarity: 'epic',      weight: 12, emoji: '⭐' },
  { label: '25% Off', value: 25, rarity: 'legendary', weight: 4,  emoji: '💫' },
  { label: '50% Off', value: 50, rarity: 'mythic',    weight: 1,  emoji: '🌟' },
];

function spinWheel() {
  const total  = DISCOUNT_WHEEL.reduce((s, d) => s + d.weight, 0);
  let rand     = Math.random() * total;
  for (const slot of DISCOUNT_WHEEL) {
    rand -= slot.weight;
    if (rand <= 0) return slot;
  }
  return DISCOUNT_WHEEL[0];
}

router.post('/spin-discount', auth, async (req, res) => {
  try {
    const user = await User.findById(req.user.userId);
    if (!user) return res.status(404).json({ error: 'User not found' });

    if ((user.xp || 0) < SPIN_COST)
      return res.status(400).json({ error: `Need ${SPIN_COST} XP to spin. You have ${user.xp || 0} XP.` });

    const prize = spinWheel();
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + 30); // 30-day validity

    const newDiscount = {
      id:        `disc_${Date.now()}`,
      label:     prize.label,
      value:     prize.value,
      rarity:    prize.rarity,
      emoji:     prize.emoji,
      code:      `SIDIS${prize.value}OFF${Math.random().toString(36).slice(2, 6).toUpperCase()}`,
      expiresAt: expiresAt.toISOString(),
      used:      false,
    };

    const currentDiscounts = Array.isArray(user.discounts) ? user.discounts : [];

    await User.updateOne(
      { _id: req.user.userId },
      {
        $inc: { xp: -SPIN_COST, spinCount: 1 },
        $set: { discounts: [...currentDiscounts, newDiscount] },
      }
    );

    res.json({
      success:     true,
      prize:       newDiscount,
      xpRemaining: (user.xp || 0) - SPIN_COST,
      spinCount:   (user.spinCount || 0) + 1,
    });
  } catch (err) {
    console.error('Spin discount error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ─── GET /api/gamification/my-discounts ───────────────────────────────────────
router.get('/my-discounts', auth, async (req, res) => {
  try {
    const user = await User.findById(req.user.userId).select('discounts spinCount xp adsRemovedUntil');
    if (!user) return res.status(404).json({ error: 'User not found' });

    const now       = new Date();
    const discounts = (Array.isArray(user.discounts) ? user.discounts : [])
      .filter(d => !d.used && new Date(d.expiresAt) > now);

    const adsActive = user.adsRemovedUntil && new Date(user.adsRemovedUntil) > now;

    res.json({
      success:         true,
      discounts,
      spinCount:       user.spinCount || 0,
      xp:              user.xp || 0,
      spinCost:        SPIN_COST,
      adsActive,
      adsRemovedUntil: user.adsRemovedUntil || null,
    });
  } catch (err) {
    console.error('My discounts error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ─── POST /api/gamification/remove-ads ────────────────────────────────────────
const ADS_PLANS = {
  week:  { days: 7,  cost: 150, label: '7 Days Ad-Free'  },
  month: { days: 30, cost: 400, label: '30 Days Ad-Free' },
};

router.post('/remove-ads', auth, async (req, res) => {
  try {
    const { plan = 'week' } = req.body;
    if (!ADS_PLANS[plan])
      return res.status(400).json({ error: 'Invalid plan. Choose "week" or "month".' });

    const user = await User.findById(req.user.userId);
    if (!user) return res.status(404).json({ error: 'User not found' });

    const { days, cost, label } = ADS_PLANS[plan];
    if ((user.xp || 0) < cost)
      return res.status(400).json({ error: `Need ${cost} XP for ${label}. You have ${user.xp || 0} XP.` });

    const now    = new Date();
    // Extend from current expiry if already active
    const base   = (user.adsRemovedUntil && new Date(user.adsRemovedUntil) > now)
      ? new Date(user.adsRemovedUntil) : now;
    const until  = new Date(base);
    until.setDate(until.getDate() + days);

    await User.updateOne(
      { _id: req.user.userId },
      { $inc: { xp: -cost }, $set: { adsRemovedUntil: until } }
    );

    res.json({
      success:         true,
      label,
      adsRemovedUntil: until,
      xpRemaining:     (user.xp || 0) - cost,
    });
  } catch (err) {
    console.error('Remove ads error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ─── POST /api/gamification/tutor-chat ────────────────────────────────────────
// Real conversational AI tutor powering the StudyBuddy "Chat" tab. Grounds
// every answer in the student's own data (recent scores, weak topics, active
// study plan) so "why did I score low" / "what should I review next" get real
// answers instead of generic advice. Chat history is passed in by the client
// and not persisted server-side (kept intentionally simple/ephemeral).
router.post('/tutor-chat', auth, async (req, res) => {
  if (!gemini.ready) return res.status(503).json({ error: 'AI service unavailable' });

  try {
    const { message, history } = req.body;
    if (!message || !message.trim()) return res.status(400).json({ error: 'message is required' });

    const userId = req.user.userId;
    const [planKey, user, results, weakTopics, plan] = await Promise.all([
      getUserPlan(userId),
      User.findById(userId).select('studyBuddyName xp level currentStreak tutorChatCount tutorChatCountDate'),
      QuizResult.find({ userId }).sort({ createdAt: -1 }).limit(10).lean(),
      TopicMastery.find({ userId, status: 'weak' }).sort({ masteryScore: 1 }).limit(5).lean(),
      StudyPlan.findOne({ userId, examDate: { $gt: new Date() } }).sort({ examDate: 1 }).lean(),
    ]);
    if (!user) return res.status(404).json({ error: 'User not found' });

    // Daily rate limit — free/exam_mode tiers only, paid tiers are unlimited.
    const { tutorChatDailyLimit } = getPlanFeatures(planKey);
    if (tutorChatDailyLimit !== Infinity) {
      const todayStart = new Date();
      todayStart.setHours(0, 0, 0, 0);
      const lastCountDate = user.tutorChatCountDate ? new Date(user.tutorChatCountDate) : null;
      if (lastCountDate) lastCountDate.setHours(0, 0, 0, 0);
      const sameDay = lastCountDate && lastCountDate.getTime() === todayStart.getTime();
      const usedToday = sameDay ? (user.tutorChatCount || 0) : 0;

      if (usedToday >= tutorChatDailyLimit) {
        return res.status(403).json({
          error: `You've used all ${tutorChatDailyLimit} AI tutor messages for today. Upgrade your plan for unlimited chat.`,
          limitReached: true,
        });
      }
      await User.updateOne({ _id: userId }, { $set: { tutorChatCount: usedToday + 1, tutorChatCountDate: new Date() } });
    }

    const avgScore = results.length > 0
      ? Math.round(results.reduce((s, r) => s + (r.score || 0), 0) / results.length)
      : null;
    const recentScoresStr = results.slice(0, 5).map(r => `${r.subjectTag || 'General'}: ${r.score}%`).join(', ') || 'no quizzes taken yet';
    const weakStr = weakTopics.map(t => `${t.topic} (${t.subject}, ${t.masteryScore}% mastery)`).join(', ') || 'none identified yet';
    const planStr = plan
      ? `"${plan.examName}" on ${new Date(plan.examDate).toDateString()} — ${plan.schedule.filter(s => s.completed).length}/${plan.schedule.length} sessions done`
      : 'no active study plan';

    const historyText = Array.isArray(history)
      ? history.slice(-6).map(h => `${h.role === 'user' ? 'Student' : 'Tutor'}: ${h.content}`).join('\n')
      : '';

    const prompt = `You are ${user?.studyBuddyName || 'Siddy'}, a friendly, encouraging personal AI tutor inside a study app called Sidis.

Student context (ground your answer in this — don't ask for info you already have here):
- Recent quiz scores: ${recentScoresStr}
- Average score (last 10 quizzes): ${avgScore !== null ? avgScore + '%' : 'no data yet'}
- Weakest topics: ${weakStr}
- Current streak: ${user?.currentStreak || 0} days, Level ${user?.level || 1}, ${user?.xp || 0} XP
- Active study plan: ${planStr}
${historyText ? `\nRecent conversation:\n${historyText}\n` : ''}
Student's new message: "${message.trim()}"

Reply as their tutor — be specific and reference their real data above where relevant (e.g. if asked why they scored low, name a real weak topic; if asked what to review next, recommend one of their actual weak topics). If asked to generate a revision question, include one short question and its answer directly in your reply. Keep it conversational, under 120 words, no markdown headers.
Return JSON: { "reply": "..." }`;

    let reply;
    try {
      const parsed = await gemini.generateJSON(prompt, { maxOutputTokens: 400, temperature: 0.7 });
      reply = parsed.reply;
    } catch (aiErr) {
      console.error('Tutor chat AI error:', aiErr.message);
      return res.status(500).json({ error: 'AI failed to respond. Try again.' });
    }
    if (!reply) return res.status(500).json({ error: 'AI returned an empty response.' });

    res.json({ success: true, reply });
  } catch (err) {
    console.error('Tutor chat error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
