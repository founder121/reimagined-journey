'use strict';
/**
 * Agent 2 — Investor Lead Finder
 * ════════════════════════════════════════════════════════════════════════════
 * Square Centimeter Ltd | squarecentimeter.co.uk
 *
 * Sources:
 *   • HMLR UK-Wide Price Paid (hmlr_uk_wide) — 4 parallel queries, full UK
 *   • HM Land Registry PCL/POL (land_registry_price_paid) — legacy PCL focus
 *   • Companies House API
 *   • LinkedIn public search
 *   • Property press
 *   • Expat forums
 *
 * Lead scoring: investment_intent_signal 40%, capital_capacity 25%,
 *               accessibility 20%, strategic_fit 15%
 */

const axios   = require('axios');
const cheerio = require('cheerio');
const yaml    = require('js-yaml');
const fs      = require('fs');
const path    = require('path');
const { execSync } = require('child_process');

const RateLimiter   = require('../utils/rateLimiter');
const RobotsChecker = require('../utils/robotsChecker');
const { writeData, listFiles, DATA_DIR } = require('../utils/fileStore');
const createLogger  = require('../utils/logger');

const log           = createLogger('agent2-leads');
const AGENT_VERSION = '1.0.0';
const CONFIG_PATH   = path.resolve(__dirname, '..', 'config', 'lead-sources.yml');

const LEAD_STATUSES = ['new', 'contacted', 'responded', 'meeting_booked', 'converted', 'dead'];

const CSV_HEADERS = [
  'name', 'company', 'nationality', 'property_interest', 'budget_range',
  'contact_email', 'contact_phone', 'linkedin_url', 'motivation',
  'lead_score', 'source_url', 'date_found', 'status',
  'type', 'sourceKey', 'capturedAt', 'agentVersion',
  'score_intent', 'score_capacity', 'score_accessibility', 'score_fit',
  'flags',
];

// ── HMLR UK-Wide constants ────────────────────────────────────────────────────

const PCL_DISTRICTS = new Set(['SW1', 'SW3', 'SW7', 'SW10', 'W1', 'W8', 'WC2', 'EC1', 'E1W']);

const VALID_CM2_BUDGETS = new Set(['£250k–£500k', '£500k–£1M', '£1M–£3M', '£3M+']);

const HMLR_CSV_HEADERS = [
  'transactionId', 'name', 'property_address', 'postcode',
  'pcl', 'asset_class', 'tenure', 'price', 'budget_range',
  'motivation_signal', 'motivation_score', 'lead_score',
  'mandate_interest', 'date_found', 'source_url', 'status',
];

const HMLR_BASE = 'https://landregistry.data.gov.uk/data/ppi/transaction-record.json';
const PCL_POSTCODES = ['SW1', 'SW3', 'SW7', 'SW10', 'W1', 'W8', 'WC2', 'EC1', 'E1W'];

// ── Public API ────────────────────────────────────────────────────────────────

async function run({ source, limit, dryRun = false } = {}) {
  const config    = loadConfig();
  const sourceKey = resolveSourceKey(config, source);

  if (!sourceKey) {
    throw new Error(
      `Unknown source/type "${source}". ` +
      `Available: ${Object.keys(config.sources).join(', ')}`
    );
  }

  const srcCfg = config.sources[sourceKey];

  if (!srcCfg.enabled) {
    log.warn(`Lead source "${sourceKey}" is disabled in lead-sources.yml. Skipping.`);
    return [];
  }

  if (dryRun) {
    log.info(`[DRY RUN] Would run source "${sourceKey}" (type: ${srcCfg.type})`);
    validateSourceConfig(srcCfg, sourceKey);
    return [];
  }

  log.info(`Running lead source: ${sourceKey} (type: ${srcCfg.type})`);

  const leads = await fetchSource(sourceKey, srcCfg, config, limit);

  log.info(`Source "${sourceKey}": ${leads.length} leads after dedup & scoring`);

  if (leads.length > 0) {
    if (sourceKey === 'hmlr_uk_wide') {
      // HMLR uses ISO timestamp filename and special CSV headers
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      writeData('leads/raw', `leads-hmlr-${timestamp}`, leads);
      writeHMLRCsv('leads/raw', `leads-hmlr-${timestamp}`, leads);
    } else {
      const date = todayStr();
      writeData('leads/raw', `leads-${sourceKey}-${date}`, leads);
      writeCsv('leads/raw', `leads-${sourceKey}-${date}`, leads);
    }
    appendTracker(`Agent 2 — source "${sourceKey}" — ${leads.length} leads found`);
    maybeUpdatePipeline(leads);
  }

  return leads;
}

async function runAll({ type, limit, dryRun = false } = {}) {
  const config = loadConfig();
  const keys   = Object.entries(config.sources)
    .filter(([, s]) => s.type === type && s.enabled)
    .map(([k]) => k);

  if (keys.length === 0) {
    log.warn(`No enabled sources found for type "${type}".`);
    return [];
  }

  log.info(`Running all enabled sources for type="${type}": [${keys.join(', ')}]`);

  const allLeads = [];
  const seen     = new Set();

  for (const key of keys) {
    const srcLeads = await run({ source: key, limit, dryRun });
    for (const lead of srcLeads) {
      const dedupeVal = lead.transactionId ?? lead.linkedin_url ?? lead.source_url ?? lead.name;
      if (dedupeVal && seen.has(dedupeVal)) continue;
      if (dedupeVal) seen.add(dedupeVal);
      allLeads.push(lead);
    }
  }

  if (!dryRun && allLeads.length > 0) {
    const date = todayStr();
    writeData('leads/raw', `leads-${type}-combined-${date}`, allLeads);
    writeCsv('leads/raw',  `leads-${type}-combined-${date}`, allLeads);
  }

  return allLeads;
}

function listSources(enabledOnly = false) {
  const config = loadConfig();
  return Object.entries(config.sources)
    .filter(([, s]) => !enabledOnly || s.enabled)
    .map(([key, s]) => ({
      key,
      type:        s.type,
      enabled:     s.enabled,
      description: s.description ?? '',
      rateLimit:   s.rateLimit,
      maxRecords:  s.maxRecords,
    }));
}

