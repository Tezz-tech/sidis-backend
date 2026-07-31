// utils/email.js — transactional email via Resend.
//
// Resend over Gmail/nodemailer: Gmail SMTP needs an App Password (only
// possible with 2FA enabled) or OAuth2, and Google frequently flags/blocks
// auth from generic hosting IPs like Vercel's — a recurring source of
// silent send failures. Resend just needs an API key and works reliably
// from serverless.
'use strict';

const { Resend } = require('resend');

const apiKey = (process.env.RESEND_API_KEY || '').trim();
const resend = apiKey ? new Resend(apiKey) : null;

// Works out of the box with no domain setup — swap in your own verified
// domain via RESEND_FROM_EMAIL once you've added one in the Resend dashboard.
const DEFAULT_FROM = process.env.RESEND_FROM_EMAIL || 'Sidis <onboarding@resend.dev>';

if (!resend) {
  console.warn('[email] RESEND_API_KEY not set — emails will be skipped (logged only)');
}

/**
 * Sends a transactional email. Never throws — always returns
 * { sent: boolean, error?: string } so callers can fall back gracefully
 * (e.g. showing the user a copyable link) instead of failing the request.
 */
async function sendEmail({ to, subject, text, html }) {
  if (!resend) {
    console.warn(`[email] Skipped (no RESEND_API_KEY) — would have sent "${subject}" to ${to}`);
    return { sent: false, error: 'Email service is not configured yet.' };
  }

  try {
    const { data, error } = await resend.emails.send({
      from: DEFAULT_FROM,
      to,
      subject,
      text,
      html: html || undefined,
    });

    if (error) {
      console.error('[email] Resend rejected the send:', error.message || error);
      return { sent: false, error: error.message || 'Failed to send email' };
    }

    console.log(`[email] Sent "${subject}" to ${to} (id: ${data?.id})`);
    return { sent: true };
  } catch (err) {
    console.error('[email] Send failed:', err.message);
    return { sent: false, error: err.message };
  }
}

module.exports = sendEmail;
