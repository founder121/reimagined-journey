'use strict';
/**
 * utils/safeHttp.js
 * ════════════════════════════════════════════════════════════════════════════
 * Square Centimeter Ltd | squarecentimeter.co.uk
 *
 * Shared safe HTTP wrapper for all SC agents.
 *
 * Features:
 *   - Configurable timeout (default 10 s per CLAUDE.md operational rule 7)
 *   - Structured error classification:
 *       network_blocked | timeout | auth_required | http_error
 *   - Always returns an HttpResult — never throws
 *   - Logs network failures to data/tracker.md (best-effort)
 *
 * Usage:
 *   const { get, logNetworkFailure } = require('./safeHttp');
 *
 *   const result = await get('https://api.example.com/data');
 *   if (!result.ok) {
 *     logNetworkFailure('agent-name', result.url, result.errorType, result.error);
 *     // handle gracefully
 *   }
 */

const axios = require('axios');
const fs    = require('fs');
const path  = require('path');

// DATA_DIR is not imported at module level to avoid circular deps with fileStore
const DATA_DIR_FALLBACK = path.resolve(__dirname, '..', 'data');

const DEFAULT_TIMEOUT_MS = 10_000;

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Make a safe HTTP GET request.
 * Returns a result object — never throws.
 *
 * @param {string}  url
 * @param {object}  [opts]
 * @param {number}  [opts.timeout=10000]     Timeout in ms
 * @param {object}  [opts.headers]           Request headers
 * @param {object}  [opts.auth]              axios basicAuth {username, password}
 * @param {boolean} [opts.logErrors=true]    Log errors to stderr
 * @returns {Promise<HttpResult>}
 */
async function get(url, opts = {}) {
  /** @type {HttpResult} */
  const result = {
    ok:        false,
    data:      null,
    status:    null,
    error:     null,
    errorType: null,
    url,
  };

  try {
    const res = await axios.get(url, {
      timeout: opts.timeout ?? DEFAULT_TIMEOUT_MS,
      headers: opts.headers ?? { Accept: 'application/json' },
      ...(opts.auth ? { auth: opts.auth } : {}),
      validateStatus: null,   // don't throw on non-2xx
    });

    result.status = res.status;

    if (res.status >= 200 && res.status < 300) {
      result.ok   = true;
      result.data = res.data;
    } else {
      result.error     = `HTTP ${res.status}`;
      result.errorType = classifyStatus(res.status);
    }
  } catch (err) {
    result.status = err.response?.status ?? null;
    result.error  = err.message;
    result.errorType = classifyError(err, result.status);

    if (opts.logErrors !== false) {
      process.stderr.write(`[safeHttp] ${result.errorType} | ${url.slice(0, 100)} | ${err.message}\n`);
    }
  }

  return result;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function classifyStatus(status) {
  if (status === 401 || status === 407) return 'auth_required';
  if (status === 403)                   return 'network_blocked';
  if (status === 429)                   return 'rate_limited';
  if (status >= 500)                    return 'server_error';
  return 'http_error';
}

function classifyError(err, status) {
  const msg = err.message ?? '';
  if (err.code === 'ECONNABORTED' || msg.toLowerCase().includes('timeout')) return 'timeout';
  if (err.code === 'ENOTFOUND' || err.code === 'ECONNREFUSED')              return 'network_blocked';
  if (!err.response)                                                         return 'network_blocked';
  return classifyStatus(status);
}

/**
 * Append a network failure entry to data/tracker.md.
 * Best-effort — never throws.
 *
 * @param {string} agentName
 * @param {string} url
 * @param {string} errorType
 * @param {string} message
 */
function logNetworkFailure(agentName, url, errorType, message) {
  try {
    const dataDir = process.env.DATA_DIR
      ? path.resolve(process.env.DATA_DIR)
      : DATA_DIR_FALLBACK;
    const line = `- ${new Date().toISOString()} | ${agentName} | network_failure | ${errorType} | ${url.slice(0, 100)} | ${String(message).slice(0, 120)}\n`;
    fs.appendFileSync(path.join(dataDir, 'tracker.md'), line, 'utf8');
  } catch (_) { /* best effort */ }
}

module.exports = { get, logNetworkFailure, DEFAULT_TIMEOUT_MS };

/**
 * @typedef {object} HttpResult
 * @property {boolean}     ok          True if request succeeded (2xx)
 * @property {any}         data        Parsed response body (or null)
 * @property {number|null} status      HTTP status code (or null on connection error)
 * @property {string|null} error       Error message (or null on success)
 * @property {string|null} errorType   'network_blocked' | 'timeout' | 'auth_required' | 'rate_limited' | 'server_error' | 'http_error' | null
 * @property {string}      url         The requested URL
 */