// ── Source dispatchers ────────────────────────────────────────────────────────

async function fetchSource(sourceKey, srcCfg, config, limit) {
  // HMLR UK-Wide: self-contained (own dedup, scoring, output format)
  if (sourceKey === 'hmlr_uk_wide') {
    return fetchHMLRUKWide(srcCfg, config.defaults || {}, limit);
  }

  const defaults = config.defaults || {};
  const weights  = config.lead_score_weights || defaultWeights();

  const dedupeKey    = srcCfg.dedupeKey ?? defaults.dedupeKey ?? 'source_url';
  const existingKeys = loadExistingDedupeKeys(dedupeKey);

  let rawLeads = [];

  switch (sourceKey) {
    case 'land_registry_price_paid':
      rawLeads = await fetchLandRegistry(srcCfg, defaults, limit);
      break;

    case 'companies_house':
    case 'psc_overseas':
      rawLeads = await fetchCompaniesHouse(sourceKey, srcCfg, defaults, limit);
      break;

    case 'linkedin_public':
      rawLeads = await fetchLinkedIn(srcCfg, defaults, limit);
      break;

    case 'property_press':
      rawLeads = await fetchPropertyPress(srcCfg, defaults, limit);
      break;

    case 'expat_forums':
      rawLeads = await fetchExpatForums(srcCfg, defaults, limit);
      break;

    default:
      rawLeads = await fetchGeneric(sourceKey, srcCfg, defaults, limit);
  }

  const fresh = rawLeads.filter((lead) => {
    const k = lead[dedupeKey] ?? lead.source_url;
    if (!k || existingKeys.has(k)) return false;
    existingKeys.add(k);
    return true;
  });

  return fresh.map((lead) => enrichLead(lead, sourceKey, srcCfg, weights));
}

// ── HMLR UK-Wide (4 parallel queries) ────────────────────────────────────────

async function fetchHMLRUKWide(srcCfg, defaults, limit) {
  log.info('[HMLR UK-Wide] Starting 4 parallel queries…');
  const timeout = defaults.timeout ?? 30_000;

  const seenIds   = loadHMLRDedupeKeys();
  const queryResults = { queryA: 0, queryB: 0, queryC: 0, queryD: 0 };
  let   belowThreshold = 0;

  // Run Query A, C, D concurrently; Query B is per-postcode (sequential in its own async fn)
  const [resultA, resultB, resultC, resultD] = await Promise.allSettled([
    _hmlrQuery(
      `${HMLR_BASE}?min-price=500000&_pageSize=100&_sort=-transactionDate&_format=json`,
      timeout, 'queryA'
    ),
    _hmlrQueryB(timeout),
    _hmlrQuery(
      `${HMLR_BASE}?newBuild=true&min-price=300000&_pageSize=100&_sort=-transactionDate&_format=json`,
      timeout, 'queryC'
    ),
    _hmlrQuery(
      `${HMLR_BASE}?propertyType=F&estateType=L&min-price=400000&_pageSize=100&_sort=-transactionDate&_format=json`,
      timeout, 'queryD'
    ),
  ]);

  const all = [];

  for (const [queryLabel, settled] of [
    ['queryA', resultA], ['queryB', resultB], ['queryC', resultC], ['queryD', resultD],
  ]) {
    if (settled.status === 'rejected') {
      log.error(`[HMLR ${queryLabel}] ${settled.reason?.message ?? settled.reason}`);
      continue;
    }
    for (const item of (settled.value ?? [])) {
      const mapped = mapHMLRRecord(item.raw, item.sourceUrl, queryLabel);
      if (!mapped) { belowThreshold++; continue; }
      if (seenIds.has(mapped.transactionId)) continue;
      seenIds.add(mapped.transactionId);
      all.push(mapped);
      queryResults[queryLabel]++;
    }
  }

  const valid = all.filter(l => validateCM2Lead({ ...l }) !== null);
  const capped = limit ? valid.slice(0, limit) : valid;

  appendHMLRScanHistory(capped);

  printHMLRSummary(queryResults, all.length, capped.length, belowThreshold, capped);

  return capped;
}

async function _hmlrQuery(url, timeout, label) {
  log.info(`  [HMLR ${label}] ${url}`);
  try {
    const res = await axios.get(url, { timeout, headers: { Accept: 'application/json' } });
    const items = res.data?.result?.items ?? res.data?.items ?? [];
    return items.map(raw => ({ raw, sourceUrl: url }));
  } catch (err) {
    throw new Error(`[HMLR ${label}] ${err.message}`);
  }
}

async function _hmlrQueryB(timeout) {
  const results = [];
  for (const postcode of PCL_POSTCODES) {
    const url = `${HMLR_BASE}?propertyAddress.postcode=${encodeURIComponent(postcode)}&_pageSize=50&_sort=-transactionDate&_format=json`;
    log.info(`  [HMLR queryB] ${postcode}`);
    try {
      const res = await axios.get(url, { timeout, headers: { Accept: 'application/json' } });
      const items = res.data?.result?.items ?? res.data?.items ?? [];
      for (const raw of items) results.push({ raw, sourceUrl: url });
    } catch (err) {
      log.error(`  [HMLR queryB ${postcode}] ${err.message}`);
    }
    await sleep(500); // light rate limiting within sequential loop
  }
  return results;
}

