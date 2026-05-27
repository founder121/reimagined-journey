'use strict';
/**
 * Agent 5 — Client Relations (Square Centimeter Ltd)
 * ════════════════════════════════════════════════════
 * Qualifies inbound HNW investor leads, generates meeting briefing notes for
 * Julian Noble, schedules viewings in iCal format, and flags overdue follow-ups.
 *
 * Qualification dimensions (weighted 0–10 each → 0–100 composite):
 *   Budget Capacity    40 %  — £500 k threshold; £5 m+ scores maximum
 *   Acquisition Timeline 20 %  — immediate > 3–6 mo > 6–12 mo > unknown
 *   Residency Profile  20 %  — non-dom / overseas > UK resident > unknown
 *   Location Alignment 20 %  — PCL > POL > emerging > flexible > unknown
 *
 * Outputs
 * ───────
 *   data/leads/qualified/qualified-YYYY-MM-DD.csv   (qualified leads)
 *   reports/brief-{slug}-YYYY-MM-DD.md              (meeting briefing notes)
 *   tracker entry → data/tracker.md                 (every action logged)
 *
 * Constraints (CLAUDE.md — non-negotiable)
 * ─────────────────────────────────────────
 *   – Confirm before sending: outreach approved locally; never auto-sent
 *   – Client confidentiality: names / deal details never in public content
 *   – No hallucinated data: all figures from supplied lead data only
 *
 * Usage
 * ─────
 *   const sales = require('./agent5-sales');
 *
 *   // Qualify raw leads:
 *   const result = await sales.run({ leads: rawLeadsArray });
 *
 *   // Check overdue follow-ups in qualified pipeline:
 *   const result = await sales.run({ action: 'followup' });
 *
 *   // Generate briefing notes for qualified leads:
 *   const result = await sales.run({ leads: rawLeadsArray, action: 'brief' });
 */

const fs   = require('fs');
const path = require('path');

const { listFiles, DATA_DIR, REPORTS_DIR } = require('../utils/fileStore');
const createLogger              = require('../utils/logger');

const log = createLogger('agent5-sales');

const AGENT_VERSION            = '1.0.0';
const OVERDUE_THRESHOLD_DAYS   = 7;
const BUDGET_THRESHOLD_MIN     = 500_000;    // £ — leads below this are flagged under_budget

// ── Qualification field metadata ──────────────────────────────────────────────
const QUALIFICATION_FIELDS = {
  budget:    { weight: 0.40, label: 'Investment Budget Capacity' },
  timeline:  { weight: 0.20, label: 'Acquisition Timeline' },
  residency: { weight: 0.20, label: 'Residency Profile' },
  location:  { weight: 0.20, label: 'Location Alignment' },
};

// ── Budget band → minimum £ figure ───────────────────────────────────────────
// Handles both en-dash (–) and hyphen (-) variants from agent2 output
const BUDGET_BANDS = new Map([
  ['£10m+',       10_000_000],
  ['£5m–£10m',     5_000_000],
  ['£5m-£10m',     5_000_000],
  ['£2m–£5m',      2_000_000],
  ['£2m-£5m',      2_000_000],
  ['£1m–£2m',      1_000_000],
  ['£1m-£2m',      1_000_000],
  ['£500k–£1m',      500_000],
  ['£500k-£1m',      500_000],
  ['under £500k',    100_000],
]);

// PCL outcode prefixes (matches agent1-crawler)
const PCL_PREFIXES = new Set(['SW1', 'SW3', 'SW7', 'SW10', 'W1', 'W8', 'WC2', 'EC1', 'E1W']);
// POL outcode prefixes
const POL_PREFIXES = new Set(['SW11', 'W11', 'SW8', 'SW6', 'W2', 'NW3', 'N1', 'SE1', 'E14']);

// ── CSV headers for qualified leads output ────────────────────────────────────
const QUALIFIED_CSV_HEADERS = [
  'name', 'company', 'nationality', 'property_interest', 'budget_range',
  'contact_email', 'contact_phone', 'linkedin_url', 'motivation',
  'lead_score', 'source_url', 'date_found', 'status',
  // Qualification dimensions
  'qualified', 'qualificationScore', 'disqualifyReason',
  'budgetMin', 'residencyStatus', 'timeline', 'assetClass', 'locationPreference',
  'qualifiedAt', 'lastContactAt', 'flags',
];

