'use strict';
/**
 * Agent 1 — Property Scout
 * ════════════════════════════════════════════════════════════════════════════
 * Square Centimeter Ltd | squarecentimeter.co.uk
 *
 * Scans prime London residential listing portals and surfaces investment
 * opportunities for Julian Noble and the advisory team.
 *
 * Portals configured in config/portals.yml:
 *   rightmove · zoopla · onthemarket · knightfrank · savills · jll
 *
 * Output (per run):
 *   data/raw/listings-YYYY-MM-DD.json   – structured records
 *   data/raw/listings-YYYY-MM-DD.csv    – flat export
 *   data/scan-history.tsv              – cumulative log
 *   data/tracker.md                    – human-readable activity log
 *
 * Compliance (non-negotiable):
 *   • robots.txt checked before every request (hard gate — never bypassed)
 *   • Rate limit: 1 req/s per domain + 50–300 ms random jitter
 *   • Retry: exponential back-off up to `retries` attempts per page
 *   • agent-browser fallback for JS-rendered portals (jsRendered: true)
 *   • No hallucinated data — only values parsed from real HTML/JSON
 *
 * Usage:
 *   const scout = require('./agent1-crawler');
 *   const records = await scout.run({ portal: 'rightmove', minPrice: 750000 });
 *   const records = await scout.run({ portal: 'all', dryRun: true });
 */

const axios   = require('axios');
const cheerio = require('cheerio');
const yaml    = require('js-yaml');
const fs      = require('fs');
const path    = require('path');
const { execSync } = require('child_process');

const RateLimiter   = require('../utils/rateLimiter');
const RobotsChecker = require('../utils/robotsChecker');
const { writeData, DATA_DIR } = require('../utils/fileStore');
const createLogger  = require('../utils/logger');

const log           = createLogger('agent1-crawler');
const AGENT_VERSION = '1.0.0';
const CONFIG_PATH   = path.resolve(__dirname, '..', 'config', 'portals.yml');

// ── London market zones ───────────────────────────────────────────────────────
// Postcode prefix → zone mapping for flagging
const ZONE_MAP = {
  PCL:      ['SW1', 'SW3', 'SW7', 'SW10', 'W1', 'W8', 'WC2', 'EC1', 'E1W', 'NW1', 'NW8'],
  POL:      ['SW6', 'SW11', 'W2', 'W4', 'W6', 'W9', 'W11', 'W12', 'W14', 'E2', 'N1', 'SE1', 'SE11'],
  EMERGING: ['SW8', 'SW9', 'SE10', 'E14', 'E20', 'W12', 'N1C'],
};

// ── CSV column order ──────────────────────────────────────────────────────────
const CSV_HEADERS = [
  'portal', 'area', 'capturedAt', 'agentVersion',
  'address', 'postcode', 'marketZone',
  'price', 'tenure',
  'beds', 'baths', 'sqft', 'sqm', 'pricePerSqft',
  'serviceCharge', 'groundRent', 'leaseYearsRemaining',
  'developer', 'daysOnMarket', 'priceReduced',
  'epcRating', 'listingUrl', 'sourceUrl',
  'flags',
];

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Scan one or more portals for prime London listings.
 *
 * @param {object}   opts
 * @param {string}   [opts.portal='all']  Portal key or 'all' for every enabled portal
 * @param {string[]} [opts.areas]         Override portal areas list
 * @param {number}   [opts.minPrice]      £ minimum price filter
 * @param {number}   [opts.maxPrice]      £ maximum price filter
 * @param {number}   [opts.pages]         Override portal maxPages
 * @param {boolean}  [opts.dryRun=false]  Validate config without HTTP calls
 * @returns {Promise<object[]>}           Array of parsed listing records
 */
