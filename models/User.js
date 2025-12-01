const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
  fullName: { type: String, required: true },
  email: { type: String, required: true, unique: true },
  password: { type: String, required: true },
  isAdmin: { type: Boolean, default: false },
  createdAt: { type: Date, default: Date.now },
  quizzesTaken: { type: Number, default: 0 },
  totalScore: { type: Number, default: 0 },
  hoursPracticed: { type: Number, default: 0 },
  rank: { type: Number, default: 0 },
  lastLogin: { type: Date, default: null },
  lastActive: { type: Date, default: Date.now },
  isActive: { type: Boolean, default: true },
});

module.exports = mongoose.model('User', userSchema);
