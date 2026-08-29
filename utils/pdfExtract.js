// utils/pdfExtract.js — shared PDF text extraction via pdf-parse.
//
// pdf-parse's underlying engine (pdfjs-dist) appears to lazily initialize
// something on first use in a fresh process — that first call can
// intermittently fail on a perfectly valid, well-formed PDF with errors like
// "Invalid PDF structure" / "Unknown compression method in flate stream",
// then succeed reliably on every call afterward in that same process.
// Confirmed directly: a fresh process's first pdf-parse call fails, a retry
// on the exact same buffer immediately succeeds, and every call after that
// succeeds on the first try. This is exactly the shape of a Vercel cold
// start, so without a retry this would silently reject valid PDFs as
// "scanned images" for real users. A short retry makes it reliable.
'use strict';

let pdfParse = null;
try       { pdfParse = require('pdf-parse/lib/pdf-parse.js'); }
catch (_) { try { pdfParse = require('pdf-parse'); } catch (_2) {} }

const MAX_ATTEMPTS = 3;

function pdfParseAvailable() {
  return !!pdfParse;
}

/**
 * Extracts text from a PDF buffer. Retries a few times on failure (with a
 * short backoff) before giving up — see the module comment for why.
 * Throws if the parser isn't available, or if every attempt fails.
 */
async function extractPdfText(buffer) {
  if (!pdfParse) throw new Error('PDF parser is not available on this server.');

  let lastErr;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const parsed = await pdfParse(buffer);
      return parsed.text || '';
    } catch (err) {
      lastErr = err;
      if (attempt < MAX_ATTEMPTS) await new Promise(r => setTimeout(r, 250 * attempt));
    }
  }
  throw lastErr;
}

module.exports = { extractPdfText, pdfParseAvailable };
