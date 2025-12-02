// models/FlashcardSet.js
const mongoose = require('mongoose');

const CardSchema = new mongoose.Schema({
  question: { type: String, required: true },
  answer:   { type: String, required: true },
  masteryLevel: { type: Number, default: 0, min: 0, max: 100 },
});

const FlashcardSetSchema = new mongoose.Schema({
  userId:       { type: mongoose.Schema.Types.ObjectId, ref: 'User' }, // optional for public submissions
  authorName:   { type: String, default: null },
  title:        { type: String, required: true },
  subject:      { type: String, required: true },
  cards:        [CardSchema],
  masteryLevel: { type: Number, default: 0 },
  lastStudied:  { type: Date },
  createdAt:    { type: Date, default: Date.now },
  isAdminCreated: { type: Boolean, default: false },
  isPublic: { type: Boolean, default: false },
});

module.exports = mongoose.model('FlashcardSet', FlashcardSetSchema);