// ─────────────────────────────────────────────────────────────────────────────
// Main export
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Qualify, brief, and/or follow up on HNW investor leads.
 *
 * @param {object}          opts
 * @param {object[]|string} [opts.leads]            Lead array or file path (raw leads)
 * @param {string}          [opts.action]           'qualify'|'brief'|'followup'|'all'
 * @param {number}          [opts.limit]            Max leads to process
 * @param {number}          [opts.overdueAfterDays] Days before a lead is overdue (default 7)
 * @param {boolean}         [opts.writeToDisk]      Write CSV, memos, tracker (default true)
 * @returns {Promise<{
 *   action: string,
 *   processedAt: string,
 *   qualified: object[],
 *   overdue: object[],
 *   briefings: {lead: object, note: string}[],
 * }>}
 */
async function run({
  leads,
  action           = 'qualify',
  limit,
  overdueAfterDays = OVERDUE_THRESHOLD_DAYS,
  writeToDisk      = true,
} = {}) {
  const processedAt = new Date().toISOString();

  // ── Follow-up action: read from qualified/ directory ─────────────────────
  if (action === 'followup') {
    const existing = loadQualifiedLeads();
    const overdue  = checkOverdue(existing, overdueAfterDays);
    log.info(`[agent5] Follow-up: ${existing.length} qualified leads, ${overdue.length} overdue`);

    if (writeToDisk) {
      if (overdue.length > 0) {
        appendTracker(`Agent 5 | ${overdue.length} overdue lead(s) flagged for Julian Noble — no contact in ${overdueAfterDays}+ days`);
        updatePipeline(overdue);
      } else {
        appendTracker(`Agent 5 | Follow-up check: all ${existing.length} qualified leads contacted within ${overdueAfterDays} days`);
      }
    }

    return { action, processedAt, qualified: existing, overdue, briefings: [] };
  }

  // ── Qualify / brief / all actions ────────────────────────────────────────
  let rawLeads = resolveLeads(leads);
  if (!rawLeads.length) {
    log.warn('[agent5] No leads to process.');
    return { action, processedAt, qualified: [], overdue: [], briefings: [] };
  }
  if (limit) rawLeads = rawLeads.slice(0, limit);

  log.info(`[agent5] Qualifying ${rawLeads.length} lead(s) | action: ${action}`);

  // Qualify
  const allQualified   = rawLeads.map(qualifyLead);
  const passed         = allQualified.filter((l) => l.qualified);
  const failed         = allQualified.filter((l) => !l.qualified);

  log.info(`[agent5] ${passed.length} qualified, ${failed.length} disqualified`);

  // Generate briefings if requested
  const briefings = [];
  if (action === 'brief' || action === 'all') {
    for (const lead of passed) {
      const note = generateBriefingNote(lead);
      briefings.push({ lead, note });
      if (writeToDisk) writeBriefingNote(lead, note);
    }
    log.info(`[agent5] ${briefings.length} briefing note(s) prepared`);
  }

  // Check overdue in existing qualified pipeline
  const overdue = checkOverdue(loadQualifiedLeads(), overdueAfterDays);

  // Persist
  if (writeToDisk) {
    writeQualifiedCsv(allQualified);
    appendTracker(`Agent 5 | Qualified ${passed.length}/${rawLeads.length} leads (${failed.length} disqualified)`);
    if (overdue.length > 0) {
      appendTracker(`Agent 5 | ${overdue.length} existing lead(s) overdue for follow-up`);
    }
  }

  return { action, processedAt, qualified: passed, overdue, briefings };
}

// ─────────────────────────────────────────────────────────────────────────────
// Lead qualification  (pure function)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Qualify a single raw lead against SC's four investment dimensions.
 * Pure function — no I/O.
 *
 * @param {object} lead  Raw lead from agent2-leads
 * @returns {object}     Lead with qualification fields appended
 */
