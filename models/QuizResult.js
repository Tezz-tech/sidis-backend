const mongoose = require('mongoose');

const essayAnswerSchema = new mongoose.Schema({
  questionIndex: Number,
  userText: String,
  aiScore: { type: Number, default: null },
  aiFeedback: { type: String, default: '' },
}, { _id: false });

const topicOutcomeSchema = new mongoose.Schema({
  questionIndex: Number,
  // The question subdocument's own stable _id (every Quiz question already
  // has one) — lets a missed question be traced precisely even if
  // questionIndex would otherwise be ambiguous, and lets remediation link
  // straight back to the exact question that was failed.
  questionId: { type: mongoose.Schema.Types.ObjectId, default: null },
  subject: String,
  topic: String,
  correct: Boolean,
}, { _id: false });

const quizResultSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  quizId: { type: mongoose.Schema.Types.ObjectId, ref: 'Quiz', required: true },
  score: { type: Number, required: true },
  answers: [Number],
  essayAnswers: [essayAnswerSchema],
  timeSpent: { type: Number, required: true },
  timePerQuestion: { type: [Number], default: [] },
  subjectTag: { type: String, default: 'General' },
  correctCount: { type: Number, default: 0 },
  totalCount: { type: Number, default: 0 },
  // True when the student wagered XP (enabled "Exam Mode") before this attempt.
  examMode: { type: Boolean, default: false },
  // Per-question topic + correctness, used by the adaptive learning engine
  // to detect repeated weak spots at the sub-topic level (not just subject).
  topicBreakdown: { type: [topicOutcomeSchema], default: [] },
  createdAt: { type: Date, default: Date.now },
});

module.exports = mongoose.model('QuizResult', quizResultSchema);
