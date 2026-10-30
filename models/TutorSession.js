// models/TutorSession.js — "AI Tutor": upload a note, AI reteaches it back
// section by section, and after each section the student is offered a quick
// quiz or flashcard check before moving to the next. Deliberately its own
// model (rather than extending CatchUpSession) because the per-section
// progression/quiz-or-flashcard-per-section loop is a different shape from
// Catch-Up's single end-of-material quiz-or-flashcard choice.
//
// Each section's flow follows the learn -> understand -> recall -> practice
// -> review cycle: `read` is Learn, the section chat (routes/tutor.js) is
// Understand, `recallDone`/`lastRecallAttempt` is Recall (closed-book free
// retrieval, checked against the explanation), quizId/flashcardSetId is
// Practice, and reviewStage/reviewDueAt is Review — a light, fixed-interval
// spaced-repetition schedule (due tomorrow, then in 3 days, then in 7) that
// starts once a section is first marked read.
const mongoose = require('mongoose');

const SectionSchema = new mongoose.Schema({
  heading:        { type: String, required: true },
  explanation:    { type: String, required: true },
  read:           { type: Boolean, default: false },
  quizId:         { type: mongoose.Schema.Types.ObjectId, ref: 'Quiz', default: null },
  flashcardSetId: { type: mongoose.Schema.Types.ObjectId, ref: 'FlashcardSet', default: null },
  // Recall — a closed-book "write what you remember" check, distinct from
  // the open-book Understand chat. Never required to advance, just tracked
  // so the stage tracker can show it's been done.
  recallDone:        { type: Boolean, default: false },
  lastRecallAttempt: { type: String, default: '' },
  // Review — reviewStage 0 = never reviewed, 1/2/3 = completed that many
  // spaced review passes (capped at 3, matching "later that day / next day
  // / a few days later / the following week"). reviewDueAt is null once
  // there's nothing currently due.
  reviewStage: { type: Number, default: 0, min: 0, max: 3 },
  reviewDueAt: { type: Date, default: null },
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
