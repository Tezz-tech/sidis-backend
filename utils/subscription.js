// utils/subscription.js — plan feature definitions + active-plan lookup
const Subscription = require('../models/Subscription');

// ── Feature matrix per plan ───────────────────────────────────────────────────
const PLAN_FEATURES = {
  free: {
    aiQuizzesPerMonth:  5,
    unlimitedQuizzes:   false,
    moreTools:          false,
    studyJourney:       false,
    studyBuddy:         false,
    forecaster:         false,
    sidIQ:              false,
    sidIQMonthlyLimit:  0,
    adFree:             false,
  },
  exam_mode: {
    aiQuizzesPerMonth:  5,
    unlimitedQuizzes:   false,
    moreTools:          false,
    studyJourney:       true,
    studyBuddy:         false,
    forecaster:         false,
    sidIQ:              false,
    sidIQMonthlyLimit:  0,
    adFree:             false,
  },
  weekly_individual: {
    aiQuizzesPerMonth:  Infinity,
    unlimitedQuizzes:   true,
    moreTools:          true,
    studyJourney:       false,
    studyBuddy:         false,
    forecaster:         false,
    sidIQ:              false,
    sidIQMonthlyLimit:  0,
    adFree:             true,
  },
  weekly_group: {
    aiQuizzesPerMonth:  Infinity,
    unlimitedQuizzes:   true,
    moreTools:          true,
    studyJourney:       false,
    studyBuddy:         true,
    forecaster:         false,
    sidIQ:              false,
    sidIQMonthlyLimit:  0,
    adFree:             true,
  },
  monthly_individual: {
    aiQuizzesPerMonth:  Infinity,
    unlimitedQuizzes:   true,
    moreTools:          true,
    studyJourney:       true,
    studyBuddy:         true,
    forecaster:         false,
    sidIQ:              false,
    sidIQMonthlyLimit:  0,
    adFree:             true,
  },
  monthly_group: {
    aiQuizzesPerMonth:  Infinity,
    unlimitedQuizzes:   true,
    moreTools:          true,
    studyJourney:       true,
    studyBuddy:         true,
    forecaster:         true,
    sidIQ:              true,
    sidIQMonthlyLimit:  1,
    adFree:             true,
  },
  yearly_individual: {
    aiQuizzesPerMonth:  Infinity,
    unlimitedQuizzes:   true,
    moreTools:          true,
    studyJourney:       true,
    studyBuddy:         true,
    forecaster:         false,
    sidIQ:              false,
    sidIQMonthlyLimit:  0,
    adFree:             true,
  },
  yearly_group: {
    aiQuizzesPerMonth:  Infinity,
    unlimitedQuizzes:   true,
    moreTools:          true,
    studyJourney:       true,
    studyBuddy:         true,
    forecaster:         true,
    sidIQ:              true,
    sidIQMonthlyLimit:  1,
    adFree:             true,
  },
};

// Plan display names
const PLAN_NAMES = {
  free:               'Free',
  exam_mode:          'Exam Mode',
  weekly_individual:  'Weekly Individual',
  weekly_group:       'Weekly Group',
  monthly_individual: 'Monthly Individual',
  monthly_group:      'Monthly Group',
  yearly_individual:  'Yearly Individual',
  yearly_group:       'Yearly Group',
};

// Which paid plan a feature requires (for upgrade prompts)
const FEATURE_REQUIRED_PLAN = {
  moreTools:    'Weekly Individual (₦5,500/week)',
  studyJourney: 'Exam Mode (₦7,000 one-time)',
  studyBuddy:   'Weekly Group (₦2,700/person/week)',
  forecaster:   'Monthly Group (₦10,000/month)',
  sidIQ:        'Monthly Group (₦10,000/month)',
};

/**
 * Returns the active plan key for a user, or 'free' if none.
 */
async function getUserPlan(userId) {
  const now = new Date();
  const sub = await Subscription.findOne({
    userId,
    status: 'active',
    $or: [{ expiresAt: null }, { expiresAt: { $gt: now } }],
  }).sort({ createdAt: -1 }).lean();
  return sub ? sub.plan : 'free';
}

/**
 * Returns the feature flags object for a given plan key.
 */
function getPlanFeatures(plan) {
  return PLAN_FEATURES[plan] || PLAN_FEATURES.free;
}

module.exports = { getUserPlan, getPlanFeatures, PLAN_FEATURES, PLAN_NAMES, FEATURE_REQUIRED_PLAN };
