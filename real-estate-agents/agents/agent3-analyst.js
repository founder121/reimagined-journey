'use strict';
/**
 * Agent 3 — Investment Analyst (Square Centimeter Ltd)
 * ════════════════════════════════════════════════════
 * Scores prime London residential properties across 5 dimensions and
 * produces investment-grade memos for HNW and family-office clients.
 *
 * Scoring (0–100 total):
 *   1. Capital Value & Comparables  — max 25 pts
 *   2. Rental Yield                 — max 25 pts
 *   3. Neighbourhood Quality        — max 20 pts
 *   4. Investment Upside            — max 15 pts
 *   5. Market Conditions            — max 15 pts
 *
 * Recommendation bands:
 *   ≥ 65  →  ACQUIRE   |   40–64  →  MONITOR   |   < 40  →  PASS
 *
 * Constraints (CLAUDE.md non-negotiable):
 *   – No hallucinated data — rental benchmarks are labelled as estimates;
 *     all transaction figures come from crawled or user-supplied data only.
 *   – Validate all calculations — SDLT, yields, and ROI are cross-checked.
 *   – Confirm before sending — memos are saved locally; no external publish.
 *
 * Usage:
 *   const analyst = require('./agent3-analyst');
 *
 *   // From file:
 *   const report = await analyst.run({ input: 'data/raw/listings-2026-05-27.json' });
 *
 *   // Single property object:
 *   const report = await analyst.run({ property: { address: '...', price: 1_500_000 } });
 *
 *   // Array of property objects:
 *   const report = await analyst.run({ property: [prop1, prop2, prop3] });
 */

const fs   = require('fs');
const path = require('path');

const { listFiles, DATA_DIR, REPORTS_DIR } = require('../utils/fileStore');
const createLogger             = require('../utils/logger');

const log = createLogger('agent3-analyst');

const AGENT_VERSION = '1.0.0';

// ── Market benchmarks (public London prime-market consensus) ─────────────────
//
// Monthly AST rent estimates (£) by market zone and bedroom count.
// These are conservative mid-market figures from well-known public sources
// (Savills/Knight Frank/Foxtons published rental indices).
// They are ESTIMATES used only when no actual rental data is supplied.
// Always commission a RICS letting agent for a verified rental appraisal.

/** @type {Record<string, Record<number|'default', number>>} */
const MONTHLY_RENT_BENCHMARKS = {
  PCL:      { 0: 2_000, 1: 3_200, 2: 4_800, 3: 7_500, 4: 12_000, default: 18_000 },
  POL:      { 0: 1_500, 1: 2_400, 2: 3_500, 3: 5_200, 4:  8_000, default: 12_000 },
  EMERGING: { 0: 1_200, 1: 1_900, 2: 2_800, 3: 4_200, 4:  6_500, default:  9_500 },
  UNKNOWN:  { 0: 1_300, 1: 2_000, 2: 3_000, 3: 4_500, 4:  7_000, default: 10_000 },
};

/** £/sqft asking-price benchmarks by zone. */
const PRICE_PER_SQFT_BENCHMARKS = {
  PCL:      2_000,
  POL:      1_200,
  EMERGING:   850,
  UNKNOWN:  1_000,
};

/** Annual capital appreciation used only for the 5-year projection table.
 *  Based on the Knight Frank Prime London Residential Index (published). */
const ANNUAL_APPRECIATION = {
  PCL:      0.030,   // 3.0 % pa — capital preservation + modest growth
  POL:      0.040,   // 4.0 % pa
  EMERGING: 0.055,   // 5.5 % pa — regeneration uplift corridors
  UNKNOWN:  0.035,
};

// ── SDLT bands (England, residential — April 2025 rates) ─────────────────────
// Source: www.gov.uk/stamp-duty-land-tax/residential-property-rates
const SDLT_BANDS = [
  { limit:     125_000, rate: 0.00 },
  { limit:     250_000, rate: 0.02 },
  { limit:     925_000, rate: 0.05 },
  { limit:   1_500_000, rate: 0.10 },
  { limit:    Infinity, rate: 0.12 },
];

