// utils/ai.js — Single shared Gemini client for the whole backend
// All routes import { gemini, capText } from here.
'use strict';

const { GoogleGenerativeAI } = require('@google/generative-ai');
require('dotenv').config();

const MODEL     = 'gemini-2.5-flash';
const MAX_RETRY = 3;

class GeminiClient {
  constructor() {
    this._keys = (process.env.GEMINI_API_KEYS || '')
      .split(',').map(k => k.trim()).filter(Boolean);
    this._idx   = 0;
    this._model = null;
    this._init();
  }

  // ── Initialisation ────────────────────────────────────────────────────────────
  _init() {
    if (!this._keys.length) {
      console.warn('[AI] GEMINI_API_KEYS not set — AI features will be disabled');
      this._model = null;
      return;
    }
    try {
      const genAI  = new GoogleGenerativeAI(this._keys[this._idx]);
      // No responseMimeType here — we set it per-call so text / JSON can both work
      this._model = genAI.getGenerativeModel({
        model: MODEL,
        generationConfig: { temperature: 0.7, topK: 40, topP: 0.95, maxOutputTokens: 8192 },
      });
      console.log(`[AI] Gemini ready → ${MODEL} (key ${this._idx + 1}/${this._keys.length})`);
    } catch (e) {
      console.error('[AI] Init error:', e.message);
      this._model = null;
    }
  }

  get ready()    { return !!this._model; }
  get keyCount() { return this._keys.length; }

  // ── Key rotation on rate-limit ────────────────────────────────────────────────
  _rotate() {
    if (this._keys.length <= 1) return false;
    this._idx = (this._idx + 1) % this._keys.length;
    this._init();
    console.log(`[AI] Rotated to key ${this._idx + 1}/${this._keys.length}`);
    return true;
  }

  _isRateLimit(err) {
    return err?.status === 429 || /quota|rate.?limit|429/i.test(err?.message || '');
  }
  _isTransient(err) {
    const s = err?.status;
    return s === 503 || s === 500 || /unavailable|overloaded|internal server/i.test(err?.message || '');
  }
  _sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  // ── Core call with retry + rotation ──────────────────────────────────────────
  async _call(prompt, opts = {}) {
    if (!this._model)
      throw new Error('AI not initialized — check GEMINI_API_KEYS in Vercel env vars');

    const { jsonMode = false, temperature = 0.7, maxOutputTokens = 8192 } = opts;

    const generationConfig = {
      temperature,
      topK: 40,
      topP: 0.95,
      maxOutputTokens,
      ...(jsonMode ? { responseMimeType: 'application/json' } : {}),
    };

    let lastErr;
    for (let attempt = 0; attempt < MAX_RETRY; attempt++) {
      try {
        const result = await this._model.generateContent({
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          generationConfig,
        });
        const text = result.response.text().trim();
        if (!text) throw new Error('Empty response from Gemini');
        return text;
      } catch (err) {
        lastErr = err;

        if (this._isRateLimit(err)) {
          const rotated = this._rotate();
          const wait = rotated ? 1000 : 4000 * (attempt + 1);
          console.warn(`[AI] Rate limit (attempt ${attempt + 1}) — ${rotated ? 'rotated key' : `waiting ${wait}ms`}`);
          await this._sleep(wait);

        } else if (this._isTransient(err)) {
          const wait = 2000 * (attempt + 1);
          console.warn(`[AI] Transient error (attempt ${attempt + 1}): ${err.message} — waiting ${wait}ms`);
          await this._sleep(wait);

        } else {
          // Non-retryable (bad key, bad prompt, etc.) — throw immediately
          throw err;
        }
      }
    }
    throw lastErr;
  }

  // ── Public: generate JSON ─────────────────────────────────────────────────────
  // Returns a parsed JS object. Throws if AI returns non-parseable text.
  async generateJSON(prompt, opts = {}) {
    const raw = await this._call(prompt, { ...opts, jsonMode: true });

    // Strip any markdown fences the model might add despite the mime type
    const cleaned = raw
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/```\s*$/i, '')
      .trim();

    try {
      return JSON.parse(cleaned);
    } catch {
      // Fallback: find the outermost JSON structure
      const startBrace  = cleaned.indexOf('{');
      const startBracket = cleaned.indexOf('[');
      const start = startBrace !== -1 && (startBracket === -1 || startBrace < startBracket)
        ? startBrace : startBracket;

      if (start !== -1) {
        const closer = cleaned[start] === '{' ? '}' : ']';
        const end    = cleaned.lastIndexOf(closer);
        if (end > start) {
          try { return JSON.parse(cleaned.slice(start, end + 1)); } catch (_) {}
        }
      }

      const snippet = cleaned.slice(0, 120);
      throw new Error(`Gemini returned non-JSON output: ${snippet}`);
    }
  }

  // ── Public: generate plain text ───────────────────────────────────────────────
  async generateText(prompt, opts = {}) {
    return this._call(prompt, { ...opts, jsonMode: false });
  }
}

// ── Singleton ─────────────────────────────────────────────────────────────────
const gemini = new GeminiClient();

// ── Token-budget helper ───────────────────────────────────────────────────────
// Clamp user content before embedding in a prompt.
// Gemini 2.5 Flash supports ~1M input tokens, but we cap for latency/cost.
function capText(text, maxChars = 30000) {
  if (!text || text.length <= maxChars) return text || '';
  return text.slice(0, maxChars) + '\n[...content truncated to token budget...]';
}

module.exports = { gemini, capText };
