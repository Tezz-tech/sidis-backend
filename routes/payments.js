// routes/payments.js
const express      = require('express');
const router       = express.Router();
const axios        = require('axios');
const crypto       = require('crypto');
const auth         = require('../middlewares/auth');
const Subscription = require('../models/Subscription');
const User         = require('../models/User');
const Quiz         = require('../models/Quiz');
const Referral     = require('../models/Referral');
const DiscountCode = require('../models/DiscountCode');
const { getPlanFeatures, getPlanName, getEffectiveSubscription, getPackageByKey, getAllActivePackages, grantBonusAccessDays } = require('../utils/subscription');
const MAX_GROUP_MEMBERS = 2;

const PAYSTACK_SECRET = process.env.PAYSTACK_SECRET_KEY;
const PAYSTACK_BASE   = 'https://api.paystack.co';

// Referral only ever counts once — findOneAndUpdate's status:'pending'
// filter means a second activation (renewal) for the same user simply
// won't match anything, so this is safe to call on every activation path.
async function convertReferralIfPending(userId, subscriptionId) {
  try {
    const ref = await Referral.findOneAndUpdate(
      { referredId: userId, status: 'pending' },
      { status: 'converted', convertedAt: new Date(), subscriptionId },
      { new: true }
    );
    if (ref) console.log(`[referrals] converted referral ${ref._id} for user ${userId}`);
  } catch (err) {
    console.error('[referrals] conversion error:', err.message);
  }
}

// Checks a discount code against BOTH sources: admin-created global codes
// (DiscountCode collection) and the user's own wallet (User.discounts —
// spin-wheel winnings, streak rewards, or an admin code already redeemed
// ahead of time via POST /payments/redeem-code). An admin code this user has
// already personally redeemed is skipped here on purpose (falls through to
// their wallet instead) so it can never be consumed from the global pool
// twice for the same person. Returns { percentOff, source, code } or { error }.
async function resolveDiscount(code, userId, planKey) {
  const normalized = (code || '').trim().toUpperCase();
  if (!normalized) return { error: 'Enter a discount code.' };

  const adminCode = await DiscountCode.findOne({ code: normalized });
  const alreadyRedeemedByThisUser = !!adminCode?.redeemedBy?.some((id) => id.toString() === String(userId));

  if (adminCode && !alreadyRedeemedByThisUser) {
    if (adminCode.type === 'freeAccess')
      return { error: 'This code grants free access time, not a checkout discount — redeem it from the Discount Randomizer page instead.' };
    if (!adminCode.active) return { error: 'This discount code is no longer active.' };
    if (adminCode.expiresAt && adminCode.expiresAt < new Date()) return { error: 'This discount code has expired.' };
    if (adminCode.maxUses !== null && adminCode.usedCount >= adminCode.maxUses) return { error: 'This discount code has reached its usage limit.' };
    if (adminCode.planKey && adminCode.planKey !== planKey) return { error: `This code only applies to the ${adminCode.planKey} plan.` };
    return { percentOff: adminCode.percentOff, source: 'admin', code: normalized };
  }

  const user = await User.findById(userId).select('discounts').lean();
  const own = (Array.isArray(user?.discounts) ? user.discounts : []).find(d => d.code === normalized);
  if (own) {
    if (own.used) return { error: 'This discount code has already been used.' };
    if (new Date(own.expiresAt) < new Date()) return { error: 'This discount code has expired.' };
    return { percentOff: own.value, source: 'personal', code: normalized };
  }

  return { error: 'Invalid discount code.' };
}

// Marks a redeemed discount as consumed — called only once, right after a
// payment actually activates (never at /prepare time, since the user might
// abandon checkout without paying).
async function redeemDiscountIfApplicable(sub) {
  if (!sub.discountCode) return;
  try {
    if (sub.discountSource === 'admin') {
      await DiscountCode.updateOne({ code: sub.discountCode }, { $inc: { usedCount: 1 } });
    } else if (sub.discountSource === 'personal') {
      await User.updateOne(
        { _id: sub.userId, 'discounts.code': sub.discountCode },
        { $set: { 'discounts.$.used': true } }
      );
    }
  } catch (err) {
    console.error('[payments] discount redemption error:', err.message);
  }
}

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

  const planConfig = await getPackageByKey(sub.plan);
  if (!planConfig) {
    const err = new Error('This plan is no longer available.');
    err.httpStatus = 410;
    throw err;
  }
  const now        = new Date();
  sub.status                = 'active';
  sub.paystackTransactionId = String(tx.id);
  sub.paystackCustomerCode  = tx.customer?.customer_code || '';
  sub.startDate             = now;
  sub.expiresAt             = new Date(now.getTime() + planConfig.durationDays * 86400 * 1000);
  await sub.save();

  console.log(`[payments] activated ${sub.planName} for user ${userId} until ${sub.expiresAt.toISOString()}`);
  await convertReferralIfPending(userId, sub._id);
  await redeemDiscountIfApplicable(sub);
  return { subscription: sub, alreadyActive: false };
}