async function run({ portal = 'all', areas, minPrice, maxPrice, pages, dryRun = false } = {}) {
  const config   = loadConfig();
  const defaults = config.defaults || {};

  const portalKeys = portal === 'all'
    ? Object.keys(config.portals).filter((k) => config.portals[k].enabled)
    : [portal];

  if (portalKeys.length === 0) {
    log.warn('No enabled portals found. Check portals.yml.');
    return [];
  }

  if (dryRun) {
    log.info(`[DRY RUN] Would scan: ${portalKeys.join(', ')}`);
    for (const k of portalKeys) validatePortalConfig(config.portals[k], k, defaults);
    return [];
  }

  log.info(`Starting scan: portals=[${portalKeys.join(', ')}]${minPrice ? ` minPrice=£${minPrice.toLocaleString()}` : ''}`);

  const allRecords = [];

  for (const key of portalKeys) {
    const cfg = config.portals[key];
    if (!cfg) { log.warn(`Unknown portal "${key}" — skipping.`); continue; }
    if (!cfg.enabled) { log.info(`Portal "${key}" disabled — skipping.`); continue; }

    log.info(`\n━━━ Portal: ${key} ━━━`);
    const records = await scanPortal({ key, cfg, defaults, areas, minPrice, maxPrice, pages });
    allRecords.push(...records);
  }

  // ── Persist output ───────────────────────────────────────────────────────
  if (allRecords.length > 0) {
    const date = todayStr();
    writeData('raw', `listings-${date}`, allRecords);
    writeCsv('raw', `listings-${date}`, allRecords);
    appendScanHistory(portalKeys, allRecords.length);
  }

  appendTracker(`Agent 1 scan complete — ${allRecords.length} listings from [${portalKeys.join(', ')}]`);
  log.info(`\n✓ Scan complete. Total listings: ${allRecords.length}`);
  return allRecords;
}

/**
 * Return metadata for all configured portals (for the `sc list` command).
 * @param {boolean} [enabledOnly=false]
 * @returns {{ key, enabled, baseUrl, areas, rateLimit, jsRendered }[]}
 */
function listPortals(enabledOnly = false) {
  const config = loadConfig();
  return Object.entries(config.portals)
    .filter(([, cfg]) => !enabledOnly || cfg.enabled)
    .map(([key, cfg]) => ({
      key,
      enabled:    cfg.enabled,
      baseUrl:    cfg.baseUrl,
      areaCount:  (cfg.areas ?? []).length,
      rateLimit:  cfg.rateLimit,
      jsRendered: cfg.jsRendered ?? false,
    }));
}

// ── Portal scan loop ──────────────────────────────────────────────────────────

async function scanPortal({ key, cfg, defaults, areas, minPrice, maxPrice, pages }) {
  const delayMs    = (cfg.rateLimit    ?? defaults.rateLimit    ?? 1)   * 1000;
  const maxPg      = pages ?? cfg.maxPages ?? defaults.maxPages ?? 5;
  const ua         = cfg.userAgent     ?? defaults.userAgent    ?? 'SquareCentimeterBot/1.0';
  const retries    = cfg.retries       ?? defaults.retries      ?? 2;
  const retryDelay = (cfg.retryDelay   ?? defaults.retryDelay   ?? 6)   * 1000;
  const scanAreas  = areas ?? cfg.areas ?? [];

  if (scanAreas.length === 0) {
    log.warn(`  Portal "${key}" has no areas configured — skipping.`);
    return [];
  }

  const limiter = new RateLimiter({ defaultDelay: delayMs });
  const robots  = new RobotsChecker(ua);
  const records = [];

  for (const area of scanAreas) {
    const areaName = area.name ?? area;
    log.info(`  ▸ Area: ${areaName}`);

    for (let page = 1; page <= maxPg; page++) {
      const url = buildUrl(cfg, { locationId: area.locationId ?? area, page, minPrice, maxPrice });
      log.info(`    [${key}] ${areaName} pg${page} → ${url}`);

      // ── robots.txt gate (hard — never skip) ─────────────────────────────
      const allowed = await robots.isAllowed(url);
      if (!allowed) {
        log.warn(`    robots.txt disallows ${url} — stopping "${key}/${areaName}".`);
        break;
      }

      // ── rate limit + jitter ──────────────────────────────────────────────
      const hostname = new URL(url).hostname;
      await limiter.wait(hostname);
      await jitter();

      // ── fetch with retry ─────────────────────────────────────────────────
      let html;
      try {
        html = await fetchWithRetry(url, cfg, ua, retries, retryDelay);
      } catch (err) {
        log.error(`    Fetch error (${areaName} pg${page}): ${err.message} — skipping page.`);
        continue;           // skip page, never abort the whole scan
      }

      // ── parse ─────────────────────────────────────────────────────────────
      const pageRecords = parseListings(html, cfg, key, url, areaName);
      log.info(`    Parsed ${pageRecords.length} listings`);

      if (pageRecords.length === 0) {
        log.info(`    Empty page — assuming last page for this area.`);
        break;
      }

      records.push(...pageRecords);
    }
  }

  log.info(`  Portal "${key}" subtotal: ${records.length}`);
  return records;
}

