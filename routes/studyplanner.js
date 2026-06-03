// routes/studyplanner.js
const express  = require('express');
const router   = express.Router();
const auth     = require('../middlewares/auth');
const StudyPlan     = require('../models/StudyPlan');
const Quiz          = require('../models/Quiz');
const FlashcardSet  = require('../models/FlashcardSet');

const { GoogleGenerativeAI } = require('@google/generative-ai');
require('dotenv').config();

const GEMINI_KEYS = process.env.GEMINI_API_KEYS
  ? process.env.GEMINI_API_KEYS.split(',').map(k => k.trim()).filter(Boolean)
  : [];

let aiModel = null;
if (GEMINI_KEYS.length > 0) {
  try {
    const genAI = new GoogleGenerativeAI(GEMINI_KEYS[0]);
    aiModel = genAI.getGenerativeModel({
      model: 'gemini-2.5-flash',
      generationConfig: { temperature: 0.7, maxOutputTokens: 4096, responseMimeType: 'application/json' },
    });
  } catch (_) {}
}

// ─── POST /api/study-planner/create-exam ──────────────────────────────────────
// Body: { examName: string, papers: [{ date: ISO, subject: string }] }
router.post('/create-exam', auth, async (req, res) => {
  try {
    const { examName, papers } = req.body;
    if (!examName?.trim())
      return res.status(400).json({ error: 'examName is required' });
    if (!Array.isArray(papers) || papers.length === 0)
      return res.status(400).json({ error: 'At least one paper is required' });

    const validPapers = papers
      .filter(p => p.subject?.trim() && p.date)
      .map(p => ({
        date:       new Date(p.date),
        subject:    p.subject.trim(),
        notes:      '',
        hasContent: false,
        generated:  false,
      }));

    if (validPapers.length === 0)
      return res.status(400).json({ error: 'Each paper must have a subject and date' });

    const plan = await StudyPlan.create({
      userId:   req.user.userId,
      examName: examName.trim(),
      papers:   validPapers,
    });

    res.json({ success: true, plan });
  } catch (err) {
    console.error('Create exam plan error:', err);
    res.status(500).json({ error: 'Failed to create exam plan' });
  }
});

// ─── POST /api/study-planner/plan/:planId/paper/:paperId/material ─────────────
// Accepts either: multipart with file "pdf", OR JSON body { notes: "..." }
router.post('/plan/:planId/paper/:paperId/material', auth, async (req, res) => {
  try {
    const plan = await StudyPlan.findOne({ _id: req.params.planId, userId: req.user.userId });
    if (!plan) return res.status(404).json({ error: 'Plan not found' });

    const paper = plan.papers.id(req.params.paperId);
    if (!paper) return res.status(404).json({ error: 'Paper not found' });

    let extractedText = '';
    let fileName      = '';

    // ── PDF upload ──────────────────────────────────────────────────────────
    if (req.files?.pdf) {
      try {
        const pdfParse = require('pdf-parse');
        const buffer   = req.files.pdf.data;
        const parsed   = await pdfParse(buffer);
        extractedText  = (parsed.text || '').trim();
        fileName       = req.files.pdf.name || 'document.pdf';

        if (!extractedText) {
          return res.status(422).json({ error: 'Could not extract text from PDF. Try pasting notes instead.' });
        }
      } catch (pdfErr) {
        console.error('PDF parse error:', pdfErr.message);
        return res.status(422).json({ error: 'PDF parsing failed. Try pasting notes as text.' });
      }
    }

    // ── Pasted notes ────────────────────────────────────────────────────────
    else if (req.body?.notes?.trim()) {
      extractedText = req.body.notes.trim();
      fileName      = '';
    } else {
      return res.status(400).json({ error: 'Send a PDF file or paste notes text' });
    }

    paper.notes      = extractedText.slice(0, 50000); // cap at 50k chars
    paper.fileName   = fileName;
    paper.hasContent = true;
    plan.updatedAt   = new Date();
    await plan.save();

    res.json({
      success:   true,
      paperId:   paper._id,
      fileName:  paper.fileName,
      textLength: paper.notes.length,
    });
  } catch (err) {
    console.error('Upload material error:', err);
    res.status(500).json({ error: 'Failed to save material' });
  }
});

