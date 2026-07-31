// routes/quizzes.js
const express = require("express");
const router = express.Router();
const auth = require("../middlewares/auth");
const Quiz = require("../models/Quiz");
const QuizResult = require("../models/QuizResult");
const PDFParser = require("pdf2json");
const mammoth = require("mammoth");
require("dotenv").config();

// Safe import — gamificationUtils only exists when running the full local/deployed backend
let awardXP = null;
try { ({ awardXP } = require("../utils/gamificationUtils")); } catch (_) {}

const { gemini, capText } = require("../utils/ai");
const { resolveSpecificSubject } = require("../utils/subjectResolver");
const { processQuizResult } = require("../utils/adaptiveEngine");

// AI is now handled by the shared utils/ai.js singleton (gemini)

// ==================== HELPER: extract text from PDF buffer ====================
async function extractPdfText(buffer) {
  const pdfParser = new PDFParser();
  const data = await new Promise((resolve, reject) => {
    pdfParser.on("pdfParser_dataError", reject);
    pdfParser.on("pdfParser_dataReady", resolve);
    pdfParser.parseBuffer(buffer);
  });
  let text = "";
  for (const page of data.Pages) {
    for (const t of page.Texts) {
      try { text += decodeURIComponent(t.R[0].T) + " "; } catch { text += " "; }
    }
  }
  return text;
}

// ==================== MANUAL QUIZ CREATION (ADMIN) ====================
router.post("/admin/create-manual", auth, async (req, res) => {
  try {
    const { title, subject, difficulty, timeLimit, questions, questionType = "mcq" } = req.body;

    if (!title || !subject || !Array.isArray(questions) || questions.length === 0) {
      return res.status(400).json({ error: "Missing required fields: title, subject, questions" });
    }

    const validQuestions = questions.filter(q => {
      if (!q.question || !q.question.trim()) return false;
      if (questionType === "essay") return !!q.modelAnswer;
      return Array.isArray(q.options) && q.options.length === 4 &&
        q.options.every(o => o && o.trim()) &&
        typeof q.correctAnswer === "number" && q.correctAnswer >= 0 && q.correctAnswer <= 3;
    });

    if (validQuestions.length === 0) {
      return res.status(400).json({ error: "No valid questions found." });
    }

    const quiz = new Quiz({
      userId: req.user.userId,
      title: title.trim(),
      subject: subject.trim(),
      difficulty: difficulty || "medium",
      timeLimit: parseInt(timeLimit) || 30,
      numQuestions: validQuestions.length,
      questionType,
      questions: validQuestions.map(q => ({
        question: q.question.trim(),
        options: q.options?.map(o => o.trim()) || [],
        correctAnswer: q.correctAnswer ?? null,
        modelAnswer: q.modelAnswer?.trim() || "",
        explanation: q.explanation?.trim() || "",
        topic: q.topic?.trim() || "",
      })),
      isAdminCreated: true,
      isPublic: true,
    });

    await quiz.save();

    res.status(201).json({
      success: true,
      id: quiz._id,
      message: `Quiz created with ${validQuestions.length} questions!`,
    });
  } catch (err) {
    console.error("Manual quiz creation error:", err);
    res.status(500).json({ error: "Failed to create quiz: " + err.message });
  }
});

