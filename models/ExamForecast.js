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
  // Use Mixed so AI-returned values never cause strict-type validation failures
  patterns:         { type: mongoose.Schema.Types.Mixed, default: [] },
  mockExamQuizId:   { type: mongoose.Schema.Types.ObjectId, ref: 'Quiz', default: null },
  mockExamTitle:    { type: String, default: '' },
  attempts:         { type: Number, default: 0 },
  lastScore:        { type: Number, default: null },
  forecastedTopics: { type: mongoose.Schema.Types.Mixed, default: [] },
  preparationAdvice: [String],
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
}, { strict: false }); // strict:false lets any extra AI fields through safely

module.exports = mongoose.model('ExamForecast', ExamForecastSchema);
