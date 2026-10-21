// utils/webPush.js — thin wrapper around the `web-push` library so every
// route that wants to notify a user goes through one place: it looks up
// that user's subscriptions, sends to each, and silently prunes any
// subscription the push service reports as gone (expired/uninstalled)
// instead of letting it fail forever on every future send.
'use strict';

const webpush = require('web-push');
const PushSubscription = require('../models/PushSubscription');

const configured = Boolean(process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY);

if (configured) {
  webpush.setVapidDetails(
    `mailto:${process.env.RESEND_FROM_EMAIL?.match(/[\w.-]+@[\w.-]+/)?.[0] || 'noreply@5amas.ng'}`,
    process.env.VAPID_PUBLIC_KEY,
    process.env.VAPID_PRIVATE_KEY
  );
}

function isPushConfigured() {
  return configured;
}

// Sends `{ title, body, url, icon, tag }` to every subscription this user
// has. Returns true if at least one send succeeded.
async function sendPushToUser(userId, { title, body, url = '/', icon = '/icon-192.png', tag } = {}) {
  if (!configured) return false;

  const subs = await PushSubscription.find({ userId }).lean();
  if (subs.length === 0) return false;

  const payload = JSON.stringify({ title, body, url, icon, tag });
  let sentAny = false;

  await Promise.all(subs.map(async (sub) => {
    try {
      await webpush.sendNotification({ endpoint: sub.endpoint, keys: sub.keys }, payload);
      sentAny = true;
    } catch (err) {
      // 404/410 = the push service says this endpoint no longer exists
      // (browser data cleared, app uninstalled, etc.) — stop retrying it.
      if (err.statusCode === 404 || err.statusCode === 410) {
        await PushSubscription.deleteOne({ _id: sub._id }).catch(() => {});
      } else {
        console.error('[webPush] send failed:', err.statusCode, err.message);
      }
    }
  }));

  return sentAny;
}

module.exports = { sendPushToUser, isPushConfigured };
