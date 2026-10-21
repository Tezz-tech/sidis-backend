// routes/push.js — Web Push: subscription management for the logged-in
// user, plus two Vercel Cron targets (same shared-secret pattern as
// /api/adaptive/daily-sweep) that nudge users who've enabled notifications.
const express = require('express');
const router = express.Router();
const auth = require('../middlewares/auth');
const PushSubscription = require('../models/PushSubscription');
const StudyPlan = require('../models/StudyPlan');
const User = require('../models/User');
const { sendPushToUser, isPushConfigured } = require('../utils/webPush');

function isSameDay(date1, date2) {
  const d1 = new Date(date1);
  const d2 = new Date(date2);
  return d1.getFullYear() === d2.getFullYear() &&
    d1.getMonth() === d2.getMonth() &&
    d1.getDate() === d2.getDate();
}

// ─── GET /api/push/public-key ──────────────────────────────────────────────
// No auth — the VAPID public key isn't secret, it's handed to every browser
// that wants to subscribe.
router.get('/public-key', (req, res) => {
  if (!isPushConfigured()) return res.status(503).json({ error: 'Push notifications are not configured yet.' });
  res.json({ publicKey: process.env.VAPID_PUBLIC_KEY });
});

// ─── POST /api/push/subscribe ──────────────────────────────────────────────
router.post('/subscribe', auth, async (req, res) => {
  try {
    const { endpoint, keys } = req.body || {};
    if (!endpoint || !keys?.p256dh || !keys?.auth) {
      return res.status(400).json({ error: 'Invalid push subscription.' });
    }
    await PushSubscription.findOneAndUpdate(
      { endpoint },
      { endpoint, keys, userId: req.user.userId },
      { upsert: true, setDefaultsOnInsert: true }
    );
    res.json({ success: true });
  } catch (err) {
    console.error('Push subscribe error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ─── POST /api/push/unsubscribe ────────────────────────────────────────────
router.post('/unsubscribe', auth, async (req, res) => {
  try {
    const { endpoint } = req.body || {};
    if (endpoint) await PushSubscription.deleteOne({ endpoint, userId: req.user.userId });
    res.json({ success: true });
  } catch (err) {
    console.error('Push unsubscribe error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ─── POST /api/push/test ───────────────────────────────────────────────────
// Lets the Profile page's "Send test notification" button prove the whole
// pipeline (permission → subscription → backend → push service → device)
// actually works, without waiting for a cron run.
router.post('/test', auth, async (req, res) => {
  try {
    if (!isPushConfigured()) return res.status(503).json({ error: 'Push notifications are not configured yet.' });
    const sent = await sendPushToUser(req.user.userId, {
      title: 'Sidis',
      body: "Push notifications are working — you'll hear from us when it matters.",
      url: '/over',
    });
    if (!sent) return res.status(404).json({ error: 'No active subscription found for this device.' });
    res.json({ success: true });
  } catch (err) {
    console.error('Push test error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ─── Shared cron-secret check (same scheme as /api/adaptive/daily-sweep) ──
function cronAuthorized(req, res) {
  const provided = req.headers['x-cron-secret'] || req.headers['authorization']?.replace(/^Bearer\s+/i, '') || req.query.secret;
  if (!process.env.CRON_SECRET || provided !== process.env.CRON_SECRET) {
    res.status(401).json({ error: 'Unauthorized' });
    return false;
  }
  return true;
}

// ─── /api/push/daily-reminder — Vercel Cron, mornings ──────────────────────
// For every user who has push enabled: if they have a Study Planner session
// due today, name it; otherwise a generic "today's mission" nudge.
async function dailyReminder(req, res) {
  if (!cronAuthorized(req, res)) return;
  if (!isPushConfigured()) return res.json({ success: true, skipped: 'push not configured' });

  try {
    const userIds = await PushSubscription.distinct('userId');
    const todayStart = new Date();
    todayStart.setUTCHours(0, 0, 0, 0);

    let sent = 0;
    for (const userId of userIds) {
      const plans = await StudyPlan.find({ userId, generated: true }).lean();

      let due = null;
      outer:
      for (const plan of plans) {
        for (const s of plan.schedule) {
          if (s.completed) continue;
          const d = new Date(s.date);
          d.setUTCHours(0, 0, 0, 0);
          if (d.getTime() === todayStart.getTime()) { due = { session: s, plan }; break outer; }
        }
      }

      const payload = due ? {
        title: `📚 ${due.session.subject} is on today's plan`,
        body: due.session.isExamDay
          ? "Exam day — quick flashcard recap, you've got this."
          : `Your ${due.plan.examName} session is ready whenever you are.`,
        url: '/study-planner',
      } : {
        title: "🎯 Today's Mission is ready",
        body: 'Open your dashboard and keep building that streak.',
        url: '/over',
      };

      if (await sendPushToUser(userId, payload)) sent++;
    }
    res.json({ success: true, usersChecked: userIds.length, sent });
  } catch (err) {
    console.error('Daily reminder cron error:', err);
    res.status(500).json({ error: 'Server error' });
  }
}

// ─── /api/push/streak-check — Vercel Cron, evenings ────────────────────────
// Only fires for users who have an active streak AND haven't taken a quiz
// yet today — reuses the same lastQuizDate/currentStreak fields the
// Profile page and leaderboard already read, so this agrees with what the
// user sees elsewhere instead of recomputing its own notion of "streak".
async function streakCheck(req, res) {
  if (!cronAuthorized(req, res)) return;
  if (!isPushConfigured()) return res.json({ success: true, skipped: 'push not configured' });

  try {
    const subscribedUserIds = await PushSubscription.distinct('userId');
    if (subscribedUserIds.length === 0) return res.json({ success: true, usersChecked: 0, sent: 0 });

    const users = await User.find({
      _id: { $in: subscribedUserIds },
      currentStreak: { $gt: 0 },
    }).select('currentStreak lastQuizDate').lean();

    const today = new Date();
    let sent = 0;
    for (const user of users) {
      const studiedToday = user.lastQuizDate && isSameDay(user.lastQuizDate, today);
      if (studiedToday) continue;

      const ok = await sendPushToUser(user._id, {
        title: `🔥 Your ${user.currentStreak}-day streak ends at midnight`,
        body: 'One quick quiz keeps it alive.',
        url: '/over',
      });
      if (ok) sent++;
    }
    res.json({ success: true, usersChecked: users.length, sent });
  } catch (err) {
    console.error('Streak check cron error:', err);
    res.status(500).json({ error: 'Server error' });
  }
}

router.get('/daily-reminder', dailyReminder);
router.post('/daily-reminder', dailyReminder);
router.get('/streak-check', streakCheck);
router.post('/streak-check', streakCheck);

module.exports = router;
