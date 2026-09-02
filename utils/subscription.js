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
    tutorChatDailyLimit: 15,
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
    tutorChatDailyLimit: 15,
  },
  weekly_individual: {
    aiQuizzesPerMonth:  Infinity,
    unlimitedQuizzes:   true,
    moreTools:          true,
    studyJourney:       false,
    studyBuddy:         false,
    forecaster:         true,
    sidIQ:              true,
    sidIQMonthlyLimit:  1,
    adFree:             true,
    tutorChatDailyLimit: Infinity,
  },
  weekly_group: {
    aiQuizzesPerMonth:  Infinity,
    unlimitedQuizzes:   true,
    moreTools:          true,
    studyJourney:       false,
    studyBuddy:         true,
    forecaster:         true,
    sidIQ:              true,
    sidIQMonthlyLimit:  1,
    adFree:             true,
    tutorChatDailyLimit: Infinity,
  },
  monthly_individual: {
    aiQuizzesPerMonth:  Infinity,
    unlimitedQuizzes:   true,
    moreTools:          true,
    studyJourney:       true,
    studyBuddy:         true,
    forecaster:         true,
    sidIQ:              true,
    sidIQMonthlyLimit:  1,
    adFree:             true,
    tutorChatDailyLimit: Infinity,
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
    tutorChatDailyLimit: Infinity,
  },
  yearly_individual: {
    aiQuizzesPerMonth:  Infinity,
    unlimitedQuizzes:   true,
    moreTools:          true,
    studyJourney:       true,
    studyBuddy:         true,
    forecaster:         true,
    sidIQ:              true,
    sidIQMonthlyLimit:  1,
    adFree:             true,
    tutorChatDailyLimit: Infinity,
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
    tutorChatDailyLimit: Infinity,
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
  moreTools:    'Weekly Individual (₦5,750/week)',
  studyJourney: 'Exam Mode (₦7,250 one-time)',
  studyBuddy:   'Weekly Group (₦2,950/person/week)',
  forecaster:   'Weekly Group (₦2,950/person/week)',
  sidIQ:        'Weekly Group (₦2,950/person/week)',
};

/**
 * The user's own active subscription (regardless of isGroup), or null.
 */
async function getOwnActiveSubscription(userId) {
  const now = new Date();
  return Subscription.findOne({
    userId,
    status: 'active',
    $or: [{ expiresAt: null }, { expiresAt: { $gt: now } }],
  }).sort({ createdAt: -1 }).lean();
}

/**
 * An active group subscription this user has *joined* as an invited member
 * (i.e. someone else's group plan), or null.
 */
async function getGroupSubscriptionForMember(userId) {
  const now = new Date();
  return Subscription.findOne({
    isGroup: true,
    status: 'active',
    $or: [{ expiresAt: null }, { expiresAt: { $gt: now } }],
    members: { $elemMatch: { userId, status: 'joined' } },
  }).sort({ createdAt: -1 }).lean();
}

/**
 * Resolves which subscription actually grants this user their plan: their
 * own first, falling back to a group plan they've joined as a member.
 * Returns { subscription, viaGroup }.
 */
async function getEffectiveSubscription(userId) {
  const own = await getOwnActiveSubscription(userId);
  if (own) return { subscription: own, viaGroup: false };
  const group = await getGroupSubscriptionForMember(userId);
  if (group) return { subscription: group, viaGroup: true };
  return { subscription: null, viaGroup: false };
}

/**
 * Returns the active plan key for a user, or 'free' if none — checking the
 * user's own subscription first, then any group plan they've joined.
 */
async function getUserPlan(userId) {
  const { subscription } = await getEffectiveSubscription(userId);
  return subscription ? subscription.plan : 'free';
}

/**
 * Returns the feature flags object for a given plan key.
 */
function getPlanFeatures(plan) {
  return PLAN_FEATURES[plan] || PLAN_FEATURES.free;
}

module.exports = {
  getUserPlan, getPlanFeatures, PLAN_FEATURES, PLAN_NAMES, FEATURE_REQUIRED_PLAN,
  getEffectiveSubscription, getOwnActiveSubscription, getGroupSubscriptionForMember,
};
