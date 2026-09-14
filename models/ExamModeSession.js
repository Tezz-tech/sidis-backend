// models/ExamModeSession.js — standalone "Exam Mode": upload course material,
// AI walks the student through it step by step, then a Q&A phase checks
// understanding conversationally, then a real timed Quiz gets generated and
// graded against the material. The generated Quiz/QuizResult stay
// independent, reusable documents (same pattern as CatchUpSession.quizId) —
// deleting the session here never deletes them.
const mongoose = require('mongoose');

const ExamModeSessionSchema = new mongoose.Schema({
  userId:  { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  title:   { type: String, required: true },
  subject: { type: String, required: true },

  uploadedFiles: [{
    name:       String,
    textLength: Number,
  }],
  combinedText: { type: String, default: '' },

  // Optional past exam papers / examiner's reports uploaded alongside the
  // course material — same "forecaster" idea as the standalone Question
  // Forecaster feature, but folded directly into Exam Mode's own exam
  // generation so the final timed exam is shaped by real past questions
  // without requiring a separate Forecaster session.
  pastQuestionsFiles: [{
    name:       String,
    textLength: Number,
  }],
  pastQuestionsText: { type: String, default: '' },

  walkthroughIntro: { type: String, default: '' },
  walkthrough: [{
    heading:     String,
    explanation: String,
  }],

  // Condensed record of what the Q&A phase covered — written once when the
  // student moves to the exam. The live chat itself stays ephemeral
  // client-side (same convention as the tutor-chat widget), so this is the
  // only trace of it kept server-side, used to ground exam-generation and
  // later retake advice.
  qaSummary: { type: String, default: '' },

  quizId:    { type: mongoose.Schema.Types.ObjectId, ref: 'Quiz', default: null },
  quizTitle: { type: String, default: '' },

  passThreshold: { type: Number, default: 60 },
  phase: { type: String, enum: ['walkthrough', 'qa', 'exam', 'completed'], default: 'walkthrough' },

  attempts: [{
    quizResultId: { type: mongoose.Schema.Types.ObjectId, ref: 'QuizResult' },
    score:        Number,
    passed:       Boolean,
    retakeAdvice: { type: String, default: '' },
    // Per-topic time spent, derived from QuizResult.timePerQuestion — lets
    // the student (and the retake-advice prompt) see not just what they
    // got wrong, but what took suspiciously long even when they got it
    // right, since that's usually a sign of shaky understanding too.
    timeAnalysis: [{
      topic:          String,
      avgTimeSeconds: Number,
      correct:        Boolean,
      slow:           Boolean,
    }],
    createdAt:    { type: Date, default: Date.now },
  }],

  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
});

module.exports = mongoose.model('ExamModeSession', ExamModeSessionSchema);
