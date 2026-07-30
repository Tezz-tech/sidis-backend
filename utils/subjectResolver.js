// utils/subjectResolver.js — maps a quiz title/subject to a specific academic
// subject so "General" is never shown as a topic name. Extracted from
// routes/dashboard.js so quizzes.js (topic fallback) can reuse the same logic.
'use strict';

const SUBJECT_KEYWORDS = [
  // STEM
  ['Mathematics',     ['math', 'mathemat', 'calculus', 'algebra', 'geometry', 'trigonometry', 'arithmetic', 'number', 'equation', 'statistics', 'probability', 'maths']],
  ['Calculus',        ['calculus', 'differential', 'integral', 'derivative', 'limit']],
  ['Statistics',      ['statistic', 'probability', 'distribution', 'regression', 'hypothesis']],
  ['Algebra',         ['algebra', 'polynomial', 'quadratic', 'linear equation']],
  ['Biology',         ['biology', 'cell', 'genetics', 'evolution', 'ecology', 'organism', 'photosynthesis', 'mitosis', 'anatomy', 'physiology', 'microbiology']],
  ['Chemistry',       ['chemistry', 'chemical', 'periodic', 'atom', 'molecule', 'reaction', 'organic', 'inorganic', 'compound', 'element', 'bonding']],
  ['Physics',         ['physics', 'force', 'motion', 'energy', 'wave', 'optics', 'electricity', 'magnetism', 'quantum', 'mechanics', 'thermodynamic']],
  ['Computer Science',['computer', 'programming', 'algorithm', 'data structure', 'software', 'coding', 'python', 'javascript', 'database', 'network', 'cybersecurity', 'machine learning', 'ai ', 'artificial intelligence']],
  // Business & Finance
  ['Accounting',      ['accounting', 'ledger', 'journal', 'debit', 'credit', 'balance sheet', 'income statement', 'audit', 'tax', 'bookkeeping', 'financial statement']],
  ['Finance',         ['finance', 'investment', 'portfolio', 'stock', 'bond', 'market', 'valuation', 'asset', 'liability', 'capital', 'cash flow', 'banking']],
  ['Economics',       ['economics', 'microeconom', 'macroeconom', 'supply', 'demand', 'gdp', 'inflation', 'fiscal', 'monetary policy', 'trade']],
  ['Business Studies',['business', 'management', 'marketing', 'entrepreneur', 'strategy', 'organisation', 'operations', 'hrm', 'human resource']],
  // Social Sciences
  ['Psychology',      ['psychology', 'behaviour', 'behavior', 'cognitive', 'mental', 'freud', 'piaget', 'stimulus', 'response', 'therapy', 'emotion', 'personality']],
  ['Sociology',       ['sociology', 'society', 'social structure', 'culture', 'institution', 'deviance', 'stratification', 'norms', 'values']],
  ['Philosophy',      ['philosophy', 'ethics', 'logic', 'metaphysics', 'epistemology', 'plato', 'aristotle', 'kant', 'moral']],
  ['History',         ['history', 'historical', 'war', 'revolution', 'empire', 'civilization', 'colonial', 'century', 'ancient', 'medieval', 'modern history']],
  ['Geography',       ['geography', 'climate', 'continent', 'ecosystem', 'population', 'urbanization', 'map', 'physical geography', 'human geography']],
  ['Political Science',['politic', 'government', 'democracy', 'constitution', 'election', 'parliament', 'legislation', 'policy', 'international relations']],
  // Languages & Humanities
  ['English',         ['english', 'grammar', 'comprehension', 'essay writing', 'literature', 'shakespeare', 'novel', 'poetry', 'prose', 'language arts']],
  ['Literature',      ['literature', 'novel', 'short story', 'poetry', 'drama', 'theme', 'character', 'plot', 'symbolism']],
  // Health & Medicine
  ['Medicine',        ['medicine', 'medical', 'disease', 'diagnosis', 'pharmacology', 'pathology', 'clinical', 'drug', 'symptom', 'treatment']],
  ['Nursing',         ['nursing', 'patient care', 'ward', 'clinical', 'nurse', 'healthcare', 'medication']],
  ['Anatomy',         ['anatomy', 'bone', 'muscle', 'organ', 'tissue', 'skeletal', 'cardiovascular', 'nervous system']],
  // Law
  ['Law',             ['law', 'legal', 'contract', 'tort', 'criminal', 'constitution', 'court', 'statute', 'case study', 'judicial']],
];

function resolveSpecificSubject(subject, title) {
  // If the saved subject is already specific, use it
  if (subject && subject.trim() && subject.trim().toLowerCase() !== 'general') {
    return subject.trim();
  }
  const text = ((subject || '') + ' ' + (title || '')).toLowerCase();
  for (const [name, keywords] of SUBJECT_KEYWORDS) {
    if (keywords.some(k => text.includes(k))) return name;
  }
  // Fall back to first 2–3 meaningful words from the title
  const words = (title || '')
    .replace(/[^a-zA-Z\s]/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(w => w.length > 3 && !['quiz', 'test', 'exam', 'chapter', 'unit', 'part', 'with', 'from', 'your', 'this', 'that'].includes(w.toLowerCase()));
  if (words.length > 0) return words.slice(0, 2).map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
  return 'General';
}

module.exports = { resolveSpecificSubject, SUBJECT_KEYWORDS };
