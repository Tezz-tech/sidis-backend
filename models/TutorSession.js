// models/TutorSession.js — "AI Tutor": upload a note, AI reteaches it back
// section by section, and after each section the student is offered a quick
// quiz or flashcard check before moving to the next. Deliberately its own
// model (rather than extending CatchUpSession) because the per-section
// progression/quiz-or-flashcard-per-section loop is a different shape from
// Catch-Up's single end-of-material quiz-or-flashcard choice.
const mongoose = require('mongoose');

const SectionSchema = new mongoose.Schema({
  heading:        { type: String, required: true },
  explanation:    { type: String, required: true },
  read:           { type: Boolean, default: false },
  quizId:         { type: mongoose.Schema.Types.ObjectId, ref: 'Quiz', default: null },
  flashcardSetId: { type: mongoose.Schema.Types.ObjectId, ref: 'FlashcardSet', default: null },
}, { _id: false });

const ReadinessSchema = new mongoose.Schema({
  score:          { type: Number, default: null }, // 0-100
  summary:        { type: String, default: '' },
  recommendation: { type: String, default: '' },
}, { _id: false });

const TutorSessionSchema = new mongoose.Schema({
  userId:   { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  title:    { type: String, required: true },
  subject:  { type: String, required: true },
  uploadedFiles: { type: [{ name: String, textLength: Number }], default: [] },
  // Full extracted/transcribed source material — kept so later actions
  // (adding sections, per-section quiz/flashcard generation) stay grounded
  // in the original text instead of re-deriving from just the headings.
  combinedText: { type: String, default: '' },
  overview:     { type: String, default: '' },
  sections:     { type: [SectionSchema], default: [] },
  currentSectionIndex: { type: Number, default: 0 },
  status:    { type: String, enum: ['in_progress', 'completed'], default: 'in_progress' },
  readiness: { type: ReadinessSchema, default: () => ({}) },
}, { timestamps: true });

module.exports = mongoose.model('TutorSession', TutorSessionSchema);