function qualifyLead(lead) {
  // ── Parse / infer qualification dimensions ─────────────────────────────────
  const budgetMin         = parseBudgetMin(lead.budget_range ?? lead.price);
  const residencyStatus   = inferResidency(lead);
  const timeline          = inferTimeline(lead);
  const assetClass        = inferAssetClass(lead);
  const locationPref      = inferLocation(lead);

  // ── Score each dimension (0–10) ────────────────────────────────────────────
  const scoreBudget    = scoreDimBudget(budgetMin);
  const scoreTimeline  = scoreDimTimeline(timeline);
  const scoreResidency = scoreDimResidency(residencyStatus);
  const scoreLocation  = scoreDimLocation(locationPref);

  // Weighted composite 0–100
  const qualificationScore = Math.round(
    (scoreBudget    * QUALIFICATION_FIELDS.budget.weight   +
     scoreTimeline  * QUALIFICATION_FIELDS.timeline.weight  +
     scoreResidency * QUALIFICATION_FIELDS.residency.weight +
     scoreLocation  * QUALIFICATION_FIELDS.location.weight) * 10,
  );

  // ── Flags ──────────────────────────────────────────────────────────────────
  const flags = Array.isArray(lead.flags) ? [...lead.flags] : [];

  let disqualifyReason = null;

  if (budgetMin !== null && budgetMin < BUDGET_THRESHOLD_MIN) {
    if (!flags.includes('under_budget')) flags.push('under_budget');
    disqualifyReason = `Budget below minimum threshold (£${BUDGET_THRESHOLD_MIN.toLocaleString('en-GB')})`;
  }
  if (budgetMin === null && !flags.includes('budget_unknown')) {
    flags.push('budget_unknown');
  }
  if (residencyStatus === 'overseas' || residencyStatus === 'non-dom') {
    if (!flags.includes('international')) flags.push('international');
  }
  if (timeline === 'immediate') {
    if (!flags.includes('hot_lead')) flags.push('hot_lead');
  }
  if (lead.contact_email || lead.contact_phone || lead.linkedin_url) {
    if (!flags.includes('contactable')) flags.push('contactable');
  }

  // Qualified: budget ≥ threshold (or unknown) AND composite score ≥ 30
  const underBudget = budgetMin !== null && budgetMin < BUDGET_THRESHOLD_MIN;
  const qualified   = !underBudget && qualificationScore >= 30;

  if (!qualified && !disqualifyReason) {
    disqualifyReason = `Qualification score too low (${qualificationScore}/100)`;
  }

  return {
    ...lead,
    // Normalised fields
    budgetMin,
    residencyStatus,
    timeline,
    assetClass,
    locationPreference: locationPref,
    // Scores
    qualificationScore,
    scoreBreakdown: {
      budget:    scoreBudget,
      timeline:  scoreTimeline,
      residency: scoreResidency,
      location:  scoreLocation,
    },
    // Outcome
    qualified,
    disqualifyReason,
    flags,
    // Lifecycle
    status:         lead.status ?? 'new',
    qualifiedAt:    new Date().toISOString(),
    lastContactAt:  lead.lastContactAt ?? null,
  };
}

// ── Dimension scorers ─────────────────────────────────────────────────────────

function scoreDimBudget(budgetMin) {
  if (budgetMin === null)              return 3;  // unknown — some signal
  if (budgetMin >= 10_000_000)         return 10;
  if (budgetMin >=  5_000_000)         return 9;
  if (budgetMin >=  2_000_000)         return 8;
  if (budgetMin >=  1_000_000)         return 6;
  if (budgetMin >=    500_000)         return 4;
  return 0;                                       // under threshold
}

function scoreDimTimeline(timeline) {
  switch (timeline) {
    case 'immediate':   return 10;
    case '3-6 months':  return 7;
    case '6-12 months': return 5;
    case '12+ months':  return 3;
    default:            return 2;  // unknown
  }
}