function mapHMLRRecord(item, sourceUrl, queryType) {
  // Parse price
  const price = parseInt(
    String(item.pricePaid?.value ?? item.pricePaid ?? item.price ?? '0').replace(/[^0-9]/g, ''),
    10
  ) || null;

  if (!price || price < 250_000) return null;

  // Strip transactionId curly braces
  const rawTxId = (
    item['transaction-id']?.value ??
    item.transactionId?.value ??
    item.transactionId ??
    ''
  );
  const transactionId = rawTxId.replace(/[{}]/g, '').trim();
  if (!transactionId) return null;

  // Build address
  const addrObj  = item['property-address'] ?? item.propertyAddress ?? {};
  const paon     = addrObj.paon?.value   ?? item.paon?.value   ?? '';
  const saon     = addrObj.saon?.value   ?? item.saon?.value   ?? '';
  const street   = addrObj.street?.value ?? item.street?.value ?? '';
  const town     = addrObj.town?.value   ?? item.town?.value   ?? '';
  const postcode = addrObj.postcode?.value ?? item.postcode?.value ?? '';
  const property_address = [paon, saon, street, town].filter(Boolean).join(', ');

  const propertyTypeCode = item.propertyType?.value ?? '';
  const estateTypeCode   = item.estateType?.value   ?? '';
  const newBuild         = item.newBuild?.value === 'Y' || item.newBuild === true;

  const asset_class = { D: 'Detached', S: 'Semi-detached', T: 'Terraced', F: 'Flat/Apartment' }[propertyTypeCode] ?? null;
  const tenure      = { F: 'Freehold', L: 'Leasehold' }[estateTypeCode] ?? null;
  const pcl         = isPCL(postcode);

  const budget_range     = priceToCM2Budget(price);
  const motivation_signal = newBuild ? 'new_build_buyer' : 'recent_buyer';
  const mandate_interest = assignHMLRMandate(pcl, price, estateTypeCode, propertyTypeCode, newBuild, property_address);

  const score_intent       = scoreHMLRIntent(pcl, price, newBuild);
  const score_capacity     = scoreHMLRCapacity(price);
  const score_accessibility = 4; // HMLR only — no contact details
  const score_fit          = scoreHMLRStrategicFit(pcl, price, estateTypeCode, propertyTypeCode, newBuild);

  const w = { investment_intent_signal: 0.40, capital_capacity: 0.25, accessibility: 0.20, strategic_fit: 0.15 };
  const lead_score = +(
    score_intent       * w.investment_intent_signal +
    score_capacity     * w.capital_capacity          +
    score_accessibility * w.accessibility             +
    score_fit          * w.strategic_fit
  ).toFixed(2);

  return {
    // HMLR-specific columns
    transactionId,
    name:             null,
    property_address,
    postcode,
    pcl,
    asset_class,
    tenure,
    price,
    budget_range,
    motivation_signal,
    motivation_score: score_intent,
    lead_score,
    mandate_interest,
    date_found:       new Date().toISOString(),
    source_url:       sourceUrl,
    status:           'new',

    // CLAUDE.md compatibility (standard lead columns)
    company:          null,
    nationality:      null,
    property_interest: `UK residential — ${postcode || 'nationwide'}`,
    contact_email:    null,
    contact_phone:    null,
    linkedin_url:     null,
    motivation:       motivation_signal,

    // Scoring breakdown
    score_intent,
    score_capacity,
    score_accessibility,
    score_fit,

    // Metadata
    type:        'cash_buyer',
    sourceKey:   'hmlr_uk_wide',
    queryType,
    newBuild,
    agentVersion: AGENT_VERSION,
    capturedAt:   new Date().toISOString(),
  };
}

// ── HMLR helpers ──────────────────────────────────────────────────────────────

/**
 * Convert a price to an exact CM2 budget string.
 * Returns null if price < £250k.
 */
function priceToCM2Budget(price) {
  if (!price || price < 250_000) return null;
  if (price >= 3_000_000) return '£3M+';
  if (price >= 1_000_000) return '£1M–£3M';
  if (price >= 500_000)   return '£500k–£1M';
  return '£250k–£500k';
}

/**
 * True if a postcode falls within a PCL district.
 */
function isPCL(postcode) {
  if (!postcode) return false;
  const district = (postcode.trim().toUpperCase().match(/^([A-Z]{1,2}\d{1,2}[A-Z]?)/)?.[1] ?? '').trim();
  return PCL_DISTRICTS.has(district);
}

function assignHMLRMandate(pcl, price, estateTypeCode, propertyTypeCode, newBuild, address) {
  if (pcl && price >= 3_000_000) return 'London Heritage & Trophy';
  if (pcl)                        return 'London Entry & Yield';
  if (estateTypeCode === 'L' && propertyTypeCode === 'F') return 'SDLT for Non-Residents';
  if (newBuild)                   return 'London Entry & Yield';
  const lower = (address || '').toLowerCase();
  if (lower.includes('dubai') || lower.includes('uae') || lower.includes('abu dhabi')) return 'UAE Golden Visa';
  return 'London Entry & Yield';
}

function scoreHMLRIntent(pcl, price, newBuild) {
  if (pcl && price >= 3_000_000) return 10;
  if (pcl)                        return 9;
  if (price >= 3_000_000)         return 8;
  if (newBuild)                   return 7;
  if (price >= 1_000_000)         return 7;
  if (price >= 500_000)           return 6;
  return 5;
}

function scoreHMLRCapacity(price) {
  if (price >= 5_000_000) return 10;
  if (price >= 3_000_000) return 9;
  if (price >= 2_000_000) return 8;
  if (price >= 1_000_000) return 7;
  if (price >= 500_000)   return 6;
  return 5;
}

function scoreHMLRStrategicFit(pcl, price, estateTypeCode, propertyTypeCode, newBuild) {
  if (pcl && estateTypeCode === 'L' && propertyTypeCode === 'F' && price >= 1_000_000) return 10;
  if (pcl && price >= 500_000) return 8;
  if (newBuild && price >= 500_000) return 7;
  if (price >= 1_000_000) return 7;
  if (price >= 500_000)   return 6;
  return 5;
}

/**
 * Validate a lead for CM2 push eligibility.
 * Returns the (possibly corrected) lead or null if invalid.
 * @throws {Error} if transactionId is missing
 */
function validateCM2Lead(lead) {
  if (!lead.transactionId || !String(lead.transactionId).trim()) {
    throw new Error(`Missing transactionId for lead at ${lead.property_address ?? lead.name ?? '?'}`);
  }

  const price = parseInt(String(lead.price || '0').replace(/[^0-9]/g, ''), 10);
  if (!price || price < 250_000) return null;

  if (!VALID_CM2_BUDGETS.has(lead.budget_range)) {
    lead.budget_range = priceToCM2Budget(price);
    if (!VALID_CM2_BUDGETS.has(lead.budget_range)) return null;
  }

  return lead;
}

