const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
  fullName: { type: String, required: true },
  email: { type: String, required: true, unique: true },
  password: { type: String, required: true },
  phoneNumber: { type: String, required: true },
  isAdmin: { type: Boolean, default: false },
  createdAt: { type: Date, default: Date.now },
  quizzesTaken: { type: Number, default: 0 },
  totalScore: { type: Number, default: 0 },
  averageScore: { type: Number, default: 0 },
  accuracy: { type: Number, default: 0 },
  hoursPracticed: { type: Number, default: 0 },
  rank: { type: Number, default: 0 },
  currentStreak: { type: Number, default: 0 },
  bestStreak: { type: Number, default: 0 },
  weeklyImprovement: { type: Number, default: 0 },
  lastQuizDate: { type: Date, default: null },
  lastLogin: { type: Date, default: null },
  lastActive: { type: Date, default: Date.now },
  isActive: { type: Boolean, default: true },

  // ── Gamification ──────────────────────────────────────
  xp:    { type: Number, default: 0 },
  level: { type: Number, default: 1 },
  badges: [{ type: String }],
  powerUps: {
    timeFreeze: { type: Number, default: 0 },
    fiftyFifty: { type: Number, default: 0 },
    hint:       { type: Number, default: 0 },
    doubleXP:   { type: Number, default: 0 },
  },
  activeWager: {
    quizId:       { type: mongoose.Schema.Types.ObjectId, ref: 'Quiz', default: null },
    wagerAmount:  { type: Number, default: 0 },
  },
  totalWagersWon: { type: Number, default: 0 },
  doubleXPActive: { type: Boolean, default: false },
  lastDailyBonus: { type: Date, default: null },

  // ── Study Buddy ───────────────────────────────────────
  studyBuddyName: { type: String, default: 'Siddy' },
});

module.exports = mongoose.model('User', userSchema);