// ── GET /api/payments/plans (public) ─────────────────────────────────────────
// Admin-managed catalogue — see /api/admin/packages for create/edit/delete.
router.get('/plans', async (req, res) => {
  try {
    const packages = await getAllActivePackages();
    const out = packages.map(p => ({
      key:      p.key,
      name:     p.name,
      amount:   p.amount,
      amountNGN: p.amount / 100,
      durationDays: p.durationDays,
      isGroup:  p.isGroup,
      popular:  p.popular,
      badge:    p.badge,
      color:    p.color,
      displayFeatures: p.displayFeatures,
      access:   p.access,
    }));
    res.json({ success: true, plans: out });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
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
// and usage counters (AI quizzes this month, Sidis IQ uses this month).
router.get('/my-features', auth, async (req, res) => {
  try {
    const { subscription, viaGroup } = await getEffectiveSubscription(req.user.userId);
    const plan     = subscription ? subscription.plan : 'free';
    const features = await getPlanFeatures(plan);

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
      planName:         await getPlanName(plan),
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
    const { plan, discountCode } = req.body;
    const planConfig = plan && await getPackageByKey(plan);
    if (!planConfig || !planConfig.active)
      return res.status(400).json({ error: `Unknown plan: ${plan}` });

    const user = await User.findById(req.user.userId).lean();
    if (!user) return res.status(404).json({ error: 'User not found.' });

    let finalAmount = planConfig.amount;
    let discount = null;
    if (discountCode) {
      discount = await resolveDiscount(discountCode, req.user.userId, plan);
      if (discount.error) return res.status(400).json({ error: discount.error });
      finalAmount = Math.max(0, Math.round(planConfig.amount * (1 - discount.percentOff / 100)));
    }

    const reference  = `SIDIS_${plan}_${req.user.userId}_${Date.now()}`;

    await Subscription.create({
      userId:            req.user.userId,
      plan,
      planName:          planConfig.name,
      amount:            finalAmount,
      status:            'pending',
      paystackReference: reference,
      isGroup:           planConfig.isGroup,
      discountCode:      discount ? discount.code : null,
      discountPercent:   discount ? discount.percentOff : 0,
      discountSource:    discount ? discount.source : null,
      originalAmount:    discount ? planConfig.amount : null,
    });

    res.json({
      success:   true,
      reference,
      email:     user.email,
      amount:    finalAmount,
      amountNGN: finalAmount / 100,
      originalAmountNGN: discount ? planConfig.amount / 100 : null,
      discountPercent: discount ? discount.percentOff : 0,
      planName:  planConfig.name,
      plan,
    });
  } catch (err) {
    console.error('[payments] prepare error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/payments/validate-discount ───────────────────────────────────────
// Lets the frontend preview a code's discount before committing to checkout.
router.get('/validate-discount', auth, async (req, res) => {
  try {
    const { code, plan } = req.query;
    const discount = await resolveDiscount(code, req.user.userId, plan);
    if (discount.error) return res.status(400).json({ error: discount.error });
    res.json({ success: true, percentOff: discount.percentOff });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/payments/best-discount ───────────────────────────────────────────
// The best (highest %) unused, unexpired discount already sitting in this
// user's own wallet, for a given plan — lets checkout auto-apply it instead
// of making the student retype a code they've already redeemed/won.
router.get('/best-discount', auth, async (req, res) => {
  try {
    const user = await User.findById(req.user.userId).select('discounts').lean();
    const now = new Date();
    const usable = (Array.isArray(user?.discounts) ? user.discounts : [])
      .filter(d => !d.used && new Date(d.expiresAt) > now)
      .sort((a, b) => b.value - a.value);
    if (usable.length === 0) return res.json({ success: true, discount: null });
    res.json({ success: true, discount: { code: usable[0].code, percentOff: usable[0].value } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/payments/redeem-code ────────────────────────────────────────────
// Lets a student paste an admin-created code and activate it right away,
// instead of only being able to type it at checkout. A 'percent' code is
// banked into the student's own wallet (same shape as a spin-wheel win) so
// it auto-applies at their next payment; a 'freeAccess' code grants the free
// days immediately (queued after their current plan if they're already paid
// — see grantBonusAccessDays).
router.post('/redeem-code', auth, async (req, res) => {
  try {
    const normalized = (req.body?.code || '').trim().toUpperCase();
    if (!normalized) return res.status(400).json({ error: 'Enter a code.' });

    const dc = await DiscountCode.findOne({ code: normalized });
    if (!dc) return res.status(404).json({ error: 'Invalid code.' });
    if (!dc.active) return res.status(400).json({ error: 'This code is no longer active.' });
    if (dc.expiresAt && dc.expiresAt < new Date()) return res.status(400).json({ error: 'This code has expired.' });
    if (dc.maxUses !== null && dc.usedCount >= dc.maxUses) return res.status(400).json({ error: 'This code has reached its usage limit.' });
    if (dc.redeemedBy.some((id) => id.toString() === String(req.user.userId)))
      return res.status(400).json({ error: "You've already redeemed this code." });

    if (dc.type === 'freeAccess') {
      const { appliedImmediately, expiresAt } = await grantBonusAccessDays(req.user.userId, dc.freeDays, {
        plan: 'promo_pass', planName: `${dc.freeDays}-Day Free Access (${normalized})`,
      });
      dc.usedCount += 1;
      dc.redeemedBy.push(req.user.userId);
      await dc.save();
      return res.json({ success: true, type: 'freeAccess', days: dc.freeDays, appliedImmediately, expiresAt });
    }

    const expiresAt = dc.expiresAt || new Date(Date.now() + 90 * 86400000);
    const newDiscount = {
      id:        `disc_${Date.now()}`,
      label:     `${dc.percentOff}% Off`,
      value:     dc.percentOff,
      rarity:    'common',
      emoji:     '🎁',
      code:      normalized,
      expiresAt: new Date(expiresAt).toISOString(),
      used:      false,
      source:    'admin',
    };
    const user = await User.findById(req.user.userId).select('discounts');
    if (!user) return res.status(404).json({ error: 'User not found.' });
    const currentDiscounts = Array.isArray(user.discounts) ? user.discounts : [];
    await User.updateOne({ _id: req.user.userId }, { $set: { discounts: [...currentDiscounts, newDiscount] } });

    dc.usedCount += 1;
    dc.redeemedBy.push(req.user.userId);
    await dc.save();

    res.json({ success: true, type: 'percent', percentOff: dc.percentOff, discount: newDiscount });
  } catch (err) {
    console.error('[payments] redeem-code error:', err.message);
    res.status(500).json({ error: 'Server error' });
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

    const { plan, callbackUrl, discountCode } = req.body;
    const planConfig = plan && await getPackageByKey(plan);
    if (!planConfig || !planConfig.active)
      return res.status(400).json({ error: `Unknown plan: ${plan}` });

    const user = await User.findById(req.user.userId).lean();
    if (!user) return res.status(404).json({ error: 'User not found.' });

    let finalAmount = planConfig.amount;
    let discount = null;
    if (discountCode) {
      discount = await resolveDiscount(discountCode, req.user.userId, plan);
      if (discount.error) return res.status(400).json({ error: discount.error });
      finalAmount = Math.max(0, Math.round(planConfig.amount * (1 - discount.percentOff / 100)));
    }

    const reference  = `SIDIS_${plan}_${req.user.userId}_${Date.now()}`;

    // Call Paystack initialize
    const psRes = await axios.post(
      `${PAYSTACK_BASE}/transaction/initialize`,
      {
        email:        user.email,
        amount:       finalAmount,
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
      amount:            finalAmount,
      status:            'pending',
      paystackReference: reference,
      isGroup:           planConfig.isGroup,
      discountCode:      discount ? discount.code : null,
      discountPercent:   discount ? discount.percentOff : 0,
      discountSource:    discount ? discount.source : null,
      originalAmount:    discount ? planConfig.amount : null,
    });

    res.json({
      success:           true,
      authorization_url: psRes.data.data.authorization_url,
      reference,
      amount:            finalAmount,
      amountNGN:         finalAmount / 100,
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
          const planConfig = await getPackageByKey(sub.plan);
          if (planConfig) {
            const now        = new Date();
            sub.status       = 'active';
            sub.startDate    = now;
            sub.expiresAt    = new Date(now.getTime() + planConfig.durationDays * 86400 * 1000);
            sub.paystackTransactionId = String(event.data.id);
            await sub.save();
            console.log(`[payments] webhook activated ${sub.planName} for user ${sub.userId}`);
            await convertReferralIfPending(sub.userId, sub._id);
            await redeemDiscountIfApplicable(sub);
          }
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