function scoreDimResidency(status) {
  switch (status) {
    case 'non-dom':   return 10;  // core SC client profile
    case 'overseas':  return 9;
    case 'resident':  return 6;
    default:          return 3;   // unknown
  }
}

function scoreDimLocation(pref) {
  switch (pref) {
    case 'PCL':      return 10;
    case 'FLEXIBLE': return 8;
    case 'POL':      return 7;
    case 'EMERGING': return 5;
    default:         return 3;   // unknown
  }
}

// ── Inference helpers ─────────────────────────────────────────────────────────

/** Parse the minimum budget from a budget_range band string or numeric price. */
function parseBudgetMin(raw) {
  if (raw == null) return null;
  if (typeof raw === 'number') return raw > 0 ? raw : null;

  const str = String(raw).trim();

  // Direct band lookup
  for (const [key, val] of BUDGET_BANDS) {
    if (str === key) return val;
  }

  // Numeric string (e.g. "£1,450,000" or "1450000")
  const num = parseFloat(str.replace(/[£,\s]/g, '').replace(/[mk]$/i, (m) =>
    m.toLowerCase() === 'm' ? 'e6' : 'e3',
  ));
  return isNaN(num) || num <= 0 ? null : Math.round(num);
}

/** Infer residency status from nationality, source, and motivation. */
function inferResidency(lead) {
  const nat  = String(lead.nationality ?? '').toLowerCase();
  const mot  = String(lead.motivation  ?? '').toLowerCase();
  const src  = String(lead.sourceKey   ?? lead.source ?? '').toLowerCase();

  if (lead.residencyStatus) return lead.residencyStatus;
  if (mot.includes('non-dom') || nat.includes('non-dom'))   return 'non-dom';
  if (nat.includes('british') || nat.includes('uk'))        return 'resident';
  if (src.includes('psc') || mot.includes('overseas') || mot.includes('overseas_property_vehicle')) return 'overseas';
  if (nat && nat !== 'unknown' && nat !== 'null' && !nat.includes('british')) return 'overseas';
  return 'unknown';
}

/** Infer acquisition timeline from property_interest and motivation text. */
function inferTimeline(lead) {
  if (lead.timeline) return lead.timeline;
  const text = `${lead.property_interest ?? ''} ${lead.motivation ?? ''}`.toLowerCase();
  if (/\bimmediat|urgently|asap\b/.test(text))           return 'immediate';
  if (/3.{0,3}6\s*month|q[1-4]\s*\d{4}/.test(text))      return '3-6 months';
  if (/6.{0,3}12\s*month|end of year/.test(text))         return '6-12 months';
  if (/next year|12\+\s*month/.test(text))                return '12+ months';
  return 'unknown';
}

/** Infer target asset class from property_interest text. */
function inferAssetClass(lead) {
  if (lead.assetClass) return lead.assetClass;
  const text = String(lead.property_interest ?? '').toLowerCase();
  if (/new.?build|new.?development|off.?plan/.test(text)) return 'new_build';
  if (/period|georgian|victorian|edwardian/.test(text))   return 'period';
  if (/mixed.?use|commercial|retail/.test(text))          return 'mixed_use';
  return 'unknown';
}

/** Infer preferred market zone from property_interest and postcode signals. */
function inferLocation(lead) {
  if (lead.locationPreference) return lead.locationPreference;
  const text = String(lead.property_interest ?? '').toUpperCase();

  // Check PCL outcode mentions
  for (const pc of PCL_PREFIXES) {
    if (text.includes(pc)) return 'PCL';
  }
  if (/PCL|PRIME CENTRAL|BELGRAVIA|CHELSEA|MAYFAIR|KNIGHTSBRIDGE|KENSINGTON/.test(text)) return 'PCL';

  // Check POL outcode mentions
  for (const pc of POL_PREFIXES) {
    if (text.includes(pc)) return 'POL';
  }
  if (/POL|PRIME OUTER|FULHAM|BATTERSEA|NOTTING HILL|MARYLEBONE/.test(text)) return 'POL';

  if (/EMERGING|NINE ELMS|WHITE CITY|STRATFORD|KING.S CROSS/.test(text)) return 'EMERGING';
  if (/LONDON/.test(text)) return 'FLEXIBLE';
  return 'unknown';
}

