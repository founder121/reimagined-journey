'use strict';
/**
 * Agent 2 — Lead Finder
 * ─────────────────────
 * Harvests motivated-seller / buyer leads from publicly listed sources
 * defined in config/lead-sources.yml.
 *
 * Only stores legally public data that the property owner voluntarily
 * published in a listing or public filing:
 *   – Property address
 *   – Listing price (if present)
 *   – Source URL
 *   – Lead type (fsbo, expired, preforeclosure, probate, cashbuyer, landlord)
 *
 * Usage:
 *   const leads = require('./agent2-leads');
 *   const records = await leads.run({ source: 'fsbo_zillow', state: 'FL', limit: 50 });
 *
 * CLI:
 *   node index.js leads fsbo --limit 50
 *   node index.js leads expired --type residential
 */

const axios = require('axios');
const cheerio = require('cheerio');
const yaml = require('js-yaml');
const fs = require('fs');
const path = require('path');

const RateLimiter = require('../utils/rateLimiter');
const RobotsChecker = require('../utils/robotsChecker');
const { writeData, listFiles, readData } = require('../utils/fileStore');
const createLogger = require('../utils/logger');

const log = createLogger('agent2-leads');
const CONFIG_PATH = path.resolve(__dirname, '..', 'config', 'lead-sources.yml');
const AGENT_VERSION = '1.0.0';

// ── Main export ──────────────────────────────────────────────────────────────

/**
 * @param {object} opts
 * @param {string} opts.source  key from lead-sources.yml OR a lead type
 *                              ('fsbo', 'expired', etc.) — picks first match
 * @param {string} [opts.state] US state abbreviation
 * @param {string} [opts.city]  city slug (used by craigslist-style sources)
 * @param {number} [opts.limit] max records to return
 * @returns {Promise<object[]>}
 */
