'use strict';
/**
 * Agent 3 — Investment Analyst
 * ────────────────────────────
 * Reads property JSON files from data/properties/ and produces
 * scored investment analysis reports in data/reports/.
 *
 * Calculations performed locally (no LLM for numbers):
 *   – Price-per-sqft
 *   – Gross Rent Multiplier (GRM)
 *   – Estimated cap rate
 *   – MAO (Maximum Allowable Offer) for flip strategy
 *   – Monthly cashflow estimate for buy-hold strategy
 *   – Deal score 0–100
 *
 * An optional LLM call (Claude) adds a plain-English deal narrative
 * when ANTHROPIC_API_KEY is set.
 *
 * Usage:
 *   const analyst = require('./agent3-analyst');
 *   const report  = await analyst.run({ strategy: 'buy-hold' });
 *
 * CLI:
 *   node index.js analyze --input data/properties/zillow-TX-2024-01-15.json
 *                         --strategy buy-hold
 */

const fs = require('fs');
const path = require('path');
const Anthropic = require('@anthropic-ai/sdk');

const { writeData, listFiles } = require('../utils/fileStore');
const createLogger = require('../utils/logger');

const log = createLogger('agent3-analyst');

// ── Strategy weight profiles ──────────────────────────────────────────────────
const STRATEGY_PROFILES = {
  'buy-hold': {
    cashflowWeight: 0.45,
    capRateWeight: 0.30,
    domWeight: 0.10,          // high DOM = motivated seller (good)
    pricePerSqftWeight: 0.15,
    targetCapRate: 0.07,       // 7 %
    targetMonthlyFlow: 300,    // $300 / door
  },
  flip: {
    maoWeight: 0.50,           // discount to ARV
    rehabBandWeight: 0.20,
    domWeight: 0.10,
    pricePerSqftWeight: 0.20,
    flipMargin: 0.70,          // 70 % rule: MAO = ARV * 0.70 – rehab
  },
  wholesale: {
    maoWeight: 0.60,
    domWeight: 0.20,
    pricePerSqftWeight: 0.20,
    wholesaleDiscount: 0.65,   // target 65 % of ARV
  },
};

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * @param {object} opts
 * @param {string} [opts.input]    path to properties JSON (or latest if omitted)
 * @param {string} [opts.strategy] 'buy-hold' | 'flip' | 'wholesale'
 * @param {boolean} [opts.narratives] add LLM narratives (requires API key)
 * @returns {Promise<object>} analysis report
 */
async function run({ input, strategy = 'buy-hold', narratives = false } = {}) {
  // Resolve input file
  const filePath = input ? path.resolve(input) : latestPropertiesFile();
  if (!filePath) throw new Error('No properties file found. Run "crawl" first.');

  log.info(`Analyzing: ${filePath} | strategy: ${strategy}`);

  const properties = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  if (!Array.isArray(properties) || properties.length === 0) {
    throw new Error('Properties file is empty or malformed.');
  }

  const profile = STRATEGY_PROFILES[strategy];
  if (!profile) throw new Error(`Unknown strategy "${strategy}".`);

  // ── Score each property ───────────────────────────────────────────────────
  const analysed = properties.map((prop) => analyzeProperty(prop, strategy, profile));
  const ranked = analysed.sort((a, b) => b.score - a.score);

  // ── Optional LLM narrative ────────────────────────────────────────────────
  if (narratives && process.env.ANTHROPIC_API_KEY) {
    await addNarratives(ranked.slice(0, 10), strategy); // narrate top 10 only
  }

  const report = {
    generatedAt: new Date().toISOString(),
    sourceFile: path.basename(filePath),
    strategy,
    totalAnalyzed: ranked.length,
    topDeals: ranked.slice(0, 20),
    allDeals: ranked,
  };

  const baseName = `analysis-${strategy}-${path.basename(filePath, '.json')}`;
  const outPath = writeData('reports', baseName, report);
  log.info(`Report written → ${outPath}`);

  return report;
}

// ── Per-property analysis ─────────────────────────────────────────────────────

function analyzeProperty(prop, strategy, profile) {
  const price = parsePrice(prop.price);
  const sqft = parseInt(prop.sqft) || null;
  const beds = parseInt(prop.beds) || 0;
  const baths = parseFloat(prop.baths) || 0;
  const dom = parseDom(prop.daysOnMarket);

  // Derived metrics
  const pricePerSqft = sqft && price ? price / sqft : null;
  const estimatedRent = estimateRent(beds, baths, prop.state);
  const estimatedRehab = estimateRehab(sqft, 'light'); // conservative
  const arv = price ? price * 1.15 : null;            // rough 15 % ARV bump

  let score = 0;
  const flags = [];

  if (strategy === 'buy-hold') {
    const annualRent = estimatedRent * 12;
    const grm = price && annualRent ? price / annualRent : null;
    const capRate = price && annualRent ? (annualRent * 0.6) / price : null; // 40 % expense ratio
    const monthlyCashflow = estimatedRent
      ? estimatedRent - (price ? price * 0.007 : 0) // PITI rough estimate
      : null;

    score = scoreHold({ capRate, monthlyCashflow, dom, pricePerSqft, profile });
    if (dom && dom > 60) flags.push('motivated_seller');
    if (capRate && capRate > 0.09) flags.push('strong_cap_rate');
    if (monthlyCashflow && monthlyCashflow > 500) flags.push('strong_cashflow');

    return {
      ...summarize(prop),
      price,
      pricePerSqft,
      estimatedRent,
      grm,
      capRate: capRate ? +capRate.toFixed(4) : null,
      monthlyCashflow: monthlyCashflow ? Math.round(monthlyCashflow) : null,
      daysOnMarket: dom,
      score,
      flags,
    };
  }

  if (strategy === 'flip') {
    const mao = arv && estimatedRehab
      ? arv * (profile.flipMargin || 0.70) - estimatedRehab
      : null;
    const profit = mao && price ? mao - price : null;
    const roi = profit && estimatedRehab ? profit / (estimatedRehab + (price || 0)) : null;

    score = scoreFlip({ mao, price, profit, dom, pricePerSqft, profile });
    if (mao && price && price < mao) flags.push('below_mao');
    if (profit && profit > 30000) flags.push('strong_profit');

    return {
      ...summarize(prop),
      price,
      arv,
      estimatedRehab,
      mao: mao ? Math.round(mao) : null,
      estimatedProfit: profit ? Math.round(profit) : null,
      roi: roi ? +roi.toFixed(4) : null,
      daysOnMarket: dom,
      score,
      flags,
    };
  }

  // wholesale
  const wholesaleMAO = arv ? arv * (profile.wholesaleDiscount || 0.65) : null;
  const spread = wholesaleMAO && price ? wholesaleMAO - price : null;

  score = scoreWholesale({ wholesaleMAO, price, spread, dom, profile });
  if (spread && spread > 20000) flags.push('strong_spread');
  if (dom && dom > 90) flags.push('highly_motivated');

  return {
    ...summarize(prop),
    price,
    arv,
    wholesaleMAO: wholesaleMAO ? Math.round(wholesaleMAO) : null,
    estimatedSpread: spread ? Math.round(spread) : null,
    daysOnMarket: dom,
    score,
    flags,
  };
}