// ─────────────────────────────────────────────────────────────────────────────
// Meeting briefing note generator  (pure function)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Generate a one-page meeting briefing note for Julian Noble.
 * Pure function — no I/O.
 *
 * @param {object} lead  Qualified lead (output of qualifyLead())
 * @returns {string}     Markdown briefing note
 */
function generateBriefingNote(lead) {
  const date     = today();
  const name     = lead.name     || 'Anonymous';
  const company  = lead.company  || 'N/A';
  const nat      = lead.nationality || 'N/A';
  const budget   = lead.budget_range || (lead.budgetMin ? fmtPrice(lead.budgetMin) : 'Unknown');
  const score    = lead.qualificationScore ?? 'N/A';
  const status   = qualificationStatus(score);
  const email    = lead.contact_email  || 'N/A';
  const phone    = lead.contact_phone  || 'N/A';
  const linkedin = lead.linkedin_url   || 'N/A';

  const scoreRows = [
    `| Budget Capacity | ${lead.scoreBreakdown?.budget ?? '–'} / 10 | ${budgetNote(lead.budgetMin)} |`,
    `| Acquisition Timeline | ${lead.scoreBreakdown?.timeline ?? '–'} / 10 | ${lead.timeline ?? 'unknown'} |`,
    `| Residency Profile | ${lead.scoreBreakdown?.residency ?? '–'} / 10 | ${lead.residencyStatus ?? 'unknown'} |`,
    `| Location Alignment | ${lead.scoreBreakdown?.location ?? '–'} / 10 | ${lead.locationPreference ?? 'unknown'} |`,
  ].join('\n');

  const approach = buildApproach(lead);
  const flagList = (lead.flags ?? []).length ? lead.flags.map((f) => `\`${f}\``).join(', ') : 'None';

  return `# Client Briefing Note — Julian Noble, Square Centimeter Ltd
**STRICTLY CONFIDENTIAL — For internal use only**
**Date:** ${date}

---

## Lead Summary

| Field | Detail |
|---|---|
| Name | ${name} |
| Company | ${company} |
| Nationality | ${nat} |
| Residency Status | ${lead.residencyStatus ?? 'Unknown'} |
| Contact Email | ${email} |
| Contact Phone | ${phone} |
| LinkedIn | ${linkedin} |
| Source | ${lead.sourceKey ?? lead.source ?? 'N/A'} |
| Date Found | ${lead.date_found ?? 'N/A'} |
| Lead Score (agent2) | ${lead.lead_score ?? 'N/A'} / 10 |

---

## Investment Profile

| Field | Detail |
|---|---|
| Property Interest | ${lead.property_interest ?? 'N/A'} |
| Budget Range | ${budget} |
| Target Zone | ${lead.locationPreference ?? 'Unknown'} |
| Timeline | ${lead.timeline ?? 'Unknown'} |
| Asset Class | ${lead.assetClass ?? 'Unknown'} |
| Motivation | ${lead.motivation ?? 'N/A'} |

---

## Qualification Assessment

**Score: ${score} / 100 — ${status}**

| Dimension | Score | Notes |
|---|---|---|
${scoreRows}

---

## Suggested Approach for Julian Noble

${approach}

---

## Flags

${flagList}

---

*Prepared by SC Agent 5 v${AGENT_VERSION} | Square Centimeter Ltd | CONFIDENTIAL*
`;
}

