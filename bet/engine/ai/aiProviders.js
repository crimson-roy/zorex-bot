/**
 * @file aiProviders.js
 * @module engine/ai/aiProviders
 *
 * @description
 * Adapter layer between the AI orchestration logic (`predictMatch.js`) and
 * the individual AI provider modules (`gemini.js`, `openrouter.js`).
 *
 * This file exists specifically to keep provider-specific quirks — response
 * shapes, method names, request formats — out of the orchestration layer.
 * `predictMatch.js` should never call `gemini.generateContent()` or
 * `openrouter.chatCompletion()` directly; it should only ever call
 * {@link generatePrediction}, which hides which underlying provider (or
 * providers, via fallback) actually served the request.
 *
 * Adding a third AI provider later means:
 *   1. Writing a small adapter function here (following the existing pattern).
 *   2. Registering it in {@link AI_PROVIDER_ADAPTERS}.
 * Nothing in `predictMatch.js` needs to change.
 *
 * @author Zorex Engineering
 */

'use strict';

// TODO: confirm real method names/signatures against the actual gemini.js /
// openrouter.js provider implementations once available. The adapters below
// assume each provider exposes a single primary "generate text" method.
const gemini = require('../../providers/gemini');
const openrouter = require('../../providers/openrouter');

/* -------------------------------------------------------------------------- */
/*  Error types                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Raised when a single AI provider call fails or returns something unusable.
 * Distinct from the aggregate failure raised by {@link generatePrediction}
 * when every provider in the attempt chain has failed.
 */
class AIProviderCallError extends Error {
  /**
   * @param {string} providerName
   * @param {string} message
   * @param {{cause?: unknown}} [meta]
   */
  constructor(providerName, message, meta = {}) {
    super(`[${providerName}] ${message}`);
    this.name = 'AIProviderCallError';
    this.providerName = providerName;
    if (meta.cause) this.cause = meta.cause;
  }
}

/**
 * Raised by {@link generatePrediction} when every provider in the attempt
 * chain failed.
 */
class AllProvidersFailedError extends Error {
  /**
   * @param {string[]} attempted
   * @param {AIProviderCallError[]} failures
   */
  constructor(attempted, failures) {
    super(`All AI providers failed: ${attempted.join(', ')}`);
    this.name = 'AllProvidersFailedError';
    this.attempted = attempted;
    this.failures = failures;
  }
}

/* -------------------------------------------------------------------------- */
/*  Per-provider adapters                                                     */
/* -------------------------------------------------------------------------- */

/**
 * A normalized AI generation result. Every adapter, regardless of provider,
 * resolves to this shape so the orchestration layer never has to branch on
 * "which provider answered."
 *
 * @typedef {Object} AIGenerationResult
 * @property {string} provider - Name of the provider that produced this result.
 * @property {string} text - Plain generated text.
 * @property {unknown} raw - The provider's original, unmodified response, kept for debugging/logging.
 */

/**
 * Calls Gemini and normalizes its response into an {@link AIGenerationResult}.
 *
 * @param {string} prompt
 * @param {Record<string, unknown>} [providerOptions] - Passed through to gemini.generateContent, if supported.
 * @returns {Promise<AIGenerationResult>}
 * @throws {AIProviderCallError}
 */
async function callGemini(prompt, providerOptions = {}) {
  let raw;
  try {
    // TODO: confirm gemini.js's real method name/signature.
    raw = await gemini.generateContent(prompt, providerOptions);
  } catch (err) {
    throw new AIProviderCallError('gemini', 'request failed', { cause: err });
  }

  const text = extractText(raw);
  if (!text) {
    throw new AIProviderCallError('gemini', 'response contained no usable text', { cause: raw });
  }

  return { provider: 'gemini', text, raw };
}

/**
 * Calls OpenRouter and normalizes its response into an {@link AIGenerationResult}.
 *
 * @param {string} prompt
 * @param {Record<string, unknown>} [providerOptions] - Passed through to openrouter.chatCompletion, if supported.
 * @returns {Promise<AIGenerationResult>}
 * @throws {AIProviderCallError}
 */