function loadHMLRDedupeKeys() {
  const seen = new Set();

  // From cm2-push-log.json (transactionId field on each entry)
  try {
    const logPath = path.join(DATA_DIR, 'cm2-push-log.json');
    if (fs.existsSync(logPath)) {
      const pushLog = JSON.parse(fs.readFileSync(logPath, 'utf8'));
      for (const entry of Object.values(pushLog)) {
        if (entry.transactionId) seen.add(String(entry.transactionId));
      }
    }
  } catch (_) {}

  // From scan-history.tsv (column 2 = transactionId)
  try {
    const histPath = path.join(DATA_DIR, 'scan-history.tsv');
    if (fs.existsSync(histPath)) {
      const lines = fs.readFileSync(histPath, 'utf8').trim().split('\n');
      for (const line of lines) {
        const cols = line.split('\t');
        if (cols[1] && cols[1] !== 'transactionId') seen.add(cols[1].trim());
      }
    }
  } catch (_) {}

  return seen;
}

function appendHMLRScanHistory(leads) {
  if (!leads.length) return;
  try {
    const histPath = path.join(DATA_DIR, 'scan-history.tsv');
    const lines    = leads.map((l) =>
      [new Date().toISOString(), l.transactionId, l.property_address, l.price, l.lead_score].join('\t')
    ).join('\n');
    fs.appendFileSync(histPath, lines + '\n', 'utf8');
  } catch (_) {}
}

function writeHMLRCsv(subdir, baseName, leads) {
  const dir  = path.join(DATA_DIR, subdir);
  fs.mkdirSync(dir, { recursive: true });
  const dest = path.join(dir, `${baseName}.csv`);
  const tmp  = `${dest}.tmp`;

  const lines = [
    HMLR_CSV_HEADERS.join(','),
    ...leads.map((r) =>
      HMLR_CSV_HEADERS.map((col) => {
        const v = r[col];
        if (v === null || v === undefined) return '';
        return csvEscape(String(v));
      }).join(',')
    ),
  ];

  fs.writeFileSync(tmp, lines.join('\n') + '\n', 'utf8');
  fs.renameSync(tmp, dest);
  log.info(`HMLR CSV written → ${dest}`);
  return dest;
}

function printHMLRSummary(queryResults, allCount, validCount, belowThreshold, leads) {
  const dist = { ge9: 0, ge8: 0, ge7: 0, ge6: 0, ge5: 0 };
  for (const l of leads) {
    if (l.lead_score >= 9) dist.ge9++;
    if (l.lead_score >= 8) dist.ge8++;
    if (l.lead_score >= 7) dist.ge7++;
    if (l.lead_score >= 6) dist.ge6++;
    if (l.lead_score >= 5) dist.ge5++;
  }

  console.log('\n── HMLR UK-Wide Run Summary ─────────────────────────────');
  console.log(`  Query A (high value):      ${queryResults.queryA}`);
  console.log(`  Query B (PCL postcodes):   ${queryResults.queryB}`);
  console.log(`  Query C (new builds):      ${queryResults.queryC}`);
  console.log(`  Query D (leasehold flats): ${queryResults.queryD}`);
  console.log(`  Total fetched:             ${allCount}`);
  console.log(`  Below £250k (skipped):     ${belowThreshold}`);
  console.log(`  Valid records:             ${validCount}`);
  console.log(`  Score ≥5:  ${dist.ge5}   ≥6: ${dist.ge6}   ≥7: ${dist.ge7}   ≥8: ${dist.ge8}   ≥9: ${dist.ge9}`);

  if (leads.length > 0) {
    console.log('\n  Top 5 leads:');
    leads.slice(0, 5).forEach((l, i) => {
      console.log(`  ${i + 1}. [${l.lead_score}] ${(l.property_address ?? 'N/A').slice(0, 50)} — £${(l.price ?? 0).toLocaleString('en-GB')}`);
    });
  }
  console.log('');
}

// ── HM Land Registry Price Paid (legacy PCL focus) ───────────────────────────

async function fetchLandRegistry(srcCfg, defaults, limit) {
  const max        = limit ?? srcCfg.maxRecords ?? 500;
  const postcodes  = srcCfg.params?.postcodes ?? [];
  const minPrice   = srcCfg.params?.minPrice  ?? 500000;
  const lookback   = srcCfg.params?.lookbackDays ?? 180;
  const cutoffDate = new Date(Date.now() - lookback * 86_400_000)
    .toISOString().slice(0, 10);

  const limiter = new RateLimiter({ defaultDelay: (srcCfg.rateLimit ?? 1) * 1000 });
  const leads   = [];

  for (const outcode of postcodes) {
    if (leads.length >= max) break;

    const url = buildLandRegistryUrl(srcCfg.apiUrl, outcode, minPrice, cutoffDate);
    log.info(`  [Land Registry] Fetching outcode ${outcode} → ${url}`);

    await limiter.wait('landregistry.data.gov.uk');
    await jitter();

    let data;
    try {
      const res = await axios.get(url, {
        timeout: defaults.timeout ?? 30_000,
        headers: { Accept: 'application/json' },
      });
      data = res.data;
    } catch (err) {
      log.error(`  [Land Registry] ${outcode} fetch error: ${err.message}`);
      continue;
    }

    const items = data?.result?.items ?? data?.items ?? [];
    for (const item of items) {
      if (leads.length >= max) break;
      leads.push(mapLandRegistryRecord(item, url, outcode));
    }

    log.info(`  [Land Registry] ${outcode}: ${items.length} records`);
  }

  return leads;
}

function buildLandRegistryUrl(baseUrl, outcode, minPrice, cutoffDate) {
  const params = new URLSearchParams({
    '_view':              'basic',
    '_pageSize':          '100',
    'outcode':            outcode,
    'pricePaid-min':      String(minPrice),
    'dateOfTransfer-min': cutoffDate,
    '_format':            'json',
    '_output':            'none',
  });
  return `${baseUrl}?${params.toString()}`;
}

