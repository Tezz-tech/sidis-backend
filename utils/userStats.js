// utils/userStats.js — the single place that computes and persists a user's
// cached quiz stats (quizzesTaken, averageScore, accuracy, streak, etc.).
// These fields are read directly off the User document by several features
// (Profile page, the global leaderboard, badge/streak-bonus checks) that
// never re-derive them from QuizResult themselves, so this must run every
// time a quiz result is saved — not just when the user happens to open
// their dashboard — or those features silently go stale.
'use strict';

const mongoose = require('mongoose');

function isConsecutiveDay(date1, date2) {
  const d1 = new Date(date1);
  const d2 = new Date(date2);
  d1.setHours(0, 0, 0, 0);
  d2.setHours(0, 0, 0, 0);
  const diff = Math.round((d2 - d1) / (1000 * 60 * 60 * 24));
  return diff === 1;
}

function isSameDay(date1, date2) {
  const d1 = new Date(date1);
  const d2 = new Date(date2);
  return d1.getFullYear() === d2.getFullYear() &&
    d1.getMonth() === d2.getMonth() &&
    d1.getDate() === d2.getDate();
}

// Computes fresh stats from `results` (must be sorted createdAt desc) against
// `user`'s current streak fields, persists them, and returns the computed
// values so the caller can reuse them without re-deriving.
async function computeAndSyncUserStats(user, results) {
  const quizzesTaken = results.length;
  const totalScore   = results.reduce((sum, r) => sum + (r.score || 0), 0);
  const averageScore = quizzesTaken > 0 ? Math.round(totalScore / quizzesTaken) : 0;
  // accuracy = same as averageScore since score = (correct/total)*100
  const accuracy = averageScore;

  const hoursPracticed = results.reduce((sum, r) => sum + (r.timeSpent || 0), 0) / 3600;

  const today = new Date();
  let currentStreak = user.currentStreak || 0;
  let bestStreak     = user.bestStreak    || 0;
  const lastQuizDate = user.lastQuizDate  || null;

  if (quizzesTaken > 0) {
    if (lastQuizDate) {
      if (isSameDay(lastQuizDate, today)) {
        // already counted today, streak stays
      } else if (isConsecutiveDay(lastQuizDate, today)) {
        currentStreak += 1;
      } else {
        currentStreak = 1; // streak broken
      }
    } else {
      currentStreak = 1;
    }
    if (currentStreak > bestStreak) bestStreak = currentStreak;
  }

  let weeklyImprovement = 0;
  if (results.length >= 2) {
    const recent = results.slice(0, Math.min(5, results.length));
    const older  = results.slice(Math.min(5, results.length), Math.min(10, results.length));
    const recentAvg = recent.reduce((s, r) => s + r.score, 0) / recent.length;
    const olderAvg  = older.length > 0
      ? older.reduce((s, r) => s + r.score, 0) / older.length
      : recentAvg;
    weeklyImprovement = Math.round(recentAvg - olderAvg);
  }

  const newLastQuizDate = results.length > 0 ? results[0].createdAt : (user.lastQuizDate || null);
  const roundedHours = parseFloat(hoursPracticed.toFixed(1));

  // Every 7-day streak milestone (7, 14, 21, ...) pays out once — gated on
  // lastStreakRewardStreak so re-computing stats later the same day (or a
  // streak that later breaks and climbs back past an old milestone) never
  // double-pays the same milestone.
  const STREAK_REWARD_XP = 50;
  const lastRewarded = user.lastStreakRewardStreak || 0;
  let streakReward = null;
  const setFields = {
    quizzesTaken, averageScore, totalScore, accuracy,
    hoursPracticed: roundedHours,
    currentStreak, bestStreak, weeklyImprovement,
    lastQuizDate: newLastQuizDate,
  };

  if (currentStreak > 0 && currentStreak % 7 === 0 && currentStreak > lastRewarded) {
    const discountCode = `STREAK${currentStreak}${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + 30);
    const discountEntry = {
      id:        `disc_${Date.now()}`,
      label:     '10% Off',
      value:     10,
      rarity:    'common',
      emoji:     '🔥',
      code:      discountCode,
      expiresAt: expiresAt.toISOString(),
      used:      false,
      source:    'streak',
    };
    setFields.lastStreakRewardStreak = currentStreak;
    setFields.xp = (user.xp || 0) + STREAK_REWARD_XP;
    setFields.discounts = [...(Array.isArray(user.discounts) ? user.discounts : []), discountEntry];
    streakReward = { days: currentStreak, xpAwarded: STREAK_REWARD_XP, discountCode, discountValue: 10 };
  }

  const User = mongoose.model('User');
  await User.updateOne({ _id: user._id }, { $set: setFields });

  return {
    quizzesTaken, averageScore, totalScore, accuracy,
    hoursPracticed: roundedHours,
    currentStreak, bestStreak, weeklyImprovement,
    lastQuizDate: newLastQuizDate,
    streakReward,
  };
}

module.exports = { isConsecutiveDay, isSameDay, computeAndSyncUserStats };
