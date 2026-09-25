// routes/blob.js — issues short-lived tokens so the browser can upload files
// directly to Vercel Blob storage instead of through this server.
//
// Why this exists: Vercel hard-caps every serverless function's request body
// at 4.5 MB on every plan — not configurable. That's the wall every upload
// page used to run into once a real course PDF or a phone-camera photo went
// past a few MB. Client uploads bypass it entirely: the browser exchanges a
// short-lived token with this route, then PUTs the file straight to Blob
// storage, and only the resulting URL ever passes through our server.
//
// This route is deliberately NOT behind the shared `auth` middleware.
// Vercel's own infrastructure calls this same endpoint a second time
// (server-to-server, no user JWT) to report upload completion via
// onUploadCompleted — gating the whole route on auth would 401 that call.
// So the JWT is checked by hand inside onBeforeGenerateToken, which only
// ever runs for the real, browser-initiated token request. The client
// upload() helper has no way to attach a custom Authorization header, so
// the token travels as clientPayload instead — verified with the exact
// same jwt.verify() call the shared `auth` middleware uses.
const express = require('express');
const router  = express.Router();
const jwt     = require('jsonwebtoken');
const { handleUpload } = require('@vercel/blob/client');

// 10 MB app-wide ceiling — the point of this whole route is to get past
// Vercel's 4.5 MB function body limit, so this is a real app-level policy
// choice, not a platform constraint.
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

const ALLOWED_CONTENT_TYPES = [
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document', // .docx
  'image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif',
];

router.post('/upload-token', async (req, res) => {
  try {
    // handleUpload expects a spec-compliant Fetch API Request, not Express's
    // req (whose .headers is a plain object, not a Headers instance) — Node
    // 18+ ships the Fetch API globals, so this is just a faithful rebuild.
    const fullUrl = `${req.protocol}://${req.get('host')}${req.originalUrl}`;
    const fetchRequest = new Request(fullUrl, { method: req.method, headers: req.headers });

    const jsonResponse = await handleUpload({
      body: req.body,
      request: fetchRequest,
      onBeforeGenerateToken: async (pathname, clientPayload) => {
        if (!clientPayload) throw new Error('Not authenticated.');

        let decoded;
        try {
          decoded = jwt.verify(clientPayload, process.env.JWT_SECRET);
        } catch {
          throw new Error('Not authenticated.');
        }

        return {
          allowedContentTypes: ALLOWED_CONTENT_TYPES,
          maximumSizeInBytes: MAX_UPLOAD_BYTES,
          addRandomSuffix: true,
          tokenPayload: JSON.stringify({ userId: decoded.userId }),
        };
      },
      // No DB bookkeeping needed — the browser already has the blob URL from
      // upload()'s return value and passes it straight to whichever
      // create/analyze endpoint it's uploading for.
      onUploadCompleted: async () => {},
    });

    res.json(jsonResponse);
  } catch (err) {
    console.error('[blob] upload-token error:', err.message);
    res.status(400).json({ error: err.message || 'Failed to issue an upload token.' });
  }
});

module.exports = router;
