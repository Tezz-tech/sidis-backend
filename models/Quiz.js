const mongoose = require('mongoose');

const quizSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  title: { type: String, required: true },
  subject: { type: String, required: true },
  difficulty: { type: String, required: true },
  timeLimit: { type: Number, required: true },
  numQuestions: { type: Number, required: true },
  questions: [{
    question: String,
    options: [String],
    correctAnswer: Number,
  }],
  status: { type: String, default: 'not-started' },
  createdAt: { type: Date, default: Date.now },
});

module.exports = mongoose.model('Quiz', quizSchema);
