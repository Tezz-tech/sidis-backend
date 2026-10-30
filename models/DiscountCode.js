// models/DiscountCode.js — admin-created discount codes, global (not tied
// to one user) — distinct from the per-user codes the spin wheel awards
// (those stay on User.discounts). Both kinds are checked and redeemed
// through the same resolveDiscount() helper in routes/payments.js.
const mongoose = require('mongoose');

const DiscountCodeSchema = new mongoose.Schema({
  code:        { type: String, required: true, unique: true, uppercase: true, trim: true },
  // 'percent' — a % off applied at checkout (via resolveDiscount), same as
  // before. 'freeAccess' — redeeming the code (see POST /payments/redeem-code)
  // immediately grants N days of full paid access instead of a checkout
  // discount; it is never usable as a checkout code.
  type:        { type: String, enum: ['percent', 'freeAccess'], default: 'percent' },
  percentOff:  { type: Number, min: 1, max: 100, default: null },   // required when type === 'percent'
  freeDays:    { type: Number, min: 1, default: null },             // required when type === 'freeAccess'
  active:      { type: Boolean, default: true },
  maxUses:     { type: Number, default: null }, // null = unlimited
  usedCount:   { type: Number, default: 0 },
  // Users who have already redeemed this code via POST /payments/redeem-code
  // — stops the same person claiming a shared/promo code more than once,
  // independent of maxUses (which caps total redemptions across everyone).
  redeemedBy:  { type: [mongoose.Schema.Types.ObjectId], ref: 'User', default: [] },
  expiresAt:   { type: Date, default: null },   // null = never expires
  // Restrict to one package key, or null to apply to any plan. Only
  // meaningful for type === 'percent' (freeAccess codes grant raw access
  // time, not a discount tied to any specific plan).
  planKey:     { type: String, default: null },
  note:        { type: String, default: '' },   // admin-facing label, e.g. "Black Friday 2026"
}, { timestamps: true });

module.exports = mongoose.model('DiscountCode', DiscountCodeSchema);