// ─── POST /api/study-planner/plan/:planId/paper/:paperId/generate ─────────────
// AI generates quiz + flashcards from paper.notes
router.post('/plan/:planId/paper/:paperId/generate', auth, async (req, res) => {
  try {
    if (!aiModel)
      return res.status(503).json({ error: 'AI generation is unavailable. Check your API key configuration.' });

    const plan = await StudyPlan.findOne({ _id: req.params.planId, userId: req.user.userId });
    if (!plan) return res.status(404).json({ error: 'Plan not found' });

    const paper = plan.papers.id(req.params.paperId);
    if (!paper) return res.status(404).json({ error: 'Paper not found' });

    if (!paper.hasContent || !paper.notes?.trim())
      return res.status(400).json({ error: 'Upload material for this paper first' });

    // Truncate notes for Gemini (keep it fast and within limits)
    const material   = paper.notes.slice(0, 7000);
    const subject    = paper.subject;
    const examDate   = new Date(paper.date).toDateString();

    // ── Generate quiz questions ─────────────────────────────────────────────
    const quizPrompt = `You are an expert exam question creator for ${subject}.
Based on the study material below, generate 12 high-quality exam questions:
- 8 MCQ questions (exactly 4 options each, one correct)
- 4 short-answer/essay questions

Rules:
- Questions must be directly based on the material (not generic)
- MCQ options must be plausible (avoid obviously wrong distractors)
- Essay model answers should be 2–4 sentences
- Match difficulty to an actual exam paper

Return ONLY valid JSON (no markdown, no code blocks):
{
  "questions": [
    {
      "type": "mcq",
      "question": "...",
      "options": ["A", "B", "C", "D"],
      "correctAnswer": 0,
      "explanation": "..."
    },
    {
      "type": "essay",
      "question": "...",
      "modelAnswer": "..."
    }
  ]
}

Study Material for ${subject} (Exam: ${examDate}):
${material}`;

    // ── Generate flashcards ─────────────────────────────────────────────────
    const flashPrompt = `You are creating revision flashcards for a ${subject} exam.
Based on the study material below, generate 18 concise flashcard pairs covering:
- Key definitions and terms
- Important formulas or dates
- Core concepts and theories
- Common exam topics

Each card: front = question/prompt, back = concise answer (1–3 sentences max).

Return ONLY valid JSON:
{
  "cards": [
    { "question": "Define [term]...", "answer": "..." }
  ]
}

Study Material:
${material}`;

    let generatedQuestions = [];
    let generatedCards     = [];

    try {
      const [quizRaw, flashRaw] = await Promise.all([
        aiModel.generateContent(quizPrompt),
        aiModel.generateContent(flashPrompt),
      ]);

      const quizText  = quizRaw.response.text().trim().replace(/^```json\s*|```$/gi, '').trim();
      const flashText = flashRaw.response.text().trim().replace(/^```json\s*|```$/gi, '').trim();

      const quizParsed  = JSON.parse(quizText);
      const flashParsed = JSON.parse(flashText);

      if (Array.isArray(quizParsed.questions))  generatedQuestions = quizParsed.questions;
      if (Array.isArray(flashParsed.cards))      generatedCards     = flashParsed.cards;
    } catch (aiErr) {
      console.error('AI generation error:', aiErr.message);
      return res.status(500).json({ error: 'AI failed to generate content. Please try again.' });
    }

    if (generatedQuestions.length === 0)
      return res.status(500).json({ error: 'AI returned no questions. Please try again.' });

    // ── Build quiz document ─────────────────────────────────────────────────
    const quizTitle = `${subject} — ${plan.examName} Exam Practice`;

    const mcqQuestions   = generatedQuestions.filter(q => q.type === 'mcq');
    const essayQuestions = generatedQuestions.filter(q => q.type === 'essay');
    const questionType   = mcqQuestions.length > 0 && essayQuestions.length > 0
      ? 'mixed' : mcqQuestions.length > 0 ? 'mcq' : 'essay';

    const quizQuestions = generatedQuestions.map(q => {
      if (q.type === 'mcq') {
        return {
          question:      q.question,
          options:       Array.isArray(q.options) ? q.options.slice(0, 4) : [],
          correctAnswer: typeof q.correctAnswer === 'number' ? q.correctAnswer : 0,
          modelAnswer:   '',
          explanation:   q.explanation || '',
        };
      }
      return {
        question:      q.question,
        options:       [],
        correctAnswer: null,
        modelAnswer:   q.modelAnswer || '',
        explanation:   '',
      };
    });

    const quiz = await Quiz.create({
      userId:       req.user.userId,
      title:        quizTitle,
      subject:      subject,
      difficulty:   'hard',
      timeLimit:    Math.max(20, Math.ceil(quizQuestions.length * 2.5)),
      numQuestions: quizQuestions.length,
      questionType,
      questions:    quizQuestions,
      isPublic:     false,
      isAdminCreated: false,
    });

    // ── Build flashcard set ─────────────────────────────────────────────────
    const flashTitle = `${subject} — ${plan.examName} Flashcards`;

    const cards = generatedCards
      .filter(c => c.question?.trim() && c.answer?.trim())
      .map(c => ({ question: c.question.trim(), answer: c.answer.trim(), masteryLevel: 0 }));

    let flashcardSetId   = null;
    let flashcardTitle   = flashTitle;

    if (cards.length > 0) {
      const set = await FlashcardSet.create({
        userId:        req.user.userId,
        title:         flashTitle,
        subject:       subject,
        cards,
        isPublic:      false,
        isAdminCreated: false,
      });
      flashcardSetId = set._id;
      flashcardTitle = set.title;
    }

    // ── Update paper record ─────────────────────────────────────────────────
    paper.generated      = true;
    paper.quizId         = quiz._id;
    paper.quizTitle      = quiz.title;
    paper.flashcardSetId = flashcardSetId;
    paper.flashcardTitle = flashcardTitle;
    plan.updatedAt       = new Date();
    await plan.save();

    res.json({
      success:         true,
      quizId:          quiz._id,
      quizTitle:       quiz.title,
      numQuestions:    quiz.numQuestions,
      flashcardSetId,
      flashcardTitle,
      numCards:        cards.length,
    });
  } catch (err) {
    console.error('Generate content error:', err);
    res.status(500).json({ error: 'Generation failed. Please try again.' });
  }
});