// ==================== AI QUIZ GENERATION (multi-source) ====================
router.post("/generate-quiz", auth, async (req, res) => {
  if (!gemini.ready) return res.status(503).json({ error: "AI service unavailable — check GEMINI_API_KEYS" });

  // ── Subscription gate: enforce 5 AI quizzes/month for free + exam_mode users ──
  try {
    const { getUserPlan, getPlanFeatures } = require('../utils/subscription');
    const plan     = await getUserPlan(req.user.userId);
    const features = getPlanFeatures(plan);

    if (!features.unlimitedQuizzes) {
      const monthStart = new Date();
      monthStart.setDate(1);
      monthStart.setHours(0, 0, 0, 0);
      const count = await Quiz.countDocuments({
        userId: req.user.userId, isAdminCreated: false, createdAt: { $gte: monthStart },
      });
      if (count >= features.aiQuizzesPerMonth) {
        return res.status(403).json({
          error:     'monthly_limit_reached',
          message:   `You've used all ${features.aiQuizzesPerMonth} AI quiz generations for this month. Upgrade your plan for unlimited quizzes.`,
          limit:     features.aiQuizzesPerMonth,
          used:      count,
          planName:  plan === 'free' ? 'Free' : 'Exam Mode',
        });
      }
    }
  } catch (_) { /* if subscription check fails, allow through */ }

  try {
    const {
      title, subject, numQuestions = 10, difficulty = "medium",
      timeLimit = 30, content, source = "text", topic, url,
      questionType = "mcq", bankSubject
    } = req.body;

    let extractedText = "";

    // ---- Source: topic only (AI knowledge) ----
    if (source === "topic") {
      if (!topic || topic.trim().length < 3) {
        return res.status(400).json({ error: "Please provide a topic" });
      }
      extractedText = `Topic: ${topic.trim()}`;
    }
    // ---- Source: question bank draw ----
    else if (source === "question-bank") {
      const search = bankSubject || subject || "";
      const bankQuizzes = await Quiz.find({
        subject: { $regex: search, $options: "i" },
      }).limit(20).lean();

      const bankQuestions = [];
      for (const q of bankQuizzes) {
        for (const qs of q.questions) {
          bankQuestions.push(qs);
          if (bankQuestions.length >= parseInt(numQuestions)) break;
        }
        if (bankQuestions.length >= parseInt(numQuestions)) break;
      }

      if (bankQuestions.length === 0) {
        return res.status(404).json({ error: "No questions found in bank for this subject" });
      }

      const quiz = new Quiz({
        userId: req.user.userId,
        title: title?.trim() || `${search} — Bank Quiz`,
        subject: subject?.trim() || search,
        difficulty,
        timeLimit: parseInt(timeLimit),
        numQuestions: bankQuestions.length,
        questionType: "mcq",
        questions: bankQuestions.map(q => ({
          question: q.question,
          options: q.options,
          correctAnswer: q.correctAnswer,
          explanation: q.explanation || "",
          modelAnswer: "",
        })),
      });
      await quiz.save();
      return res.json({ success: true, id: quiz._id, message: "Quiz drawn from question bank!" });
    }
    // ---- Source: multi-pdf ----
    else if (source === "multi-pdf") {
      const files = req.files;
      if (!files || Object.keys(files).length === 0) {
        return res.status(400).json({ error: "No files uploaded" });
      }

      const fileList = Array.isArray(files.files) ? files.files : Object.values(files).flat();
      if (fileList.length === 0) return res.status(400).json({ error: "No PDF files found" });

      for (const file of fileList) {
        if (file.mimetype === "application/pdf") {
          extractedText += await extractPdfText(file.data) + "\n\n";
        } else if (file.mimetype.includes("word")) {
          const r = await mammoth.extractRawText({ buffer: file.data });
          extractedText += r.value + "\n\n";
        }
      }
      if (!extractedText.trim()) return res.status(400).json({ error: "No readable text in uploaded files" });
    }
    // ---- Source: URL ----
    else if (source === "url") {
      const targetUrl = (req.body.url || "").trim();
      if (!targetUrl.match(/^https?:\/\/.+/)) {
        return res.status(400).json({ error: "Please provide a valid URL starting with http:// or https://" });
      }
      try {
        const axios = require("axios");
        const response = await axios.get(targetUrl, {
          timeout: 15000,
          headers: { "User-Agent": "Mozilla/5.0 (compatible; Sidis/1.0; +https://sidis.app)" },
          maxContentLength: 5 * 1024 * 1024,
          responseType: "text",
        });
        let html = response.data || "";
        // Strip scripts, styles, and their contents first
        html = html.replace(/<script[\s\S]*?<\/script>/gi, " ");
        html = html.replace(/<style[\s\S]*?<\/style>/gi, " ");
        // Strip all remaining HTML tags
        html = html.replace(/<[^>]+>/g, " ");
        // Decode common HTML entities
        html = html
          .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&")
          .replace(/&lt;/g, "<").replace(/&gt;/g, ">")
          .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
          .replace(/&[a-z]+;/gi, " ");
        extractedText = html.replace(/\s+/g, " ").trim();
        if (extractedText.length < 200) {
          return res.status(400).json({ error: "Not enough readable text found at this URL. Try a different page or paste the text directly." });
        }
      } catch (urlErr) {
        const msg = urlErr.code === "ECONNREFUSED" ? "Could not connect to the URL — check it is publicly accessible"
                  : urlErr.code === "ETIMEDOUT"    ? "URL request timed out — try again or use a faster page"
                  : urlErr.response               ? `URL returned status ${urlErr.response.status} — the page may be blocked`
                  : "Failed to fetch URL: " + (urlErr.message || "Unknown error");
        return res.status(400).json({ error: msg });
      }
    }
    // ---- Source: single pdf/text (legacy) ----
    else {
      if (content && typeof content === "string" && content.trim().length > 50) {
        extractedText = content.trim();
      } else if (req.files?.file) {
        const file = req.files.file;
        if (file.mimetype === "application/pdf") {
          extractedText = await extractPdfText(file.data);
        } else if (file.mimetype.includes("word")) {
          const r = await mammoth.extractRawText({ buffer: file.data });
          extractedText = r.value;
        } else {
          return res.status(400).json({ error: "Only PDF and DOCX files are allowed" });
        }
      } else {
        return res.status(400).json({ error: "Please provide a file, text content, or choose a topic/bank source" });
      }
    }

    if (!extractedText.trim()) {
      return res.status(400).json({ error: "No readable text found." });
    }

    const safeContent = extractedText.slice(0, 60_000);
    const isTopicOnly = source === "topic";

    // Determine if the user provided a meaningful subject or if we need AI to infer one
    const userSubject = subject?.trim();
    const needsSubjectInference = !userSubject || userSubject.toLowerCase() === 'general';
    // For topic-based quizzes without a subject, use the topic itself as the subject
    const resolvedSubject = needsSubjectInference && isTopicOnly
      ? (topic?.trim() || 'General')
      : (userSubject || 'General');

    let prompt;
    if (questionType === "essay") {
      prompt = `
You are a teacher creating SHORT ANSWER / ESSAY questions.
${needsSubjectInference ? `The content covers an academic topic — identify it.` : `Subject: ${resolvedSubject}`}
Difficulty: ${difficulty}
Count: ${numQuestions} questions
${isTopicOnly ? `Topic: ${topic}` : `Based strictly on the provided text.`}

Return a JSON OBJECT with this exact structure:
{
  "subject": "${needsSubjectInference ? 'the specific academic subject (e.g. Accounting, Biology, Psychology — never use General)' : resolvedSubject}",
  "questions": [
    {
      "question": "Essay question text?",
      "modelAnswer": "Comprehensive model answer here.",
      "explanation": "Why this answer is correct.",
      "topic": "The specific sub-topic this question tests (e.g. 'Depreciation', not just 'Accounting')"
    }
  ]
}

${isTopicOnly ? "" : `Text:\n${safeContent}`}
      `.trim();
    } else {
      prompt = `
You are a teacher creating a multiple-choice quiz.
${needsSubjectInference ? `The content covers an academic topic — identify it.` : `Subject: ${resolvedSubject}`}
Difficulty: ${difficulty}
Count: ${numQuestions} questions
${isTopicOnly ? `Topic: ${topic}` : `Based strictly on the provided text.`}

Return a JSON OBJECT with this exact structure:
{
  "subject": "${needsSubjectInference ? 'the specific academic subject (e.g. Accounting, Biology, Psychology — never use General)' : resolvedSubject}",
  "questions": [
    {
      "question": "Question text?",
      "options": ["Option A", "Option B", "Option C", "Option D"],
      "correctAnswer": 0,
      "explanation": "Brief explanation of why this answer is correct.",
      "topic": "The specific sub-topic this question tests (e.g. 'Depreciation', not just 'Accounting')"
    }
  ]
}
Note: correctAnswer is the index (0-3) of the correct option.

${isTopicOnly ? "" : `Text:\n${safeContent}`}
      `.trim();
    }

    let raw;
    try { raw = await gemini.generateText(prompt); } catch (aiErr) {
      console.error("Quiz AI error:", aiErr.message);
      return res.status(500).json({ error: `AI error: ${aiErr.message}` });
    }
    if (!raw) return res.status(500).json({ error: "AI returned empty response. Try again." });

    let questions;
    let aiInferredSubject = null;
    try {
      const cleaned = raw.replace(/^```json\s*|```$/gi, "").trim();
      const parsed = JSON.parse(cleaned);

      // Support both new object format {subject, questions} and legacy array format
      if (Array.isArray(parsed)) {
        questions = parsed;
      } else if (parsed && Array.isArray(parsed.questions)) {
        questions = parsed.questions;
        aiInferredSubject = parsed.subject?.trim() || null;
      } else {
        throw new Error("Unexpected response format");
      }

      if (questionType === "essay") {
        questions = questions
          .map(q => ({
            question: q.question?.trim(),
            modelAnswer: q.modelAnswer?.trim() || "",
            explanation: q.explanation?.trim() || "",
            options: [],
            correctAnswer: null,
            topic: q.topic?.trim() || "",
          }))
          .filter(q => q.question && q.modelAnswer);
      } else {
        questions = questions
          .map(q => ({
            question: q.question?.trim(),
            options: Array.isArray(q.options) ? q.options.slice(0, 4) : [],
            correctAnswer: Number(q.correctAnswer),
            explanation: q.explanation?.trim() || "",
            modelAnswer: "",
            topic: q.topic?.trim() || "",
          }))
          .filter(q => q.question && q.options.length === 4 && !isNaN(q.correctAnswer));
      }
    } catch (e) {
      console.error("JSON parse error:", e.message);
      return res.status(500).json({ error: "AI response was malformed. Try again." });
    }

    if (questions.length === 0) {
      return res.status(500).json({ error: "No valid questions generated." });
    }

    // Use AI-inferred subject when user left the field blank or set it to "General"
    const finalSubject = needsSubjectInference && aiInferredSubject && aiInferredSubject.toLowerCase() !== 'general'
      ? aiInferredSubject
      : resolvedSubject;

    const quiz = new Quiz({
      userId: req.user.userId,
      title: title?.trim() || "Untitled Quiz",
      subject: finalSubject,
      difficulty,
      timeLimit: parseInt(timeLimit),
      numQuestions: questions.length,
      questionType,
      questions,
    });

    await quiz.save();

    res.json({ success: true, id: quiz._id, message: "Quiz generated successfully!" });

  } catch (err) {
    console.error("Generate quiz error:", err);
    res.status(500).json({ error: "Server error: " + err.message });
  }
});