/** Build a tailored 3-point suggested approach based on lead profile. */
function buildApproach(lead) {
  const points = [];

  // Opening — based on motivation
  const mot = String(lead.motivation ?? '').toLowerCase();
  if (mot.includes('recent_buyer') || mot.includes('cash_buyer')) {
    points.push('**Opening:** Reference recent HMLR transaction as context. Congratulate on acquisition; position SC as advisory partner for future portfolio expansion.');
  } else if (mot.includes('linkedin') || mot.includes('profile')) {
    points.push('**Opening:** Reference shared LinkedIn connection or public market post. Lead with market insight, not a pitch.');
  } else {
    points.push('**Opening:** Warm introduction via SC advisory positioning. Ask about current London property allocation before discussing specific opportunities.');
  }

  // Key qualification question — based on gaps
  const gaps = [];
  if (lead.timeline === 'unknown') gaps.push('acquisition timeline');
  if (lead.assetClass === 'unknown') gaps.push('preferred asset class (new build vs period)');
  if (lead.residencyStatus === 'unknown') gaps.push('UK residency and tax position');
  if (!lead.contact_email && !lead.contact_phone) gaps.push('preferred contact method');

  if (gaps.length) {
    points.push(`**Key qualification question:** Clarify ${gaps.slice(0, 2).join(' and ')} — this will shape the advisory approach and property shortlist.`);
  } else {
    points.push('**Profile is well-qualified:** Proceed to property shortlist discussion and propose a Mayfair/Belgravia property tour.');
  }

  // Advisory angle — based on residency
  switch (lead.residencyStatus) {
    case 'non-dom':
    case 'overseas':
      points.push('**Advisory angle:** Highlight SC\'s expertise in non-dom / international acquisition structures (SPV, direct purchase, SDLT surcharge navigation). Mention currency-adjusted entry pricing and PCL capital preservation thesis.');
      break;
    case 'resident':
      points.push('**Advisory angle:** Focus on portfolio diversification within PCL/POL, yield enhancement strategy, and SC\'s off-market access. SDLT and IHT considerations may apply — recommend SC\'s legal partner referrals.');
      break;
    default:
      points.push('**Advisory angle:** Open-ended discovery. Establish UK connection and tax position before recommending acquisition structure. SDLT exposure can be significant — position SC\'s structuring knowledge as key differentiator.');
  }

  return points.map((p, i) => `${i + 1}. ${p}`).join('\n\n');
}

/** Return a human-readable qualification status from composite score. */
function qualificationStatus(score) {
  if (score >= 70) return '🟢 Highly Qualified';
  if (score >= 50) return '🟡 Qualified';
  if (score >= 30) return '🟠 Monitor';
  return '🔴 Disqualified';
}

/** Short budget note for briefing table. */
function budgetNote(budgetMin) {
  if (budgetMin === null) return 'Budget unknown — clarify';
  if (budgetMin < BUDGET_THRESHOLD_MIN) return `⚠️ Below SC minimum (£${BUDGET_THRESHOLD_MIN.toLocaleString('en-GB')})`;
  if (budgetMin >= 5_000_000) return 'Ultra-HNW — off-market access appropriate';
  if (budgetMin >= 2_000_000) return 'PCL acquisition-ready';
  if (budgetMin >= 1_000_000) return 'PCL entry-level / POL full range';
  return 'POL / emerging';
}

// ─────────────────────────────────────────────────────────────────────────────
// iCal calendar block generator  (pure function)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Generate a VCALENDAR iCal string for a viewing or investor call.
 * Pure function — no I/O.
 *
 * @param {object} lead  Qualified lead object
 * @param {object} [opts]
 * @param {Date|string} [opts.dtstart]    Event start (default: tomorrow 10:00 UTC)
 * @param {Date|string} [opts.dtend]      Event end   (default: dtstart + 60 min)
 * @param {string}      [opts.eventType]  'viewing' | 'call' | 'meeting' (default: 'call')
 * @param {string}      [opts.location]   Venue / address
 * @returns {string}    iCal VCALENDAR string
 */