// ── Fetch: axios + agent-browser fallback ─────────────────────────────────────

/**
 * Fetch URL with automatic retry and agent-browser fallback.
 * Retry schedule: retryDelayMs, retryDelayMs×2, retryDelayMs×4, …
 */
async function fetchWithRetry(url, cfg, ua, retries = 2, retryDelayMs = 6000) {
  let lastErr;

  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) {
      const wait = retryDelayMs * (2 ** (attempt - 1));
      log.debug(`    Retry ${attempt}/${retries} in ${wait}ms…`);
      await sleep(wait);
    }

    // JS-rendered portals go straight to agent-browser on first attempt
    if (cfg.jsRendered) {
      try { return await fetchWithBrowser(url); } catch (e) { lastErr = e; continue; }
    }

    try {
      const res = await axios.get(url, {
        timeout: cfg.timeout ?? 30_000,
        headers: {
          'User-Agent':      ua,
          Accept:            'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-GB,en;q=0.9',
          'Accept-Encoding': 'gzip, deflate, br',
          ...(cfg.headers || {}),
        },
        maxRedirects: 5,
      });

      // Detect bot challenges / empty shells — fall back to browser
      if (looksBlocked(res.data, res.status)) {
        log.debug(`    Response looks blocked (status ${res.status}) — trying agent-browser`);
        try { return await fetchWithBrowser(url); } catch (bErr) { lastErr = bErr; continue; }
      }

      return res.data;

    } catch (err) {
      lastErr = err;

      const status = err.response?.status;
      if (status === 403 || status === 429 || status === 503) {
        log.warn(`    HTTP ${status} — trying agent-browser`);
        try { return await fetchWithBrowser(url); } catch (bErr) { lastErr = bErr; }
      }
    }
  }

  throw lastErr ?? new Error('fetch failed after all retries');
}

/**
 * Fetch a URL via agent-browser (headless Chrome).
 * Requires `agent-browser` installed globally (npm install -g agent-browser).
 * The browser session persists between execSync calls within this function.
 */
async function fetchWithBrowser(url) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('agent-browser timeout')), 55_000);

    try {
      // 1. Open page and wait for network idle
      execSync(`agent-browser open "${url}" --wait networkidle`, {
        timeout: 35_000,
        stdio: 'pipe',
      });

      // 2. Extract the fully-rendered HTML from the page context
      const html = execSync(
        `agent-browser eval "document.documentElement.outerHTML"`,
        { timeout: 15_000, encoding: 'utf8', stdio: 'pipe' },
      );

      clearTimeout(timer);
      resolve(html);
    } catch (err) {
      clearTimeout(timer);
      reject(new Error(`agent-browser: ${err.stderr?.toString().trim() ?? err.message}`));
    } finally {
      // Always close the session to free resources
      try { execSync('agent-browser close', { stdio: 'pipe', timeout: 5_000 }); } catch (_) {}
    }
  });
}

// ── URL builder ───────────────────────────────────────────────────────────────

/**
 * Construct the search URL for a given portal, area and page.
 * Handles both 'offset' (Rightmove-style) and 'number' (Zoopla-style) pagination.
 */
