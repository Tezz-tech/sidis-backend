// utils/gamificationUtils.js — shared XP / level / badge logic
const mongoose = require('mongoose');

const BADGE_DEFS = {
  first_quiz:    { name: 'First Steps',     desc: 'Complete your first quiz',              emoji: '🎯', rarity: 'common'    },
  perfect_score: { name: 'Perfectionist',   desc: 'Score 100% on any quiz',                emoji: '💯', rarity: 'rare'      },
  streak_3:      { name: 'On Fire',         desc: 'Maintain a 3-day streak',               emoji: '🔥', rarity: 'common'    },
  streak_7:      { name: 'Week Warrior',    desc: 'Maintain a 7-day streak',               emoji: '⚡', rarity: 'uncommon'  },
  streak_30:     { name: 'Unstoppable',     desc: 'Maintain a 30-day streak',              emoji: '🌟', rarity: 'legendary' },
  quiz_master:   { name: 'Quiz Master',     desc: 'Complete 50 quizzes',                   emoji: '👑', rarity: 'epic'      },
  xp_100:        { name: 'Century Club',    desc: 'Earn 100 XP',                           emoji: '💰', rarity: 'common'    },
  xp_500:        { name: 'XP Hunter',       desc: 'Earn 500 XP',                           emoji: '💎', rarity: 'uncommon'  },
  xp_1000:       { name: 'Legend',          desc: 'Earn 1 000 XP',                         emoji: '🏆', rarity: 'epic'      },
  wager_winner:  { name: 'Risk Taker',      desc: 'Win your first XP wager',               emoji: '🎲', rarity: 'uncommon'  },
  high_roller:   { name: 'High Roller',     desc: 'Win a wager of 100+ XP',                emoji: '💸', rarity: 'rare'      },
  essay_expert:  { name: 'Essay Expert',    desc: 'Complete 10 essay quizzes',             emoji: '✍️', rarity: 'uncommon'  },
  speed_demon:   { name: 'Speed Demon',     desc: 'Finish a quiz in under half the time',  emoji: '⚡', rarity: 'rare'      },
  level_5:       { name: 'Master Scholar',  desc: 'Reach Level 5',                         emoji: '🎓', rarity: 'epic'      },
};

const LEVEL_THRESHOLDS = [
  { level: 1, minXP: 0,    title: 'Novice'      },
  { level: 2, minXP: 100,  title: 'Apprentice'  },
  { level: 3, minXP: 300,  title: 'Scholar'     },
  { level: 4, minXP: 600,  title: 'Expert'      },
  { level: 5, minXP: 1000, title: 'Master'      },
  { level: 6, minXP: 1500, title: 'Elite'       },
  { level: 7, minXP: 2500, title: 'Legend'      },
];

const POWERUP_COSTS = {
  timeFreeze: 50,
  fiftyFifty: 30,
  hint:       20,
  doubleXP:   100,
};

function getLevelInfo(xp) {
  let current = LEVEL_THRESHOLDS[0];
  let next = LEVEL_THRESHOLDS[1] || null;

  for (let i = LEVEL_THRESHOLDS.length - 1; i >= 0; i--) {
    if (xp >= LEVEL_THRESHOLDS[i].minXP) {
      current = LEVEL_THRESHOLDS[i];
      next = LEVEL_THRESHOLDS[i + 1] || null;
      break;
    }
  }

  const xpInLevel   = xp - current.minXP;
  const xpToNext    = next ? next.minXP - current.minXP : null;
  const progress    = next ? Math.min(100, Math.round((xpInLevel / xpToNext) * 100)) : 100;

  return {
    level:     current.level,
    title:     current.title,
    xp,
    xpInLevel,
    xpToNext,
    progress,
    nextTitle: next?.title || null,
  };
}

