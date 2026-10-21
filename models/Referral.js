// models/Referral.js — one document per referred signup. Created at signup
// with status 'pending'; only flips to 'converted' when the referred user's
// FIRST paid subscription actually activates (see convertReferralIfPending
// in routes/payments.js) — a signup alone never counts.
const mongoose = require('mongoose');

const ReferralSchema = new mongoose.Schema({
  referrerId:     { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  referredId:     { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
  code:           { type: String, required: true },
  status:         { type: String, enum: ['pending', 'converted'], default: 'pending', index: true },
  convertedAt:    { type: Date, default: null },
  subscriptionId: { type: mongoose.Schema.Types.ObjectId, ref: 'Subscription', default: null },
}, { timestamps: true });

module.exports = mongoose.model('Referral', ReferralSchema);
