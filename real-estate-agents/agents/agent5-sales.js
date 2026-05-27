'use strict';
/**
 * Agent 5 — Sales Agent
 * ─────────────────────
 * Produces personalised cold-call scripts, objection-handling trees,
 * follow-up cadence plans, and CRM-ready notes for each lead.
 *
 * Script types:
 *   cold-call   – first-contact opener matched to lead type
 *   follow-up   – 2nd / 3rd touch with new value proposition
 *   offer       – present a specific offer and handle objections
 *
 * CRM export formats supported (JSON):
 *   hubspot     – HubSpot contact + note import schema
 *   podio       – Podio item JSON schema
 *   generic     – flat key-value pairs
 *
 * Usage:
 *   const sales = require('./agent5-sales');
 *   await sales.run({ leadsFile: 'data/leads/fsbo-zillow-tx-2024-01-15.json',
 *                     script: 'cold-call' });
 *
 * CLI:
 *   node index.js sales --leads data/leads/fsbo-zillow-tx-2024-01-15.json
 *                       --script cold-call
 */

const fs = require('fs');
const path = require('path');
const Anthropic = require('@anthropic-ai/sdk');

const { writeData, listFiles } = require('../utils/fileStore');
const createLogger = require('../utils/logger');

const log = createLogger('agent5-sales');

// ── Script blueprints ─────────────────────────────────────────────────────────
const SCRIPT_BLUEPRINTS = {
  'cold-call': {
    description: 'First-contact phone opener',
    systemPrompt: `You are an experienced real estate investor writing a natural,
conversational cold-call script. The script must:
1. Open with a polite introduction (investor's name + company placeholder).
2. State the purpose in one sentence — no high-pressure language.
3. Ask ONE open-ended discovery question relevant to the seller's situation.
4. Provide 3 common objection responses (price, timing, "not interested").
5. Suggest a clear next step (e.g., schedule a walk-through).
Use only the lead data provided; do NOT invent property details or prices.`,
  },
  'follow-up': {
    description: '2nd/3rd touch — check-in with new value angle',
    systemPrompt: `You are an experienced real estate investor writing a follow-up
call script for a seller you already spoke with. The script must:
1. Reference the earlier conversation naturally (leave [DATE/TOPIC] placeholder).
2. Offer a new piece of value (market insight or flexible closing terms).
3. Re-ask for next step without being pushy.
4. Include 2 objection responses for "I'm still not sure" and "found another buyer".
Use only the lead data provided; do NOT invent property details or prices.`,
  },
  offer: {
    description: 'Present a specific purchase offer',
    systemPrompt: `You are an experienced real estate investor presenting a written
offer over the phone. The script must:
1. Briefly recap the property walk-through (leave [WALK-THROUGH DATE] placeholder).
2. State the offer amount clearly — use [OFFER_AMOUNT] placeholder.
3. Highlight benefits: cash close, as-is, flexible timeline.
4. Handle the 3 most common objections: "too low", "need to think", "agent said more".
5. Ask for verbal acceptance or a counter.
Use only the lead data provided; do NOT invent property details or appraisals.`,
  },
};

// ── CRM schema builders ───────────────────────────────────────────────────────
const CRM_SCHEMAS = {
  hubspot: (lead, script) => ({
    properties: {
      firstname: extractFirstName(lead.address),
      lastname: '',
      address: lead.address || '',
      city: lead.state || '',
      hs_lead_status: 'NEW',
      lead_type: lead.type || '',
      days_on_market: lead.daysOnMarket || '',
      listing_url: lead.listingUrl || '',
      source: lead.sourceKey || '',
    },
    note: {
      hs_note_body: script,
      hs_timestamp: Date.now(),
    },
  }),
  podio: (lead, script) => ({
    fields: [
      { field_id: 'title', values: [{ value: lead.address || 'Unknown Address' }] },
      { field_id: 'lead_type', values: [{ value: lead.type || '' }] },
      { field_id: 'price', values: [{ value: lead.price || '' }] },
      { field_id: 'source', values: [{ value: lead.listingUrl || '' }] },
      { field_id: 'call_script', values: [{ value: script }] },
    ],
  }),
  generic: (lead, script) => ({
    address: lead.address,
    price: lead.price,
    leadType: lead.type,
    source: lead.sourceKey,
    listingUrl: lead.listingUrl,
    daysOnMarket: lead.daysOnMarket,
    callScript: script,
    capturedAt: lead.capturedAt,
    exportedAt: new Date().toISOString(),
  }),
};

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * @param {object} opts
 * @param {string} [opts.leadsFile]   path to leads JSON
 * @param {string} [opts.script]      'cold-call' | 'follow-up' | 'offer'
 * @param {string} [opts.crm]         'hubspot' | 'podio' | 'generic'
 * @param {number} [opts.limit]       max leads to process
 * @returns {Promise<object[]>}
 */
