const express = require('express');
const router = express.Router();
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const User = require('../models/User');
const Subscription = require('../models/Subscription');
const Referral = require('../models/Referral');
const auth = require('../middlewares/auth');
const sendEmail = require('../utils/email');
const { generateUniqueReferralCode } = require('../utils/referral');

function hashResetToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

// Signup route
router.post('/signup', async (req, res) => {
  try {
    const { fullName, email, password, phoneNumber, referralCode } = req.body;

    // Validate required fields
    if (!fullName || !email || !password || !phoneNumber) {
      return res.status(400).json({ error: 'All fields are required' });
    }

    // Check if user already exists
    const existingUser = await User.findOne({ email });
    if (existingUser) {
      return res.status(400).json({ error: 'Email already exists' });
    }

    // Hash password
    const hashedPassword = await bcrypt.hash(password, 10);

    // A bad/unknown referral code never blocks signup — it's just ignored.
    let referrer = null;
    if (referralCode && referralCode.trim()) {
      referrer = await User.findOne({ referralCode: referralCode.trim().toUpperCase() });
    }

    const ownCode = await generateUniqueReferralCode(fullName);

    // Create new user with phone number
    const user = new User({
      fullName,
      email,
      password: hashedPassword,
      phoneNumber,
      referralCode: ownCode,
      referredBy: referrer ? referrer._id : null,
    });

    await user.save();

    // Referral only ever "counts" once the referred user actually pays —
    // this record starts 'pending' and is flipped to 'converted' from
    // routes/payments.js when that first payment verifies.
    if (referrer) {
      await Referral.create({
        referrerId: referrer._id,
        referredId: user._id,
        code: referrer.referralCode,
      }).catch((e) => console.error('[referrals] signup record error:', e.message));
    }

    // Generate token
    const token = jwt.sign({ userId: user._id }, process.env.JWT_SECRET, { expiresIn: '7d' });

    res.status(201).json({
      token,
      user: {
        id: user._id,
        fullName,
        email,
        phoneNumber
      }
    });
  } catch (error) {
    console.error('Signup error:', error);
    res.status(500).json({ error: 'Error creating user' });
  }
});

// Login route
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    
    // Find user
    const user = await User.findOne({ email });
    if (!user) {
      return res.status(400).json({ error: 'Invalid credentials' });
    }
    
    // Verify password
    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      return res.status(400).json({ error: 'Invalid credentials' });
    }
    
    // Generate token
    const token = jwt.sign({ userId: user._id }, process.env.JWT_SECRET, { expiresIn: '7d' });
    
    res.json({ 
      token, 
      user: { 
        id: user._id, 
        fullName: user.fullName, 
        email,
        phoneNumber: user.phoneNumber 
      } 
    });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Error logging in' });
  }
});