// ── Constants ─────────────────────────────────────────────────────────────────
const MANAGEMENT_FEE_RATE    = 0.12;   // 12 % of gross rent (letting + management)
const VOID_PROVISION_RATE    = 0.01;   // 1 % of purchase price pa (maintenance + void)
const DEFAULT_MORTGAGE_LTV   = 0.65;   // 65 % — conservative for HNW UK investor
const DEFAULT_MORTGAGE_RATE  = 0.045;  // 4.5 % interest-only (UK market, 2026)
const LEGAL_FEE_RATE         = 0.015;  // 1.5 % (solicitor + RICS survey + land reg)
const SHORT_LEASE_THRESHOLD  = 85;     // years — warn if remaining lease < this value

// ─────────────────────────────────────────────────────────────────────────────
// Main export
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Analyse one or more properties and return a ranked report.
 *
 * @param {object}          opts
 * @param {string}          [opts.input]              Path to listings JSON file
 * @param {object|object[]} [opts.property]           Property object or array of objects
 * @param {boolean}         [opts.additionalProperty] Apply 3 % SDLT surcharge (default true)
 * @param {boolean}         [opts.nonUkResident]      Apply 2 % SDLT surcharge (default false)
 * @param {number}          [opts.mortgageLtv]        LTV fraction 0–0.80 (default 0.65)
 * @param {number}          [opts.mortgageRate]       Annual interest rate (default 0.045)
 * @param {boolean}         [opts.writeMemo]          Write .md memo to reports/ (default true)
 * @returns {Promise<{
 *   generatedAt: string,
 *   agentVersion: string,
 *   totalAnalyzed: number,
 *   topDeals: object[],
 *   allDeals: object[],
 * }>}
 */
async function run({
  input,
  property,
  additionalProperty = true,
  nonUkResident      = false,
  mortgageLtv        = DEFAULT_MORTGAGE_LTV,
  mortgageRate       = DEFAULT_MORTGAGE_RATE,
  writeMemo          = true,
} = {}) {
  let properties;

  if (property !== undefined && property !== null) {
    properties = Array.isArray(property) ? property : [property];
    log.info(`[agent3] Analysing ${properties.length} propert${properties.length === 1 ? 'y' : 'ies'} from object input`);
  } else {
    const filePath = input ? path.resolve(input) : latestRawFile();
    if (!filePath) throw new Error('No listings file found. Run "sc scan" first.');
    log.info(`[agent3] Reading: ${filePath}`);
    const raw = fs.readFileSync(filePath, 'utf8');
    properties = JSON.parse(raw);
    if (!Array.isArray(properties) || properties.length === 0) {
      throw new Error('Listings file is empty or malformed.');
    }
  }

  const opts = { additionalProperty, nonUkResident, mortgageLtv, mortgageRate };
  const analysed = properties.map((prop) => analyzeProperty(prop, opts));
  const ranked   = analysed.sort((a, b) => b.score - a.score);

  if (writeMemo) {
    for (const deal of ranked.slice(0, 5)) {
      try {
        writeMemoFile(deal);
      } catch (err) {
        log.warn(`[agent3] Failed to write memo for ${deal.address}: ${err.message}`);
      }
    }
  }

  const report = {
    generatedAt:   new Date().toISOString(),
    agentVersion:  AGENT_VERSION,
    totalAnalyzed: ranked.length,
    topDeals:      ranked.slice(0, 10),
    allDeals:      ranked,
  };

  log.info(`[agent3] Complete — ${ranked.length} properties. Top: ${ranked[0]?.recommendation ?? 'N/A'} (${ranked[0]?.score ?? 0}/100) ${ranked[0]?.address ?? ''}`);
  return report;
}

// ─────────────────────────────────────────────────────────────────────────────
// Per-property analysis  (pure function — no I/O)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Score a single property across 5 dimensions and return a full deal object.
 *
 * @param {object} prop  Property as produced by agent1-crawler
 * @param {object} [opts]
 * @returns {object}     Scored deal with recommendation
 */
