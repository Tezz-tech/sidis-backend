// models/MausbotSession.js — "Mausbot": AI-assisted university project (final
// year project/thesis) writing, chapter by chapter, resumable across many
// visits — the same shape as TutorSession's section-by-section progression,
// just researching and writing a chapter instead of reteaching a note.
//
// Unlike AI Tutor (which breaks down material the student already has),
// Mausbot has nothing to break down — each chapter is generated on demand
// (not all upfront) since it requires real research, and later chapters may
// want to stay consistent with what was already written. A short quiz gates
// moving on to the next chapter for free-tier students (verifies real
// engagement with what was generated); paid-plan students skip the gate
// entirely — see routes/mausbot.js, which checks the same getPlanFeatures()
// used everywhere else in the app rather than any new payment logic.
const mongoose = require('mongoose');

const ChapterSchema = new mongoose.Schema({
  number:      { type: Number, required: true },
  title:       { type: String, required: true },
  content:     { type: String, default: '' },        // '' until generated
  status:      { type: String, enum: ['pending', 'ready'], default: 'pending' },
  grounded:    { type: Boolean, default: false },      // true only if real search sources were found
  sources:     { type: [{ title: String, url: String }], default: [] },
  // Originality pass — similarity flags + whether the natural-writing-style
  // revision has been applied. Never blocks anything, just surfaced to the
  // student so they know what to personally double-check/rewrite.
  originalityNotes: { type: [{ passage: String, note: String }], default: [] },
  styleRevised:     { type: Boolean, default: false },
  quizId:      { type: mongoose.Schema.Types.ObjectId, ref: 'Quiz', default: null },
  quizPassed:  { type: Boolean, default: false },
}, { _id: false });

const MausbotSessionSchema = new mongoose.Schema({
  userId:     { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  topic:      { type: String, required: true },
  fieldOfStudy: { type: String, required: true },
  chapters:   { type: [ChapterSchema], default: [] },
  currentChapterIndex: { type: Number, default: 0 },
  status:     { type: String, enum: ['in_progress', 'completed'], default: 'in_progress' },
  pdfGeneratedAt: { type: Date, default: null },
}, { timestamps: true });

module.exports = mongoose.model('MausbotSession', MausbotSessionSchema);