function mapLandRegistryRecord(item, sourceUrl, outcode) {
  const price   = parseInt(item.pricePaid?.value ?? item.price ?? '0', 10) || null;
  const address = [item.paon, item.saon, item.street, item.town].filter(Boolean).join(', ');

  return {
    name:              null,
    company:           null,
    nationality:       null,
    property_interest: `London residential — ${outcode}`,
    budget_range:      price ? formatBudgetBand(price) : null,
    contact_email:     null,
    contact_phone:     null,
    linkedin_url:      null,
    motivation:        'recent_buyer',
    source_url:        sourceUrl,
    date_found:        todayStr(),
    status:            'new',
    type:              'cash_buyer',
    subtype:           item.newBuild?.value === 'Y' ? 'new_build_buyer' : 'resale_buyer',
    address,
    postcode:          item.postcode?.value ?? null,
    price,
    dateOfTransfer:    item.dateOfTransfer?.value ?? null,
    propertyType:      item.propertyType?.value ?? null,
    estateType:        item.estateType?.value ?? null,
    ppdCategory:       item.ppdCategory?.value ?? null,
    newBuild:          item.newBuild?.value === 'Y',
    transactionId:     item.transactionId?.value ?? null,
  };
}

// ── Companies House API ───────────────────────────────────────────────────────

async function fetchCompaniesHouse(sourceKey, srcCfg, defaults, limit) {
  const apiKey = process.env[srcCfg.apiKeyEnvVar ?? 'COMPANIES_HOUSE_API_KEY'];
  if (!apiKey) {
    log.warn(`  [Companies House] API key not set (${srcCfg.apiKeyEnvVar ?? 'COMPANIES_HOUSE_API_KEY'}). Skipping.`);
    return [];
  }

  const max     = limit ?? srcCfg.maxRecords ?? 200;
  const leads   = [];
  const limiter = new RateLimiter({ defaultDelay: (srcCfg.rateLimit ?? 0.5) * 1000 });

  if (sourceKey === 'psc_overseas') {
    return fetchPscOverseas(srcCfg, defaults, apiKey, max, limiter);
  }

  const searchTerms = srcCfg.searchTerms ?? [];
  const sicCodes    = srcCfg.filters?.sicCodes ?? [];

  for (const term of searchTerms) {
    if (leads.length >= max) break;

    const url = `${srcCfg.apiUrl}/search/companies?q=${encodeURIComponent(term)}&items_per_page=20`;
    log.info(`  [Companies House] Search: "${term}"`);

    await limiter.wait('api.company-information.service.gov.uk');
    await jitter();

    let data;
    try {
      const res = await axios.get(url, {
        timeout: defaults.timeout ?? 30_000,
        auth: { username: apiKey, password: '' },
        headers: { Accept: 'application/json' },
      });
      data = res.data;
    } catch (err) {
      log.error(`  [Companies House] Search error "${term}": ${err.message}`);
      continue;
    }

    const items = data?.items ?? [];
    for (const company of items) {
      if (leads.length >= max) break;
      const sics = company.sic_codes ?? [];
      if (sicCodes.length > 0 && !sicCodes.some((s) => sics.includes(s))) continue;
      leads.push(mapCompaniesHouseRecord(company, url, term));
    }
    log.info(`  [Companies House] "${term}": ${items.length} companies`);
  }

  return leads;
}

async function fetchPscOverseas(srcCfg, defaults, apiKey, max, limiter) {
  const nationalities = srcCfg.filters?.nationality ?? [];
  const leads = [];

  for (const nat of nationalities) {
    if (leads.length >= max) break;

    const url = `${srcCfg.apiUrl}?nationality=${encodeURIComponent(nat)}&items_per_page=20`;
    log.info(`  [PSC] Nationality filter: ${nat}`);

    await limiter.wait('api.company-information.service.gov.uk');
    await jitter();

    let data;
    try {
      const res = await axios.get(url, {
        timeout: defaults.timeout ?? 30_000,
        auth: { username: apiKey, password: '' },
        headers: { Accept: 'application/json' },
      });
      data = res.data;
    } catch (err) {
      log.error(`  [PSC] Error for nationality "${nat}": ${err.message}`);
      continue;
    }

    const items = data?.items ?? [];
    for (const psc of items) {
      if (leads.length >= max) break;
      leads.push(mapPscRecord(psc, url, nat));
    }
    log.info(`  [PSC] ${nat}: ${items.length} records`);
  }

  return leads;
}

function mapCompaniesHouseRecord(company, sourceUrl, searchTerm) {
  const address = company.registered_office_address;
  return {
    name:              null,
    company:           company.company_name ?? null,
    nationality:       null,
    property_interest: searchTerm,
    budget_range:      null,
    contact_email:     null,
    contact_phone:     null,
    linkedin_url:      null,
    motivation:        'property_company',
    source_url:        `https://find-and-update.company-information.service.gov.uk/company/${company.company_number}`,
    date_found:        todayStr(),
    status:            'new',
    type:              'developer',
    companyNumber:     company.company_number ?? null,
    companyType:       company.company_type ?? null,
    incorporatedOn:    company.date_of_creation ?? null,
    sicCodes:          (company.sic_codes ?? []).join('|'),
    addressSummary:    address
      ? [address.address_line_1, address.locality, address.postal_code].filter(Boolean).join(', ')
      : null,
  };
}

function mapPscRecord(psc, sourceUrl, filterNationality) {
  return {
    name:              [psc.name_elements?.forename, psc.name_elements?.surname].filter(Boolean).join(' ') || psc.name || null,
    company:           psc.company_name ?? null,
    nationality:       psc.nationality ?? filterNationality,
    property_interest: 'London property SPV (PSC)',
    budget_range:      null,
    contact_email:     null,
    contact_phone:     null,
    linkedin_url:      null,
    motivation:        'overseas_property_vehicle',
    source_url:        sourceUrl,
    date_found:        todayStr(),
    status:            'new',
    type:              'family_office',
    countryOfResidence: psc.country_of_residence ?? null,
    naturesOfControl:  (psc.natures_of_control ?? []).join('|'),
  };
}