function checkNewBadges(user, results) {
  const newBadges   = [];
  const earned      = new Set(user.badges || []);

  const total         = results.length;
  const essayCount    = results.filter(r => r.essayAnswers && r.essayAnswers.length > 0).length;
  const hasPerfect    = results.some(r => r.score === 100);
  const streak        = user.currentStreak || 0;
  const bestStreak    = user.bestStreak    || 0;
  const xp            = user.xp            || 0;
  const level         = user.level          || 1;
  const wagersWon     = user.totalWagersWon || 0;

  if (total >= 1      && !earned.has('first_quiz'))    newBadges.push('first_quiz');
  if (hasPerfect      && !earned.has('perfect_score')) newBadges.push('perfect_score');
  if ((streak >= 3 || bestStreak >= 3)  && !earned.has('streak_3'))  newBadges.push('streak_3');
  if ((streak >= 7 || bestStreak >= 7)  && !earned.has('streak_7'))  newBadges.push('streak_7');
  if ((streak >= 30|| bestStreak >= 30) && !earned.has('streak_30')) newBadges.push('streak_30');
  if (total >= 50     && !earned.has('quiz_master'))   newBadges.push('quiz_master');
  if (xp >= 100       && !earned.has('xp_100'))        newBadges.push('xp_100');
  if (xp >= 500       && !earned.has('xp_500'))        newBadges.push('xp_500');
  if (xp >= 1000      && !earned.has('xp_1000'))       newBadges.push('xp_1000');
  if (wagersWon >= 1  && !earned.has('wager_winner'))  newBadges.push('wager_winner');
  if (essayCount >= 10&& !earned.has('essay_expert'))  newBadges.push('essay_expert');
  if (level >= 5      && !earned.has('level_5'))       newBadges.push('level_5');

  return newBadges;
}

/**
 * Award XP to a user and resolve wager/badges/level.
 * Mutates and saves the User document.
 * Returns { xpGained, totalXP, level, leveledUp, newBadges, bonuses, wagerResult }.
 */