async function callOpenRouter(prompt, providerOptions = {}) {
  let raw;
  try {
    // TODO: confirm openrouter.js's real method name/signature.
    raw = await openrouter.chatCompletion(prompt, providerOptions);
  } catch (err) {
    throw new AIProviderCallError('openrouter', 'request failed', { cause: err });
  }

  const text = extractText(raw);
  if (!text) {
    throw new AIProviderCallError('openrouter', 'response contained no usable text', { cause: raw });
  }

  return { provider: 'openrouter', text, raw };
}

/**
 * Registry of available AI provider adapters, keyed by name. This is the one
 * place a new provider needs to be registered.
 *
 * @type {Record<string, (prompt: string, providerOptions?: Record<string, unknown>) => Promise<AIGenerationResult>>}
 */
const AI_PROVIDER_ADAPTERS = {
  gemini: callGemini,
  openrouter: callOpenRouter,
};

/* -------------------------------------------------------------------------- */
/*  Public orchestration-facing API                                           */
/* -------------------------------------------------------------------------- */

/**
 * Generates AI text for a prompt, trying each provider in `attemptOrder` in
 * sequence until one succeeds. This is the ONLY function the orchestration
 * layer should call — it deliberately hides which provider ends up serving
 * the request.
 *
 * @param {string} prompt - The fully-built prompt to send.
 * @param {Object} [options={}]
 * @param {string[]} [options.attemptOrder=['gemini', 'openrouter']] - Provider names to try, in order.
 * @param {Record<string, unknown>} [options.providerOptions={}] - Passed through to whichever provider ends up being called.
 * @returns {Promise<AIGenerationResult>}
 * @throws {AllProvidersFailedError} If every provider in `attemptOrder` fails.
 * @throws {TypeError} If `attemptOrder` references an unregistered provider name.
 */
async function generatePrediction(prompt, options = {}) {
  const attemptOrder = options.attemptOrder && options.attemptOrder.length
    ? options.attemptOrder
    : ['gemini', 'openrouter'];

  const unknown = attemptOrder.filter((name) => !AI_PROVIDER_ADAPTERS[name]);
  if (unknown.length) {
    throw new TypeError(`generatePrediction: unregistered AI provider(s): ${unknown.join(', ')}`);
  }

  /** @type {AIProviderCallError[]} */
  const failures = [];

  for (const providerName of attemptOrder) {
    try {
      return await AI_PROVIDER_ADAPTERS[providerName](prompt, options.providerOptions || {});
    } catch (err) {
      failures.push(err instanceof AIProviderCallError ? err : new AIProviderCallError(providerName, String(err)));
    }
  }

  throw new AllProvidersFailedError(attemptOrder, failures);
}

/**
 * Returns the list of currently registered provider names. Useful for
 * validating configuration or building admin/debug tooling.
 *
 * @returns {string[]}
 */
function getAvailableProviders() {
  return Object.keys(AI_PROVIDER_ADAPTERS);
}

/* -------------------------------------------------------------------------- */
/*  Shared helpers                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Best-effort extraction of plain text from a provider's raw response,
 * tolerant of the small shape differences typically seen between AI APIs
 * (string body, `.text`, `.content`, OpenAI-style `.choices[0].message.content`).
 *
 * @param {unknown} raw
 * @returns {string|null}
 */
function extractText(raw) {
  if (typeof raw === 'string') return raw.trim() || null;
  if (raw?.text) return String(raw.text).trim() || null;
  if (raw?.content) return String(raw.content).trim() || null;
  if (raw?.choices?.[0]?.message?.content) return String(raw.choices[0].message.content).trim() || null;
  return null;
}

/* -------------------------------------------------------------------------- */
/*  Exports                                                                    */
/* -------------------------------------------------------------------------- */

module.exports = {
  generatePrediction,
  getAvailableProviders,
  AIProviderCallError,
  AllProvidersFailedError,
};
