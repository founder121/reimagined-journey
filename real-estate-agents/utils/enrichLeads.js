'use strict';
/**
 * utils/enrichLeads.js
 * ════════════════════════════════════════════════════════════════════════════
 * Square Centimeter Ltd | squarecentimeter.co.uk
 *
 * Companies House enrichment for investor leads.
 *
 * Pipeline:
 *   data/leads/raw/*.json  +  data/pipeline.md
 *     ↓  search by company name / director name / postcode
 *   Companies House API  (api.company-information.service.gov.uk)
 *     ↓  director name · registered address · company status
 *   data/leads/qualified/qualified-YYYY-MM-DD.csv
 *
 * Graceful degradation on network failure (403 / timeout):
 *   lead.status = 'needs_manual_enrichment'
 *   lead.ch_enrichment_note = 'ch_api_blocked' | 'ch_search_timeout' | …
 *   All leads are saved regardless of enrichment success.
 *
 * Accessibility re-scoring:
 *   email + phone  → 10
 *   email only     → 10
 *   phone only     →  9
 *   linkedin_url   →  8
 *   CH director + company known  →  6
 *   CH company only  →  5
 *   source_url only  →  4
 *   nothing          →  2
 *
 * Lead score weights (CLAUDE.md):
 *   investment_intent_signal  40%
 *   capital_capacity          25%
 *   accessibility             20%
 *   strategic_fit             15%
 *
 * Usage:
 *   const enrich = require('./enrichLeads');
 *   const result = await enrich.run({ minScore: 7 });
 *   // result = { enriched, needsReview, total, leads }
 *
 *   // Or enrich a single lead:
 *   const enriched = await enrich.enrichOne(lead, { apiKey: 'xxx' });
 */

const fs   = require('fs');
const path = require('path');

const { get: safeGet, logNetworkFailure } = require('./safeHttp');
const { listFiles, DATA_DIR }             = require('./fileStore');
const createLogger                        = require('./logger');

const log = createLogger('enrich-leads');

const CH_BASE     = 'https://api.company-information.service.gov.uk';
const CH_HOSTNAME = 'api.company-information.service.gov.uk';
const CH_TIMEOUT  = 10_000;   // 10 s per CLAUDE.md operational rules

// Lead score weights from CLAUDE.md
const WEIGHTS = {
  investment_intent_signal: 0.40,
  capital_capacity:         0.25,
  accessibility:            0.20,
  strategic_fit:            0.15,
};

/**
 * Column order for the qualified leads CSV.
 * Includes all CLAUDE.md standard columns + SC-specific fields + CH enrichment.
 */
const QUALIFIED_HEADERS = [
  // Core lead identity
  'name', 'company', 'nationality',
  'property_address',          // specific property address of interest
  'property_interest',
  'budget_range',
  'estimated_equity',          // estimated investable capital (£ string)
  // Contact
  'contact_email', 'contact_phone', 'linkedin_url',
  // Classification
  'motivation', 'lead_score', 'source_url', 'date_found', 'status',
  'type', 'sourceKey',
  // Scoring dimensions
  'score_intent', 'score_capacity', 'score_accessibility', 'score_fit', 'flags',
  // HMLR property fields (cash buyer leads)
  'postcode', 'address', 'price', 'dateOfTransfer',
  'propertyType', 'estateType', 'newBuild', 'transactionId',
  // Companies House enrichment
  'ch_enriched', 'ch_enrichment_note',
  'ch_company_number', 'ch_company_name', 'ch_company_type',
  'ch_company_status', 'ch_incorporated_on', 'ch_registered_address',
  'ch_sic_codes', 'ch_director_name', 'ch_director_nationality',
  'ch_director_country', 'ch_officers_count', 'ch_profile_url',
];

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Enrich all high-value raw leads and save to data/leads/qualified/.
 *
 * @param {object}  opts
 * @param {number}  [opts.minScore=7]            Min lead_score to enrich
 * @param {number}  [opts.limit]                 Cap on leads processed
 * @param {string}  [opts.apiKey]                CH API key (or env COMPANIES_HOUSE_API_KEY)
 * @param {boolean} [opts.includePipeline=true]  Also read data/pipeline.md
 * @param {boolean} [opts.dryRun=false]          Parse leads only; no HTTP calls
 * @returns {Promise<EnrichResult>}
 */