function buildUrl(cfg, { locationId, page, minPrice, maxPrice }) {
  const min = minPrice  ?? cfg.defaultMinPrice ?? 500000;
  const max = maxPrice  ?? cfg.defaultMaxPrice ?? '';
  const rpp = cfg.resultsPerPage ?? 24;

  // Page 1 offset = 0; page N offset = (N-1)*rpp
  const offset = (page - 1) * rpp;

  // locationId values in portals.yml are already formatted for the target URL
  // (e.g. Rightmove uses pre-encoded "OUTCODE%5E1036"; Zoopla uses raw "sw1").
  // Do NOT call encodeURIComponent here or it will double-encode percent signs.
  let url = `${cfg.baseUrl}${cfg.searchPath}`
    .replace('{locationId}', locationId)
    .replace('{minPrice}',    String(min))
    .replace('{maxPrice}',    String(max))
    .replace('{offset}',      String(offset))
    .replace('{page}',        String(page));

  // Clean up double-encoded percent or empty trailing tokens
  url = url.replace(/&&+/g, '&').replace(/\?&/, '?').replace(/&$/, '');

  return url;
}

// ── HTML parser ───────────────────────────────────────────────────────────────

/**
 * Extract listing records from a portal HTML page.
 * Uses CSS selectors from portals.yml. Missing fields → null (never invented).
 */
function parseListings(html, cfg, portalName, sourceUrl, areaName) {
  const $ = cheerio.load(html);
  const sel = cfg.selectors || {};
  const records = [];

  if (!sel.listingCard) {
    log.warn(`  No listingCard selector for "${portalName}" — check portals.yml`);
    return records;
  }

  // Try JSON-LD first — richer, more stable than CSS selectors
  const jsonLdItems = extractAllJsonLd($);

  $(sel.listingCard).each((idx, el) => {
    const card = $(el);

    const rawAddress = text(card, sel.address);
    const rawPrice   = text(card, sel.price);
    const listingUrl = href(card, sel.listingUrl, cfg.baseUrl);

    // Skip cards that yielded absolutely nothing
    if (!rawAddress && !rawPrice && !listingUrl) return;

    // Supplement from JSON-LD if available for this index
    const ld = jsonLdItems[idx] ?? null;

    const priceNum  = parsePrice(rawPrice ?? ld?.offers?.price);
    const sqftRaw   = text(card, sel.sqft) ?? text(card, sel.sqm);
    const sqftNum   = parseSqft(sqftRaw);
    const sqmNum    = sqftToSqm(sqftNum);
    const domStr    = text(card, sel.daysOnMarket);

    const record = {
      // Provenance
      portal:       portalName,
      area:         areaName,
      capturedAt:   new Date().toISOString(),
      agentVersion: AGENT_VERSION,
      sourceUrl,

      // Location
      address:  rawAddress ?? ld?.name ?? null,
      postcode: extractPostcode(rawAddress ?? ld?.address?.postalCode),

      // Price & tenure
      price:    priceNum,
      rawPrice: rawPrice,
      tenure:   normaliseTenure(text(card, sel.tenure) ?? ld?.tenure),

      // Property attributes
      beds:             parseIntOrNull(text(card, sel.beds)  ?? ld?.numberOfBedrooms),
      baths:            parseIntOrNull(text(card, sel.baths) ?? ld?.numberOfBathroomsTotal),
      sqft:             sqftNum,
      sqm:              sqmNum,
      pricePerSqft:     priceNum && sqftNum ? Math.round(priceNum / sqftNum) : null,

      // Leasehold specifics (critical for prime London flats)
      serviceCharge:       text(card, sel.serviceCharge)   ?? null,
      groundRent:          text(card, sel.groundRent)       ?? null,
      leaseYearsRemaining: parseIntOrNull(text(card, sel.leaseYears)),

      // Vendor & market signals
      developer:    text(card, sel.developer) ?? text(card, sel.agent) ?? null,
      daysOnMarket: parseDom(domStr),
      priceReduced: detectPriceReduction(card, sel.priceReduced),
      epcRating:    text(card, sel.epcRating) ?? null,

      // URL
      listingUrl,

      // Computed (populated below)
      flags:      [],
      marketZone: null,
    };

    record.marketZone = computeMarketZone(record.postcode);
    record.flags      = computeFlags(record);

    records.push(record);
  });

  return records;
}

// ── Flags & zones ─────────────────────────────────────────────────────────────

