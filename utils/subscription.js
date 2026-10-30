// utils/subscription.js — plan feature lookups + active-plan resolution.
// Feature flags and pricing used to live here as hardcoded objects; they
// now live in the Package collection (admin-editable via /api/admin/packages),
// so every lookup here is async. Falls back to a safe default (effectively
// "free") only if the DB has no matching package at all — should only ever
// happen before the initial seed runs.
const Subscription = require('../models/Subscription');
const Package = require('../models/Package');

const DEFAULT_ACCESS = {
  aiQuizzesPerMonth: 5, unlimitedQuizzes: false, moreTools: false, studyJourney: false,
  examMode: false, studyBuddy: false, forecaster: false, sidIQ: false,
  sidIQMonthlyLimit: 0, adFree: false, tutorChatDailyLimit: 15,
};

// Paying for ANY plan unlocks EVERYTHING — packages only ever differ by
// price/duration/group-size from here on, never by which features they
// grant. This is also what fixes the class of bug where one specific paid
// package (e.g. Yearly) had a stale/unchecked `access.sidIQ` flag in the
// DB and so was quietly missing a feature every other paid plan had —
// since paid access no longer reads the DB's per-package `access` object
// at all, that kind of mismatch can't happen again. The admin package
// editor's per-feature checkboxes now only have any effect on the 'free'
// package.
const FULL_ACCESS = {
  aiQuizzesPerMonth: -1, unlimitedQuizzes: true, moreTools: true, studyJourney: true,
  examMode: true, studyBuddy: true, forecaster: true, sidIQ: true,
  sidIQMonthlyLimit: -1, adFree: true, tutorChatDailyLimit: -1,
};

async function getPackageByKey(key) {
  if (!key) return null;
  return Package.findOne({ key }).lean();
}

async function getAllActivePackages() {
  return Package.find({ active: true }).sort({ sortOrder: 1, amount: 1 }).lean();
}

async function getAllPackages() {
  return Package.find({}).sort({ sortOrder: 1, amount: 1 }).lean();
}

/**
 * Returns the feature-flag object for a given plan key (falls back to the
 * 'free' package, then to a hardcoded default if the DB has neither).
 */
async function getPlanFeatures(planKey) {
  if (planKey && planKey !== 'free') return FULL_ACCESS;
  const pkg = await getPackageByKey('free');
  return pkg ? pkg.access : DEFAULT_ACCESS;
}

/**
 * Returns the display name for a plan key, or 'Free' if unknown.
 */
async function getPlanName(planKey) {
  if (!planKey || planKey === 'free') return 'Free';
  const pkg = await getPackageByKey(planKey);
  return pkg ? pkg.name : 'Free';
}

function formatPrice(pkg) {
  const price = `₦${(pkg.amount / 100).toLocaleString('en-NG')}`;
  const period = pkg.durationDays === 1 ? '/day'
    : pkg.durationDays === 7 ? '/week'
    : pkg.durationDays === 30 ? '/month'
    : pkg.durationDays === 365 ? '/year'
    : pkg.durationDays >= 1000 ? ' one-time'
    : '';
  return `${price}${period}`;
}

/**
 * The cheapest currently-active PAID package, formatted as
 * "Plan Name (₦price/period)" for upgrade prompts — or null if there is no
 * active paid package at all. `featureKey` no longer narrows the search
 * since every paid package now unlocks every feature (see FULL_ACCESS
 * above) — any paid plan is a correct answer, so we just recommend the
 * cheapest one.
 */
async function getFeatureRequiredPlanText(featureKey) {
  const packages = await getAllActivePackages();
  const candidates = packages
    .filter(p => p.key !== 'free')
    .sort((a, b) => a.amount - b.amount);
  if (candidates.length === 0) return null;
  return `${candidates[0].name} (${formatPrice(candidates[0])})`;
}

/**
 * Same as above but for a whole list of feature keys at once — returns
 * { featureKey: text|null }.
 */
async function getFeatureRequiredPlanMap(featureKeys) {
  const out = {};
  await Promise.all(featureKeys.map(async (k) => { out[k] = await getFeatureRequiredPlanText(k); }));
  return out;
}

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

module.exports = {
  getUserPlan, getPlanFeatures, getPlanName,
  getFeatureRequiredPlanText, getFeatureRequiredPlanMap,
  getPackageByKey, getAllActivePackages, getAllPackages,
  getEffectiveSubscription, getOwnActiveSubscription, getGroupSubscriptionForMember,
};
