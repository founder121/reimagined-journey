'use strict';
/**
 * Agent 1 — Web Crawler
 * ─────────────────────
 * Crawls real estate listing portals defined in config/portals.yml.
 * Emits structured property records to data/properties/.
 *
 * Usage (programmatic):
 *   const crawler = require('./agent1-crawler');
 *   const records = await crawler.run({ portal: 'zillow', state: 'TX', pages: 3 });
 *
 * CLI via index.js:
 *   node index.js crawl zillow --state TX --pages 5
 */

const axios = require('axios');
const cheerio = require('cheerio');
const yaml = require('js-yaml');
const fs = require('fs');
const path = require('path');

const RateLimiter = require('../utils/rateLimiter');
const RobotsChecker = require('../utils/robotsChecker');
const { writeData } = require('../utils/fileStore');
const createLogger = require('../utils/logger');

const log = createLogger('agent1-crawler');
const CONFIG_PATH = path.resolve(__dirname, '..', 'config', 'portals.yml');

// ── Main export ──────────────────────────────────────────────────────────────

/**
 * @param {object} opts
 * @param {string} opts.portal   key from portals.yml  (e.g. 'zillow')
 * @param {string} [opts.state]  US state abbreviation (e.g. 'TX')
 * @param {number} [opts.pages]  override maxPages from config
 * @returns {Promise<object[]>}  array of parsed property records
 */
async function run({ portal, state = 'TX', pages } = {}) {
  const config = loadConfig();
  const portalCfg = config.portals[portal];
  if (!portalCfg) throw new Error(`Unknown portal "${portal}". Check portals.yml.`);
  if (!portalCfg.enabled) {
    log.warn(`Portal "${portal}" is disabled in portals.yml. Skipping.`);
    return [];
  }

  const defaults = config.defaults || {};
  const delayMs = (portalCfg.rateLimit ?? defaults.rateLimit ?? 3) * 1000;
  const maxPages = pages ?? portalCfg.maxPages ?? defaults.maxPages ?? 5;
  const ua = portalCfg.userAgent ?? defaults.userAgent ?? 'RealEstateResearchBot/1.0';

  const limiter = new RateLimiter({ defaultDelay: delayMs });
  const robots = new RobotsChecker(ua);

  const allRecords = [];

  for (let page = 1; page <= maxPages; page++) {
    const url = buildUrl(portalCfg, state, page);
    log.info(`Crawling page ${page}/${maxPages}: ${url}`);

    // ── robots.txt check (hard gate) ──────────────────────────────────────
    const allowed = await robots.isAllowed(url);
    if (!allowed) {
      log.warn(`robots.txt disallows ${url} — stopping crawl for "${portal}".`);
      break;
    }

    // ── rate limit ────────────────────────────────────────────────────────
    const hostname = new URL(url).hostname;
    await limiter.wait(hostname);

    // ── fetch ─────────────────────────────────────────────────────────────
    let html;
    try {
      const res = await axios.get(url, {
        timeout: (portalCfg.timeout ?? defaults.timeout ?? 30_000),
        headers: {
          'User-Agent': ua,
          'Accept-Language': 'en-US,en;q=0.9',
          ...(portalCfg.headers || {}),
        },
      });
      html = res.data;
    } catch (err) {
      log.error(`Failed to fetch ${url}: ${err.message}`);
      break;
    }

    // ── parse ─────────────────────────────────────────────────────────────
    const records = parseListings(html, portalCfg, portal, url, state);
    log.info(`  Parsed ${records.length} listings from page ${page}`);
    allRecords.push(...records);

    if (records.length === 0) {
      log.info('  No listings found — assuming last page.');
      break;
    }
  }

  log.info(`Total records crawled for ${portal}/${state}: ${allRecords.length}`);

  if (allRecords.length > 0) {
    writeData('properties', `${portal}-${state.toLowerCase()}`, allRecords);
  }

  return allRecords;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function loadConfig() {
  const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
  return yaml.load(raw);
}

function buildUrl(cfg, state, page) {
  const tmpl = cfg.searchPath
    .replace('{state}', encodeURIComponent(state))
    .replace('{page}', String(page));
  return `${cfg.baseUrl}${tmpl}`;
}

/**
 * Parse listing cards from HTML using portal-specific CSS selectors.
 * Returns an array of plain objects.  No values are invented; missing
 * fields are recorded as null so consumers know they are absent.
 */
function parseListings(html, cfg, portalName, sourceUrl, state) {
  const $ = cheerio.load(html);
  const sel = cfg.selectors || {};
  const records = [];

  $(sel.listingCard || '.listing-card').each((_, el) => {
    const card = $(el);

    const record = {
      portal: portalName,
      state,
      sourceUrl,
      capturedAt: new Date().toISOString(),
      address: text(card, sel.address),
      price: text(card, sel.price),
      beds: text(card, sel.beds),
      baths: text(card, sel.baths),
      sqft: text(card, sel.sqft),
      daysOnMarket: text(card, sel.daysOnMarket),
      listingUrl: href(card, sel.listingUrl, cfg.baseUrl),
      capRate: text(card, sel.capRate) || null,
    };

    // Drop records with no address AND no price (totally empty parse)
    if (!record.address && !record.price) return;

    records.push(record);
  });

  return records;
}

function text(card, selector) {
  if (!selector) return null;
  const val = card.find(selector).first().text().trim();
  return val || null;
}

function href(card, selector, baseUrl) {
  if (!selector) return null;
  const raw = card.find(selector).first().attr('href');
  if (!raw) return null;
  return raw.startsWith('http') ? raw : `${baseUrl}${raw}`;
}

// ── CLI shim (called from index.js) ─────────────────────────────────────────

async function cli(args) {
  const portal = args._[0];
  if (!portal) {
    log.error('Usage: crawl <portal> [--state ST] [--pages N]');
    process.exit(1);
  }
  const state = args.state || args.s || 'TX';
  const pages = args.pages || args.p ? parseInt(args.pages || args.p, 10) : undefined;
  return run({ portal, state, pages });
}

module.exports = { run, cli };
