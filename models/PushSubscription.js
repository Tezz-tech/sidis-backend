// models/PushSubscription.js — one document per browser/device push
// endpoint. Keyed by `endpoint` (unique) rather than userId, since a user
// can have several (phone + desktop) and a shared/reused browser endpoint
// should always belong to whoever most recently subscribed from it.
const mongoose = require('mongoose');

const PushSubscriptionSchema = new mongoose.Schema({
  userId:   { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  endpoint: { type: String, required: true, unique: true },
  keys: {
    p256dh: { type: String, required: true },
    auth:   { type: String, required: true },
  },
  createdAt: { type: Date, default: Date.now },
});

module.exports = mongoose.model('PushSubscription', PushSubscriptionSchema);
