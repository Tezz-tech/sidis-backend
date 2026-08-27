// utils/ai.js — Single shared AI client for the whole backend.
// All routes import { gemini, capText } from here.
//
// Resilience strategy: every call is tried across a list of models, and
// across every configured API key, before giving up. If a model is
// rate-limited or unavailable, we quietly move to the next model on the same
// key; if a key itself is rejected/suspended, we skip straight to the next
// key. Nothing about the underlying provider, model name, or raw error text
// is ever surfaced to a caller outside this file — every route in the app
// just sees a plain Error with a clean, user-safe message (or a successful
// result), so a provider/model swap here never needs a matching change
// anywhere else, and no response the app sends ever reveals which AI vendor
// or model actually served the request.
'use strict';

const { GoogleGenerativeAI } = require('@google/generative-ai');
require('dotenv').config();

// Tried in this order for every request. Keep the most reliable/cheapest
// model first — later entries are only reached once earlier ones are
// rate-limited or unavailable. An invalid/unreleased model name here is
// harmless: it just fails fast (treated as "unavailable") and we move on.
const MODELS = [
  'gemini-2.5-flash',
  'gemini-3-flash',
  'gemini-3.1-flash-lite',
  'gemini-3.5-flash',
  'gemini-3.5-flash-lite',
  'gemini-3.6-flash',
  'gemini-3.7-flash',
];

const MAX_TRANSIENT_RETRIES = 2; // in-place retries for a genuine transient blip, same model+key
const GENERIC_UNAVAILABLE = 'Our AI assistant is temporarily unavailable. Please try again in a few minutes.';

class AIClient {
  constructor() {
    this._keys = (process.env.GEMINI_API_KEYS || '')
      .split(',').map(k => k.trim()).filter(Boolean);
    this._keyIdx   = 0;
    this._modelIdx = 0;
    this._genAI    = null;
    this._initKey();
  }

  get ready()      { return this._keys.length > 0; }
  get keyCount()   { return this._keys.length; }
  get modelCount() { return MODELS.length; }

  // ── Key / model bookkeeping (internal — never exposed to callers) ──────────
  _initKey() {
    if (!this._keys.length) { this._genAI = null; return; }
    try {
      this._genAI = new GoogleGenerativeAI(this._keys[this._keyIdx]);
    } catch (e) {
      console.error(`[AI] Failed to initialize key ${this._keyIdx + 1}/${this._keys.length}:`, e.message);
      this._genAI = null;
    }
  }

  _advanceModel() {
    this._modelIdx++;
    if (this._modelIdx >= MODELS.length) {
      this._modelIdx = 0;
      this._advanceKey();
    }
  }

  _advanceKey() {
    if (this._keys.length <= 1) return;
    this._keyIdx = (this._keyIdx + 1) % this._keys.length;
    this._initKey();
  }

  // ── Error classification ────────────────────────────────────────────────────
  // Auth/quota-suspension issues are a property of the KEY, not the model —
  // no point trying the other 6 models with a key that's already rejected.
  _isKeyLevelError(err) {
    const s = err?.status;
    const msg = err?.message || '';
    return s === 401 || s === 403 || /CONSUMER_SUSPENDED|PERMISSION_DENIED|API key not valid|API_KEY_INVALID/i.test(msg);
  }
  _isModelUnavailable(err) {
    const s = err?.status;
    const msg = err?.message || '';
    return s === 404 || /not found|not supported|NOT_FOUND/i.test(msg);
  }
  _isRateLimit(err) {
    return err?.status === 429 || /quota|rate.?limit|RESOURCE_EXHAUSTED/i.test(err?.message || '');
  }
  _isTransient(err) {
    const s = err?.status;
    return s === 500 || s === 503 || /unavailable|overloaded|internal server|ECONNRESET|ETIMEDOUT/i.test(err?.message || '');
  }

  _sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  // ── Core call: tries every (key, model) combination before giving up ───────
  async _call(prompt, opts = {}) {
    if (!this.ready) throw new Error(GENERIC_UNAVAILABLE);

    const { jsonMode = false, temperature = 0.7, maxOutputTokens = 8192 } = opts;
    const generationConfig = {
      temperature, topK: 40, topP: 0.95, maxOutputTokens,
      ...(jsonMode ? { responseMimeType: 'application/json' } : {}),
    };

    const totalCombos = this._keys.length * MODELS.length;
    let combosTried = 0;
    let transientRetries = 0;

    while (combosTried < totalCombos) {
      if (!this._genAI) {
        this._advanceKey();
        combosTried += MODELS.length;
        continue;
      }

      const modelName = MODELS[this._modelIdx];
      const keyLabel   = `key ${this._keyIdx + 1}/${this._keys.length}`;

      try {
        const model  = this._genAI.getGenerativeModel({ model: modelName, generationConfig });
        const result = await model.generateContent({ contents: [{ role: 'user', parts: [{ text: prompt }] }] });
        const text   = result.response.text().trim();
        if (!text) throw new Error('Empty response');
        return text;
      } catch (err) {
        if (this._isKeyLevelError(err)) {
          console.warn(`[AI] ${keyLabel} rejected — rotating key. (${err.message})`);
          this._modelIdx = 0;
          this._advanceKey();
          transientRetries = 0;
          combosTried += MODELS.length;
          continue;
        }

        if (this._isTransient(err) && transientRetries < MAX_TRANSIENT_RETRIES) {
          transientRetries++;
          const wait = 700 * transientRetries;
          console.warn(`[AI] Transient error on ${modelName}/${keyLabel} (retry ${transientRetries}/${MAX_TRANSIENT_RETRIES} in ${wait}ms): ${err.message}`);
          await this._sleep(wait);
          continue; // same combo — doesn't consume budget
        }

        const reason = this._isRateLimit(err) ? 'rate-limited'
          : this._isModelUnavailable(err) ? 'unavailable'
          : 'errored';
        console.warn(`[AI] ${modelName}/${keyLabel} ${reason} — trying next model. (${err.message})`);
        transientRetries = 0;
        this._advanceModel();
        combosTried++;
      }
    }

    console.error('[AI] Exhausted every configured model and key for this request.');
    throw new Error(GENERIC_UNAVAILABLE);
  }

  // ── Public: generate JSON ─────────────────────────────────────────────────────
  // Returns a parsed JS object. Throws a clean, generic error if the model
  // response can't be parsed — never echoes raw model output back to callers.
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
      const startBrace   = cleaned.indexOf('{');
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

      console.error('[AI] Non-JSON output could not be parsed:', cleaned.slice(0, 200));
      throw new Error('The AI returned an unexpected response. Please try again.');
    }
  }

  // ── Public: generate plain text ───────────────────────────────────────────────
  async generateText(prompt, opts = {}) {
    return this._call(prompt, { ...opts, jsonMode: false });
  }
}

// ── Singleton ─────────────────────────────────────────────────────────────────
const gemini = new AIClient();
if (gemini.ready) {
  console.log(`[AI] Ready — ${gemini.keyCount} key(s) × ${gemini.modelCount} model(s) configured for automatic failover`);
} else {
  console.warn('[AI] No API keys configured — AI features will be disabled');
}

// ── Token-budget helper ───────────────────────────────────────────────────────
// Clamp user content before embedding in a prompt (input token budget).
function capText(text, maxChars = 30000) {
  if (!text || text.length <= maxChars) return text || '';
  return text.slice(0, maxChars) + '\n[...content truncated to token budget...]';
}

module.exports = { gemini, capText };
