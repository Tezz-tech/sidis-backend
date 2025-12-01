const mongoose = require('mongoose');

const FlashcardProgressSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  setId:  { type: mongoose.Schema.Types.ObjectId, ref: 'FlashcardSet', required: true },
  cardId: { type: mongoose.Schema.Types.ObjectId, required: true },
  masteryLevel: { type: Number, default: 0, min: 0, max: 100 },
  lastStudied: { type: Date, default: Date.now },
});

FlashcardProgressSchema.index({ userId: 1, setId: 1, cardId: 1 }, { unique: true });

module.exports = mongoose.model('FlashcardProgress', FlashcardProgressSchema);
