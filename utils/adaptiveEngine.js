// utils/adaptiveEngine.js — the automatic part of adaptive learning.
//
// Flow: every quiz result reports per-question topic outcomes. This module
// keeps a per-topic mastery ledger, and when it sees a *repeated* miss on the
// same topic (not a one-off), it reacts on its own: generates a short focused
// practice quiz, writes a simplified explanation of the concept, and inserts
// a session into the student's study plan — no student action required.
'use strict';

const mongoose      = require('mongoose');
const TopicMastery  = require('../models/TopicMastery');
const Quiz          = require('../models/Quiz');
const StudyPlan     = require('../models/StudyPlan');
const { gemini }    = require('./ai');

const WEAK_THRESHOLD   = 60;
const STRONG_THRESHOLD = 80;
const MISS_TRIGGER     = 2;                     // consecutive misses before we react
const RE_TRIGGER_MS    = 3 * 24 * 60 * 60 * 1000; // don't re-fire on the same topic within 3 days

function statusFor(masteryScore) {
  if (masteryScore < WEAK_THRESHOLD) return 'weak';
  if (masteryScore >= STRONG_THRESHOLD) return 'strong';
  return 'moderate';
}

// ── Record outcomes from one quiz result into the per-topic ledger ──────────
async function recordTopicOutcomes(userId, topicBreakdown) {
  const touched = [];
  for (const entry of topicBreakdown || []) {
    const subject = (entry.subject || '').trim() || 'General';
    const topic   = (entry.topic || '').trim() || subject;

    const existing = await TopicMastery.findOne({ userId, subject, topic });
    const timesSeen    = (existing?.timesSeen || 0) + 1;
    const timesCorrect = (existing?.timesCorrect || 0) + (entry.correct ? 1 : 0);
    const masteryScore = Math.round((timesCorrect / timesSeen) * 100);
    const consecutiveMisses = entry.correct ? 0 : (existing?.consecutiveMisses || 0) + 1;

    const doc = await TopicMastery.findOneAndUpdate(
      { userId, subject, topic },
      {
        $set: {
          timesSeen, timesCorrect, masteryScore, consecutiveMisses,
          status: statusFor(masteryScore),
          lastSeen: new Date(),
          updatedAt: new Date(),
        },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
    touched.push(doc);
  }
  return touched;
}

// ── Which topics just crossed the "repeated failure" line and haven't been actioned recently ──
function needsAdaptiveAction(topicMasteryDoc) {
  if (!topicMasteryDoc || topicMasteryDoc.consecutiveMisses < MISS_TRIGGER) return false;
  const last = topicMasteryDoc.lastAutoActionAt;
  return !last || (Date.now() - new Date(last).getTime()) > RE_TRIGGER_MS;
}

async function detectWeakPatterns(userId) {
  const candidates = await TopicMastery.find({
    userId,
    consecutiveMisses: { $gte: MISS_TRIGGER },
  }).lean();
  const cutoff = new Date(Date.now() - RE_TRIGGER_MS);
  return candidates.filter(t => !t.lastAutoActionAt || new Date(t.lastAutoActionAt) < cutoff);
}

// ── Generate a short focused practice quiz for exactly one topic ────────────
async function generatePracticeForTopic(userId, subject, topic) {
  if (!gemini.ready) return null;

  const prompt = `You are an expert exam question creator for ${subject}.
The student keeps getting questions wrong on this specific sub-topic: "${topic}".
Generate exactly 5 multiple-choice questions that focus ONLY on "${topic}", starting a little easier than usual to rebuild confidence.

Return ONLY valid JSON:
{
  "questions": [
    { "question": "...", "options": ["A","B","C","D"], "correctAnswer": 0, "explanation": "..." }
  ]
}`;

  let generated = [];
  try {
    const parsed = await gemini.generateJSON(prompt, { maxOutputTokens: 4096, temperature: 0.6 });
    if (Array.isArray(parsed.questions)) generated = parsed.questions;
  } catch (err) {
    console.error('[adaptiveEngine] practice generation failed:', err.message);
    return null;
  }

  const questions = generated
    .filter(q => q.question && Array.isArray(q.options) && q.options.length >= 2)
    .map(q => ({
      question:      q.question,
      options:       q.options.slice(0, 4),
      correctAnswer: typeof q.correctAnswer === 'number' ? Math.min(q.correctAnswer, q.options.length - 1) : 0,
      modelAnswer:   '',
      explanation:   q.explanation || '',
      topic,
    }));

  if (questions.length === 0) return null;

  return Quiz.create({
    userId,
    title:        `${topic} — Adaptive Practice`,
    subject,
    difficulty:   'medium',
    timeLimit:    Math.max(10, questions.length * 2),
    numQuestions: questions.length,
    questionType: 'mcq',
    questions,
    isAdaptive:   true,
    isPublic:     false,
  });
}

// ── Generate a simplified, easy-to-digest explanation of the concept ────────
async function generateEasyDigest(subject, topic) {
  const fallback = `Let's break ${topic} down more simply — revisit the core definition and a worked example before your next attempt. Small, focused review beats re-reading everything.`;
  if (!gemini.ready) return fallback;

  try {
    const prompt = `A student keeps getting "${topic}" (part of ${subject}) wrong.
Explain the core concept in the simplest possible way — plain language, one short analogy or example, max 60 words.
Return JSON: { "digest": "..." }`;
    const parsed = await gemini.generateJSON(prompt, { maxOutputTokens: 256, temperature: 0.5 });
    return parsed.digest || fallback;
  } catch (err) {
    console.error('[adaptiveEngine] easy digest failed:', err.message);
    return fallback;
  }
}

// ── Insert a session into the student's nearest active study plan ───────────
async function patchStudyPlanWithTopic(userId, subject, topic, quiz) {
  const plan = await StudyPlan.findOne({
    userId,
    generated: true,
    examDate: { $gt: new Date() },
  }).sort({ examDate: 1 });
  if (!plan) return null;

  const tomorrow = new Date();
  tomorrow.setHours(0, 0, 0, 0);
  tomorrow.setDate(tomorrow.getDate() + 1);

  plan.schedule.push({
    date: tomorrow,
    subject,
    durationMinutes: 20,
    sessionType: 'practice',
    priority: 'high',
    notes: `Auto-added: repeated mistakes detected on ${topic}`,
    quizId: quiz?._id || null,
    quizTitle: quiz?.title || '',
    topic,
    autoGenerated: true,
  });
  plan.updatedAt = new Date();
  await plan.save();

  return plan;
}

// ── Full cycle for one weak topic: digest + practice quiz + plan patch ──────
async function runAdaptiveCycle(userId, subject, topic) {
  const easyDigest = await generateEasyDigest(subject, topic);
  const quiz        = await generatePracticeForTopic(userId, subject, topic);
  const patchedPlan = quiz ? await patchStudyPlanWithTopic(userId, subject, topic, quiz) : null;

  await TopicMastery.updateOne(
    { userId, subject, topic },
    {
      $set: {
        easyDigest,
        lastAutoActionAt: new Date(),
        lastPracticeQuizId: quiz?._id || null,
        lastPracticeQuizTitle: quiz?.title || '',
        lastPlanPatched: !!patchedPlan,
      },
    }
  );

  return { subject, topic, easyDigest, quizId: quiz?._id || null, quizTitle: quiz?.title || '', planPatched: !!patchedPlan };
}

// ── Entry point called right after a quiz result is saved ───────────────────
// Never throws — adaptive learning is a bonus, not a dependency of saving a score.
async function processQuizResult(userId, topicBreakdown) {
  try {
    const touched = await recordTopicOutcomes(userId, topicBreakdown);
    const actions = [];
    for (const doc of touched) {
      if (needsAdaptiveAction(doc)) {
        const result = await runAdaptiveCycle(userId, doc.subject, doc.topic);
        actions.push(result);
      }
    }
    return actions;
  } catch (err) {
    console.error('[adaptiveEngine] processQuizResult failed (non-fatal):', err.message);
    return [];
  }
}

module.exports = {
  recordTopicOutcomes,
  detectWeakPatterns,
  needsAdaptiveAction,
  generatePracticeForTopic,
  generateEasyDigest,
  patchStudyPlanWithTopic,
  runAdaptiveCycle,
  processQuizResult,
};
