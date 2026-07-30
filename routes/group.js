// routes/group.js — group plan membership: the payer invites up to 2 people
// by email onto their active group subscription; once an invited email logs
// in (new or existing account), it inherits the group's plan features for as
// long as the payer's subscription stays active.
const express      = require('express');
const router       = express.Router();
const crypto        = require('crypto');
const auth          = require('../middlewares/auth');
const Subscription  = require('../models/Subscription');
const User          = require('../models/User');

let sendEmail = null;
try { sendEmail = require('../utils/nodemailer'); } catch (_) {}

const MAX_GROUP_MEMBERS = 2; // + the payer = 3 people, matching the plan's marketing copy

function activeGroupQuery(extra = {}) {
  const now = new Date();
  return {
    isGroup: true,
    status: 'active',
    $or: [{ expiresAt: null }, { expiresAt: { $gt: now } }],
    ...extra,
  };
}

// ─── GET /api/group/my-group ────────────────────────────────────────────────
// The caller's own active group subscription + its members, for the
// "Manage Group" panel. null if the caller doesn't own one.
router.get('/my-group', auth, async (req, res) => {
  try {
    const sub = await Subscription.findOne(activeGroupQuery({ userId: req.user.userId }))
      .sort({ createdAt: -1 }).lean();
    if (!sub) return res.json({ success: true, group: null });

    res.json({
      success: true,
      group: {
        plan: sub.plan,
        planName: sub.planName,
        expiresAt: sub.expiresAt,
        seatsUsed: sub.members.length,
        seatsTotal: MAX_GROUP_MEMBERS,
        members: sub.members.map(m => ({
          id: m._id, email: m.email, status: m.status, invitedAt: m.invitedAt, joinedAt: m.joinedAt,
        })),
      },
    });
  } catch (err) {
    console.error('Get my-group error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ─── POST /api/group/invite ─────────────────────────────────────────────────
router.post('/invite', auth, async (req, res) => {
  try {
    const email = (req.body?.email || '').trim().toLowerCase();
    if (!email || !/^\S+@\S+\.\S+$/.test(email)) {
      return res.status(400).json({ error: 'A valid email is required' });
    }

    const sub = await Subscription.findOne(activeGroupQuery({ userId: req.user.userId }));
    if (!sub) return res.status(403).json({ error: 'You need an active group plan to invite members.' });

    const payer = await User.findById(req.user.userId).select('fullName email');
    if (payer.email.toLowerCase() === email) {
      return res.status(400).json({ error: "You can't invite your own email." });
    }
    if (sub.members.some(m => m.email === email)) {
      return res.status(400).json({ error: 'That email is already part of your group.' });
    }
    if (sub.members.length >= MAX_GROUP_MEMBERS) {
      return res.status(400).json({ error: `Your group is full (${MAX_GROUP_MEMBERS} members max).` });
    }

    const inviteToken = crypto.randomBytes(12).toString('hex');
    sub.members.push({ email, inviteToken, status: 'invited' });
    await sub.save();

    const path = `/join-group/${inviteToken}`;

    let emailSent = false;
    if (sendEmail) {
      try {
        await sendEmail({
          to: email,
          subject: `${payer.fullName} invited you to their Sidis ${sub.planName} plan`,
          text: `${payer.fullName} has invited you to join their ${sub.planName} plan on Sidis.\n\nClick the link below to accept — you'll be able to sign up or log in:\n\n(open the Sidis app and go to) ${path}\n\nIf you weren't expecting this, you can ignore this email.`,
        });
        emailSent = true;
      } catch (mailErr) {
        console.warn('[group] invite email failed (non-fatal):', mailErr.message);
      }
    }

    res.json({ success: true, path, emailSent });
  } catch (err) {
    console.error('Invite error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ─── GET /api/group/invite/:token (public) ──────────────────────────────────
router.get('/invite/:token', async (req, res) => {
  try {
    const sub = await Subscription.findOne({ 'members.inviteToken': req.params.token }).lean();
    if (!sub) return res.status(404).json({ error: 'Invite link not found or expired.' });

    const member = sub.members.find(m => m.inviteToken === req.params.token);
    const inviter = await User.findById(sub.userId).select('fullName').lean();

    res.json({
      success: true,
      planName: sub.planName,
      inviterName: inviter?.fullName || 'A Sidis user',
      invitedEmail: member.email,
      alreadyJoined: member.status === 'joined',
      groupActive: sub.status === 'active' && (!sub.expiresAt || new Date(sub.expiresAt) > new Date()),
    });
  } catch (err) {
    console.error('Get invite error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ─── POST /api/group/join/:token ────────────────────────────────────────────
router.post('/join/:token', auth, async (req, res) => {
  try {
    const sub = await Subscription.findOne({ 'members.inviteToken': req.params.token });
    if (!sub) return res.status(404).json({ error: 'Invite link not found or expired.' });

    const member = sub.members.find(m => m.inviteToken === req.params.token);
    if (!member) return res.status(404).json({ error: 'Invite link not found or expired.' });

    const user = await User.findById(req.user.userId).select('email fullName');
    if (user.email.toLowerCase() !== member.email) {
      return res.status(403).json({
        error: `This invite was sent to ${member.email} — please log in with that account instead.`,
      });
    }

    if (member.status !== 'joined') {
      member.userId   = req.user.userId;
      member.status   = 'joined';
      member.joinedAt = new Date();
      await sub.save();
    }

    res.json({ success: true, planName: sub.planName });
  } catch (err) {
    console.error('Join group error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ─── DELETE /api/group/member/:memberId ─────────────────────────────────────
router.delete('/member/:memberId', auth, async (req, res) => {
  try {
    const sub = await Subscription.findOne(activeGroupQuery({ userId: req.user.userId }));
    if (!sub) return res.status(403).json({ error: 'You do not own an active group plan.' });

    const before = sub.members.length;
    sub.members = sub.members.filter(m => m._id.toString() !== req.params.memberId);
    if (sub.members.length === before) return res.status(404).json({ error: 'Member not found.' });

    await sub.save();
    res.json({ success: true });
  } catch (err) {
    console.error('Remove member error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
