// routes/payments.js
const express      = require('express');
const router       = express.Router();
const axios        = require('axios');
const crypto       = require('crypto');
const auth         = require('../middlewares/auth');
const Subscription = require('../models/Subscription');
const User         = require('../models/User');
const Quiz         = require('../models/Quiz');
const { getPlanFeatures, PLAN_NAMES, getEffectiveSubscription } = require('../utils/subscription');
const MAX_GROUP_MEMBERS = 2;

const PAYSTACK_SECRET = process.env.PAYSTACK_SECRET_KEY;
const PAYSTACK_BASE   = 'https://api.paystack.co';

// ── Plan catalogue ────────────────────────────────────────────────────────────
const PLANS = {
  exam_mode:          { name: 'Exam Mode',          amount: 700000,   durationDays: 3650, isGroup: false },
  weekly_individual:  { name: 'Weekly Individual',  amount: 550000,   durationDays: 7,    isGroup: false },
  weekly_group:       { name: 'Weekly Group',        amount: 270000,   durationDays: 7,    isGroup: true  },
  monthly_individual: { name: 'Monthly Individual', amount: 1500000,  durationDays: 30,   isGroup: false },
  monthly_group:      { name: 'Monthly Group',       amount: 333400,   durationDays: 30,   isGroup: true  },
  yearly_individual:  { name: 'Yearly Individual',  amount: 5000000,  durationDays: 365,  isGroup: false },
  yearly_group:       { name: 'Yearly Group',        amount: 833300,   durationDays: 365,  isGroup: true  },
};

function paystackHeaders() {
  return { Authorization: `Bearer ${(PAYSTACK_SECRET || '').trim()}`, 'Content-Type': 'application/json' };
}

// ── GET /api/payments/plans (public) ─────────────────────────────────────────
router.get('/plans', (req, res) => {
  const out = Object.entries(PLANS).map(([key, p]) => ({
    key,
    name:    p.name,
    amount:  p.amount,
    amountNGN: p.amount / 100,
    durationDays: p.durationDays,
    isGroup: p.isGroup,
  }));
  res.json({ success: true, plans: out });
});

