// routes/referrals.js — a user's own referral code + the people they've
// referred. Conversion (pending -> converted) only happens in
// routes/payments.js, when a referred user's first payment actually
// verifies — this file is read-only with respect to that status.
const express = require('express');
const router = express.Router();
const auth = require('../middlewares/auth');
const User = require('../models/User');
const Referral = require('../models/Referral');
const { generateUniqueReferralCode } = require('../utils/referral');

// ── GET /api/referrals/mine — my code + summary stats ───────────────────────
router.get('/mine', auth, async (req, res) => {
  try {
    const user = await User.findById(req.user.userId).select('fullName referralCode');
    if (!user) return res.status(404).json({ error: 'User not found' });

    // Lazy backfill for accounts created before this feature existed.
    if (!user.referralCode) {
      user.referralCode = await generateUniqueReferralCode(user.fullName);
      await user.save();
    }

    const [total, converted] = await Promise.all([
      Referral.countDocuments({ referrerId: user._id }),
      Referral.countDocuments({ referrerId: user._id, status: 'converted' }),
    ]);

    res.json({
      success: true,
      code: user.referralCode,
      stats: { total, pending: total - converted, converted },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/referrals/list — who I've referred + their status ──────────────
router.get('/list', auth, async (req, res) => {
  try {
    const referrals = await Referral.find({ referrerId: req.user.userId })
      .sort({ createdAt: -1 })
      .populate('referredId', 'fullName email')
      .lean();

    res.json({
      success: true,
      referrals: referrals.map(r => ({
        id: r._id,
        status: r.status,
        referredName: r.referredId?.fullName || 'A referred user',
        createdAt: r.createdAt,
        convertedAt: r.convertedAt,
      })),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
