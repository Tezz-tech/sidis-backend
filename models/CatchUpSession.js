// models/CatchUpSession.js — "Study Catch-Up": a student uploads material
// from a class they missed, AI teaches it back to them (summary), then a
// real Quiz and FlashcardSet get generated from the same material so they
// can check their understanding. Those are independent, reusable documents
// (same pattern as ExamForecast.mockExamQuizId) — deleting the session here
// never deletes them.
const mongoose = require('mongoose');

const CatchUpSessionSchema = new mongoose.Schema({
  userId:  { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  title:   { type: String, required: true },
  subject: { type: String, required: true },

  uploadedFiles: [{
    name:       String,
    textLength: Number,
  }],
  combinedText: { type: String, default: '' },

  summary: {
    overview:    { type: String, default: '' },
    keyConcepts: [{
      heading:     String,
      explanation: String,
    }],
    recap:       { type: String, default: '' },
  },

  quizId:    { type: mongoose.Schema.Types.ObjectId, ref: 'Quiz', default: null },
  quizTitle: { type: String, default: '' },

  flashcardSetId:    { type: mongoose.Schema.Types.ObjectId, ref: 'FlashcardSet', default: null },
  flashcardSetTitle: { type: String, default: '' },

  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
});

module.exports = mongoose.model('CatchUpSession', CatchUpSessionSchema);