async function awardXP(user, results, { baseXP = 0, reason = '', score = null, timeSpent = 0, timeLimit = 0, quizId = null } = {}) {
  let xpGained = baseXP;
  const bonuses = [];

  // Double XP power-up
  if (user.doubleXPActive && baseXP > 0) {
    xpGained += baseXP; // doubles it
    bonuses.push({ type: 'double_xp', amount: baseXP });
    user.doubleXPActive = false;
  }

  if (reason === 'quiz_complete') {
    // Streak bonus (capped at 50 XP)
    const streakBonus = Math.min(50, (user.currentStreak || 0) * 5);
    if (streakBonus > 0) {
      xpGained += streakBonus;
      bonuses.push({ type: 'streak_bonus', amount: streakBonus });
    }

    // Speed bonus — finish in under half the time limit
    if (timeSpent && timeLimit && timeSpent < (timeLimit * 60) / 2) {
      xpGained += 15;
      bonuses.push({ type: 'speed_bonus', amount: 15 });
    }

    // Perfect score bonus
    if (score === 100) {
      xpGained += 25;
      bonuses.push({ type: 'perfect_score', amount: 25 });
    }

    // Daily first-quiz bonus
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const lastBonus = user.lastDailyBonus ? new Date(user.lastDailyBonus) : null;
    if (lastBonus) lastBonus.setHours(0, 0, 0, 0);
    if (!lastBonus || lastBonus < today) {
      xpGained += 15;
      bonuses.push({ type: 'daily_first_quiz', amount: 15 });
      user.lastDailyBonus = new Date();
    }
  }

  const oldXP = user.xp || 0;
  user.xp = Math.max(0, oldXP + xpGained);

  // Level up check
  const levelInfo = getLevelInfo(user.xp);
  const oldLevel  = user.level || 1;
  user.level      = levelInfo.level;
  const leveledUp = levelInfo.level > oldLevel;

  // Wager resolution — the stake is already escrowed (deducted) at the time
  // the wager was placed (see POST /gamification/wager), so this only ever
  // needs to credit back a payout. A loss credits nothing further back
  // (the stake stays forfeited); crediting a further negative here would
  // double-deduct it.
  let wagerResult = null;
  const wager = user.activeWager;
  if (wager && wager.wagerAmount > 0 && quizId && wager.quizId && wager.quizId.toString() === quizId.toString()) {
    let wagerXPChange = 0;  // actually credited to user.xp now (post-escrow)
    let netForDisplay = 0;  // net effect vs. the student's pre-wager balance
    let won           = false;

    if (score >= 95)      { wagerXPChange = Math.round(wager.wagerAmount * 3);   won = true; }
    else if (score >= 85) { wagerXPChange = Math.round(wager.wagerAmount * 2);   won = true; }
    else if (score >= 70) { wagerXPChange = Math.round(wager.wagerAmount * 1.5); won = true; }
    else if (score >= 50) { wagerXPChange = wager.wagerAmount; /* refund stake — true break-even */ }
    else                  { wagerXPChange = 0; /* stake already forfeited via escrow */ }
    // wagerXPChange is the GROSS credit (includes the stake being returned,
    // since the stake was already deducted at escrow time) — the net change
    // vs. the student's pre-wager balance is always that credit minus the
    // stake they already lost from their balance, in every band including
    // the loss band (0 credited - stake = -stake).
    netForDisplay = wagerXPChange - wager.wagerAmount;

    user.xp = Math.max(0, user.xp + wagerXPChange);

    if (won) {
      user.totalWagersWon = (user.totalWagersWon || 0) + 1;
      if (wager.wagerAmount >= 100 && !(user.badges || []).includes('high_roller')) {
        user.badges = [...(user.badges || []), 'high_roller'];
      }
    }

    wagerResult = {
      wagerAmount: wager.wagerAmount,
      xpChange:    netForDisplay,
      won,
      multiplier:  won ? parseFloat((wagerXPChange / wager.wagerAmount).toFixed(1)) : null,
    };

    user.activeWager = { quizId: null, wagerAmount: 0 };

    // Re-check level after wager
    const newLevelInfo = getLevelInfo(user.xp);
    user.level = newLevelInfo.level;
  }

  // Badge check
  const newBadges = checkNewBadges(user, results);
  if (newBadges.length > 0) {
    user.badges = [...new Set([...(user.badges || []), ...newBadges])];
  }

  // Speed demon badge (needs timeSpent + timeLimit)
  if (
    timeSpent && timeLimit &&
    timeSpent < (timeLimit * 60) / 2 &&
    !(user.badges || []).includes('speed_demon')
  ) {
    user.badges = [...(user.badges || []), 'speed_demon'];
    newBadges.push('speed_demon');
  }

  // Level 5 badge
  if (user.level >= 5 && !(user.badges || []).includes('level_5')) {
    user.badges = [...(user.badges || []), 'level_5'];
    newBadges.push('level_5');
  }

  // Use updateOne instead of user.save() to bypass Mongoose full-document
  // validation and to correctly persist Mixed-type fields (activeWager, powerUps)
  // which Mongoose doesn't detect as modified without markModified().
  const User = mongoose.model('User');

  const setFields = {
    xp:             user.xp,
    level:          user.level,
    doubleXPActive: user.doubleXPActive || false,
    lastDailyBonus: user.lastDailyBonus || null,
    totalWagersWon: user.totalWagersWon || 0,
    activeWager:    user.activeWager    || { quizId: null, wagerAmount: 0 },
  };

  const updateOp = { $set: setFields };
  if (newBadges.length > 0) {
    updateOp.$addToSet = { badges: { $each: [...new Set(newBadges)] } };
  }

  await User.updateOne({ _id: user._id }, updateOp);

  return {
    xpGained,
    totalXP: user.xp,
    level:   user.level,
    leveledUp,
    newBadges,
    bonuses,
    wagerResult,
  };
}

module.exports = { BADGE_DEFS, LEVEL_THRESHOLDS, POWERUP_COSTS, getLevelInfo, checkNewBadges, awardXP };
