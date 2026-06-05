const mongoose = require('mongoose');

const SessionSchema = new mongoose.Schema({
  date:            { type: Date,    required: true },
  subject:         { type: String,  required: true },
  durationMinutes: { type: Number,  default: 60 },
  sessionType:     { type: String,  enum: ['quiz', 'review', 'practice'], default: 'quiz' },
  priority:        { type: String,  enum: ['high', 'medium', 'low'],      default: 'medium' },
  notes:           { type: String,  default: '' },
  quizId:          { type: mongoose.Schema.Types.ObjectId, ref: 'Quiz', default: null },
  quizTitle:       { type: String,  default: '' },
  completed:       { type: Boolean, default: false },
  completedAt:     { type: Date,    default: null },
  score:           { type: Number,  default: null },
}, { _id: true });

const SubjectMaterialSchema = new mongoose.Schema({
  subject:    { type: String, required: true },
  notes:      { type: String, default: '' },
  fileName:   { type: String, default: '' },
  hasContent: { type: Boolean, default: false },
}, { _id: false });

const StudyPlanSchema = new mongoose.Schema({
  userId:           { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  examName:         { type: String, required: true },
  examDate:         { type: Date,   required: true },
  subjects:         [{ type: String }],
  dailyStudyHours:  { type: Number, default: 2 },
  schedule:         [SessionSchema],
  subjectMaterials: [SubjectMaterialSchema],
  generated:        { type: Boolean, default: false },
  createdAt:        { type: Date, default: Date.now },
  updatedAt:        { type: Date, default: Date.now },
});

module.exports = mongoose.model('StudyPlan', StudyPlanSchema);
