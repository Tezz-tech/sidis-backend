const mongoose = require('mongoose');

const essayAnswerSchema = new mongoose.Schema({
  questionIndex: Number,
  userText: String,
  aiScore: { type: Number, default: null },
  aiFeedback: { type: String, default: '' },
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
  createdAt: { type: Date, default: Date.now },
});

module.exports = mongoose.model('QuizResult', quizResultSchema);