async function run({ minScore = 7, limit, apiKey, includePipeline = true, dryRun = false } = {}) {
  const key = apiKey ?? process.env.COMPANIES_HOUSE_API_KEY ?? null;

  // ── Load leads ─────────────────────────────────────────────────────────────
  let leads = loadRawLeads(minScore);
  log.info(`Loaded ${leads.length} raw lead(s) (score ≥ ${minScore})`);

  if (includePipeline) {
    const pipelineLeads = parsePipelineLeads();
    const existingKeys  = new Set(leads.map(dedupeKey));
    const fresh         = pipelineLeads.filter((l) => !existingKeys.has(dedupeKey(l)));
    if (fresh.length > 0) {
      log.info(`+ ${fresh.length} additional lead(s) from pipeline.md`);
      leads = leads.concat(fresh);
    }
  }

  if (limit && limit > 0) leads = leads.slice(0, limit);

  if (leads.length === 0) {
    log.warn('No leads to enrich. Run "sc leads" first (or seed data/leads/raw/).');
    return { enriched: 0, needsReview: 0, total: 0, leads: [] };
  }

  log.info(`Enriching ${leads.length} lead(s) via Companies House…`);

  const results     = [];
  let enrichedCount = 0;
  let reviewCount   = 0;

  for (const lead of leads) {
    // Jitter between requests to respect rate limits
    if (!dryRun && results.length > 0) await sleep(800 + Math.random() * 400);

    const result = await enrichOne(lead, { key, dryRun });
    results.push(result);

    if (result.ch_enriched)                          enrichedCount++;
    if (result.status === 'needs_manual_enrichment') reviewCount++;
  }

  log.info(`Complete — ${enrichedCount}/${results.length} CH-matched, ${reviewCount} need manual review`);

  if (!dryRun) {
    const date  = new Date().toISOString().slice(0, 10);
    const saved = saveQualifiedCsv(results, `qualified-${date}`);
    appendTracker(
      `enrich-leads | processed=${results.length} ch_matched=${enrichedCount} needs_review=${reviewCount} → ${path.basename(saved)}`
    );
  }

  return {
    enriched:    enrichedCount,
    needsReview: reviewCount,
    total:       results.length,
    leads:       results,
  };
}

/**
 * Enrich a single lead with Companies House data.
 * Never throws — returns the lead with ch_enriched fields set.
 *
 * @param {object}  lead
 * @param {object}  [opts]
 * @param {string}  [opts.key]        CH API key
 * @param {boolean} [opts.dryRun]     Skip HTTP calls
 * @returns {Promise<object>}
 */
async function enrichOne(lead, { key, dryRun = false } = {}) {
  const query = buildSearchQuery(lead);

  if (!query) {
    log.warn(`  No CH query for: ${leadLabel(lead)}`);
    return {
      ...lead,
      ch_enriched:        false,
      ch_enrichment_note: 'no_search_query',
      status:             'needs_manual_enrichment',
    };
  }

  if (dryRun) {
    return { ...lead, ch_enriched: false, ch_enrichment_note: 'dry_run', ch_query: query };
  }

  log.info(`  Enriching "${leadLabel(lead)}" — CH query: "${query}"`);

  // ── Step 1: Company search ─────────────────────────────────────────────────
  const searchUrl = `${CH_BASE}/search/companies?q=${encodeURIComponent(query)}&items_per_page=5`;
  const searchRes = await safeGet(searchUrl, {
    timeout:   CH_TIMEOUT,
    headers:   { Accept: 'application/json' },
    logErrors: false,
    ...(key ? { auth: { username: key, password: '' } } : {}),
  });

  if (!searchRes.ok) {
    const note = searchRes.errorType === 'network_blocked'
      ? 'ch_api_blocked'
      : `ch_search_${searchRes.errorType}`;

    logNetworkFailure(CH_HOSTNAME, searchUrl, searchRes.errorType ?? 'unknown', searchRes.error ?? '');
    log.warn(`  CH search failed (${searchRes.errorType}): ${leadLabel(lead)}`);

    return {
      ...lead,
      ch_enriched:        false,
      ch_enrichment_note: note,
      status:             'needs_manual_enrichment',
    };
  }

  const items   = searchRes.data?.items ?? [];
  const active  = items.filter((c) => c.company_status === 'active');
  const company = active[0] ?? items[0] ?? null;

  if (!company) {
    log.info(`  No CH match for "${query}"`);
    return { ...lead, ch_enriched: false, ch_enrichment_note: 'no_ch_match' };
  }

  log.info(`  Matched: ${company.company_name} (${company.company_number})`);

  // ── Step 2: Directors ──────────────────────────────────────────────────────
  await sleep(400 + Math.random() * 200);
  const officersUrl = `${CH_BASE}/company/${company.company_number}/officers?register_type=directors&items_per_page=10`;
  const officersRes = await safeGet(officersUrl, {
    timeout:   CH_TIMEOUT,
    headers:   { Accept: 'application/json' },
    logErrors: false,
    ...(key ? { auth: { username: key, password: '' } } : {}),
  });

  const allOfficers    = officersRes.ok ? (officersRes.data?.items ?? []) : [];
  const activeOfficers = allOfficers.filter((o) => !o.resigned_on);
  const primaryDir     = activeOfficers.find((o) => o.officer_role === 'director') ?? activeOfficers[0] ?? null;

  // ── Step 3: Build enriched record ─────────────────────────────────────────
  const regAddr = company.registered_office_address;
  const chAddress = regAddr
    ? [regAddr.address_line_1, regAddr.address_line_2, regAddr.locality, regAddr.region, regAddr.postal_code, regAddr.country]
        .filter(Boolean).join(', ')
    : null;

  const dirName = primaryDir
    ? ([primaryDir.name_elements?.forename, primaryDir.name_elements?.surname]
         .filter(Boolean).join(' ') || primaryDir.name || null)
    : null;

  const enriched = {
    ...lead,
    // Back-fill anonymous HMLR fields from CH match
    name:        lead.name        ?? dirName,
    company:     lead.company     ?? company.company_name,
    nationality: lead.nationality ?? primaryDir?.nationality ?? null,
    // CH enrichment columns
    ch_enriched:             true,
    ch_enrichment_note:      'matched',
    ch_company_number:       company.company_number,
    ch_company_name:         company.company_name,
    ch_company_type:         company.company_type   ?? null,
    ch_company_status:       company.company_status ?? null,
    ch_incorporated_on:      company.date_of_creation ?? null,
    ch_registered_address:   chAddress,
    ch_sic_codes:            (company.sic_codes ?? []).join('|'),
    ch_director_name:        dirName,
    ch_director_nationality: primaryDir?.nationality           ?? null,
    ch_director_country:     primaryDir?.country_of_residence  ?? null,
    ch_officers_count:       activeOfficers.length,
    ch_profile_url:          `https://find-and-update.company-information.service.gov.uk/company/${company.company_number}`,
  };

  // Re-score accessibility and recalculate composite
  enriched.score_accessibility = rescoreAccessibility(enriched);
  enriched.lead_score          = recalculateScore(enriched);

  // Update flags
  const flags = Array.isArray(enriched.flags)
    ? [...enriched.flags]
    : (enriched.flags ? String(enriched.flags).split('|') : []);
  if (!flags.includes('ch_enriched')) flags.push('ch_enriched');
  if (enriched.score_accessibility >= 8 && !flags.includes('contactable')) flags.push('contactable');
  enriched.flags = flags;

  return enriched;
}