// ==================== EVALUATE ESSAY ANSWER (AI grading) ====================
router.post("/evaluate-essay", auth, async (req, res) => {
  if (!gemini.ready) return res.status(503).json({ error: "AI service unavailable — check GEMINI_API_KEYS" });

  try {
    const { question, userAnswer, modelAnswer } = req.body;

    if (!question || !userAnswer) {
      return res.status(400).json({ error: "question and userAnswer are required" });
    }

    const prompt = `
You are an expert teacher grading a student's short answer response.

Question: ${question}
Model Answer: ${modelAnswer || "No model answer provided."}
Student's Answer: ${userAnswer}

Evaluate the student's answer on a scale of 0-100 based on:
- Accuracy and correctness (50%)
- Completeness (30%)
- Clarity (20%)

Return JSON ONLY:
{
  "score": 75,
  "feedback": "Your answer correctly identified X but missed Y. Consider also mentioning Z."
}
    `.trim();

    let result;
    try {
      result = await gemini.generateJSON(prompt);
      if (typeof result.score !== "number") throw new Error("Invalid score field");
    } catch (aiErr) {
      console.error("Essay eval AI error:", aiErr.message);
      return res.status(500).json({ error: `AI evaluation failed: ${aiErr.message}` });
    }

    res.json({
      success:  true,
      score:    Math.min(100, Math.max(0, Math.round(result.score))),
      feedback: result.feedback || "Evaluation complete.",
    });
  } catch (err) {
    console.error("Evaluate essay error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// ==================== GENERATE EXPLANATIONS for existing quiz ====================
router.post("/generate-explanations/:quizId", auth, async (req, res) => {
  if (!gemini.ready) return res.status(503).json({ error: "AI service unavailable — check GEMINI_API_KEYS" });

  try {
    const quiz = await Quiz.findOne({ _id: req.params.quizId, userId: req.user.userId });
    if (!quiz) return res.status(404).json({ error: "Quiz not found" });

    const questionsNeedingExplanation = quiz.questions.filter(q => !q.explanation);
    if (questionsNeedingExplanation.length === 0) {
      return res.json({ success: true, message: "All questions already have explanations" });
    }

    const prompt = `
For each of these quiz questions, provide a concise explanation (1-2 sentences) of why the correct answer is right.

Questions (JSON):
${JSON.stringify(questionsNeedingExplanation.map(q => ({
  question: q.question,
  options: q.options,
  correctAnswer: q.correctAnswer,
  modelAnswer: q.modelAnswer,
})))}

Return a JSON array with one explanation per question (in the same order):
["Explanation for Q1", "Explanation for Q2", ...]
    `.trim();

    let explanations;
    try {
      explanations = await gemini.generateJSON(prompt);
      if (!Array.isArray(explanations)) throw new Error("Not array");
    } catch (aiErr) {
      console.error("Generate explanations AI error:", aiErr.message);
      return res.status(500).json({ error: "AI returned invalid explanations" });
    }

    let idx = 0;
    for (const q of quiz.questions) {
      if (!q.explanation && idx < explanations.length) {
        q.explanation = explanations[idx++] || "";
      }
    }
    await quiz.save();

    res.json({ success: true, message: "Explanations generated!", count: idx });
  } catch (err) {
    console.error("Generate explanations error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// ==================== AI TUTOR: why wrong + correct concept ====================
// Embedded in the post-quiz review screen (TakeQuiz.jsx QuestionBreakdown).
// Result is cached onto the question so repeat views cost no AI calls.
router.post("/:quizId/tutor-explain", auth, async (req, res) => {
  try {
    const quiz = await Quiz.findById(req.params.quizId);
    if (!quiz) return res.status(404).json({ error: "Quiz not found" });
    if (quiz.userId && quiz.userId.toString() !== req.user.userId && !quiz.isPublic) {
      return res.status(403).json({ error: "Not authorized to view this quiz" });
    }

    const { questionIndex } = req.body;
    const q = quiz.questions[questionIndex];
    if (!q) return res.status(400).json({ error: "Invalid questionIndex" });

    if (q.explanation && q.conceptNote) {
      return res.json({ success: true, whyWrong: q.explanation, correctConcept: q.conceptNote, cached: true });
    }

    if (!gemini.ready) return res.status(503).json({ error: "AI service unavailable — check GEMINI_API_KEYS" });

    const topic = q.topic || quiz.subject;
    const prompt = `You are a patient tutor helping a student who got this ${quiz.subject} question wrong (topic: ${topic}).

Question: ${q.question}
${q.options?.length ? `Options: ${q.options.map((o, i) => `${i}) ${o}`).join(', ')}\nCorrect answer: ${q.options[q.correctAnswer]}` : `Model answer: ${q.modelAnswer}`}

Return ONLY valid JSON:
{
  "whyWrong": "One short sentence on why a student typically picks the wrong answer here.",
  "correctConcept": "Two to three sentences clearly explaining the correct underlying concept, in simple language."
}`;

    let whyWrong = q.explanation || "";
    let correctConcept = "";
    try {
      const parsed = await gemini.generateJSON(prompt, { maxOutputTokens: 512, temperature: 0.5 });
      whyWrong = parsed.whyWrong || whyWrong;
      correctConcept = parsed.correctConcept || "";
    } catch (aiErr) {
      console.error("Tutor explain AI error:", aiErr.message);
      if (!whyWrong) return res.status(500).json({ error: `AI tutor failed: ${aiErr.message}` });
    }

    q.explanation = whyWrong || q.explanation;
    q.conceptNote = correctConcept || q.conceptNote;
    await quiz.save();

    res.json({ success: true, whyWrong: q.explanation, correctConcept: q.conceptNote, cached: false });
  } catch (err) {
    console.error("Tutor explain error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// ==================== AI TUTOR: on-demand easier/harder practice question ====================
// Ephemeral — not persisted. Lets a student immediately retry a lighter or
// tougher version of the same topic right from the review screen.
router.post("/:quizId/tutor-practice", auth, async (req, res) => {
  if (!gemini.ready) return res.status(503).json({ error: "AI service unavailable — check GEMINI_API_KEYS" });

  try {
    const quiz = await Quiz.findById(req.params.quizId);
    if (!quiz) return res.status(404).json({ error: "Quiz not found" });
    if (quiz.userId && quiz.userId.toString() !== req.user.userId && !quiz.isPublic) {
      return res.status(403).json({ error: "Not authorized to view this quiz" });
    }

    const { questionIndex, difficulty } = req.body;
    const q = quiz.questions[questionIndex];
    if (!q) return res.status(400).json({ error: "Invalid questionIndex" });
    if (!["easier", "harder"].includes(difficulty)) {
      return res.status(400).json({ error: "difficulty must be 'easier' or 'harder'" });
    }

    const topic = q.topic || quiz.subject;
    const prompt = `Create exactly ONE multiple-choice question on "${topic}" (part of ${quiz.subject}), ${
      difficulty === "easier" ? "noticeably simpler than usual — rebuild the student's confidence" : "noticeably more challenging — push a student who just got it right"
    }.

Return ONLY valid JSON:
{
  "question": "...",
  "options": ["A","B","C","D"],
  "correctAnswer": 0,
  "explanation": "One sentence."
}`;

    let parsed;
    try {
      parsed = await gemini.generateJSON(prompt, { maxOutputTokens: 512, temperature: 0.7 });
    } catch (aiErr) {
      console.error("Tutor practice AI error:", aiErr.message);
      return res.status(500).json({ error: `AI failed to generate a practice question: ${aiErr.message}` });
    }

    if (!parsed.question || !Array.isArray(parsed.options) || parsed.options.length < 2) {
      return res.status(500).json({ error: "AI returned an invalid practice question" });
    }

    res.json({
      success: true,
      question: {
        question: parsed.question,
        options: parsed.options.slice(0, 4),
        correctAnswer: typeof parsed.correctAnswer === "number" ? parsed.correctAnswer : 0,
        explanation: parsed.explanation || "",
        topic,
      },
    });
  } catch (err) {
    console.error("Tutor practice error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// ==================== QUESTION BANK SEARCH ====================
router.get("/question-bank", auth, async (req, res) => {
  try {
    const subject = req.query.subject || "";
    const limit = Math.min(50, parseInt(req.query.limit) || 20);

    const quizzes = await Quiz.find({
      subject: { $regex: subject, $options: "i" },
    }).select("title subject questions").limit(10).lean();

    const questions = [];
    for (const quiz of quizzes) {
      for (const q of quiz.questions) {
        questions.push({
          questionId: q._id,
          quizId: quiz._id,
          quizTitle: quiz.title,
          subject: quiz.subject,
          question: q.question,
          options: q.options,
          correctAnswer: q.correctAnswer,
          explanation: q.explanation,
        });
        if (questions.length >= limit) break;
      }
      if (questions.length >= limit) break;
    }

    res.json({ success: true, questions, total: questions.length });
  } catch (err) {
    console.error("Question bank search error:", err);
    res.status(500).json({ error: "Failed to search question bank" });
  }
});

// ==================== USER QUIZ SETS ====================
router.get("/sets", auth, async (req, res) => {
  try {
    const quizzes = await Quiz.find({ userId: req.user.userId }).sort({ createdAt: -1 });
    const results = await QuizResult.find({ userId: req.user.userId }).select("quizId score examMode");

    const map = {};
    const examModeMap = {};
    results.forEach(r => {
      map[r.quizId] = r.score;
      examModeMap[r.quizId] = r.examMode || false;
    });

    const formatted = quizzes.map(q => ({
      id: q._id,
      _id: q._id,
      title: q.title,
      subject: q.subject,
      difficulty: q.difficulty,
      timeLimit: q.timeLimit,
      numQuestions: q.numQuestions,
      questionType: q.questionType,
      score: map[q._id] ?? null,
      maxScore: 100,
      createdAt: q.createdAt,
      status: map[q._id] !== undefined ? "completed" : "pending",
      examMode: examModeMap[q._id] ?? false,
    }));

    res.json({ success: true, quizzes: formatted });
  } catch (e) {
    console.error("Fetch sets error:", e);
    res.status(500).json({ error: "Error fetching quizzes" });
  }
});

// ==================== DELETE QUIZ SET ====================
router.delete("/sets/:id", auth, async (req, res) => {
  try {
    const quiz = await Quiz.findOneAndDelete({ _id: req.params.id, userId: req.user.userId });
    if (!quiz) return res.status(404).json({ error: "Quiz not found" });
    await QuizResult.deleteMany({ quizId: req.params.id, userId: req.user.userId });
    res.json({ success: true, message: "Quiz deleted" });
  } catch (e) {
    console.error("Delete quiz error:", e);
    res.status(500).json({ error: "Failed to delete quiz" });
  }
});

// ==================== SINGLE QUIZ ====================
router.get("/:id", auth, async (req, res) => {
  try {
    const quiz = await Quiz.findOne({ _id: req.params.id, userId: req.user.userId });
    if (!quiz) return res.status(404).json({ error: "Quiz not found" });
    res.json({ success: true, quiz });
  } catch (e) {
    console.error("Fetch quiz error:", e);
    res.status(500).json({ error: "Error fetching quiz" });
  }
});

// ==================== SAVE QUIZ RESULT ====================
router.post("/quiz-results", auth, async (req, res) => {
  try {
    const { quizId, score, answers, essayAnswers, timeSpent, timePerQuestion, correctCount, totalCount } = req.body;

    const quiz = await Quiz.findById(quizId);
    if (!quiz) return res.status(404).json({ error: "Quiz not found" });

    // Per-question topic outcomes — feeds the adaptive learning engine so it
    // can notice repeated mistakes on a specific sub-topic (not just subject).
    const resolvedSubjectTag = resolveSpecificSubject(quiz.subject, quiz.title);
    const topicBreakdown = quiz.questions.map((q, i) => {
      const topic = (q.topic || "").trim() || resolvedSubjectTag;
      let correct = null;
      if (q.correctAnswer !== null && q.correctAnswer !== undefined) {
        correct = (answers || [])[i] === q.correctAnswer;
      } else {
        const essayEntry = (essayAnswers || []).find(e => e.questionIndex === i);
        if (essayEntry) correct = (essayEntry.aiScore ?? 0) >= 60;
      }
      return { questionIndex: i, subject: resolvedSubjectTag, topic, correct };
    }).filter(t => t.correct !== null);

    const result = new QuizResult({
      userId: req.user.userId,
      quizId,
      score,
      answers: answers || [],
      essayAnswers: essayAnswers || [],
      timeSpent,
      timePerQuestion: timePerQuestion || [],
      subjectTag: quiz.subject || "General",
      correctCount: correctCount ?? 0,
      totalCount: totalCount ?? (quiz.numQuestions || 0),
      topicBreakdown,
    });
    await result.save();

    // ── Adaptive learning: update topic mastery and auto-react to repeated misses ──
    // Never blocks or fails the result save — adaptive learning is a bonus.
    let adaptiveActions = [];
    try {
      adaptiveActions = await processQuizResult(req.user.userId, topicBreakdown);
    } catch (adaptErr) {
      console.error("Adaptive engine error (non-fatal):", adaptErr.message);
    }

    // ── Auto-award XP for completing this quiz ──
    let xpAward = null;
    try {
      if (awardXP) {
        const User = require("../models/User");
        const user = await User.findById(req.user.userId);
        if (user) {
          // Was XP wagered ("Exam Mode") on this specific quiz? Check before
          // awardXP resolves/clears the wager below.
          const wager = user.activeWager;
          if (wager && wager.wagerAmount > 0 && wager.quizId && wager.quizId.toString() === quizId.toString()) {
            result.examMode = true;
            await result.save();
          }

          const baseXP = Math.round(10 + (score / 10));
          const allResults = await QuizResult.find({ userId: req.user.userId });
          xpAward = await awardXP(user, allResults, {
            baseXP,
            reason:    "quiz_complete",
            score,
            timeSpent,
            timeLimit: quiz.timeLimit || 0,
            quizId:    quiz._id,
          });
        }
      }
    } catch (xpErr) {
      console.error("XP award error (non-fatal):", xpErr.message);
    }

    try {
      const ActivityLog = require("../models/ActivityLog");
      await ActivityLog.create({
        userId: req.user.userId,
        action: "quiz_taken",
        entityType: "quiz",
        entityId: quiz._id,
        details: { score, timeSpent, subject: quiz.subject },
      });
    } catch { /* ignore logging errors */ }

    res.json({
      success: true,
      message: "Quiz result saved successfully",
      xpAward: xpAward || null,
      adaptiveActions,
    });
  } catch (e) {
    console.error("Save result error:", e);
    res.status(500).json({ error: "Error saving quiz result" });
  }
});

// ==================== PUBLIC ROUTES ====================
router.post("/public/create", async (req, res) => {
  try {
    const { title, subject, questions, difficulty = "medium", timeLimit = 30, authorName } = req.body;
    if (!title || !subject || !Array.isArray(questions) || questions.length === 0) {
      return res.status(400).json({ error: "Missing required fields" });
    }
    const valid = questions.filter(q => q.question && Array.isArray(q.options) && q.options.length === 4 && q.correctAnswer !== undefined);
    if (valid.length === 0) return res.status(400).json({ error: "Invalid questions" });

    const quiz = new Quiz({
      userId: null,
      authorName: authorName?.trim() || null,
      title: title.trim(),
      subject: subject.trim(),
      difficulty,
      timeLimit: parseInt(timeLimit, 10),
      numQuestions: valid.length,
      questions: valid.map(q => ({ ...q, explanation: q.explanation || "", modelAnswer: "" })),
      isPublic: true,
    });
    await quiz.save();
    res.status(201).json({ success: true, id: quiz._id, message: "Public quiz created" });
  } catch (err) {
    console.error("Public create quiz error:", err);
    res.status(500).json({ error: "Failed to create public quiz" });
  }
});

router.get("/public/sets", async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 20));
    const skip = (page - 1) * limit;

    // Search matches across the ENTIRE public collection (title or subject),
    // not just the currently-loaded page.
    const search = (req.query.search || "").trim();
    const filter = search
      ? { $or: [
          { title:   { $regex: search, $options: "i" } },
          { subject: { $regex: search, $options: "i" } },
        ] }
      : {};

    const [quizzes, total] = await Promise.all([
      Quiz.find(filter)
        .select("title subject difficulty numQuestions timeLimit createdAt authorName questionType")
        .populate("userId", "fullName")
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      Quiz.countDocuments(filter),
    ]);

    const formatted = quizzes.map(q => ({
      id: q._id,
      title: q.title,
      subject: q.subject,
      difficulty: q.difficulty,
      numQuestions: q.numQuestions,
      timeLimit: q.timeLimit,
      questionType: q.questionType || "mcq",
      creator: q.userId?.fullName || q.authorName || "Anonymous",
      createdAt: q.createdAt,
    }));

    res.json({ success: true, quizzes: formatted, pagination: { page, limit, total, pages: Math.ceil(total / limit) } });
  } catch (e) {
    console.error("Fetch public quizzes error:", e);
    res.status(500).json({ success: false, error: "Failed to fetch public quizzes" });
  }
});

router.get("/public/:id", async (req, res) => {
  try {
    const quiz = await Quiz.findById(req.params.id).populate("userId", "fullName").lean();
    if (!quiz) return res.status(404).json({ success: false, error: "Quiz not found" });

    // For MCQ hide correct answers; for essay include modelAnswer
    const safeQuestions = quiz.questions.map(q => ({
      question: q.question,
      options: q.options,
      modelAnswer: quiz.questionType === "essay" ? q.modelAnswer : undefined,
    }));

    res.json({
      success: true,
      quiz: {
        id: quiz._id,
        title: quiz.title,
        subject: quiz.subject,
        difficulty: quiz.difficulty,
        timeLimit: quiz.timeLimit,
        numQuestions: quiz.numQuestions,
        questionType: quiz.questionType || "mcq",
        creator: quiz.userId?.fullName || quiz.authorName || "Anonymous",
        createdAt: quiz.createdAt,
        questions: safeQuestions,
      },
    });
  } catch (e) {
    console.error("Fetch public quiz error:", e);
    res.status(500).json({ success: false, error: "Server error" });
  }
});

router.get("/quiz-results/:quizId", auth, async (req, res) => {
  try {
    const result = await QuizResult.findOne({ quizId: req.params.quizId, userId: req.user.userId });
    if (!result) return res.json({ success: true, result: null });
    res.json({ success: true, result });
  } catch (e) {
    console.error("Fetch result error:", e);
    res.status(500).json({ error: "Server error" });
  }
});

module.exports = router;