// ── GET /api/payments/my-subscription ────────────────────────────────────────
router.get('/my-subscription', auth, async (req, res) => {
  try {
    const now = new Date();
    const sub = await Subscription.findOne({
      userId: req.user.userId,
      status: 'active',
      $or: [{ expiresAt: null }, { expiresAt: { $gt: now } }],
    }).sort({ createdAt: -1 }).lean();

    res.json({ success: true, subscription: sub || null });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/payments/my-features ─────────────────────────────────────────────
// Returns the current user's plan key, display name, feature flags,
// and usage counters (AI quizzes this month, SID IQ uses this month).
router.get('/my-features', auth, async (req, res) => {
  try {
    const { subscription, viaGroup } = await getEffectiveSubscription(req.user.userId);
    const plan     = subscription ? subscription.plan : 'free';
    const features = getPlanFeatures(plan);

    // Count AI quizzes generated this month (free users have a 5/month cap)
    const monthStart = new Date();
    monthStart.setDate(1);
    monthStart.setHours(0, 0, 0, 0);

    const aiQuizzesThisMonth = await Quiz.countDocuments({
      userId:         req.user.userId,
      isAdminCreated: false,
      createdAt:      { $gte: monthStart },
    });

    // Group plan context — either the caller owns the group plan, or they
    // joined someone else's as an invited member.
    let isGroupOwner = false, groupSeats = null, isGroupMember = false, groupOwnerName = null;
    if (subscription?.isGroup) {
      if (viaGroup) {
        isGroupMember = true;
        const owner = await User.findById(subscription.userId).select('fullName').lean();
        groupOwnerName = owner?.fullName || null;
      } else {
        isGroupOwner = true;
        groupSeats = { used: subscription.members?.length || 0, total: MAX_GROUP_MEMBERS };
      }
    }

    res.json({
      success:          true,
      plan,
      planName:         PLAN_NAMES[plan] || 'Free',
      features,
      usage: {
        aiQuizzesThisMonth,
        aiQuizzesLimit: features.unlimitedQuizzes ? null : features.aiQuizzesPerMonth,
        aiQuizzesRemaining: features.unlimitedQuizzes
          ? null
          : Math.max(0, features.aiQuizzesPerMonth - aiQuizzesThisMonth),
      },
      isGroupOwner,
      groupSeats,
      isGroupMember,
      groupOwnerName,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/payments/prepare ────────────────────────────────────────────────
// Inline popup flow: generates reference + returns user email so frontend
// can open PaystackPop directly without a server-side Paystack API call.
router.post('/prepare', auth, async (req, res) => {
  try {
    const { plan } = req.body;
    if (!plan || !PLANS[plan])
      return res.status(400).json({ error: `Unknown plan: ${plan}` });

    const user = await User.findById(req.user.userId).lean();
    if (!user) return res.status(404).json({ error: 'User not found.' });

    const planConfig = PLANS[plan];
    const reference  = `SIDIS_${plan}_${req.user.userId}_${Date.now()}`;

    await Subscription.create({
      userId:            req.user.userId,
      plan,
      planName:          planConfig.name,
      amount:            planConfig.amount,
      status:            'pending',
      paystackReference: reference,
      isGroup:           planConfig.isGroup,
    });

    res.json({
      success:   true,
      reference,
      email:     user.email,
      amount:    planConfig.amount,
      amountNGN: planConfig.amount / 100,
      planName:  planConfig.name,
      plan,
    });
  } catch (err) {
    console.error('[payments] prepare error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/payments/activate ───────────────────────────────────────────────
// Called by frontend immediately after Paystack confirms success.
// Activates the pending subscription without a server-side Paystack API call.
// The Paystack webhook (below) remains as an independent safety net.
router.post('/activate', auth, async (req, res) => {
  try {
    const { reference } = req.body;
    if (!reference) return res.status(400).json({ error: 'Reference required' });

    const sub = await Subscription.findOne({
      paystackReference: reference,
      userId:            req.user.userId,
    });
    if (!sub) return res.status(404).json({ error: 'Payment record not found.' });

    if (sub.status === 'active') {
      return res.json({ success: true, subscription: sub, alreadyActive: true });
    }

    const planConfig = PLANS[sub.plan];
    const now        = new Date();
    sub.status    = 'active';
    sub.startDate = now;
    sub.expiresAt = new Date(now.getTime() + planConfig.durationDays * 86400 * 1000);
    await sub.save();

    console.log(`[payments] activated ${sub.planName} for user ${req.user.userId} until ${sub.expiresAt.toISOString()}`);
    res.json({ success: true, subscription: sub });
  } catch (err) {
    console.error('[payments] activate error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/payments/initialize ─────────────────────────────────────────────
// Body: { plan, callbackUrl }
router.post('/initialize', auth, async (req, res) => {
  try {
    if (!PAYSTACK_SECRET)
      return res.status(503).json({ error: 'Payment service not configured — PAYSTACK_SECRET_KEY missing.' });

    const { plan, callbackUrl } = req.body;
    if (!plan || !PLANS[plan])
      return res.status(400).json({ error: `Unknown plan: ${plan}. Valid: ${Object.keys(PLANS).join(', ')}` });

    const user = await User.findById(req.user.userId).lean();
    if (!user) return res.status(404).json({ error: 'User not found.' });

    const planConfig = PLANS[plan];
    const reference  = `SIDIS_${plan}_${req.user.userId}_${Date.now()}`;

    // Call Paystack initialize
    const psRes = await axios.post(
      `${PAYSTACK_BASE}/transaction/initialize`,
      {
        email:        user.email,
        amount:       planConfig.amount,
        currency:     'NGN',
        reference,
        callback_url: callbackUrl || `${req.headers.origin}/payment/callback`,
        metadata: {
          userId:   String(req.user.userId),
          plan,
          planName: planConfig.name,
          custom_fields: [
            { display_name: 'Plan', variable_name: 'plan', value: planConfig.name },
            { display_name: 'User', variable_name: 'user', value: user.fullName || user.email },
          ],
        },
      },
      { headers: paystackHeaders() }
    );

    if (!psRes.data?.status)
      return res.status(502).json({ error: 'Paystack initialization failed.', detail: psRes.data?.message });

    // Create pending subscription record
    await Subscription.create({
      userId:            req.user.userId,
      plan,
      planName:          planConfig.name,
      amount:            planConfig.amount,
      status:            'pending',
      paystackReference: reference,
      isGroup:           planConfig.isGroup,
    });

    res.json({
      success:           true,
      authorization_url: psRes.data.data.authorization_url,
      reference,
      amount:            planConfig.amount,
      amountNGN:         planConfig.amount / 100,
      planName:          planConfig.name,
    });

  } catch (err) {
    console.error('[payments] initialize error:', err.response?.data || err.message);
    res.status(500).json({ error: err.response?.data?.message || err.message });
  }
});

// ── POST /api/payments/verify/:reference ──────────────────────────────────────
router.post('/verify/:reference', auth, async (req, res) => {
  try {
    if (!PAYSTACK_SECRET)
      return res.status(503).json({ error: 'Payment service not configured.' });

    const { reference } = req.params;

    // Check we have a pending record for this reference owned by this user
    const sub = await Subscription.findOne({ paystackReference: reference, userId: req.user.userId });
    if (!sub)
      return res.status(404).json({ error: 'Payment record not found.' });

    // Already verified
    if (sub.status === 'active')
      return res.json({ success: true, subscription: sub, alreadyActive: true });

    // Call Paystack verify
    const psRes = await axios.get(
      `${PAYSTACK_BASE}/transaction/verify/${encodeURIComponent(reference)}`,
      { headers: paystackHeaders() }
    );

    const tx = psRes.data?.data;
    if (!psRes.data?.status || !tx)
      return res.status(502).json({ error: 'Could not verify payment with Paystack.' });

    if (tx.status !== 'success')
      return res.status(402).json({ error: `Payment not completed. Status: ${tx.status}` });

    // Activate subscription
    const planConfig = PLANS[sub.plan];
    const now        = new Date();
    const expiresAt  = new Date(now.getTime() + planConfig.durationDays * 86400 * 1000);

    sub.status                = 'active';
    sub.paystackTransactionId = String(tx.id);
    sub.paystackCustomerCode  = tx.customer?.customer_code || '';
    sub.startDate             = now;
    sub.expiresAt             = expiresAt;
    await sub.save();

    console.log(`[payments] Activated ${sub.planName} for user ${req.user.userId} until ${expiresAt.toISOString()}`);

    res.json({ success: true, subscription: sub });

  } catch (err) {
    console.error('[payments] verify error:', err.response?.data || err.message);
    res.status(500).json({ error: err.response?.data?.message || err.message });
  }
});

// ── POST /api/payments/webhook (Paystack server-to-server) ───────────────────
// Verify signature then update subscription status
router.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  try {
    const secret = PAYSTACK_SECRET;
    if (!secret) return res.sendStatus(400);

    const hash = crypto
      .createHmac('sha512', secret)
      .update(req.body)
      .digest('hex');

    if (hash !== req.headers['x-paystack-signature'])
      return res.sendStatus(400);

    const event = JSON.parse(req.body.toString());
    console.log('[payments] webhook event:', event.event);

    if (event.event === 'charge.success') {
      const ref = event.data?.reference;
      if (ref) {
        const sub = await Subscription.findOne({ paystackReference: ref });
        if (sub && sub.status !== 'active') {
          const planConfig = PLANS[sub.plan];
          const now        = new Date();
          sub.status       = 'active';
          sub.startDate    = now;
          sub.expiresAt    = new Date(now.getTime() + planConfig.durationDays * 86400 * 1000);
          sub.paystackTransactionId = String(event.data.id);
          await sub.save();
          console.log(`[payments] webhook activated ${sub.planName} for user ${sub.userId}`);
        }
      }
    }

    res.sendStatus(200);
  } catch (err) {
    console.error('[payments] webhook error:', err.message);
    res.sendStatus(500);
  }
});

module.exports = router;
