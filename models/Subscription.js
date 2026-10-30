const mongoose = require('mongoose');

// A person invited onto a group plan by its payer. `userId` stays null until
// the invited email actually signs up/logs in and claims the invite token.
const GroupMemberSchema = new mongoose.Schema({
  email:       { type: String, required: true, lowercase: true, trim: true },
  userId:      { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  status:      { type: String, enum: ['invited', 'joined'], default: 'invited' },
  inviteToken: { type: String, required: true },
  invitedAt:   { type: Date, default: Date.now },
  joinedAt:    { type: Date, default: null },
}, { _id: true });

const subscriptionSchema = new mongoose.Schema({
  userId:               { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  // No enum — plan keys now come from the admin-managed Package collection
  // (see models/Package.js), which can grow/shrink over time.
  plan:                 { type: String, required: true },
  planName:             { type: String, required: true },
  amount:               { type: Number, required: true },   // kobo
  currency:             { type: String, default: 'NGN' },
  status:               { type: String, enum: ['pending','active','expired','cancelled'], default: 'pending', index: true },
  paystackReference:    { type: String, unique: true, sparse: true },
  paystackTransactionId:{ type: String },
  paystackCustomerCode: { type: String },
  startDate:            { type: Date },
  expiresAt:            { type: Date, index: true },
  isGroup:              { type: Boolean, default: false },
  members:              { type: [GroupMemberSchema], default: [] },
  // Discount applied at checkout, if any — `amount` above is already the
  // discounted price actually charged; these are kept only so the exact
  // discount can be shown/audited later and so the source code can be
  // marked consumed only once, at activation (see convertReferralIfPending's
  // sibling, redeemDiscountIfPending, in routes/payments.js).
  discountCode:         { type: String, default: null },
  discountPercent:      { type: Number, default: 0 },
  // 'admin' — a fresh, never-personally-redeemed admin code typed directly
  // at checkout (consumes DiscountCode.usedCount). 'personal' — anything
  // already sitting in the user's own wallet (spin-wheel win, streak
  // reward, or an admin code they redeemed ahead of time via
  // POST /payments/redeem-code) — consumes that User.discounts entry
  // instead, never DiscountCode.usedCount again.
  discountSource:       { type: String, enum: ['admin', 'personal', null], default: null },
  originalAmount:       { type: Number, default: null }, // pre-discount price, kobo
}, { timestamps: true });

// Helper: is this subscription currently active?
subscriptionSchema.virtual('isActive').get(function () {
  return this.status === 'active' && (!this.expiresAt || this.expiresAt > new Date());
});

module.exports = mongoose.model('Subscription', subscriptionSchema);