// ── Search query construction ─────────────────────────────────────────────────

/**
 * Build the best possible Companies House search query for a lead.
 * Priority: company name → director name → postcode → address keywords
 *
 * @param {object} lead
 * @returns {string|null}
 */
function buildSearchQuery(lead) {
  if (lead.company  && String(lead.company).trim())  return String(lead.company).trim();
  if (lead.name     && String(lead.name).trim())     return String(lead.name).trim();
  if (lead.postcode && String(lead.postcode).trim()) return String(lead.postcode).trim();
  if (lead.address) {
    // Extract postcode from freeform address
    const m = String(lead.address).match(/[A-Z]{1,2}\d{1,2}[A-Z]?\s?\d[A-Z]{2}/i);
    if (m) return m[0].toUpperCase();
    // Fall back to first two comma-separated segments
    const parts = String(lead.address).split(',').map((s) => s.trim()).filter(Boolean);
    if (parts.length >= 1) return parts.slice(0, 2).join(' ');
  }
  return null;
}

// ── Accessibility re-scoring ──────────────────────────────────────────────────

/**
 * Score accessibility (0–10) based on available contact and CH data.
 *
 * @param {object} lead
 * @returns {number}
 */
function rescoreAccessibility(lead) {
  if (lead.contact_email && lead.contact_phone) return 10;
  if (lead.contact_email)                       return 10;
  if (lead.contact_phone)                       return 9;
  if (lead.linkedin_url)                        return 8;
  if (lead.ch_director_name && lead.ch_company_number) return 6;
  if (lead.ch_company_number)                   return 5;
  if (lead.source_url)                          return 4;
  return 2;
}

// ── Lead score calculator ─────────────────────────────────────────────────────

/**
 * Recalculate composite lead_score from dimension scores.
 *
 * @param {object} lead
 * @param {object} [weights]   Override CLAUDE.md weights
 * @returns {number}
 */
function recalculateScore(lead, weights = WEIGHTS) {
  return +(
    (lead.score_intent       ?? 0) * weights.investment_intent_signal +
    (lead.score_capacity     ?? 0) * weights.capital_capacity         +
    (lead.score_accessibility ?? 0) * weights.accessibility            +
    (lead.score_fit          ?? 0) * weights.strategic_fit
  ).toFixed(2);
}

// ── Pipeline.md parser ────────────────────────────────────────────────────────

