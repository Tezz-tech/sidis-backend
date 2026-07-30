// routes/collaboration.js — lightweight collaboration: share a link to a
// quiz or flashcard set, award small XP when it's completed, and show a
// pass/fail comparison between sharer and recipient. No friends/groups.
const express          = require('express');
const router           = express.Router();
const auth              = require('../middlewares/auth');
const SharedItem        = require('../models/SharedItem');
const Quiz               = require('../models/Quiz');
const FlashcardSet       = require('../models/FlashcardSet');
const QuizResult         = require('../models/QuizResult');
const FlashcardProgress  = require('../models/FlashcardProgress');
const User               = require('../models/User');

let awardXP = null;
try { ({ awardXP } = require('../utils/gamificationUtils')); } catch (_) {}

const PASS_SCORE = 60;

// ─── POST /api/collaboration/share ─────────────────────────────────────────────
router.post('/share', auth, async (req, res) => {
  try {
    const { itemType, itemId } = req.body;
    if (!['quiz', 'flashcard'].includes(itemType)) {
      return res.status(400).json({ error: "itemType must be 'quiz' or 'flashcard'" });
    }

    const Model = itemType === 'quiz' ? Quiz : FlashcardSet;
    const item = await Model.findOne({ _id: itemId, userId: req.user.userId });
    if (!item) return res.status(404).json({ error: 'Item not found or not owned by you' });

    let shared = await SharedItem.findOne({ fromUserId: req.user.userId, itemType, itemId });
    if (!shared) {
      shared = await SharedItem.create({ fromUserId: req.user.userId, itemType, itemId });
    }

    const path = itemType === 'quiz'
      ? `/public-quiz/${itemId}?share=${shared.shareToken}`
      : `/public-flashcards/${itemId}?share=${shared.shareToken}`;

    res.json({ success: true, shareToken: shared.shareToken, path });
  } catch (err) {
    console.error('Share error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ─── GET /api/collaboration/shared/:token ──────────────────────────────────────
router.get('/shared/:token', async (req, res) => {
  try {
    const shared = await SharedItem.findOne({ shareToken: req.params.token }).lean();
    if (!shared) return res.status(404).json({ error: 'Share link not found' });

    const owner = await User.findById(shared.fromUserId).select('fullName').lean();

    let ownerScore = null;
    if (shared.itemType === 'quiz') {
      const best = await QuizResult.find({ userId: shared.fromUserId, quizId: shared.itemId })
        .sort({ score: -1 }).limit(1).lean();
      ownerScore = best[0]?.score ?? null;
    } else {
      const progress = await FlashcardProgress.find({ userId: shared.fromUserId, setId: shared.itemId }).lean();
      ownerScore = progress.length > 0
        ? Math.round(progress.reduce((s, p) => s + p.masteryLevel, 0) / progress.length)
        : null;
    }

    res.json({
      success: true,
      itemType: shared.itemType,
      itemId: shared.itemId,
      ownerName: owner?.fullName || 'A Sidis student',
      ownerScore,
      completions: shared.completions.length,
    });
  } catch (err) {
    console.error('Get shared item error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ─── POST /api/collaboration/shared/:token/complete ────────────────────────────
router.post('/shared/:token/complete', auth, async (req, res) => {
  try {
    const { score } = req.body;
    if (typeof score !== 'number') return res.status(400).json({ error: 'score is required' });

    const shared = await SharedItem.findOne({ shareToken: req.params.token });
    if (!shared) return res.status(404).json({ error: 'Share link not found' });

    const user = await User.findById(req.user.userId).select('fullName');
    shared.completions = shared.completions.filter(c => c.userId.toString() !== req.user.userId);
    shared.completions.push({ userId: req.user.userId, name: user?.fullName || '', score, completedAt: new Date() });
    await shared.save();

    // Small XP for both sides — the recipient for completing shared content,
    // the sharer for content that got someone else studying.
    let recipientXP = null;
    let sharerXP = null;
    if (awardXP && shared.fromUserId.toString() !== req.user.userId) {
      try {
        const recipient = await User.findById(req.user.userId);
        if (recipient) recipientXP = await awardXP(recipient, [], { baseXP: 15, reason: 'share_complete', score });
      } catch (_) {}
      try {
        const sharer = await User.findById(shared.fromUserId);
        if (sharer) sharerXP = await awardXP(sharer, [], { baseXP: 10, reason: 'share_complete', score });
      } catch (_) {}
    }

    let ownerScore = null;
    if (shared.itemType === 'quiz') {
      const best = await QuizResult.find({ userId: shared.fromUserId, quizId: shared.itemId })
        .sort({ score: -1 }).limit(1).lean();
      ownerScore = best[0]?.score ?? null;
    } else {
      const progress = await FlashcardProgress.find({ userId: shared.fromUserId, setId: shared.itemId }).lean();
      ownerScore = progress.length > 0
        ? Math.round(progress.reduce((s, p) => s + p.masteryLevel, 0) / progress.length)
        : null;
    }

    res.json({
      success: true,
      comparison: {
        yourScore: score,
        yourPass: score >= PASS_SCORE,
        ownerScore,
        ownerPass: ownerScore !== null ? ownerScore >= PASS_SCORE : null,
      },
      recipientXP,
      sharerXP,
    });
  } catch (err) {
    console.error('Complete shared item error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
