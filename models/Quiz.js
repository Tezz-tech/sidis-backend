const mongoose = require('mongoose');

const questionSchema = new mongoose.Schema({
  question: { type: String, required: true },
  // MCQ fields
  options: [String],
  correctAnswer: Number,
  // Essay fields
  modelAnswer: { type: String, default: '' },
  // Shared
  explanation: { type: String, default: '' },
}, { _id: true });

const quizSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  authorName: { type: String, default: null },
  title: { type: String, required: true },
  subject: { type: String, required: true },
  difficulty: { type: String, default: 'medium' },
  timeLimit: { type: Number, default: 30 },
  numQuestions: { type: Number },
  questionType: { type: String, enum: ['mcq', 'essay', 'mixed'], default: 'mcq' },
  questions: [questionSchema],
  isAdminCreated: { type: Boolean, default: false },
  isPublic: { type: Boolean, default: false },
  status: { type: String, default: 'not-started' },
  createdAt: { type: Date, default: Date.now },
});

module.exports = mongoose.model('Quiz', quizSchema);