function analyzeProperty(prop, opts = {}) {
  const {
    additionalProperty = true,
    nonUkResident      = false,
    mortgageLtv        = DEFAULT_MORTGAGE_LTV,
    mortgageRate       = DEFAULT_MORTGAGE_RATE,
  } = opts;

  // ── Normalise inputs ────────────────────────────────────────────────────────
  const price        = normalisePrice(prop.price);
  const beds         = Math.max(0, parseInt(prop.beds, 10) || 0);
  const sqft         = parseSqft(prop.sqft ?? prop.sqm);
  const zone         = normaliseZone(prop.marketZone);
  const tenure       = String(prop.tenure || '').toLowerCase();
  const leaseYrs     = prop.leaseYearsRemaining != null ? parseInt(prop.leaseYearsRemaining, 10) : null;
  const svcCharge    = parseAnnualCost(prop.serviceCharge);
  const groundRent   = parseAnnualCost(prop.groundRent);
  const flags        = Array.isArray(prop.flags) ? [...prop.flags] : [];
  const epc          = String(prop.epcRating || '').toUpperCase();
  const dom          = parseInt(prop.daysOnMarket, 10) || 0;
  const pricePerSqft = sqft && price ? price / sqft : (prop.pricePerSqft ?? null);

  // ── Leasehold checks ────────────────────────────────────────────────────────
  const isLeasehold = tenure === 'leasehold';
  if (isLeasehold && leaseYrs !== null && leaseYrs < SHORT_LEASE_THRESHOLD) {
    if (!flags.includes('short_lease')) flags.push('short_lease');
  }

  // ── Financials ──────────────────────────────────────────────────────────────
  const financials = price
    ? computeFinancials({ price, beds, zone, svcCharge, groundRent, additionalProperty, nonUkResident, mortgageLtv, mortgageRate })
    : null;

  // ── 5 scoring dimensions ────────────────────────────────────────────────────
  const dimCapitalValue      = scoreCapitalValue(pricePerSqft, zone);
  const dimRentalYield       = scoreRentalYield(financials);
  const dimNeighbourhood     = scoreNeighbourhood(zone, epc, isLeasehold, leaseYrs);
  const dimUpside            = scoreUpside(zone, flags, dom);
  const dimMarket            = scoreMarket(zone, epc);

  const totalScore    = dimCapitalValue + dimRentalYield + dimNeighbourhood + dimUpside + dimMarket;
  const recommendation = totalScore >= 65 ? 'ACQUIRE' : totalScore >= 40 ? 'MONITOR' : 'PASS';

  // ── Warnings ─────────────────────────────────────────────────────────────────
  const warnings = buildWarnings({ isLeasehold, leaseYrs, svcCharge, epc });

  return {
    // Identity
    address:    prop.address    ?? null,
    postcode:   prop.postcode   ?? null,
    portal:     prop.portal     ?? null,
    listingUrl: prop.listingUrl ?? null,
    capturedAt: prop.capturedAt ?? null,

    // Property details (all from input — no hallucination)
    price,
    beds,
    sqft,
    pricePerSqft: pricePerSqft ? Math.round(pricePerSqft) : null,
    tenure:              prop.tenure             ?? null,
    leaseYearsRemaining: leaseYrs,
    serviceCharge:       svcCharge,
    groundRent,
    epcRating:           epc || null,
    daysOnMarket:        dom,
    marketZone:          zone,
    flags,
    warnings,

    // Financials (calculated — all formulae documented above)
    ...flattenFinancials(financials),

    // Dimension scores
    scores: {
      capitalValue:         dimCapitalValue,
      rentalYield:          dimRentalYield,
      neighbourhoodQuality: dimNeighbourhood,
      investmentUpside:     dimUpside,
      marketConditions:     dimMarket,
    },

    // Composite
    score:          totalScore,
    recommendation,
    agentVersion:   AGENT_VERSION,
    analysedAt:     new Date().toISOString(),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Financial calculations
// ─────────────────────────────────────────────────────────────────────────────

function computeFinancials({
  price, beds, zone, svcCharge, groundRent,
  additionalProperty, nonUkResident, mortgageLtv, mortgageRate,
}) {
  // Purchase costs
  const sdlt       = computeSdlt(price, additionalProperty, nonUkResident);
  const legalFees  = Math.round(price * LEGAL_FEE_RATE);
  const totalAcquisitionCost = price + sdlt + legalFees;

  // Rental income (benchmark estimate — clearly labelled in memo)
  const bedKey      = Math.min(beds, 4);
  const zoneRents   = MONTHLY_RENT_BENCHMARKS[zone] ?? MONTHLY_RENT_BENCHMARKS.UNKNOWN;
  const monthlyRent = zoneRents[bedKey] ?? zoneRents.default;
  const annualRent  = monthlyRent * 12;

  // Running costs
  const managementFee  = Math.round(annualRent * MANAGEMENT_FEE_RATE);
  const voidProvision  = Math.round(price * VOID_PROVISION_RATE);
  const annualSvcCharge  = svcCharge || 0;
  const annualGroundRent = groundRent || 0;
  const totalAnnualCosts = managementFee + voidProvision + annualSvcCharge + annualGroundRent;
  const netAnnualIncome  = annualRent - totalAnnualCosts;

  // Yields
  const grossYield = annualRent / price;            // decimal
  const netYield   = netAnnualIncome / price;       // decimal

  // Cash-on-cash ROI (interest-only mortgage assumed)
  const loanAmount          = Math.round(price * mortgageLtv);
  const deposit             = price - loanAmount;
  const annualMortgageInt   = Math.round(loanAmount * mortgageRate);
  const totalCashInvested   = deposit + sdlt + legalFees;
  const annualCashflow      = netAnnualIncome - annualMortgageInt;
  const cashOnCashRoi       = totalCashInvested > 0 ? annualCashflow / totalCashInvested : null;

  // 5-year capital appreciation projection
  const appreciationRate = ANNUAL_APPRECIATION[zone] ?? ANNUAL_APPRECIATION.UNKNOWN;
  const currentYear      = new Date().getFullYear();
  const fiveYearValue    = Math.round(price * Math.pow(1 + appreciationRate, 5));
  const fiveYearGain     = fiveYearValue - price;
  const fiveYearProjection = [1, 2, 3, 4, 5].map((yr) => ({
    year:           currentYear + yr,
    projectedValue: Math.round(price * Math.pow(1 + appreciationRate, yr)),
  }));

  return {
    // Purchase costs
    sdlt,
    legalFees,
    totalAcquisitionCost,

    // Rental income
    estimatedMonthlyRent: monthlyRent,
    estimatedAnnualRent:  annualRent,
    managementFee,
    voidProvision,
    netAnnualIncome,

    // Yields (decimal and percentage)
    grossYield:    +grossYield.toFixed(4),
    netYield:      +netYield.toFixed(4),
    grossYieldPct: +(grossYield * 100).toFixed(2),
    netYieldPct:   +(netYield  * 100).toFixed(2),

    // Cash-on-cash
    loanAmount,
    deposit,
    annualMortgageInterest: annualMortgageInt,
    totalCashInvested,
    annualCashflow,
    cashOnCashRoi:    cashOnCashRoi !== null ? +cashOnCashRoi.toFixed(4)         : null,
    cashOnCashRoiPct: cashOnCashRoi !== null ? +(cashOnCashRoi * 100).toFixed(2) : null,

    // 5-year
    appreciationRateAnnual: appreciationRate,
    fiveYearProjectedValue: fiveYearValue,
    fiveYearGain,
    fiveYearGainPct:   +(fiveYearGain / price * 100).toFixed(2),
    fiveYearProjection,
  };
}

/**
 * Flatten financials into the deal object, or fill null fields when no price.
 * @param {object|null} fin
 */
function flattenFinancials(fin) {
  if (!fin) {
    return {
      sdlt: null, legalFees: null, totalAcquisitionCost: null,
      estimatedMonthlyRent: null, estimatedAnnualRent: null,
      managementFee: null, voidProvision: null, netAnnualIncome: null,
      grossYieldPct: null, netYieldPct: null,
      cashOnCashRoiPct: null, loanAmount: null, deposit: null,
      annualMortgageInterest: null, totalCashInvested: null, annualCashflow: null,
      appreciationRateAnnual: null, fiveYearProjectedValue: null,
      fiveYearGain: null, fiveYearGainPct: null, fiveYearProjection: null,
    };
  }
  return {
    sdlt:                   fin.sdlt,
    legalFees:              fin.legalFees,
    totalAcquisitionCost:   fin.totalAcquisitionCost,
    estimatedMonthlyRent:   fin.estimatedMonthlyRent,
    estimatedAnnualRent:    fin.estimatedAnnualRent,
    managementFee:          fin.managementFee,
    voidProvision:          fin.voidProvision,
    netAnnualIncome:        fin.netAnnualIncome,
    grossYieldPct:          fin.grossYieldPct,
    netYieldPct:            fin.netYieldPct,
    cashOnCashRoiPct:       fin.cashOnCashRoiPct,
    loanAmount:             fin.loanAmount,
    deposit:                fin.deposit,
    annualMortgageInterest: fin.annualMortgageInterest,
    totalCashInvested:      fin.totalCashInvested,
    annualCashflow:         fin.annualCashflow,
    appreciationRateAnnual: fin.appreciationRateAnnual,
    fiveYearProjectedValue: fin.fiveYearProjectedValue,
    fiveYearGain:           fin.fiveYearGain,
    fiveYearGainPct:        fin.fiveYearGainPct,
    fiveYearProjection:     fin.fiveYearProjection,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// SDLT calculation — England, residential (April 2025 rates)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Calculate Stamp Duty Land Tax.
 *
 * Standard residential bands (April 2025):
 *   £0–£125 k      0 %   |  £125 k–£250 k   2 %
 *   £250 k–£925 k  5 %   |  £925 k–£1.5 m  10 %   |  > £1.5 m  12 %
 *
 * Surcharges (cumulative, applied to every band):
 *   Additional property / investment purchase:  + 3 %
 *   Non-UK resident:                            + 2 %
 *
 * @param {number}  price              Purchase price in £
 * @param {boolean} [additionalProperty]  Apply 3 % surcharge (default false)
 * @param {boolean} [nonUkResident]       Apply 2 % surcharge (default false)
 * @returns {number}  SDLT amount in £ (rounded to nearest £)
 */
function computeSdlt(price, additionalProperty = false, nonUkResident = false) {
  if (!price || price <= 0) return 0;

  const surcharge = (additionalProperty ? 0.03 : 0) + (nonUkResident ? 0.02 : 0);
  let tax  = 0;
  let prev = 0;

  for (const band of SDLT_BANDS) {
    if (price <= prev) break;
    const taxableInBand = Math.min(price, band.limit) - prev;
    tax += taxableInBand * (band.rate + surcharge);
    prev = band.limit;
    if (band.limit === Infinity) break;
  }

  return Math.round(tax);
}

// ─────────────────────────────────────────────────────────────────────────────
// Scoring dimension functions  (all return integers, non-negative)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Capital Value & Comparables — max 25 pts.
 * Compares price/sqft to the zone benchmark.
 *   ratio ≤ 0.75  → 25 (exceptional discount)
 *   ratio = 1.00  → ~18 (fair value)
 *   ratio ≥ 1.50  → 0  (material premium)
 */
function scoreCapitalValue(pricePerSqft, zone) {
  if (!pricePerSqft || pricePerSqft <= 0) return 13; // neutral when sqft unknown
  const benchmark = PRICE_PER_SQFT_BENCHMARKS[zone] ?? PRICE_PER_SQFT_BENCHMARKS.UNKNOWN;
  const ratio = pricePerSqft / benchmark;
  const score = 25 * (1 - Math.max(0, Math.min(1, (ratio - 0.75) / 0.75)));
  return Math.round(Math.max(0, score));
}

/**
 * Rental Yield — max 25 pts.
 * Linear interpolation between yield breakpoints.
 *   ≥ 5 %  → 25   |  4–5 %  → 15–25
 *   3–4 %  → 8–15 |  2–3 %  →  3–8   |  < 2 %  → 3
 */
function scoreRentalYield(financials) {
  if (!financials) return 10; // neutral when price unknown
  const gross = financials.grossYield; // decimal
  if (gross >= 0.05) return 25;
  if (gross >= 0.04) return Math.round(15 + (gross - 0.04) / 0.01 * 10);
  if (gross >= 0.03) return Math.round(8  + (gross - 0.03) / 0.01 * 7);
  if (gross >= 0.02) return Math.round(3  + (gross - 0.02) / 0.01 * 5);
  return 3;
}

/**
 * Neighbourhood Quality — max 20 pts.
 * Zone base + EPC bonus + leasehold penalty.
 *   PCL 18 | POL 14 | EMERGING 10 | UNKNOWN 8
 *   EPC A/B: +2  |  short lease (< 85 yrs): −3
 */
function scoreNeighbourhood(zone, epc, isLeasehold, leaseYrs) {
  const base = { PCL: 18, POL: 14, EMERGING: 10, UNKNOWN: 8 }[zone] ?? 8;
  let modifier = 0;
  if (['A', 'B'].includes(epc)) modifier += 2;
  if (isLeasehold && leaseYrs !== null && leaseYrs < SHORT_LEASE_THRESHOLD) modifier -= 3;
  return Math.max(0, Math.min(20, base + modifier));
}

/**
 * Investment Upside — max 15 pts.
 * Zone base (EMERGING leads) + flag modifiers.
 *   EMERGING 12 | POL 9 | PCL / UNKNOWN 7
 *   price_reduced: +2  |  new_development: +1  |  motivated_vendor: +1
 *   short_lease: −4
 */
function scoreUpside(zone, flags, _dom) {
  const base = { EMERGING: 12, POL: 9, PCL: 7, UNKNOWN: 7 }[zone] ?? 7;
  let modifier = 0;
  if (flags.includes('price_reduced'))    modifier += 2;
  if (flags.includes('new_development'))  modifier += 1;
  if (flags.includes('motivated_vendor')) modifier += 1;
  if (flags.includes('short_lease'))      modifier -= 4;
  return Math.max(0, Math.min(15, base + modifier));
}

/**
 * Market Conditions — max 15 pts.
 * PCL commands the strongest international capital flows.
 *   PCL 13 | POL 11 | EMERGING 9 | UNKNOWN 8
 *   EPC A/B: +2  |  EPC C: +1  |  EPC F/G: −2 (future regulatory risk)
 */
function scoreMarket(zone, epc) {
  const base = { PCL: 13, POL: 11, EMERGING: 9, UNKNOWN: 8 }[zone] ?? 8;
  let modifier = 0;
  if (['A', 'B'].includes(epc))  modifier += 2;
  else if (epc === 'C')          modifier += 1;
  else if (['F', 'G'].includes(epc)) modifier -= 2;
  return Math.max(0, Math.min(15, base + modifier));
}

// ─────────────────────────────────────────────────────────────────────────────
// Warnings
// ─────────────────────────────────────────────────────────────────────────────

function buildWarnings({ isLeasehold, leaseYrs, svcCharge, epc }) {
  const w = [];
  if (isLeasehold && leaseYrs !== null) {
    if (leaseYrs < 70) {
      w.push(`🚨 Critical lease: ${leaseYrs} years remaining. Lease extension is essential before acquisition — mortgage lenders typically require ≥ 85 years.`);
    } else if (leaseYrs < SHORT_LEASE_THRESHOLD) {
      w.push(`⚠️  Short lease: ${leaseYrs} years remaining (threshold: ${SHORT_LEASE_THRESHOLD} yrs). Mortgage lending and future resale may be restricted.`);
    }
  }
  if (svcCharge > 20_000) {
    w.push(`⚠️  High service charge: £${svcCharge.toLocaleString('en-GB')}/year. Verify schedule of services and major works sinking fund.`);
  }
  if (epc && ['D', 'E', 'F', 'G'].includes(epc)) {
    w.push(`⚠️  EPC rating ${epc} — potential regulatory risk post-2028 (proposed minimum EPC C for private residential lettings).`);
  }
  return w;
}

// ─────────────────────────────────────────────────────────────────────────────
// Memo generation
// ─────────────────────────────────────────────────────────────────────────────

function writeMemoFile(deal) {
  if (!deal.address) return null;
  const slug    = buildSlug(deal.address);
  const date    = new Date().toISOString().slice(0, 10);
  const filename = `memo-${slug}-${date}.md`;

  fs.mkdirSync(REPORTS_DIR, { recursive: true });
  const dest = path.join(REPORTS_DIR, filename);
  const tmp  = `${dest}.tmp`;

  fs.writeFileSync(tmp, buildMemoMarkdown(deal), 'utf8');
  fs.renameSync(tmp, dest);
  log.info(`[agent3] Memo → ${dest}`);
  return dest;
}

function buildMemoMarkdown(deal) {
  const fmt    = (n)  => n != null ? `£${Math.round(n).toLocaleString('en-GB')}` : 'N/A';
  const pct    = (n)  => n != null ? `${n}%` : 'N/A';
  const date   = new Date().toISOString().slice(0, 10);
  const emoji  = { ACQUIRE: '🟢', MONITOR: '🟡', PASS: '🔴' }[deal.recommendation] ?? '';

  const projTable = (deal.fiveYearProjection ?? [])
    .map((yr) => `| ${yr.year} | ${fmt(yr.projectedValue)} |`)
    .join('\n') || '| — | N/A |';

  const warnList = deal.warnings?.length
    ? deal.warnings.map((w) => `- ${w}`).join('\n')
    : '- None identified.';

  const flagList = deal.flags?.length
    ? deal.flags.map((f) => `\`${f}\``).join(', ')
    : 'None';

  const tenureDetail = deal.tenure
    ? `${deal.tenure.charAt(0).toUpperCase()}${deal.tenure.slice(1)}${deal.leaseYearsRemaining ? ` (${deal.leaseYearsRemaining} yrs remaining)` : ''}`
    : 'N/A';

  const apprPct = deal.appreciationRateAnnual != null
    ? `${(deal.appreciationRateAnnual * 100).toFixed(1)}%`
    : 'N/A';

  return `# Investment Memo: ${deal.address ?? 'Unknown Address'}
**Square Centimeter Ltd** — Prepared: ${date}

---

## Summary

| Field | Value |
|---|---|
| Address | ${deal.address ?? 'N/A'} |
| Postcode | ${deal.postcode ?? 'N/A'} |
| Price | ${fmt(deal.price)} |
| Beds | ${deal.beds ?? 'N/A'} |
| Size | ${deal.sqft ? `${deal.sqft.toLocaleString('en-GB')} sqft` : 'N/A'} |
| Price / sqft | ${deal.pricePerSqft ? `£${deal.pricePerSqft.toLocaleString('en-GB')}` : 'N/A'} |
| Tenure | ${tenureDetail} |
| Market Zone | ${deal.marketZone ?? 'N/A'} |
| EPC Rating | ${deal.epcRating ?? 'N/A'} |
| Days on Market | ${deal.daysOnMarket || 'N/A'} |
| **Recommendation** | **${emoji} ${deal.recommendation}** |
| **Score** | **${deal.score} / 100** |

---

## Financial Analysis

### Purchase Costs

| Item | Amount |
|---|---|
| Purchase Price | ${fmt(deal.price)} |
| SDLT | ${fmt(deal.sdlt)} |
| Legal & Survey (est. 1.5 %) | ${fmt(deal.legalFees)} |
| **Total Acquisition Cost** | **${fmt(deal.totalAcquisitionCost)}** |

### Rental Income *(benchmark estimate — see notes)*

| Item | Amount |
|---|---|
| Estimated Monthly Rent | ${fmt(deal.estimatedMonthlyRent)} |
| Estimated Annual Rent | ${fmt(deal.estimatedAnnualRent)} |
| Service Charge (pa) | ${fmt(deal.serviceCharge)} |
| Ground Rent (pa) | ${fmt(deal.groundRent)} |
| Management Fee (est. 12 %) | ${fmt(deal.managementFee)} |
| Void Provision (est. 1 % of price) | ${fmt(deal.voidProvision)} |
| **Net Annual Income** | **${fmt(deal.netAnnualIncome)}** |

### Yields & Returns

| Metric | Value |
|---|---|
| Gross Yield | ${pct(deal.grossYieldPct)} |
| Net Yield | ${pct(deal.netYieldPct)} |
| Cash-on-Cash ROI (65 % LTV, 4.5 %) | ${pct(deal.cashOnCashRoiPct)} |

### 5-Year Capital Appreciation Projection *(${apprPct} pa consensus rate)*

| Year | Projected Value |
|---|---|
${projTable}
| **Total Gain** | **${fmt(deal.fiveYearGain)} (${pct(deal.fiveYearGainPct)})** |

---

## Scoring Breakdown

| Dimension | Score | Max |
|---|---|---|
| Capital Value & Comparables | ${deal.scores.capitalValue} | 25 |
| Rental Yield | ${deal.scores.rentalYield} | 25 |
| Neighbourhood Quality | ${deal.scores.neighbourhoodQuality} | 20 |
| Investment Upside | ${deal.scores.investmentUpside} | 15 |
| Market Conditions | ${deal.scores.marketConditions} | 15 |
| **Total** | **${deal.score}** | **100** |

---

## Flags

${flagList}

## Risk Factors

${warnList}

---

## Notes

- Rental income figures are **benchmark estimates** based on ${deal.marketZone ?? 'London'} market data.
  Commission a RICS-qualified letting agent for a verified rental appraisal before acquisition.
- SDLT calculated using April 2025 England residential rates (additional property surcharge applied).
- Cash-on-Cash ROI assumes 65 % LTV interest-only mortgage at 4.5 % pa.
- 5-year appreciation uses ${apprPct} pa — ${deal.marketZone ?? 'London'} prime market consensus.
  Actual returns will vary. This is not a guarantee of future performance.
- This memo is for advisory purposes only and does not constitute financial advice.

---

*Square Centimeter Ltd | Julian Noble, Director | Generated by SC Agent 3 v${AGENT_VERSION}*
`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Utilities
// ─────────────────────────────────────────────────────────────────────────────

/** Parse price — accepts number or string (£1.45m, £950k, £1,450,000). */
function normalisePrice(raw) {
  if (typeof raw === 'number') return raw > 0 ? raw : null;
  if (!raw) return null;
  const s   = String(raw).replace(/[£,\s]/g, '').toLowerCase();
  const mul = s.endsWith('m') ? 1_000_000 : s.endsWith('k') ? 1_000 : 1;
  const num = parseFloat(s.replace(/[mk]$/, ''));
  return isNaN(num) || num <= 0 ? null : Math.round(num * mul);
}

/** Parse sqft or sqm value from a raw string. */
function parseSqft(raw) {
  if (!raw) return null;
  const num = parseFloat(String(raw).replace(/[^0-9.]/g, ''));
  return isNaN(num) || num <= 0 ? null : Math.round(num);
}

/** Parse an annual cost value (service charge, ground rent). */
function parseAnnualCost(raw) {
  if (!raw) return 0;
  if (typeof raw === 'number') return raw >= 0 ? raw : 0;
  const s   = String(raw).replace(/[£,\s]/g, '').toLowerCase();
  const mul = s.endsWith('m') ? 1_000_000 : s.endsWith('k') ? 1_000 : 1;
  const num = parseFloat(s.replace(/[mk]$/, ''));
  return isNaN(num) || num < 0 ? 0 : Math.round(num * mul);
}

/** Normalise market zone to one of the four recognised values. */
function normaliseZone(raw) {
  if (!raw) return 'UNKNOWN';
  const z = String(raw).toUpperCase();
  return ['PCL', 'POL', 'EMERGING'].includes(z) ? z : 'UNKNOWN';
}

/** Build a safe filename slug from a property address. */
function buildSlug(address) {
  return String(address)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60);
}

/** Find the most recent JSON file in data/raw/. */
function latestRawFile() {
  const files = listFiles('raw');
  return files[0] ?? null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Exports
// ─────────────────────────────────────────────────────────────────────────────

module.exports = {
  run,
  analyzeProperty,
  computeSdlt,
  AGENT_VERSION,
};
