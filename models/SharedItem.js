// models/SharedItem.js — lightweight collaboration: a shareable link for one
// quiz or flashcard set, plus who completed it and how they did. No
// friends/groups system — just link + XP + a pass/fail comparison.
const mongoose = require('mongoose');
const crypto   = require('crypto');

const CompletionSchema = new mongoose.Schema({
  userId:      { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  name:        { type: String, default: '' },
  score:       { type: Number, required: true },
  completedAt: { type: Date, default: Date.now },
}, { _id: false });

const SharedItemSchema = new mongoose.Schema({
  fromUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  itemType:   { type: String, enum: ['quiz', 'flashcard'], required: true },
  itemId:     { type: mongoose.Schema.Types.ObjectId, required: true },
  shareToken: { type: String, required: true, unique: true, default: () => crypto.randomBytes(8).toString('hex') },
  completions: { type: [CompletionSchema], default: [] },
  createdAt:  { type: Date, default: Date.now },
});

SharedItemSchema.index({ fromUserId: 1, itemType: 1, itemId: 1 });

module.exports = mongoose.model('SharedItem', SharedItemSchema);