async function run({ leadsFile, script = 'cold-call', crm = 'generic', limit = 25 } = {}) {
  const blueprint = SCRIPT_BLUEPRINTS[script];
  if (!blueprint) {
    const valid = Object.keys(SCRIPT_BLUEPRINTS).join(', ');
    throw new Error(`Unknown script type "${script}". Valid: ${valid}`);
  }

  const filePath = leadsFile ? path.resolve(leadsFile) : latestLeadsFile();
  if (!filePath) throw new Error('No leads file found. Run "leads" first.');

  log.info(`Script: ${script} | CRM: ${crm} | file: ${path.basename(filePath)}`);

  const leads = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  const batch = leads.slice(0, limit);
  log.info(`Generating scripts for ${batch.length} leads…`);

  const results = [];

  if (!process.env.ANTHROPIC_API_KEY) {
    log.warn('ANTHROPIC_API_KEY not set — using static template scripts.');
    for (const lead of batch) {
      results.push(buildStaticScript(lead, script, crm));
    }
  } else {
    const client = new Anthropic();
    for (const lead of batch) {
      try {
        const result = await generateScript(client, lead, blueprint, script, crm);
        results.push(result);
        await sleep(200);
      } catch (err) {
        log.error(`Script generation failed for ${lead.address}: ${err.message}`);
        results.push(buildStaticScript(lead, script, crm));
      }
    }
  }

  const outPath = writeData('campaigns', `scripts-${script}-${crm}`, results);
  log.info(`${results.length} scripts written → ${outPath}`);

  // Print top 3 to console for quick review
  printPreview(results.slice(0, 3));

  return results;
}

// ── Script generation ─────────────────────────────────────────────────────────

async function generateScript(client, lead, blueprint, scriptType, crm) {
  const userPrompt = `Generate a ${scriptType} call script for the following lead.

Lead data (use ONLY these details — do NOT invent addresses, prices, or names):
${JSON.stringify({
    address: lead.address,
    price: lead.price,
    type: lead.type,
    daysOnMarket: lead.daysOnMarket,
    state: lead.state,
    listingUrl: lead.listingUrl,
  }, null, 2)}

Format:
OPENER: [opening line]
PURPOSE: [one-sentence purpose statement]
DISCOVERY: [open-ended question]
OBJECTION_1: [objection label] → [response]
OBJECTION_2: [objection label] → [response]
OBJECTION_3: [objection label] → [response]
NEXT_STEP: [call to action]
FOLLOW_UP_CADENCE: [e.g., "Call again in 3 days if no response"]`;

  const msg = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 500,
    system: blueprint.systemPrompt,
    messages: [{ role: 'user', content: userPrompt }],
  });

  const scriptText = msg.content[0]?.text?.trim() || '';
  const crmRecord = buildCrmRecord(lead, scriptText, crm);

  return {
    lead: { address: lead.address, type: lead.type, price: lead.price },
    scriptType,
    script: scriptText,
    crm: crmRecord,
    generatedAt: new Date().toISOString(),
    model: msg.model,
  };
}

function buildStaticScript(lead, scriptType, crm) {
  const addr = lead.address || '[ADDRESS]';
  const scriptText = [
    `OPENER: Hi, my name is [YOUR NAME] with [YOUR COMPANY]. Is this the owner of ${addr}?`,
    `PURPOSE: I'm a local real estate investor and I noticed your property — I wanted to see if you'd be open to a cash offer.`,
    `DISCOVERY: What's your ideal timeline if you were to sell?`,
    `OBJECTION_1: "The price is too low" → I understand. My offer is based on a cash, as-is purchase which saves you agent fees and repair costs. Could we look at a net-to-you comparison?`,
    `OBJECTION_2: "I need to think about it" → Absolutely, take your time. Can I check back with you on [DATE]?`,
    `OBJECTION_3: "Not interested" → I respect that. May I ask — is it price, timing, or something else? I'd love to understand in case circumstances change.`,
    `NEXT_STEP: Would you be open to a quick 15-minute walk-through this week — no obligation?`,
    `FOLLOW_UP_CADENCE: If no response, follow up in 3 business days via SMS, then again in 7 days.`,
  ].join('\n');

  return {
    lead: { address: lead.address, type: lead.type, price: lead.price },
    scriptType,
    script: scriptText,
    crm: buildCrmRecord(lead, scriptText, crm),
    generatedAt: new Date().toISOString(),
    model: 'template',
  };
}

function buildCrmRecord(lead, script, crm) {
  const builder = CRM_SCHEMAS[crm] || CRM_SCHEMAS.generic;
  return builder(lead, script);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function extractFirstName(address) {
  // We don't have the owner's name from public listing data.
  // Return empty so the caller fills it in.
  return '';
}

function latestLeadsFile() {
  const files = listFiles('leads');
  return files[0] || null;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function printPreview(results) {
  if (!results.length) return;
  console.log('\n═══════════════════════════════════════════');
  console.log('  SALES SCRIPT PREVIEW (top results)');
  console.log('═══════════════════════════════════════════');
  for (const r of results) {
    console.log(`\n📍 ${r.lead.address || 'Unknown'} | ${r.lead.type || ''} | ${r.lead.price || ''}`);
    console.log('─────────────────────────────────────────');
    console.log(r.script);
  }
  console.log('═══════════════════════════════════════════\n');
}

// ── CLI shim ──────────────────────────────────────────────────────────────────

async function cli(args) {
  const leadsFile = args.leads || args.l || undefined;
  const script = args.script || args.s || 'cold-call';
  const crm = args.crm || 'generic';
  const limit = args.limit ? parseInt(args.limit, 10) : 25;
  return run({ leadsFile, script, crm, limit });
}

module.exports = { run, cli, SCRIPT_BLUEPRINTS };
