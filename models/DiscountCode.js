// models/DiscountCode.js — admin-created discount codes, global (not tied
// to one user) — distinct from the per-user codes the spin wheel awards
// (those stay on User.discounts). Both kinds are checked and redeemed
// through the same resolveDiscount() helper in routes/payments.js.
const mongoose = require('mongoose');

const DiscountCodeSchema = new mongoose.Schema({
  code:        { type: String, required: true, unique: true, uppercase: true, trim: true },
  percentOff:  { type: Number, required: true, min: 1, max: 100 },
  active:      { type: Boolean, default: true },
  maxUses:     { type: Number, default: null }, // null = unlimited
  usedCount:   { type: Number, default: 0 },
  expiresAt:   { type: Date, default: null },   // null = never expires
  // Restrict to one package key, or null to apply to any plan.
  planKey:     { type: String, default: null },
  note:        { type: String, default: '' },   // admin-facing label, e.g. "Black Friday 2026"
}, { timestamps: true });

module.exports = mongoose.model('DiscountCode', DiscountCodeSchema);
