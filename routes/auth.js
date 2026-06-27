const express = require('express');
const router = express.Router();
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const User = require('../models/User');
const Subscription = require('../models/Subscription');
const auth = require('../middlewares/auth');

// Signup route
router.post('/signup', async (req, res) => {
  try {
    const { fullName, email, password, phoneNumber } = req.body;
    
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
    
    // Create new user with phone number
    const user = new User({ 
      fullName, 
      email, 
      password: hashedPassword,
      phoneNumber 
    });
    
    await user.save();
    
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

// Forgot password route (if you need it)
router.post('/forgot-password', async (req, res) => {
  try {
    const { email } = req.body;
    
    const user = await User.findOne({ email });
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
    
    // TODO: Implement password reset email logic here
    
    res.json({ message: 'Password reset link sent to email' });
  } catch (error) {
    console.error('Forgot password error:', error);
    res.status(500).json({ error: 'Error processing request' });
  }
});

module.exports = router;