// ─── GET /api/study-planner/plans ─────────────────────────────────────────────
router.get('/plans', auth, async (req, res) => {
  try {
    const plans = await StudyPlan.find({ userId: req.user.userId })
      .sort({ createdAt: -1 }).lean();

    const enriched = plans.map(p => ({
      ...p,
      totalPapers:     p.papers.length,
      generatedPapers: p.papers.filter(x => x.generated).length,
      nextExamDate:    p.papers.sort((a, b) => new Date(a.date) - new Date(b.date))[0]?.date || null,
    }));

    res.json({ success: true, plans: enriched });
  } catch (err) {
    console.error('Get plans error:', err);
    res.status(500).json({ error: 'Failed to fetch plans' });
  }
});

// ─── GET /api/study-planner/plan/:id ──────────────────────────────────────────
router.get('/plan/:id', auth, async (req, res) => {
  try {
    const plan = await StudyPlan.findOne({ _id: req.params.id, userId: req.user.userId }).lean();
    if (!plan) return res.status(404).json({ error: 'Plan not found' });

    const enriched = {
      ...plan,
      papers: plan.papers
        .map(p => ({
          ...p,
          daysUntilExam: Math.max(0, Math.ceil((new Date(p.date) - new Date()) / (1000 * 60 * 60 * 24))),
        }))
        .sort((a, b) => new Date(a.date) - new Date(b.date)),
    };

    res.json({ success: true, plan: enriched });
  } catch (err) {
    console.error('Get plan error:', err);
    res.status(500).json({ error: 'Failed to fetch plan' });
  }
});

// ─── DELETE /api/study-planner/plan/:id ───────────────────────────────────────
router.delete('/plan/:id', auth, async (req, res) => {
  try {
    await StudyPlan.deleteOne({ _id: req.params.id, userId: req.user.userId });
    res.json({ success: true });
  } catch (err) {
    console.error('Delete plan error:', err);
    res.status(500).json({ error: 'Failed to delete plan' });
  }
});

module.exports = router;