// ── GET /api/auth/profile ─────────────────────────────────────────────────────
router.get('/profile', auth, async (req, res) => {
  try {
    const user = await User.findById(req.user.userId).select('-password').lean();
    if (!user) return res.status(404).json({ error: 'User not found' });

    const now = new Date();
    const subscription = await Subscription.findOne({
      userId: req.user.userId,
      status: 'active',
      $or: [{ expiresAt: null }, { expiresAt: { $gt: now } }],
    }).sort({ createdAt: -1 }).lean();

    res.json({ success: true, user, subscription: subscription || null });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── PATCH /api/auth/profile ───────────────────────────────────────────────────
router.patch('/profile', auth, async (req, res) => {
  try {
    const { fullName, phoneNumber, currentPassword, newPassword } = req.body;
    const user = await User.findById(req.user.userId);
    if (!user) return res.status(404).json({ error: 'User not found' });

    if (fullName?.trim())    user.fullName    = fullName.trim();
    if (phoneNumber?.trim()) user.phoneNumber = phoneNumber.trim();

    if (newPassword) {
      if (!currentPassword)
        return res.status(400).json({ error: 'Current password is required to set a new one.' });
      const match = await bcrypt.compare(currentPassword, user.password);
      if (!match)
        return res.status(400).json({ error: 'Current password is incorrect.' });
      if (newPassword.length < 6)
        return res.status(400).json({ error: 'New password must be at least 6 characters.' });
      user.password = await bcrypt.hash(newPassword, 10);
    }

    await user.save();
    const { password: _pw, ...safe } = user.toObject();
    res.json({ success: true, user: safe });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/auth/forgot-password ────────────────────────────────────────────
// Always responds with the same generic message whether or not the email is
// registered — returning a distinct "User not found" here would let anyone
// probe which emails have Sidis accounts.
router.post('/forgot-password', async (req, res) => {
  const GENERIC_RESPONSE = { message: "If an account exists for that email, we've sent a password reset link." };
  try {
    const email = (req.body?.email || '').trim().toLowerCase();
    if (!email) return res.status(400).json({ error: 'Email is required' });

    const user = await User.findOne({ email });
    if (user) {
      const rawToken = crypto.randomBytes(32).toString('hex');
      user.resetPasswordTokenHash = hashResetToken(rawToken);
      user.resetPasswordExpires   = new Date(Date.now() + 60 * 60 * 1000); // 1 hour
      await user.save();

      const origin = req.headers.origin || process.env.FRONTEND_URL || '';
      const resetLink = `${origin}/reset-password/${rawToken}`;

      await sendEmail({
        to: user.email,
        subject: 'Reset your Sidis password',
        html: `
          <div style="font-family: -apple-system, Segoe UI, Roboto, sans-serif; max-width: 480px; margin: 0 auto; padding: 32px 24px;">
            <h2 style="color:#f97316; margin-bottom: 8px;">Reset your password 🔐</h2>
            <p style="color:#333; font-size:15px; line-height:1.5;">
              We got a request to reset the password for your Sidis account. This link expires in 1 hour.
            </p>
            <p style="margin: 28px 0;">
              <a href="${resetLink}" style="background: linear-gradient(90deg,#f97316,#ec4899); color:#fff; padding:14px 28px; border-radius:12px; text-decoration:none; font-weight:bold; display:inline-block;">
                Reset Password →
              </a>
            </p>
            <p style="color:#999; font-size:12px; line-height:1.5;">
              If the button doesn't work, copy this link: ${resetLink}<br/>
              If you didn't request this, you can safely ignore this email — your password won't change.
            </p>
          </div>
        `,
      });
    }

    res.json(GENERIC_RESPONSE);
  } catch (error) {
    console.error('Forgot password error:', error);
    // Still respond generically — don't let an internal error leak whether the email existed.
    res.json(GENERIC_RESPONSE);
  }
});

// ── POST /api/auth/reset-password ─────────────────────────────────────────────
router.post('/reset-password', async (req, res) => {
  try {
    const { token, newPassword } = req.body;
    if (!token || !newPassword) return res.status(400).json({ error: 'Token and new password are required' });
    if (newPassword.length < 6) return res.status(400).json({ error: 'New password must be at least 6 characters.' });

    const user = await User.findOne({
      resetPasswordTokenHash: hashResetToken(token),
      resetPasswordExpires:   { $gt: new Date() },
    });
    if (!user) return res.status(400).json({ error: 'This reset link is invalid or has expired. Please request a new one.' });

    user.password = await bcrypt.hash(newPassword, 10);
    user.resetPasswordTokenHash = null;
    user.resetPasswordExpires   = null;
    await user.save();

    res.json({ success: true, message: 'Password updated. You can now log in.' });
  } catch (error) {
    console.error('Reset password error:', error);
    res.status(500).json({ error: 'Error processing request' });
  }
});

// ── POST /api/auth/survey ─────────────────────────────────────────────────────
// First-login "what are you here for" survey. Saved server-side (not just
// localStorage) so it persists across devices and can inform recommendations
// elsewhere (AI Tutor, analytics, Study Planner defaults) later.
const VALID_ROLES  = ['student', 'teacher', 'professional'];
const VALID_LEVELS = ['university', 'secondary'];
const VALID_GOALS  = ['exam_prep', 'general_study'];

router.post('/survey', auth, async (req, res) => {
  try {
    const { role, studentLevel, studyGoal } = req.body;
    if (!VALID_ROLES.includes(role))
      return res.status(400).json({ error: 'role must be one of: student, teacher, professional' });
    if (role === 'student' && !VALID_LEVELS.includes(studentLevel))
      return res.status(400).json({ error: 'studentLevel must be one of: university, secondary' });
    if (!VALID_GOALS.includes(studyGoal))
      return res.status(400).json({ error: 'studyGoal must be one of: exam_prep, general_study' });

    const update = {
      role,
      studentLevel: role === 'student' ? studentLevel : null,
      studyGoal,
      surveyCompleted: true,
    };
    await User.updateOne({ _id: req.user.userId }, { $set: update });

    // Where to send a first-timer next — exam-prep goes to the Study Planner
    // onboarding (date/subjects → generated schedule); everyone else goes
    // straight to the dashboard with a short feature tour instead.
    const nextStep = studyGoal === 'exam_prep' ? 'study_planner' : 'dashboard';

    res.json({ success: true, ...update, nextStep });
  } catch (error) {
    console.error('Survey save error:', error);
    res.status(500).json({ error: 'Error saving survey' });
  }
});

module.exports = router;