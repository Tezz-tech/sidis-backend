const express = require('express');
const router  = express.Router();
const ContactMessage = require('../models/ContactMessage');

// POST /api/support/contact
router.post('/contact', async (req, res) => {
  try {
    const { name, email, phone, subject, message } = req.body;
    if (!name?.trim() || !email?.trim() || !subject?.trim() || !message?.trim())
      return res.status(400).json({ error: 'Name, email, subject, and message are required.' });

    await ContactMessage.create({
      name:    name.trim(),
      email:   email.trim(),
      phone:   phone?.trim() || '',
      subject: subject.trim(),
      message: message.trim(),
    });

    res.json({ success: true, message: 'Message sent successfully.' });
  } catch (err) {
    console.error('Contact form error:', err);
    res.status(500).json({ error: 'Failed to send message. Please try again.' });
  }
});

module.exports = router;
