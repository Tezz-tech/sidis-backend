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

// ── Shared verify-then-activate logic ─────────────────────────────────────────
// A client reporting "payment succeeded" is not proof of payment — only
// Paystack's own server-side transaction record is. This is the ONLY path
// that may ever flip a subscription to 'active'; both /activate (the inline
// popup flow) and /verify/:reference (the redirect flow) call into it so
// there is exactly one place that performs real verification, not two paths
// that can silently drift apart (one of which previously trusted the client
// outright and let anyone activate any plan for free).
async function verifyAndActivate(reference, userId) {
  if (!PAYSTACK_SECRET) {
    const err = new Error('Payment service not configured.');
    err.httpStatus = 503;
    throw err;
  }

  const sub = await Subscription.findOne({ paystackReference: reference, userId });
  if (!sub) {
    const err = new Error('Payment record not found.');
    err.httpStatus = 404;
    throw err;
  }
  if (sub.status === 'active') return { subscription: sub, alreadyActive: true };

  const psRes = await axios.get(
    `${PAYSTACK_BASE}/transaction/verify/${encodeURIComponent(reference)}`,
    { headers: paystackHeaders() }
  );
  const tx = psRes.data?.data;
  if (!psRes.data?.status || !tx) {
    const err = new Error('Could not verify payment with Paystack.');
    err.httpStatus = 502;
    throw err;
  }
  if (tx.status !== 'success') {
    const err = new Error(`Payment not completed. Status: ${tx.status}`);
    err.httpStatus = 402;
    throw err;
  }
  // Confirm the amount Paystack actually confirms was charged matches what
  // this plan costs — without this, a tampered client could pay for a
  // cheap plan and activate an expensive one against the same reference flow.
  if (tx.amount !== sub.amount) {
    const err = new Error('Payment amount does not match plan price.');
    err.httpStatus = 402;
    throw err;
  }

  const planConfig = PLANS[sub.plan];
  const now        = new Date();
  sub.status                = 'active';
  sub.paystackTransactionId = String(tx.id);
  sub.paystackCustomerCode  = tx.customer?.customer_code || '';
  sub.startDate             = now;
  sub.expiresAt             = new Date(now.getTime() + planConfig.durationDays * 86400 * 1000);
  await sub.save();

  console.log(`[payments] activated ${sub.planName} for user ${userId} until ${sub.expiresAt.toISOString()}`);
  return { subscription: sub, alreadyActive: false };
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
// Called by frontend immediately after Paystack's popup reports success.
// That client-side report is only a hint to check now — this still verifies
// the transaction with Paystack's own server-side API before activating
// anything. The webhook (below) remains as an independent, delayed safety net.
router.post('/activate', auth, async (req, res) => {
  try {
    const { reference } = req.body;
    if (!reference) return res.status(400).json({ error: 'Reference required' });

    const { subscription, alreadyActive } = await verifyAndActivate(reference, req.user.userId);
    res.json({ success: true, subscription, alreadyActive });
  } catch (err) {
    console.error('[payments] activate error:', err.response?.data || err.message);
    res.status(err.httpStatus || 500).json({ error: err.response?.data?.message || err.message });
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
    const { subscription, alreadyActive } = await verifyAndActivate(req.params.reference, req.user.userId);
    res.json({ success: true, subscription, alreadyActive });
  } catch (err) {
    console.error('[payments] verify error:', err.response?.data || err.message);
    res.status(err.httpStatus || 500).json({ error: err.response?.data?.message || err.message });
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