function computeFlags(record) {
  const flags = [];

  if (record.marketZone === 'PCL')      flags.push('pcl');
  if (record.marketZone === 'POL')      flags.push('pol');
  if (record.marketZone === 'EMERGING') flags.push('emerging');

  if (record.daysOnMarket != null && record.daysOnMarket >= 90)  flags.push('motivated_vendor');
  if (record.priceReduced)                                        flags.push('price_reduced');
  if (record.priceReduced && record.daysOnMarket >= 30)           flags.push('price_drop_stale');

  if (record.tenure === 'leasehold') {
    const ly = record.leaseYearsRemaining ?? 999;
    if (ly < 85)  flags.push('short_lease');
    if (ly < 70)  flags.push('critical_lease');
    if (ly < 80)  flags.push('lease_extension_opportunity');
  }

  if (record.developer)  flags.push('new_development');

  // Off-market signal: no listing URL or private source
  if (!record.listingUrl || record.listingUrl.includes('/off-market/')) {
    flags.push('off_market_indicator');
  }

  return flags;
}

function computeMarketZone(postcode) {
  if (!postcode) return null;
  const pc = postcode.toUpperCase();
  for (const [zone, prefixes] of Object.entries(ZONE_MAP)) {
    if (prefixes.some((p) => pc.startsWith(p))) return zone;
  }
  return 'OTHER';
}

// ── CSV output ────────────────────────────────────────────────────────────────

function writeCsv(subdir, baseName, records) {
  const dir  = path.join(DATA_DIR, subdir);
  fs.mkdirSync(dir, { recursive: true });
  const dest = path.join(dir, `${baseName}.csv`);
  const tmp  = `${dest}.tmp`;

  const lines = [
    CSV_HEADERS.join(','),
    ...records.map((r) =>
      CSV_HEADERS.map((col) => {
        const v = r[col];
        if (v === null || v === undefined) return '';
        if (Array.isArray(v)) return csvEscape(v.join('|'));
        return csvEscape(String(v));
      }).join(','),
    ),
  ];

  fs.writeFileSync(tmp, lines.join('\n') + '\n', 'utf8');
  fs.renameSync(tmp, dest);
  log.info(`CSV written → ${dest}`);
  return dest;
}

// ── Audit trail ───────────────────────────────────────────────────────────────

function appendScanHistory(portalKeys, count) {
  const tsvPath = path.join(DATA_DIR, 'scan-history.tsv');
  const needsHeader = !fs.existsSync(tsvPath);

  fs.mkdirSync(path.dirname(tsvPath), { recursive: true });

  const header = needsHeader ? 'timestamp\tportals\trecords_collected\n' : '';
  const row    = [new Date().toISOString(), portalKeys.join(','), String(count)].join('\t');
  fs.appendFileSync(tsvPath, `${header}${row}\n`, 'utf8');
}

function appendTracker(message) {
  const trackerPath = path.join(DATA_DIR, 'tracker.md');
  fs.mkdirSync(path.dirname(trackerPath), { recursive: true });
  const entry = `- ${new Date().toISOString()} | Agent 1 | ${message}\n`;
  fs.appendFileSync(trackerPath, entry, 'utf8');
}

// ── Config & validation ───────────────────────────────────────────────────────

function loadConfig() {
  return yaml.load(fs.readFileSync(CONFIG_PATH, 'utf8'));
}

function validatePortalConfig(cfg, key, defaults = {}) {
  if (!cfg) {
    log.warn(`[DRY RUN] Portal "${key}" not found in portals.yml`);
    return;
  }

  const issues = [];
  if (!cfg.selectors?.listingCard) issues.push('missing selectors.listingCard');
  if (!(cfg.areas?.length))        issues.push('no areas configured');
  if (!cfg.baseUrl)                issues.push('missing baseUrl');
  if (!cfg.searchPath)             issues.push('missing searchPath');

  if (issues.length) {
    log.warn(`[DRY RUN] "${key}" config issues: ${issues.join(', ')}`);
  } else {
    log.info(`[DRY RUN] "${key}" OK — enabled=${cfg.enabled}, areas=${cfg.areas.length}, jsRendered=${cfg.jsRendered ?? false}`);
  }
}

// ── Parsing helpers ───────────────────────────────────────────────────────────

