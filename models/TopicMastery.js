// models/TopicMastery.js — per-user, per-topic mastery ledger.
// This is the core data structure the adaptive learning engine reasons over:
// it tracks a specific sub-topic (e.g. "Depreciation") separately from its
// parent subject (e.g. "Accounting") so repeated mistakes on one concept can
// be detected even when the student is doing fine on the subject overall.
const mongoose = require('mongoose');

const TopicMasterySchema = new mongoose.Schema({
  userId:  { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  subject: { type: String, required: true },
  topic:   { type: String, required: true },

  timesSeen:    { type: Number, default: 0 },
  timesCorrect: { type: Number, default: 0 },
  masteryScore: { type: Number, default: 0, min: 0, max: 100 },

  // Consecutive wrong answers on this topic across attempts (any quiz).
  // Reset to 0 on a correct answer. Drives "repeated pattern" detection —
  // a single wrong answer should never trigger an automatic intervention.
  consecutiveMisses: { type: Number, default: 0 },

  status: { type: String, enum: ['weak', 'moderate', 'strong'], default: 'moderate' },

  lastSeen:        { type: Date, default: Date.now },
  // Last time the adaptive engine auto-generated practice/plan content for
  // this topic — used to avoid re-triggering on every single quiz result.
  lastAutoActionAt: { type: Date, default: null },
  // Simplified, easy-to-digest explanation of the concept (adaptive tutor)
  easyDigest:       { type: String, default: '' },

  // Summary of the most recent automatic intervention, surfaced in the
  // "auto actions taken" feed on the SidIQ page.
  lastPracticeQuizId:    { type: mongoose.Schema.Types.ObjectId, ref: 'Quiz', default: null },
  lastPracticeQuizTitle: { type: String, default: '' },
  lastPlanPatched:       { type: Boolean, default: false },

  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
});

TopicMasterySchema.index({ userId: 1, subject: 1, topic: 1 }, { unique: true });
TopicMasterySchema.index({ userId: 1, status: 1 });

module.exports = mongoose.model('TopicMastery', TopicMasterySchema);
