const mongoose = require('mongoose');

const activityLogSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  action: { type: String, required: true }, // e.g., "quiz_started", "flashcard_created", "quiz_completed"
  entityType: { type: String }, // "quiz", "flashcard", "user"
  entityId: { type: mongoose.Schema.Types.ObjectId },
  details: { type: mongoose.Schema.Types.Mixed }, // Additional context
  timestamp: { type: Date, default: Date.now },
  ipAddress: { type: String },
});

module.exports = mongoose.model('ActivityLog', activityLogSchema);