// ── Scoring functions ─────────────────────────────────────────────────────────

function scoreHold({ capRate, monthlyCashflow, dom, pricePerSqft, profile }) {
  let s = 0;
  if (capRate) s += Math.min(capRate / profile.targetCapRate, 2) * 30;
  if (monthlyCashflow) s += Math.min(monthlyCashflow / profile.targetMonthlyFlow, 2) * 30;
  if (dom) s += Math.min(dom / 180, 1) * 20; // long DOM = motivated
  if (pricePerSqft) s += Math.max(0, (200 - pricePerSqft) / 200) * 20;
  return Math.round(Math.min(s, 100));
}

function scoreFlip({ mao, price, profit, dom, pricePerSqft, profile }) {
  let s = 0;
  if (mao && price) s += Math.min((mao - price) / mao, 1) * 50;
  if (profit) s += Math.min(profit / 50000, 1) * 30;
  if (dom) s += Math.min(dom / 120, 1) * 10;
  if (pricePerSqft) s += Math.max(0, (150 - pricePerSqft) / 150) * 10;
  return Math.round(Math.min(s, 100));
}

function scoreWholesale({ wholesaleMAO, price, spread, dom, profile }) {
  let s = 0;
  if (wholesaleMAO && price) s += Math.min((wholesaleMAO - price) / wholesaleMAO, 1) * 60;
  if (spread) s += Math.min(spread / 40000, 1) * 20;
  if (dom) s += Math.min(dom / 120, 1) * 20;
  return Math.round(Math.min(s, 100));
}

// ── LLM narrative enrichment ──────────────────────────────────────────────────

async function addNarratives(deals, strategy) {
  const client = new Anthropic();
  for (const deal of deals) {
    try {
      const prompt = buildNarrativePrompt(deal, strategy);
      const msg = await client.messages.create({
        model: 'claude-sonnet-4-6',
        max_tokens: 300,
        messages: [{ role: 'user', content: prompt }],
      });
      deal.narrative = msg.content[0]?.text?.trim() || null;
    } catch (err) {
      log.warn(`Narrative generation failed for ${deal.address}: ${err.message}`);
      deal.narrative = null;
    }
  }
}

function buildNarrativePrompt(deal, strategy) {
  return `You are a real estate investment analyst. Based ONLY on the following
parsed property data (do NOT invent or hallucinate any values), write a 2-3 sentence
plain-English investment summary for a ${strategy} strategy.

Property data:
${JSON.stringify(deal, null, 2)}

Write only the narrative — no headings, no bullet points.`;
}

// ── Utilities ─────────────────────────────────────────────────────────────────

function summarize(prop) {
  return {
    address: prop.address,
    portal: prop.portal,
    state: prop.state,
    listingUrl: prop.listingUrl,
    rawPrice: prop.price,
    beds: prop.beds,
    baths: prop.baths,
    rawSqft: prop.sqft,
  };
}

function parsePrice(str) {
  if (!str) return null;
  const num = parseFloat(str.replace(/[^0-9.]/g, ''));
  return isNaN(num) ? null : num;
}

function parseDom(str) {
  if (!str) return null;
  const match = str.match(/\d+/);
  return match ? parseInt(match[0], 10) : null;
}

/** Rough rent estimate based on beds/baths and US regional medians. */
function estimateRent(beds, baths, state) {
  const base = { TX: 1400, FL: 1500, AZ: 1350, GA: 1300, NC: 1250 }[state] || 1300;
  return base + (beds - 2) * 200 + (baths - 1) * 100;
}

/** Rough rehab estimate: light / medium / heavy × sqft. */
function estimateRehab(sqft, level = 'light') {
  if (!sqft) return 20000;
  const costPerSqft = { light: 15, medium: 35, heavy: 60 }[level] || 15;
  return sqft * costPerSqft;
}

function latestPropertiesFile() {
  const files = listFiles('properties');
  return files[0] || null;
}

// ── CLI shim ──────────────────────────────────────────────────────────────────

async function cli(args) {
  const input = args.input || args.i || undefined;
  const strategy = args.strategy || args.s || 'buy-hold';
  const narratives = !!(args.narratives || args.n);
  return run({ input, strategy, narratives });
}

module.exports = { run, cli };
