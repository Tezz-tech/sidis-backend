const mongoose = require('mongoose');

const quizSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  title: { type: String, required: true },
  subject: { type: String, required: true },
  difficulty: { type: String, default: 'medium' },
  timeLimit: { type: Number, default: 30 },
  numQuestions: { type: Number },
  questions: [{
    question: String,
    options: [String],
    correctAnswer: Number,
  }],
  isAdminCreated: { type: Boolean, default: false },
  status: { type: String, default: 'not-started' },
  createdAt: { type: Date, default: Date.now },
});

module.exports = mongoose.model('Quiz', quizSchema);
