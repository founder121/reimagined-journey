'use strict';
/**
 * utils/rateLimiter.js
 * Per-domain token-bucket rate limiter.
 *
 * Usage:
 *   const RateLimiter = require('./rateLimiter');
 *   const limiter = new RateLimiter({ defaultDelay: 3000 });
 *   await limiter.wait('www.zillow.com');
 *   // ... make request ...
 */

const createLogger = require('./logger');
const log = createLogger('rateLimiter');

class RateLimiter {
  /**
   * @param {object} opts
   * @param {number} [opts.defaultDelay=3000]  ms between requests (default)
   * @param {Record<string,number>} [opts.domains] per-domain overrides in ms
   */
  constructor({ defaultDelay = 3000, domains = {} } = {}) {
    this.defaultDelay = defaultDelay;
    this.domainConfig = domains;
    /** @type {Map<string, number>} hostname → timestamp of last request */
    this._lastRequest = new Map();
  }

  /**
   * Resolves after honouring the rate limit for the given hostname.
   * @param {string} hostname  e.g. 'www.zillow.com'
   */
  async wait(hostname) {
    const delay = this.domainConfig[hostname] ?? this.defaultDelay;
    const now = Date.now();
    const last = this._lastRequest.get(hostname) ?? 0;
    const elapsed = now - last;
    const remaining = delay - elapsed;

    if (remaining > 0) {
      log.debug(`Rate-limiting ${hostname}: waiting ${remaining} ms`);
      await sleep(remaining);
    }

    this._lastRequest.set(hostname, Date.now());
  }

  /**
   * Override the delay for a specific hostname at runtime.
   * @param {string} hostname
   * @param {number} delayMs
   */
  setDelay(hostname, delayMs) {
    this.domainConfig[hostname] = delayMs;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = RateLimiter;
