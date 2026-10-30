// models/MausbotSession.js — backs the "SIDIS Seeds Agent" (internal name
// still Mausbot — see routes/mausbot.js): AI-assisted long-form academic
// work, one section at a time, resumable across many visits — the same
// shape as TutorSession's section-by-section progression, just researching
// and writing/solving a section instead of reteaching a note.
//
// taskType decides what a "chapter" actually is and how it gets written:
//   'project'    — final year project/thesis chapter (the original/default behavior)
//   'research'   — a standalone research paper's section
//   'essay'      — a single essay, almost always exactly one "chapter"
//   'assessment' — one assignment/calculation question per "chapter"; the
//                  question text itself IS the chapter title, and the
//                  student never types chapter titles by hand — they're
//                  split out of whatever questions/document the student
//                  provides (see buildSplitProblemsPrompt in routes/mausbot.js)
//
// Unlike AI Tutor (which breaks down material the student already has),
// most of this has nothing to break down upfront — each chapter is
// generated on demand (not all at once) since it requires real research or
// problem-solving, and later chapters may want to stay consistent with what
// was already written. A short quiz gates moving on to the next chapter for
// free-tier students (verifies real engagement with what was generated);
// paid-plan students skip the gate entirely — see routes/mausbot.js, which
// checks the same getPlanFeatures() used everywhere else in the app rather
// than any new payment logic.
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
  // student so they know what to personally double-check/rewrite. Always
  // empty for taskType 'assessment' — that pass is skipped entirely there
  // (see routes/mausbot.js) since rewording a worked calculation risks
  // corrupting it, and "originality" isn't the concern for a solved problem.
  originalityNotes: { type: [{ passage: String, note: String }], default: [] },
  styleRevised:     { type: Boolean, default: false },
  quizId:      { type: mongoose.Schema.Types.ObjectId, ref: 'Quiz', default: null },
  quizPassed:  { type: Boolean, default: false },
}, { _id: false });

const MausbotSessionSchema = new mongoose.Schema({
  userId:     { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  taskType:   { type: String, enum: ['project', 'research', 'essay', 'assessment'], default: 'project' },
  topic:      { type: String, required: true },
  fieldOfStudy: { type: String, required: true },
  wordTarget: { type: Number, default: null }, // essay only
  chapters:   { type: [ChapterSchema], default: [] },
  currentChapterIndex: { type: Number, default: 0 },
  status:     { type: String, enum: ['in_progress', 'completed'], default: 'in_progress' },
  pdfGeneratedAt: { type: Date, default: null },
}, { timestamps: true });

module.exports = mongoose.model('MausbotSession', MausbotSessionSchema);
