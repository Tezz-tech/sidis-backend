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

  const User = mongoose.model('User');
  await User.updateOne(
    { _id: user._id },
    {
      $set: {
        quizzesTaken, averageScore, totalScore, accuracy,
        hoursPracticed: roundedHours,
        currentStreak, bestStreak, weeklyImprovement,
        lastQuizDate: newLastQuizDate,
      },
    }
  );

  return {
    quizzesTaken, averageScore, totalScore, accuracy,
    hoursPracticed: roundedHours,
    currentStreak, bestStreak, weeklyImprovement,
    lastQuizDate: newLastQuizDate,
  };
}

module.exports = { isConsecutiveDay, isSameDay, computeAndSyncUserStats };
