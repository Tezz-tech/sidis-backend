// utils/disciplinePrompt.js — shared instruction block telling the AI to
// write questions the way a REAL examiner in that specific discipline
// actually writes them, instead of a generic "hard" question dressed up
// with difficult vocabulary. Reused by every AI question-generation prompt
// in the app (Create Quiz, Exam Mode, Study Catch-Up, Forecaster, admin
// tools) so the behavior is consistent everywhere, not just in one feature.
//
// The core problem this fixes: setting difficulty to "hard"/"extreme" was
// making questions use harder words on the same shallow recall format —
// not genuinely harder in the way that discipline's real exams test
// mastery. A hard accounting question is a harder computation or a
// trickier standard to apply, not a harder vocabulary word on a
// definition question; a hard law question is a denser fact pattern, not
// a longer definition.

const DISCIPLINE_CORE = `Before writing any question, identify the SPECIFIC academic or professional discipline and sub-field this material belongs to (e.g. "Financial Accounting — Depreciation", "Contract Law", "Organic Chemistry", "Cell Biology", "Differential Calculus", "Corporate Finance") — not just a broad guess. Then write every question the way a REAL examiner in that exact discipline actually writes exam questions, not a generic question dressed up with harder vocabulary:
- Accounting / Finance / Business: multi-step computational problems requiring full workings, PLUS theory questions testing WHY a standard or principle applies the way it does — the way a real professional-body exam (e.g. ICAN, ACCA) tests it. A genuinely hard accounting question is a harder computation or a trickier application of a standard to an unusual scenario — never just a harder word wrapped around the same simple lookup.
- Law: fact-pattern / scenario questions requiring the student to spot the legal issue, identify the applicable rule or case law, and apply it to reach a reasoned conclusion (IRAC-style) — never bare definition recall.
- Sciences (Biology, Chemistry, Physics, Medicine): application, mechanism, or experimental-reasoning questions — predict an outcome, explain why something happens, interpret data or a described experiment — never simple term-matching.
- Mathematics / Engineering / Statistics: genuine multi-step problems requiring real derivation, proof, or calculation with full working shown — never a single-step lookup.
- Humanities / Literature / Social Sciences: critical-analysis or argument-based questions that require interpretation and reasoning, not fact trivia.
- Any other discipline not listed above: infer its real assessment convention directly from the material's own style and match it — look at how the source document itself poses questions or explains concepts for cues.
A question's real difficulty comes from requiring genuine reasoning, computation, or application within that discipline's own conventions — never from vocabulary alone.`;

// For prompts that can mix objective (MCQ) and theory/essay questions.
const DISCIPLINE_MIXED_INSTRUCTION = `${DISCIPLINE_CORE}
This also determines how heavily to weight essay/theory versus objective questions — some disciplines (accounting, law, literature, and most humanities) are naturally essay/theory-heavy in their real exams; lean into that rather than defaulting to mostly multiple-choice. Others (introductory sciences, vocabulary-heavy subjects) are conventionally more objective-heavy. Match the real convention, don't force an even split.`;

// For prompts that only produce MCQ (no essay type available).
const DISCIPLINE_MCQ_INSTRUCTION = `${DISCIPLINE_CORE}
Even though every question here must be multiple-choice, still follow the discipline's real question-writing pattern within that format — e.g. an accounting MCQ should present a short computational scenario and ask for the correct resulting figure or treatment, not ask the student to match a term to its definition; a law MCQ should present a short fact pattern and ask which legal principle or outcome applies.`;

module.exports = { DISCIPLINE_MIXED_INSTRUCTION, DISCIPLINE_MCQ_INSTRUCTION };
