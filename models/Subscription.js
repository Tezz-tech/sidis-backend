const mongoose = require('mongoose');

const subscriptionSchema = new mongoose.Schema({
  userId:               { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  plan:                 { type: String, required: true,
                          enum: ['exam_mode','weekly_individual','weekly_group',
                                 'monthly_individual','monthly_group',
                                 'yearly_individual','yearly_group'] },
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
}, { timestamps: true });

// Helper: is this subscription currently active?
subscriptionSchema.virtual('isActive').get(function () {
  return this.status === 'active' && (!this.expiresAt || this.expiresAt > new Date());
});

module.exports = mongoose.model('Subscription', subscriptionSchema);
