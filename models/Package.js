// models/Package.js — admin-managed pricing plans. Replaces the old
// hardcoded PLANS objects that used to live separately in payments.js,
// admin.js, and utils/subscription.js (and were duplicated again in two
// frontend files) — this is now the single source of truth for what a plan
// costs and what it unlocks. `key` is what Subscription.plan stores, so it
// must stay unique and is treated as immutable after creation (changing it
// would orphan every existing subscription on that plan).
//
// Numeric "unlimited" fields (aiQuizzesPerMonth, tutorChatDailyLimit) use
// -1 as the unlimited sentinel instead of Infinity, since Infinity doesn't
// survive a JSON/Mongo round-trip.
const mongoose = require('mongoose');

const AccessSchema = new mongoose.Schema({
  aiQuizzesPerMonth:   { type: Number,  default: 5 },
  unlimitedQuizzes:    { type: Boolean, default: false },
  moreTools:           { type: Boolean, default: false },
  studyJourney:        { type: Boolean, default: false },
  examMode:            { type: Boolean, default: false },
  studyBuddy:          { type: Boolean, default: false },
  forecaster:          { type: Boolean, default: false },
  sidIQ:               { type: Boolean, default: false },
  sidIQMonthlyLimit:   { type: Number,  default: 0 },
  adFree:              { type: Boolean, default: false },
  tutorChatDailyLimit: { type: Number,  default: 15 },
}, { _id: false });

const PackageSchema = new mongoose.Schema({
  key:          { type: String, required: true, unique: true, trim: true, lowercase: true },
  name:         { type: String, required: true, trim: true },
  amount:       { type: Number, required: true, default: 0, min: 0 }, // kobo; 0 = free
  durationDays: { type: Number, required: true, default: 30, min: 0 },
  isGroup:      { type: Boolean, default: false },
  active:       { type: Boolean, default: true }, // hide from pricing/billing without deleting
  popular:      { type: Boolean, default: false },
  badge:        { type: String, default: '', trim: true },
  color:        { type: String, default: 'from-orange-500 to-pink-600', trim: true },
  sortOrder:    { type: Number, default: 0 },
  // Marketing bullet points shown on the pricing/billing cards — separate
  // from `access` (below) since the real-world copy ("2 months free") isn't
  // always a literal 1:1 feature flag.
  displayFeatures: { type: [String], default: [] },
  access: { type: AccessSchema, default: () => ({}) },
}, { timestamps: true });

module.exports = mongoose.model('Package', PackageSchema);