/**
 * Parse review-queue items from data/pipeline.md.
 * Handles the format written by agent2's maybeUpdatePipeline():
 *   - [ ] **Name** | Score X/10 | type | motivation | url
 *
 * @returns {object[]}
 */
function parsePipelineLeads() {
  const pipelinePath = path.join(DATA_DIR, 'pipeline.md');
  if (!fs.existsSync(pipelinePath)) return [];

  const leads = [];
  const today = new Date().toISOString().slice(0, 10);

  for (const line of fs.readFileSync(pipelinePath, 'utf8').split('\n')) {
    const m = line.match(
      /^-\s+\[\s\]\s+\*\*(.+?)\*\*\s+\|\s+Score\s+([\d.]+)\/10\s+\|\s+(\S+)\s+\|\s+(\S+)\s+\|\s*(\S*)/
    );
    if (!m) continue;

    const [, rawName, scoreStr, type, motivation, sourceUrl] = m;
    const name = rawName === 'Unknown' ? null : rawName;

    leads.push({
      name,
      company:           null,
      nationality:       null,
      property_interest: `${type} — ${motivation}`,
      budget_range:      null,
      contact_email:     null,
      contact_phone:     null,
      linkedin_url:      null,
      motivation,
      source_url:        sourceUrl || null,
      date_found:        today,
      status:            'new',
      type,
      lead_score:        parseFloat(scoreStr),
      score_intent:      motivation === 'recent_buyer' ? 10 : 6,
      score_capacity:    2,
      score_accessibility: sourceUrl ? 4 : 2,
      score_fit:         type === 'cash_buyer' ? 7 : type === 'family_office' ? 10 : 6,
    });
  }

  return leads;
}

// ── Data loading ──────────────────────────────────────────────────────────────

/**
 * Load leads from data/leads/raw/*.json, filtered by minimum lead_score.
 * De-duplicates by transactionId → linkedin_url → contact_email → source_url → name.
 *
 * @param {number} minScore
 * @returns {object[]}
 */
function loadRawLeads(minScore) {
  const files = listFiles('leads/raw');
  const all   = [];

  for (const file of files) {
    if (!file.endsWith('.json')) continue;
    try {
      const records = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (Array.isArray(records)) {
        all.push(...records.filter((r) => (r.lead_score ?? 0) >= minScore));
      }
    } catch (err) {
      log.warn(`Skipping ${path.basename(file)}: ${err.message}`);
    }
  }

  // Deduplicate
  const seen = new Set();
  return all.filter((r) => {
    const k = dedupeKey(r);
    if (!k || seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

// ── CSV output ────────────────────────────────────────────────────────────────

function saveQualifiedCsv(leads, baseName) {
  const dir  = path.join(DATA_DIR, 'leads', 'qualified');
  fs.mkdirSync(dir, { recursive: true });
  const dest = path.join(dir, `${baseName}.csv`);
  const tmp  = `${dest}.tmp`;

  const rows = leads.map((r) =>
    QUALIFIED_HEADERS.map((col) => {
      const v = r[col];
      if (v === null || v === undefined) return '';
      if (Array.isArray(v))             return csvEscape(v.join('|'));
      return csvEscape(String(v));
    }).join(',')
  );

  fs.writeFileSync(tmp, [QUALIFIED_HEADERS.join(','), ...rows].join('\n') + '\n', 'utf8');
  fs.renameSync(tmp, dest);
  log.info(`Saved → ${dest}`);
  return dest;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function dedupeKey(lead) {
  return lead.transactionId
    ?? lead.linkedin_url
    ?? lead.contact_email
    ?? lead.source_url
    ?? lead.name
    ?? null;
}

function leadLabel(lead) {
  return lead.name
    ?? lead.company
    ?? lead.postcode
    ?? (lead.address ? String(lead.address).slice(0, 30) : null)
    ?? 'unknown';
}

function appendTracker(message) {
  try {
    fs.appendFileSync(
      path.join(DATA_DIR, 'tracker.md'),
      `- ${new Date().toISOString()} | ${message}\n`,
      'utf8',
    );
  } catch (_) { /* best effort */ }
}

function csvEscape(val) {
  const s = String(val ?? '');
  if (!s) return '';
  if (s.includes(',') || s.includes('"') || s.includes('\n')) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

module.exports = {
  run,
  enrichOne,
  buildSearchQuery,
  rescoreAccessibility,
  recalculateScore,
  parsePipelineLeads,
  loadRawLeads,
  QUALIFIED_HEADERS,
  WEIGHTS,
};

/**
 * @typedef {object} EnrichResult
 * @property {number}   enriched    Leads successfully matched to Companies House
 * @property {number}   needsReview Leads marked needs_manual_enrichment
 * @property {number}   total       Total leads processed
 * @property {object[]} leads       Enriched lead records
 */
