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
      "explanation": "Why this answer is correct."
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
      "explanation": "Brief explanation of why this answer is correct."
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

    const raw = await generateWithRetry(model, prompt, aiManager);

    let explanations;
    try {
      const cleaned = raw.replace(/^```json\s*|```$/gi, "").trim();
      explanations = JSON.parse(cleaned);
      if (!Array.isArray(explanations)) throw new Error("Not array");
    } catch {
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
    const results = await QuizResult.find({ userId: req.user.userId }).select("quizId score");

    const map = {};
    results.forEach(r => (map[r.quizId] = r.score));

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
    }));

    res.json({ success: true, quizzes: formatted });
  } catch (e) {
    console.error("Fetch sets error:", e);
    res.status(500).json({ error: "Error fetching quizzes" });
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
    });
    await result.save();

    // ── Auto-award XP for completing this quiz ──
    let xpAward = null;
    try {
      if (awardXP) {
        const User = require("../models/User");
        const user = await User.findById(req.user.userId);
        if (user) {
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

    const [quizzes, total] = await Promise.all([
      Quiz.find({})
        .select("title subject difficulty numQuestions timeLimit createdAt authorName questionType")
        .populate("userId", "fullName")
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      Quiz.countDocuments({}),
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
