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
}, { timestamps: true });

// Helper: is this subscription currently active?
subscriptionSchema.virtual('isActive').get(function () {
  return this.status === 'active' && (!this.expiresAt || this.expiresAt > new Date());
});

module.exports = mongoose.model('Subscription', subscriptionSchema);
