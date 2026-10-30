// utils/urlExtract.js — fetches a public URL and strips it down to plain
// text. Shared by any AI-generation route that accepts a URL as a source
// (quizzes, flashcards) so the fetch/strip logic only lives in one place.
const axios = require("axios");

async function extractUrlText(targetUrl) {
  const url = (targetUrl || "").trim();
  if (!url.match(/^https?:\/\/.+/)) {
    throw new Error("Please provide a valid URL starting with http:// or https://");
  }

  let html;
  try {
    const response = await axios.get(url, {
      timeout: 15000,
      headers: { "User-Agent": "Mozilla/5.0 (compatible; Sidis/1.0; +https://sidis.app)" },
      maxContentLength: 5 * 1024 * 1024,
      responseType: "text",
    });
    html = response.data || "";
  } catch (urlErr) {
    const msg = urlErr.code === "ECONNREFUSED" ? "Could not connect to the URL — check it is publicly accessible"
              : urlErr.code === "ETIMEDOUT"    ? "URL request timed out — try again or use a faster page"
              : urlErr.response               ? `URL returned status ${urlErr.response.status} — the page may be blocked`
              : "Failed to fetch URL: " + (urlErr.message || "Unknown error");
    throw new Error(msg);
  }

  // Strip scripts, styles, and their contents first
  html = html.replace(/<script[\s\S]*?<\/script>/gi, " ");
  html = html.replace(/<style[\s\S]*?<\/style>/gi, " ");
  // Strip all remaining HTML tags
  html = html.replace(/<[^>]+>/g, " ");
  // Decode common HTML entities
  html = html
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&[a-z]+;/gi, " ");

  const text = html.replace(/\s+/g, " ").trim();
  if (text.length < 200) {
    throw new Error("Not enough readable text found at this URL. Try a different page or paste the text directly.");
  }
  return text;
}

module.exports = { extractUrlText };