// ── LinkedIn public search ────────────────────────────────────────────────────

async function fetchLinkedIn(srcCfg, defaults, limit) {
  const max     = limit ?? srcCfg.maxRecords ?? 50;
  const queries = srcCfg.searchQueries ?? [];
  const sel     = srcCfg.selectors ?? {};
  const ua      = 'SquareCentimeterResearchBot/1.0';
  const robots  = new RobotsChecker(ua);
  const limiter = new RateLimiter({ defaultDelay: (srcCfg.rateLimit ?? 3) * 1000 });
  const leads   = [];

  for (const query of queries) {
    if (leads.length >= max) break;

    const url = `${srcCfg.baseUrl}${srcCfg.searchPath.replace('{query}', encodeURIComponent(query))}`;
    log.info(`  [LinkedIn] Query: "${query}"`);

    const allowed = await robots.isAllowed(url);
    if (!allowed) { log.warn(`  [LinkedIn] robots.txt disallows ${url} — skipping.`); continue; }

    await limiter.wait('www.linkedin.com');
    await jitter();

    let html;
    try {
      html = await fetchWithBrowser(url);
    } catch (err) {
      log.error(`  [LinkedIn] Fetch error: ${err.message}`);
      continue;
    }

    const $ = cheerio.load(html);
    $(sel.card ?? '.reusable-search__result-container').each((_, el) => {
      if (leads.length >= max) return false;
      const card = $(el);
      const name = text(card, sel.name ?? '.entity-result__title-text');
      const profileUrl = href(card, sel.url ?? 'a.app-aware-link', srcCfg.baseUrl);
      if (!name && !profileUrl) return;
      leads.push({
        name,
        company:           null,
        nationality:       null,
        property_interest: query,
        budget_range:      null,
        contact_email:     null,
        contact_phone:     null,
        linkedin_url:      profileUrl,
        motivation:        'linkedin_profile_signal',
        source_url:        url,
        date_found:        todayStr(),
        status:            'new',
        type:              'hnw_investor',
        headline:          text(card, sel.headline ?? '.entity-result__primary-subtitle'),
        location:          text(card, sel.location ?? '.entity-result__secondary-subtitle'),
      });
    });

    log.info(`  [LinkedIn] "${query}": ${leads.length} cumulative leads`);
  }

  return leads;
}

// ── Property press ────────────────────────────────────────────────────────────

async function fetchPropertyPress(srcCfg, defaults, limit) {
  const max     = limit ?? srcCfg.maxRecords ?? 100;
  const queries = srcCfg.searchQueries ?? [];
  const ua      = 'SquareCentimeterResearchBot/1.0';
  const robots  = new RobotsChecker(ua);
  const limiter = new RateLimiter({ defaultDelay: (srcCfg.rateLimit ?? 2) * 1000 });
  const leads   = [];

  for (const pressSrc of (srcCfg.sources ?? [])) {
    if (leads.length >= max) break;
    const sel = pressSrc.selectors ?? {};

    for (const query of queries) {
      if (leads.length >= max) break;

      const url = `${pressSrc.baseUrl}${(pressSrc.searchPath ?? '').replace('{query}', encodeURIComponent(query))}`;
      log.info(`  [Press/${pressSrc.name}] "${query}"`);

      const allowed = await robots.isAllowed(url);
      if (!allowed) { log.warn(`  robots.txt disallows ${url}`); continue; }

      await limiter.wait(new URL(url).hostname);
      await jitter();

      let html;
      try {
        const res = await axios.get(url, {
          timeout: defaults.timeout ?? 30_000,
          headers: { 'User-Agent': ua },
        });
        html = res.data;
      } catch (err) {
        log.error(`  [Press] ${url}: ${err.message}`);
        continue;
      }

      const $ = cheerio.load(html);
      $(sel.article ?? 'article').each((_, el) => {
        if (leads.length >= max) return false;
        const card       = $(el);
        const headline   = text(card, sel.headline ?? 'h3');
        const articleUrl = href(card, sel.url ?? 'a', pressSrc.baseUrl);
        const snippet    = text(card, sel.snippet ?? 'p');

        if (!headline) return;
        if (!containsInvestmentSignal(headline + ' ' + (snippet ?? ''))) return;

        leads.push({
          name: null, company: null, nationality: null,
          property_interest: query, budget_range: null,
          contact_email: null, contact_phone: null, linkedin_url: null,
          motivation: 'press_mention',
          source_url: articleUrl ?? url,
          date_found: todayStr(), status: 'new',
          type: 'hnw_investor', pressSource: pressSrc.name, headline, snippet,
        });
      });
    }
  }

  return leads;
}

// ── Expat forums ──────────────────────────────────────────────────────────────

async function fetchExpatForums(srcCfg, defaults, limit) {
  const max     = limit ?? srcCfg.maxRecords ?? 50;
  const ua      = 'SquareCentimeterResearchBot/1.0';
  const robots  = new RobotsChecker(ua);
  const limiter = new RateLimiter({ defaultDelay: (srcCfg.rateLimit ?? 2) * 1000 });
  const leads   = [];

  for (const forumSrc of (srcCfg.sources ?? [])) {
    if (leads.length >= max) break;
    const sel = forumSrc.selectors ?? {};

    for (const query of (srcCfg.searchQueries ?? [])) {
      if (leads.length >= max) break;

      const url = `${forumSrc.baseUrl}${(forumSrc.searchPath ?? '').replace('{query}', encodeURIComponent(query))}`;
      const allowed = await robots.isAllowed(url);
      if (!allowed) continue;

      await limiter.wait(new URL(url).hostname);
      await jitter();

      let html;
      try {
        const res = await axios.get(url, { timeout: defaults.timeout ?? 30_000, headers: { 'User-Agent': ua } });
        html = res.data;
      } catch (err) { log.error(`  [Expat] ${url}: ${err.message}`); continue; }

      const $ = cheerio.load(html);
      $(sel.post ?? '.post').each((_, el) => {
        if (leads.length >= max) return false;
        const card    = $(el);
        const author  = text(card, sel.author ?? '.username');
        const content = text(card, sel.content ?? '.post-content');
        const postUrl = href(card, sel.url ?? 'a', forumSrc.baseUrl);

        if (!author || !content) return;
        if (!containsInvestmentSignal(content)) return;

        leads.push({
          name: author, company: null, nationality: null,
          property_interest: query, budget_range: null,
          contact_email: null, contact_phone: null, linkedin_url: null,
          motivation: 'expat_forum_enquiry',
          source_url: postUrl ?? url,
          date_found: todayStr(), status: 'new',
          type: 'expat', postSnippet: content.slice(0, 200),
        });
      });
    }
  }

  return leads;
}

