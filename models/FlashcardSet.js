// models/FlashcardSet.js
const mongoose = require('mongoose');

const CardSchema = new mongoose.Schema({
  question: { type: String, required: true },
  answer:   { type: String, required: true },
  masteryLevel: { type: Number, default: 0, min: 0, max: 100 },
  // Specific sub-topic this card tests, e.g. "Depreciation" (parent subject: "Accounting").
  topic: { type: String, default: '' },
});

const FlashcardSetSchema = new mongoose.Schema({
  userId:       { type: mongoose.Schema.Types.ObjectId, ref: 'User' }, // optional for public submissions
  authorName:   { type: String, default: null },
  title:        { type: String, required: true },
  subject:      { type: String, required: true },
  cards:        [CardSchema],
  // Source material this set was generated from, capped — lets "Add More
  // Cards" generate genuinely new, non-duplicate cards grounded in the
  // same content later, instead of guessing from the subject name alone.
  // Empty for manually-created sets or vision-mode uploads (no text
  // transcript was ever produced) — those fall back to a subject/topic-only
  // generation when more cards are requested.
  sourceText:   { type: String, default: '' },
  masteryLevel: { type: Number, default: 0 },
  lastStudied:  { type: Date },
  createdAt:    { type: Date, default: Date.now },
  isAdminCreated: { type: Boolean, default: false },
  isPublic: { type: Boolean, default: false },
});

module.exports = mongoose.model('FlashcardSet', FlashcardSetSchema);