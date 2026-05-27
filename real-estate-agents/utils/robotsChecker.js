'use strict';
/**
 * utils/robotsChecker.js
 * Fetches and caches robots.txt for a given origin, then answers
 * whether a given path is allowed for our User-Agent.
 *
 * Usage:
 *   const RobotsChecker = require('./robotsChecker');
 *   const checker = new RobotsChecker('RealEstateResearchBot/1.0');
 *   const ok = await checker.isAllowed('https://www.zillow.com/homes/TX_rb/');
 */

const axios = require('axios');
const createLogger = require('./logger');
const log = createLogger('robotsChecker');

/** Minimal robots.txt rule parser (Disallow / Allow directives). */
class RobotsParser {
  constructor(content, userAgent) {
    this.rules = parseRobots(content, userAgent);
  }

  /** @param {string} path  @returns {boolean} */
  isAllowed(path) {
    let allow = true;
    let longestMatch = 0;

    for (const rule of this.rules) {
      if (matchesPath(rule.path, path)) {
        const matchLen = rule.path.length;
        if (matchLen >= longestMatch) {
          longestMatch = matchLen;
          allow = rule.allow;
        }
      }
    }
    return allow;
  }
}

class RobotsChecker {
  /**
   * @param {string} userAgent  – must match what you send in requests
   * @param {number} [cacheTtlMs=3600000]  – 1 hour default
   */
  constructor(userAgent = '*', cacheTtlMs = 3_600_000) {
    this.userAgent = userAgent;
    this.cacheTtl = cacheTtlMs;
    /** @type {Map<string, { parser: RobotsParser, fetchedAt: number }>} */
    this._cache = new Map();
  }

  /**
   * Returns true if `url` may be crawled.
   * Always returns true if robots.txt cannot be fetched (fail-open safety;
   * the calling agent should still honour its rate limit).
   * @param {string} url
   * @returns {Promise<boolean>}
   */
  async isAllowed(url) {
    const parsed = new URL(url);
    const origin = parsed.origin; // e.g. https://www.zillow.com
    const path = parsed.pathname + parsed.search;

    const parser = await this._getParser(origin);
    if (!parser) return true; // fail-open if robots.txt unreachable

    const allowed = parser.isAllowed(path);
    if (!allowed) {
      log.warn(`robots.txt DISALLOWS ${url}`);
    }
    return allowed;
  }

  async _getParser(origin) {
    const cached = this._cache.get(origin);
    if (cached && Date.now() - cached.fetchedAt < this.cacheTtl) {
      return cached.parser;
    }

    const robotsUrl = `${origin}/robots.txt`;
    try {
      log.debug(`Fetching ${robotsUrl}`);
      const res = await axios.get(robotsUrl, {
        timeout: 10_000,
        headers: { 'User-Agent': this.userAgent },
        validateStatus: (s) => s < 500,
      });

      const text = res.status === 200 ? res.data : '';
      const parser = new RobotsParser(text, this.userAgent);
      this._cache.set(origin, { parser, fetchedAt: Date.now() });
      return parser;
    } catch (err) {
      log.warn(`Could not fetch ${robotsUrl}: ${err.message}. Proceeding.`);
      return null;
    }
  }
}

// ── helpers ─────────────────────────────────────────────────────────────────

/**
 * Parse robots.txt content into an ordered list of rules relevant to ua.
 * @param {string} text
 * @param {string} ua
 * @returns {{ allow: boolean, path: string }[]}
 */
function parseRobots(text, ua) {
  const rules = [];
  const lines = text.split(/\r?\n/);
  let active = false;
  const uaLower = ua.toLowerCase();

  for (const raw of lines) {
    const line = raw.split('#')[0].trim();
    if (!line) continue;

    if (line.toLowerCase().startsWith('user-agent:')) {
      const agent = line.slice('user-agent:'.length).trim().toLowerCase();
      active = agent === '*' || uaLower.startsWith(agent) || agent === uaLower;
      continue;
    }

    if (!active) continue;

    if (line.toLowerCase().startsWith('disallow:')) {
      const path = line.slice('disallow:'.length).trim();
      if (path) rules.push({ allow: false, path });
    } else if (line.toLowerCase().startsWith('allow:')) {
      const path = line.slice('allow:'.length).trim();
      if (path) rules.push({ allow: true, path });
    }
  }

  return rules;
}

/** Simple prefix / wildcard robots.txt path matching. */
function matchesPath(rulePath, requestPath) {
  // Treat '$' as end-of-string anchor
  const anchor = rulePath.endsWith('$');
  const pattern = anchor ? rulePath.slice(0, -1) : rulePath;

  if (!pattern.includes('*')) {
    return anchor
      ? requestPath === pattern
      : requestPath.startsWith(pattern);
  }

  // Convert wildcard to regex
  const escaped = pattern.replace(/[.+?^{}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  const re = new RegExp(anchor ? `^${escaped}$` : `^${escaped}`);
  return re.test(requestPath);
}

module.exports = RobotsChecker;