function generateIcal(lead, opts = {}) {
  const eventType = opts.eventType ?? 'call';

  // Default to tomorrow at 10:00 UTC
  const defaultStart = new Date();
  defaultStart.setUTCDate(defaultStart.getUTCDate() + 1);
  defaultStart.setUTCHours(10, 0, 0, 0);

  const dtstart = opts.dtstart ? new Date(opts.dtstart) : defaultStart;
  const dtend   = opts.dtend   ? new Date(opts.dtend)   : new Date(dtstart.getTime() + 60 * 60_000);

  const name    = lead.name ?? 'Investor';
  const zone    = lead.locationPreference ?? lead.marketZone ?? 'Prime London';
  const summary = eventType === 'viewing'
    ? `Property Viewing — ${zone} — Square Centimeter Ltd`
    : `Investor ${eventType === 'call' ? 'Call' : 'Meeting'}: ${name} — Square Centimeter Ltd`;

  const location = opts.location ?? (eventType === 'viewing' ? `${zone}, London` : 'Square Centimeter Ltd, London');

  const description = [
    `Lead: ${lead.name ?? 'Anonymous'}`,
    `Company: ${lead.company ?? 'N/A'}`,
    `Budget: ${lead.budget_range ?? 'Unknown'}`,
    `Zone: ${zone}`,
    `Qualification Score: ${lead.qualificationScore ?? 'N/A'}/100`,
    '',
    `Prepared by SC Agent 5. See reports/ for full briefing note.`,
    `\\nConfidential — Square Centimeter Ltd`,
  ].join('\\n');

  const uid   = buildUid(lead);
  const stamp = toIcalDate(new Date());

  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Square Centimeter Ltd//SC Agent 5//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:REQUEST',
    'BEGIN:VEVENT',
    `UID:${uid}@squarecentimeter.co.uk`,
    `DTSTAMP:${stamp}`,
    `DTSTART:${toIcalDate(dtstart)}`,
    `DTEND:${toIcalDate(dtend)}`,
    `SUMMARY:${summary}`,
    `DESCRIPTION:${description}`,
    `LOCATION:${location}`,
    'ORGANIZER;CN=Julian Noble:mailto:julian@squarecentimeter.co.uk',
    'STATUS:TENTATIVE',
    'TRANSP:OPAQUE',
    'END:VEVENT',
    'END:VCALENDAR',
    '',
  ].join('\r\n');
}

// ─────────────────────────────────────────────────────────────────────────────
// Overdue follow-up detection  (pure function)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Return leads with no contact in the past overdueAfterDays days.
 * Uses lastContactAt if present, otherwise date_found.
 * Pure function — no I/O.
 *
 * @param {object[]} qualifiedLeads
 * @param {number}   [overdueAfterDays]  default 7
 * @returns {object[]}  Overdue leads (subset of input)
 */
