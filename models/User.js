const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
  fullName: { type: String, required: true },
  email: { type: String, required: true, unique: true },
  password: { type: String, required: true },
  createdAt: { type: Date, default: Date.now },
  quizzesTaken: { type: Number, default: 0 },
  totalScore: { type: Number, default: 0 },
  hoursPracticed: { type: Number, default: 0 },
  rank: { type: Number, default: 0 },
});

module.exports = mongoose.model('User', userSchema);