// ── Generic HTML scraper ──────────────────────────────────────────────────────

async function fetchGeneric(sourceKey, srcCfg, defaults, limit) {
  log.warn(`  No specific fetcher for "${sourceKey}" — using generic HTML scraper.`);
  const max     = limit ?? srcCfg.maxRecords ?? 100;
  const ua      = 'SquareCentimeterResearchBot/1.0';
  const robots  = new RobotsChecker(ua);
  const limiter = new RateLimiter({ defaultDelay: (srcCfg.rateLimit ?? 2) * 1000 });
  const sel     = srcCfg.selectors ?? {};
  const leads   = [];

  const urls = buildGenericUrls(srcCfg);
  for (const url of urls) {
    if (leads.length >= max) break;

    const allowed = await robots.isAllowed(url);
    if (!allowed) continue;

    await limiter.wait(new URL(url).hostname);
    await jitter();

    let html;
    try {
      const res = await axios.get(url, { timeout: defaults.timeout ?? 30_000, headers: { 'User-Agent': ua } });
      html = res.data;
    } catch (err) { log.error(`  [generic/${sourceKey}] ${url}: ${err.message}`); continue; }

    const $ = cheerio.load(html);
    $(sel.card ?? '.result').each((_, el) => {
      if (leads.length >= max) return false;
      const card = $(el);
      const name    = text(card, sel.name);
      const linkUrl = href(card, sel.url ?? 'a', (srcCfg.baseUrl ?? ''));
      if (!name && !linkUrl) return;

      leads.push({
        name, company: null, nationality: null, property_interest: null, budget_range: null,
        contact_email: null, contact_phone: null, linkedin_url: null,
        motivation: sourceKey, source_url: linkUrl ?? url,
        date_found: todayStr(), status: 'new',
        type: srcCfg.type ?? 'hnw_investor',
      });
    });
  }

  return leads;
}

// ── Lead scoring (legacy sources) ─────────────────────────────────────────────

function enrichLead(lead, sourceKey, srcCfg, weights) {
  const scores = {
    intent:        scoreIntentSignal(lead),
    capacity:      scoreCapacity(lead),
    accessibility: scoreAccessibility(lead),
    fit:           scoreStrategicFit(lead),
  };

  const composite = (
    scores.intent        * weights.investment_intent_signal +
    scores.capacity      * weights.capital_capacity          +
    scores.accessibility * weights.accessibility              +
    scores.fit           * weights.strategic_fit
  );

  return {
    ...lead,
    agentVersion:         AGENT_VERSION,
    capturedAt:           new Date().toISOString(),
    sourceKey,
    lead_score:           +composite.toFixed(2),
    score_intent:         scores.intent,
    score_capacity:       scores.capacity,
    score_accessibility:  scores.accessibility,
    score_fit:            scores.fit,
    flags:                computeLeadFlags(lead, scores),
  };
}

function scoreIntentSignal(lead) {
  const motivation = lead.motivation ?? '';
  if (['recent_buyer', 'new_build_buyer', 'resale_buyer'].includes(motivation)) return 10;
  if (motivation === 'property_company')            return 8;
  if (motivation === 'overseas_property_vehicle')   return 8;
  if (motivation === 'press_mention')               return 6;
  if (motivation === 'linkedin_profile_signal')     return 5;
  if (motivation === 'expat_forum_enquiry')         return 4;
  return 2;
}

function scoreCapacity(lead) {
  const price = lead.price ?? parseBudgetBand(lead.budget_range);
  if (!price) return 2;
  if (price >= 5_000_000) return 10;
  if (price >= 2_000_000) return 8;
  if (price >= 1_000_000) return 6;
  if (price >= 500_000)   return 4;
  return 2;
}

function scoreAccessibility(lead) {
  let score = 2;
  if (lead.contact_email)               score = Math.max(score, 10);
  if (lead.contact_phone)               score = Math.max(score, 9);
  if (lead.linkedin_url)                score = Math.max(score, 8);
  if (lead.company && lead.companyNumber) score = Math.max(score, 6);
  if (lead.source_url)                  score = Math.max(score, 4);
  return score;
}

function scoreStrategicFit(lead) {
  const type       = lead.type ?? '';
  const motivation = lead.motivation ?? '';
  const nat        = (lead.nationality ?? '').toLowerCase();

  if (type === 'family_office')                    return 10;
  if (motivation === 'overseas_property_vehicle')  return 9;
  if (['emirati', 'saudi', 'qatari', 'chinese', 'hong kong', 'singaporean'].some((n) => nat.includes(n))) return 9;
  if (type === 'cash_buyer')  return 7;
  if (type === 'developer')   return 7;
  if (type === 'hnw_investor') return 6;
  if (type === 'expat')       return 5;
  return 3;
}

function computeLeadFlags(lead, scores) {
  const flags = [];
  if (scores.intent >= 9)        flags.push('high_intent');
  if (scores.capacity >= 8)      flags.push('high_budget');
  if (scores.accessibility >= 8) flags.push('contactable');
  if (scores.fit >= 8)           flags.push('core_profile');
  if (lead.nationality && !['british', 'uk'].includes((lead.nationality ?? '').toLowerCase()))
    flags.push('international');
  if (lead.ppdCategory === 'B')  flags.push('buy_to_let');
  return flags;
}

// ── CSV output ────────────────────────────────────────────────────────────────

