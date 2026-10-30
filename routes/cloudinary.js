// routes/cloudinary.js — issues short-lived signed upload params so the
// browser can upload files directly to Cloudinary instead of through this
// server.
//
// Why this exists: Vercel hard-caps every serverless function's request body
// at 4.5 MB on every plan — not configurable. That's the wall every upload
// page used to run into once a real course PDF or a phone-camera photo went
// past a few MB. Direct-to-Cloudinary uploads bypass it entirely: the
// logged-in browser asks this route for a signed upload spec, then POSTs
// the file straight to Cloudinary, and only the resulting URL ever passes
// through our server.
//
// Replaces the earlier Vercel Blob integration (routes/blob.js), which kept
// failing in production because of a Blob-store/env-var connection issue on
// Vercel's side that proved impossible to keep working reliably.
const express = require('express');
const crypto  = require('crypto');
const router  = express.Router();
const auth    = require('../middlewares/auth');

function signParams(params, apiSecret) {
  const toSign = Object.keys(params).sort().map(k => `${k}=${params[k]}`).join('&');
  return crypto.createHash('sha1').update(toSign + apiSecret).digest('hex');
}

router.post('/signature', auth, (req, res) => {
  const cloudName = process.env.CLOUDINARY_CLOUD_NAME;
  const apiKey    = process.env.CLOUDINARY_API_KEY;
  const apiSecret = process.env.CLOUDINARY_API_SECRET;
  if (!cloudName || !apiKey || !apiSecret) {
    return res.status(500).json({ error: 'File uploads are not configured on the server.' });
  }

  const timestamp = Math.round(Date.now() / 1000);
  const folder = 'sidis-uploads';
  const signature = signParams({ folder, timestamp }, apiSecret);

  res.json({ cloudName, apiKey, timestamp, folder, signature });
});

module.exports = router;
