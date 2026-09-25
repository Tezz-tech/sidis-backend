// utils/blobFetch.js — downloads a Vercel Blob URL server-side and returns
// it in the same shape express-fileupload gives a multipart file ({ data,
// mimetype, name }), so every existing extraction path (extractPdfText,
// mammoth, Gemini vision) keeps working unchanged regardless of whether a
// file arrived via the legacy multipart route or a direct-to-blob upload.
//
// Only fetches URLs on Vercel Blob's own storage domain — without this, a
// client could pass any arbitrary URL (an internal service, a metadata
// endpoint) for the server to blindly fetch on its behalf (SSRF).
function isTrustedBlobUrl(url) {
  try {
    const { hostname, protocol } = new URL(url);
    return protocol === 'https:' && hostname.endsWith('.public.blob.vercel-storage.com');
  } catch {
    return false;
  }
}

async function fetchBlobFile(url, displayName) {
  if (!isTrustedBlobUrl(url)) throw new Error('Not a recognised upload URL.');

  const res = await fetch(url);
  if (!res.ok) throw new Error(`Could not retrieve the uploaded file (status ${res.status}).`);

  const arrayBuffer = await res.arrayBuffer();
  const data = Buffer.from(arrayBuffer);
  const mimetype = res.headers.get('content-type') || 'application/octet-stream';
  // Blob storage adds a random suffix to the stored pathname, so prefer the
  // original filename the client sent alongside the URL when available.
  let name = displayName;
  if (!name) {
    try { name = decodeURIComponent(url.split('/').pop().split('?')[0]); } catch { name = 'upload'; }
  }

  return { data, mimetype, name };
}

// Normalizes either upload path into the same { data, mimetype, name }[]
// shape express-fileupload already gives every existing extraction
// function, so route code doesn't need two parallel branches everywhere.
// urlField holds [{ url, name }] (new direct-to-blob uploads); fileField
// holds the legacy multipart file(s), kept working for anything still
// under Vercel's 4.5 MB function body limit.
async function resolveUploadedFiles(req, { fileField, urlField }) {
  const urls = req.body?.[urlField];
  if (Array.isArray(urls) && urls.length > 0) {
    return Promise.all(urls.map(u => fetchBlobFile(u?.url || u, u?.name)));
  }

  const raw = req.files?.[fileField];
  if (raw) return Array.isArray(raw) ? raw : [raw];

  return [];
}

module.exports = { fetchBlobFile, isTrustedBlobUrl, resolveUploadedFiles };