function checkOverdue(qualifiedLeads, overdueAfterDays = OVERDUE_THRESHOLD_DAYS) {
  const cutoffMs = Date.now() - overdueAfterDays * 86_400_000;

  return qualifiedLeads.filter((lead) => {
    // Skip dead or converted leads
    if (['converted', 'dead'].includes(lead.status)) return false;

    const contactTime = lead.lastContactAt
      ? new Date(lead.lastContactAt).getTime()
      : null;

    const foundTime = lead.date_found
      ? new Date(lead.date_found).getTime()
      : null;

    // Reference point: last contact if known; else date when lead was found
    const referenceMs = contactTime ?? foundTime;

    // No timestamp at all → cannot determine overdue
    if (!referenceMs || isNaN(referenceMs)) return false;

    return referenceMs < cutoffMs;
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// File I/O helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Append a timestamped entry to data/tracker.md */
function appendTracker(message) {
  const line     = `- ${new Date().toISOString()} | ${message}\n`;
  const filePath = path.join(DATA_DIR, 'tracker.md');
  try {
    fs.appendFileSync(filePath, line, 'utf8');
  } catch (err) {
    log.warn(`[agent5] tracker.md write failed: ${err.message}`);
  }
}

/** Flag overdue leads in data/pipeline.md */
function updatePipeline(overdueLeads) {
  const filePath = path.join(DATA_DIR, 'pipeline.md');
  const lines    = overdueLeads.map(
    (l) => `- [ ] OVERDUE: ${l.name ?? 'Anonymous'} (${l.budget_range ?? 'budget unknown'}) — no contact since ${l.lastContactAt ?? l.date_found ?? 'unknown'} | Lead score: ${l.lead_score ?? 'N/A'}/10`,
  );
  try {
    fs.appendFileSync(filePath, '\n' + lines.join('\n') + '\n', 'utf8');
  } catch (err) {
    log.warn(`[agent5] pipeline.md write failed: ${err.message}`);
  }
}

/** Write qualified leads to data/leads/qualified/qualified-YYYY-MM-DD.csv (atomic). */
function writeQualifiedCsv(leads) {
  const dir  = path.join(DATA_DIR, 'leads', 'qualified');
  fs.mkdirSync(dir, { recursive: true });

  const filename = `qualified-${today()}.csv`;
  const dest     = path.join(dir, filename);
  const tmp      = `${dest}.tmp`;

  const rows = [
    csvLine(QUALIFIED_CSV_HEADERS),
    ...leads.map((l) => csvLine(QUALIFIED_CSV_HEADERS.map((h) => {
      const val = l[h];
      return Array.isArray(val) ? val.join('|') : (val ?? '');
    }))),
  ];

  fs.writeFileSync(tmp, rows.join('\n') + '\n', 'utf8');
  fs.renameSync(tmp, dest);
  log.info(`[agent5] Qualified CSV → ${dest}`);
}

/** Write a briefing note to reports/brief-{slug}-YYYY-MM-DD.md (atomic). */
function writeBriefingNote(lead, content) {
  fs.mkdirSync(REPORTS_DIR, { recursive: true });

  const slug     = buildNameSlug(lead.name);
  const filename = `brief-${slug}-${today()}.md`;
  const dest     = path.join(REPORTS_DIR, filename);
  const tmp      = `${dest}.tmp`;

  fs.writeFileSync(tmp, content, 'utf8');
  fs.renameSync(tmp, dest);
  log.info(`[agent5] Briefing note → ${dest}`);
}

/** Load all qualified leads from data/leads/qualified/ JSON files. */
function loadQualifiedLeads() {
  try {
    const files = listFiles('leads/qualified');
    const all   = [];
    for (const f of files) {
      try {
        const data = JSON.parse(fs.readFileSync(f, 'utf8'));
        if (Array.isArray(data)) all.push(...data);
      } catch (_) { /* skip corrupt file */ }
    }
    return all;
  } catch (_) {
    return [];
  }
}

/** Resolve leads from array or file path. */
function resolveLeads(leads) {
  if (!leads) {
    // Try latest raw leads file
    try {
      const files = listFiles('leads/raw');
      if (!files.length) return [];
      return JSON.parse(fs.readFileSync(files[0], 'utf8'));
    } catch (_) {
      return [];
    }
  }
  if (typeof leads === 'string') {
    return JSON.parse(fs.readFileSync(path.resolve(leads), 'utf8'));
  }
  if (Array.isArray(leads)) return leads;
  return [leads]; // single object
}

// ─────────────────────────────────────────────────────────────────────────────
// Utilities
// ─────────────────────────────────────────────────────────────────────────────

function toIcalDate(date) {
  // Format: YYYYMMDDTHHMMSSZ
  return date.toISOString().replace(/[-:.]/g, '').slice(0, 15) + 'Z';
}

function buildUid(lead) {
  const base = `${(lead.name ?? 'anon').toLowerCase().replace(/[^a-z0-9]/g, '-')}-${Date.now()}`;
  return base.slice(0, 60);
}

function buildNameSlug(name) {
  return String(name ?? 'lead')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40);
}

function fmtPrice(n) {
  if (!n) return 'N/A';
  return `£${Math.round(n).toLocaleString('en-GB')}`;
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

function csvLine(values) {
  return values.map((v) => {
    const s = v == null ? '' : String(v);
    return s.includes(',') || s.includes('"') || s.includes('\n')
      ? `"${s.replace(/"/g, '""')}"`
      : s;
  }).join(',');
}

// ─────────────────────────────────────────────────────────────────────────────
// Exports
// ─────────────────────────────────────────────────────────────────────────────

module.exports = {
  run,
  qualifyLead,
  generateBriefingNote,
  generateIcal,
  checkOverdue,
  appendTracker,
  parseBudgetMin,
  QUALIFICATION_FIELDS,
  BUDGET_THRESHOLD_MIN,
  AGENT_VERSION,
};