function writeCsv(subdir, baseName, leads) {
  const dir  = path.join(DATA_DIR, subdir);
  fs.mkdirSync(dir, { recursive: true });
  const dest = path.join(dir, `${baseName}.csv`);
  const tmp  = `${dest}.tmp`;

  const lines = [
    CSV_HEADERS.join(','),
    ...leads.map((r) =>
      CSV_HEADERS.map((col) => {
        const v = r[col];
        if (v === null || v === undefined) return '';
        if (Array.isArray(v)) return csvEscape(v.join('|'));
        return csvEscape(String(v));
      }).join(',')
    ),
  ];

  fs.writeFileSync(tmp, lines.join('\n') + '\n', 'utf8');
  fs.renameSync(tmp, dest);
  log.info(`CSV written → ${dest}`);
  return dest;
}

// ── Audit trail & pipeline ────────────────────────────────────────────────────

function appendTracker(message) {
  const trackerPath = path.join(DATA_DIR, 'tracker.md');
  fs.mkdirSync(path.dirname(trackerPath), { recursive: true });
  fs.appendFileSync(trackerPath, `- ${new Date().toISOString()} | Agent 2 | ${message}\n`, 'utf8');
}

function maybeUpdatePipeline(leads) {
  const highValue = leads.filter((l) => l.lead_score >= 7);
  if (highValue.length === 0) return;

  const pipelinePath = path.join(DATA_DIR, 'pipeline.md');
  fs.mkdirSync(path.dirname(pipelinePath), { recursive: true });
  const header = !fs.existsSync(pipelinePath) ? '# Square Centimeter — Pipeline Review Items\n\n' : '';
  const rows   = highValue.map((l) =>
    `- [ ] **${l.name ?? l.company ?? l.transactionId ?? 'Unknown'}** | Score ${l.lead_score}/10 | ${l.type} | ${l.motivation ?? l.motivation_signal} | ${l.source_url ?? ''}`
  ).join('\n');
  fs.appendFileSync(pipelinePath, `${header}## Batch ${todayStr()}\n${rows}\n\n`, 'utf8');
  log.info(`Pipeline updated — ${highValue.length} high-value leads flagged for Julian Noble.`);
}

// ── Deduplication ─────────────────────────────────────────────────────────────

function loadExistingDedupeKeys(dedupeKey) {
  const keys = new Set();
  let files  = [];

  try {
    files = listFiles('leads/raw');
  } catch (_) {
    return keys;
  }

  for (const file of files) {
    if (!file.endsWith('.json')) continue;
    try {
      const records = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (Array.isArray(records)) {
        for (const r of records) {
          const k = r[dedupeKey] ?? r.source_url;
          if (k) keys.add(k);
        }
      }
    } catch (_) {}
  }

  return keys;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function loadConfig() {
  return yaml.load(fs.readFileSync(CONFIG_PATH, 'utf8'));
}

function resolveSourceKey(config, input) {
  if (config.sources[input]) return input;
  const match = Object.entries(config.sources).find(([, s]) => s.type === input && s.enabled);
  return match ? match[0] : null;
}

function validateSourceConfig(cfg, key) {
  const issues = [];
  if (!cfg.type)      issues.push('missing type');
  if (!cfg.rateLimit) issues.push('missing rateLimit');
  if (issues.length) {
    log.warn(`[DRY RUN] "${key}" config issues: ${issues.join(', ')}`);
  } else {
    log.info(`[DRY RUN] "${key}" OK (type=${cfg.type}, rateLimit=${cfg.rateLimit})`);
  }
}

function buildGenericUrls(cfg) {
  const base = cfg.baseUrl ?? '';
  const tmpl = cfg.searchPath ?? '';
  if (cfg.cities?.length) return cfg.cities.map((c) => `${base.replace('{city}', c)}${tmpl}`);
  if (cfg.counties?.length) return cfg.counties.map((c) => (typeof c === 'object' ? c.url : c));
  return [`${base}${tmpl}`];
}

function defaultWeights() {
  return {
    investment_intent_signal: 0.40,
    capital_capacity:         0.25,
    accessibility:            0.20,
    strategic_fit:            0.15,
  };
}

function containsInvestmentSignal(str) {
  const signals = [
    'invest', 'acqui', 'purchas', 'buy', 'portfolio',
    'prime london', 'pcl', 'chelsea', 'mayfair', 'kensington',
    'belgravia', 'knightsbridge', 'family office', 'fund',
    '£', 'million', 'residential',
  ];
  const lower = str.toLowerCase();
  return signals.some((s) => lower.includes(s));
}

function formatBudgetBand(price) {
  if (!price) return null;
  if (price >= 10_000_000) return '£10m+';
  if (price >= 5_000_000)  return '£5m–£10m';
  if (price >= 2_000_000)  return '£2m–£5m';
  if (price >= 1_000_000)  return '£1m–£2m';
  if (price >= 500_000)    return '£500k–£1m';
  return '<£500k';
}

function parseBudgetBand(band) {
  if (!band) return null;
  const m = String(band).match(/£([\d.]+)(m|k)?/i);
  if (!m) return null;
  const n = parseFloat(m[1]);
  if (isNaN(n)) return null;
  const unit = (m[2] ?? '').toLowerCase();
  if (unit === 'm') return n * 1_000_000;
  if (unit === 'k') return n * 1_000;
  return n;
}

async function fetchWithBrowser(url) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('agent-browser timeout')), 55_000);
    try {
      execSync(`agent-browser open "${url}" --wait networkidle`, { timeout: 35_000, stdio: 'pipe' });
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
      try { execSync('agent-browser close', { stdio: 'pipe', timeout: 5_000 }); } catch (_) {}
    }
  });
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

function csvEscape(val) {
  const s = String(val ?? '');
  if (!s) return '';
  if (s.includes(',') || s.includes('"') || s.includes('\n')) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

function jitter() {
  return sleep(50 + Math.random() * 300);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

module.exports = { run, runAll, listSources, validateCM2Lead, priceToCM2Budget, isPCL, AGENT_VERSION };
