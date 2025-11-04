const nodemailer = require('nodemailer');

// Create reusable transporter object using Gmail SMTP
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.SMTP_EMAIL,
    pass: process.env.SMTP_PASSWORD
  }
});

// Function to send emails
const sendEmail = async ({ to, subject, text }) => {
  try {
    await transporter.sendMail({
      from: `"Tender App" <${process.env.SMTP_EMAIL}>`,
      to,
      subject,
      text
    });
    console.log(`Email sent to ${to}: ${subject}`);
  } catch (err) {
    console.error('Email send error:', err);
    throw new Error('Failed to send email');
  }
};

module.exports = sendEmail;