// utils/difficultyPrompt.js — shared difficulty-scale guidance. Previously
// every quiz-generation prompt just injected a bare "Difficulty: hard"
// label with no explanation of what that actually means in terms of
// question construction, so the AI had nothing concrete to calibrate
// against and difficulty barely changed between levels. This gives each
// level a real, checkable definition — spliced into every prompt that
// takes a difficulty parameter.
const DIFFICULTY_GUIDE = {
  easy: `EASY difficulty: direct recall or single-step application of a clearly-stated fact, definition, or formula. Plain, unambiguous vocabulary. One concept per question — never combine ideas. A student who read the material once attentively should get most of these right.`,
  medium: `MEDIUM difficulty: requires understanding WHY, not just WHAT — applying a concept to a slightly new situation, or a 2-3 step calculation. May combine two related ideas from the material. A student who studied but didn't deeply internalize the material will miss some of these.`,
  hard: `HARD difficulty: multi-step reasoning or calculation (3+ steps), applying a concept to an unfamiliar scenario, or requiring the student to distinguish between easily-confused concepts. MCQ distractors must be genuinely plausible — each one a mistake a half-prepared student would actually make, never an obviously-wrong filler. Only a student with real command of the material should pass these consistently.`,
  expert: `EXPERT difficulty: the hardest real-world questions in this discipline — genuine edge cases, synthesis across multiple concepts from the material at once, or a calculation/argument with no shortcuts. Should feel like the hardest question on a real professional or final exam, not just a longer version of a medium question. Never achieve this through vocabulary alone — it must come from the reasoning or computation actually required.`,
};

function getDifficultyInstruction(difficulty) {
  const key = (difficulty || 'medium').toLowerCase();
  const guide = DIFFICULTY_GUIDE[key] || DIFFICULTY_GUIDE.medium;
  return `${guide}\nEvery question in this set must actually match this difficulty level — don't let some questions quietly default to an easier level than requested.`;
}

module.exports = { getDifficultyInstruction, DIFFICULTY_GUIDE };