async function run({ source, state = 'TX', city, limit } = {}) {
  const config = loadConfig();
  const sourceKey = resolveSourceKey(config, source);
  if (!sourceKey) throw new Error(`Unknown source/type "${source}". Check lead-sources.yml.`);

  const srcCfg = config.sources[sourceKey];
  if (!srcCfg.enabled) {
    log.warn(`Lead source "${sourceKey}" is disabled. Skipping.`);
    return [];
  }

  const defaults = config.defaults || {};
  const delayMs = (srcCfg.rateLimit ?? defaults.rateLimit ?? 3) * 1000;
  const maxRec = limit ?? srcCfg.maxRecords ?? defaults.maxRecords ?? 100;
  const ua = 'RealEstateResearchBot/1.0 (+https://example.com/bot)';

  const limiter = new RateLimiter({ defaultDelay: delayMs });
  const robots = new RobotsChecker(ua);

  // Load existing leads for deduplication
  const dedupeKey = srcCfg.dedupeKey ?? defaults.dedupeKey ?? 'listingUrl';
  const existingKeys = loadExistingKeys(srcCfg.type, dedupeKey);

  const allLeads = [];
  const urls = buildUrls(srcCfg, state, city);

  for (const url of urls) {
    if (allLeads.length >= maxRec) break;
    log.info(`Fetching leads from: ${url}`);

    const allowed = await robots.isAllowed(url);
    if (!allowed) {
      log.warn(`robots.txt disallows ${url} — skipping.`);
      continue;
    }

    await limiter.wait(new URL(url).hostname);

    let html;
    try {
      const res = await axios.get(url, {
        timeout: (srcCfg.timeout ?? defaults.timeout ?? 30_000),
        headers: { 'User-Agent': ua },
      });
      html = res.data;
    } catch (err) {
      log.error(`Failed to fetch ${url}: ${err.message}`);
      continue;
    }

    const parsed = parseLeads(html, srcCfg, sourceKey, url, state);
    const fresh = dedupe(parsed, existingKeys, dedupeKey);
    log.info(`  ${parsed.length} parsed, ${fresh.length} new after dedup`);

    allLeads.push(...fresh.slice(0, maxRec - allLeads.length));

    // Register new keys so intra-run dedup works
    for (const lead of fresh) {
      if (lead[dedupeKey]) existingKeys.add(lead[dedupeKey]);
    }
  }

  log.info(`Total new leads for source "${sourceKey}": ${allLeads.length}`);

  if (allLeads.length > 0) {
    const baseName = `${srcCfg.type}-${sourceKey}-${state.toLowerCase()}`;
    writeData('leads', baseName, allLeads);
  }

  return allLeads;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function loadConfig() {
  return yaml.load(fs.readFileSync(CONFIG_PATH, 'utf8'));
}

/** Accept a source key OR a type name; returns the first enabled matching key. */
function resolveSourceKey(config, input) {
  if (config.sources[input]) return input;
  // Try by type
  for (const [key, src] of Object.entries(config.sources)) {
    if (src.type === input) return key;
  }
  return null;
}

/** Build list of URLs to fetch for this source config. */
function buildUrls(cfg, state, city) {
  const base = cfg.baseUrl || '';
  const tmpl = cfg.searchPath || '';

  // Craigslist-style: multiple cities
  if (cfg.cities && Array.isArray(cfg.cities)) {
    const targetCities = city ? [city] : cfg.cities;
    return targetCities.map((c) =>
      (base.replace('{city}', c) + tmpl).replace('{state}', state),
    );
  }

  // County-loop sources
  if (cfg.counties && !cfg.searchPath) {
    return cfg.counties.map((c) =>
      typeof c === 'object' ? c.url : c,
    );
  }

  const url = `${base}${tmpl}`
    .replace('{state}', encodeURIComponent(state))
    .replace('{city}', city || '');
  return [url];
}

function parseLeads(html, cfg, sourceKey, sourceUrl, state) {
  const $ = cheerio.load(html);
  const sel = cfg.selectors || {};
  const leads = [];

  $(sel.card || '.listing').each((_, el) => {
    const card = $(el);

    const lead = {
      type: cfg.type,
      sourceKey,
      state,
      sourceUrl,
      capturedAt: new Date().toISOString(),
      agentVersion: AGENT_VERSION,
      // Public listing fields only — no private contact info
      address: text(card, sel.address || sel.title),
      price: text(card, sel.price),
      daysOnMarket: text(card, sel.dom),
      listingUrl: href(card, sel.url, cfg.baseUrl),
    };

    if (!lead.address && !lead.listingUrl) return; // skip empty rows
    leads.push(lead);
  });

  return leads;
}

/** Load existing dedupe keys from all files of this lead type. */
function loadExistingKeys(type, dedupeKey) {
  const keys = new Set();
  try {
    const files = listFiles('leads');
    for (const file of files) {
      if (!path.basename(file).startsWith(type)) continue;
      const records = JSON.parse(fs.readFileSync(file, 'utf8'));
      for (const r of records) {
        if (r[dedupeKey]) keys.add(r[dedupeKey]);
      }
    }
  } catch (_) {
    // no existing files — that's fine
  }
  return keys;
}

function dedupe(records, existingKeys, dedupeKey) {
  return records.filter((r) => {
    const k = r[dedupeKey];
    return !k || !existingKeys.has(k);
  });
}

function text(card, selector) {
  if (!selector) return null;
  const val = card.find(selector).first().text().trim();
  return val || null;
}

function href(card, selector, baseUrl = '') {
  if (!selector) return null;
  const raw = card.find(selector).first().attr('href');
  if (!raw) return null;
  return raw.startsWith('http') ? raw : `${baseUrl}${raw}`;
}

// ── CLI shim ─────────────────────────────────────────────────────────────────

async function cli(args) {
  const source = args._[0];
  if (!source) {
    log.error('Usage: leads <source|type> [--state ST] [--limit N]');
    process.exit(1);
  }
  const state = args.state || 'TX';
  const city = args.city || undefined;
  const limit = args.limit ? parseInt(args.limit, 10) : undefined;
  return run({ source, state, city, limit });
}

module.exports = { run, cli };
