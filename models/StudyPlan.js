const mongoose = require('mongoose');

const PaperSchema = new mongoose.Schema({
  date:           { type: Date,    required: true },
  subject:        { type: String,  required: true },
  notes:          { type: String,  default: '' },       // extracted PDF text or pasted notes
  fileName:       { type: String,  default: '' },       // original filename if PDF
  hasContent:     { type: Boolean, default: false },
  generated:      { type: Boolean, default: false },
  quizId:         { type: mongoose.Schema.Types.ObjectId, ref: 'Quiz',         default: null },
  flashcardSetId: { type: mongoose.Schema.Types.ObjectId, ref: 'FlashcardSet', default: null },
  quizTitle:      { type: String,  default: '' },
  flashcardTitle: { type: String,  default: '' },
}, { _id: true });

const StudyPlanSchema = new mongoose.Schema({
  userId:    { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  examName:  { type: String, required: true },
  papers:    [PaperSchema],
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
});

module.exports = mongoose.model('StudyPlan', StudyPlanSchema);
