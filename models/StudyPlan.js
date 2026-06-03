const mongoose = require('mongoose');

const TopicSchema = new mongoose.Schema({
  name:           { type: String, required: true },
  priority:       { type: String, enum: ['high', 'medium', 'low'], default: 'medium' },
  estimatedHours: { type: Number, default: 1 },
  completed:      { type: Boolean, default: false },
  completedAt:    { type: Date, default: null },
  scheduledDate:  { type: Date, required: true },
  notes:          { type: String, default: '' },
});

const StudyPlanSchema = new mongoose.Schema({
  userId:    { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  examName:  { type: String, required: true },
  subject:   { type: String, required: true },
  examDate:  { type: Date, required: true },
  topics:    [TopicSchema],
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
});

module.exports = mongoose.model('StudyPlan', StudyPlanSchema);