function looksBlocked(html, status = 200) {
  if (status === 403 || status === 429) return true;
  if (typeof html !== 'string')         return true;
  if (html.length < 1500)              return true;
  return (
    html.includes('cf-challenge')  ||
    html.includes('__cf_chl')      ||
    html.includes('challenge-form') ||
    html.includes('captcha')       ||
    (html.includes('<html') && !html.includes('<body'))
  );
}

function extractAllJsonLd($) {
  const items = [];
  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      const parsed = JSON.parse($(el).html() ?? '');
      if (Array.isArray(parsed)) items.push(...parsed);
      else items.push(parsed);
    } catch (_) {}
  });
  return items.filter((r) =>
    r['@type'] === 'RealEstateListing' ||
    r['@type'] === 'Residence'         ||
    r['@type'] === 'Apartment'         ||
    r['@type'] === 'House'
  );
}

function text(card, selector) {
  if (!selector) return null;
  const val = card.find(selector).first().text().trim().replace(/\s+/g, ' ');
  return val || null;
}

function href(card, selector, baseUrl = '') {
  if (!selector) return null;
  const raw = card.find(selector).first().attr('href');
  if (!raw) return null;
  if (raw.startsWith('http')) return raw;
  if (raw.startsWith('//'))   return `https:${raw}`;
  return `${baseUrl}${raw}`;
}

function detectPriceReduction(card, selector) {
  if (selector && card.find(selector).length) return true;
  // Common "reduced" class patterns across UK portals
  return (
    card.find('[class*="reduced"]').length > 0 ||
    card.find('[class*="price-change"]').length > 0 ||
    card.text().toLowerCase().includes('price reduced')
  );
}

function normaliseTenure(raw) {
  if (!raw) return null;
  const s = raw.toLowerCase();
  if (s.includes('freehold'))   return 'freehold';
  if (s.includes('leasehold'))  return 'leasehold';
  if (s.includes('share') && s.includes('freehold')) return 'share_of_freehold';
  return raw.trim();
}

/** Parse British price strings: £1,250,000 | £1.25m | 950k → number */
function parsePrice(str) {
  if (str == null) return null;
  const s = String(str).replace(/[£,\s]/g, '').toLowerCase();
  if (!s) return null;
  if (s.endsWith('m')) { const n = parseFloat(s); return isNaN(n) ? null : Math.round(n * 1_000_000); }
  if (s.endsWith('k')) { const n = parseFloat(s); return isNaN(n) ? null : Math.round(n * 1_000); }
  const n = parseFloat(s);
  return isNaN(n) ? null : Math.round(n);
}

/** Parse sq ft from strings like "1,250 sq ft" or "116 m²" → always returns sq ft */
function parseSqft(str) {
  if (!str) return null;
  const m = str.replace(/,/g, '').match(/(\d+(?:\.\d+)?)\s*(sq\.?\s*(?:ft|feet)|m²|sqm|sq\s*m)?/i);
  if (!m) return null;
  const n = parseFloat(m[1]);
  if (isNaN(n)) return null;
  const unit = (m[2] ?? '').toLowerCase();
  // If unit looks metric (or value is small and no explicit 'ft'), convert from m²
  if (unit.includes('m') || (!unit && n < 400)) return Math.round(n * 10.764);
  return Math.round(n);
}

function sqftToSqm(sqft) {
  return sqft ? Math.round(sqft / 10.764) : null;
}

function parseDom(str) {
  if (!str) return null;
  const m = str.match(/\d+/);
  return m ? parseInt(m[0], 10) : null;
}

function parseIntOrNull(val) {
  if (val == null) return null;
  const n = parseInt(String(val), 10);
  return isNaN(n) ? null : n;
}

/** Extract UK postcode from an address string */
function extractPostcode(address) {
  if (!address) return null;
  const m = String(address).match(/([A-Z]{1,2}[0-9][0-9A-Z]?\s*[0-9][A-Z]{2})/i);
  return m ? m[1].toUpperCase().trim() : null;
}

function csvEscape(val) {
  if (!val) return '';
  const s = String(val);
  if (s.includes(',') || s.includes('"') || s.includes('\n')) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

function jitter() {
  return sleep(50 + Math.random() * 250);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

module.exports = { run, listPortals, AGENT_VERSION };
