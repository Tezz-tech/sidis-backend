const mongoose = require('mongoose');

const ExamForecastSchema = new mongoose.Schema({
  userId:       { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  examSubject:  { type: String, required: true },
  uploadedFiles: [{
    name:       String,
    textLength: Number,
  }],
  combinedText:     { type: String, default: '' },
  analysisComplete: { type: Boolean, default: false },
  analysisSummary:  { type: String, default: '' },
  patterns: [{
    topic:        String,
    frequency:    Number,
    confidence:   String,
    lastAppeared: String,
  }],
  mockExamQuizId: { type: mongoose.Schema.Types.ObjectId, ref: 'Quiz', default: null },
  mockExamTitle:  { type: String, default: '' },
  attempts:       { type: Number, default: 0 },
  lastScore:      { type: Number, default: null },
  forecastedTopics: [{
    topic:      String,
    likelihood: Number,
    reason:     String,
    confidence: String,
  }],
  preparationAdvice: [String],
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
});

module.exports = mongoose.model('ExamForecast', ExamForecastSchema);
