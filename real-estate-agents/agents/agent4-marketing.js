'use strict';
/**
 * Agent 4 — Marketing Agent
 * ─────────────────────────
 * Reads a leads JSON file and drafts personalised outreach campaigns
 * (email and/or SMS) using an LLM.
 *
 * IMPORTANT:
 *   – Drafts are stored to data/campaigns/ but NOT automatically sent.
 *   – All drafted messages include required CAN-SPAM / TCPA opt-out language.
 *   – The LLM is explicitly instructed NOT to hallucinate contact info.
 *
 * Usage:
 *   const marketing = require('./agent4-marketing');
 *   await marketing.run({ campaign: 'motivated-sellers', channel: 'email',
 *                         leadsFile: 'data/leads/fsbo-zillow-tx-2024-01-15.json' });
 *
 * CLI:
 *   node index.js market motivated-sellers --channel email \
 *                 --leads data/leads/fsbo-zillow-tx-2024-01-15.json
 */

const fs = require('fs');
const path = require('path');
const Anthropic = require('@anthropic-ai/sdk');

const { writeData, listFiles } = require('../utils/fileStore');
const createLogger = require('../utils/logger');

const log = createLogger('agent4-marketing');

// ── Campaign templates ─────────────────────────────────────────────────────────
// Each template supplies system context, tone, and required inclusions.
const CAMPAIGN_TEMPLATES = {
  'motivated-sellers': {
    description: 'Outreach to FSBO / expired / distressed property owners',
    tone: 'empathetic, professional, no-pressure',
    emailSubjectVariants: 3,
    smsMaxChars: 160,
    requiredInclusions: {
      email: ['opt-out instructions', 'sender identity', 'physical mailing address'],
      sms: ['STOP to opt out', 'sender identity'],
    },
    systemPrompt: `You are a real estate investor writing genuine, helpful outreach
to homeowners who may need to sell quickly. Be empathetic and professional.
Never promise unrealistic prices. Do not invent facts about the property.
Use only the property data provided.`,
  },
  'cash-buyers': {
    description: 'Outreach to recent cash-purchase investors / end-buyers',
    tone: 'direct, deal-focused, peer-to-peer',
    emailSubjectVariants: 2,
    smsMaxChars: 160,
    requiredInclusions: {
      email: ['opt-out instructions', 'sender identity'],
      sms: ['STOP to opt out'],
    },
    systemPrompt: `You are a real estate wholesaler reaching out to active cash buyers.
Be concise and lead with the deal metrics. Do not fabricate property values.
Use only the data provided.`,
  },
  'expired-listings': {
    description: 'Outreach to owners of expired MLS listings',
    tone: 'consultative, problem-solving',
    emailSubjectVariants: 3,
    smsMaxChars: 160,
    requiredInclusions: {
      email: ['opt-out instructions', 'sender identity', 'physical mailing address'],
      sms: ['STOP to opt out'],
    },
    systemPrompt: `You are a real estate investor offering an alternative to relisting
for homeowners whose listings expired. Focus on solving their problem (time, certainty,
convenience). Do not invent reasons why their listing expired.`,
  },
};

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * @param {object} opts
 * @param {string} opts.campaign    key from CAMPAIGN_TEMPLATES
 * @param {string} [opts.channel]   'email' | 'sms' | 'both'
 * @param {string} [opts.leadsFile] path to leads JSON (uses latest if omitted)
 * @param {number} [opts.limit]     max leads to draft for
 * @returns {Promise<object[]>}     drafted messages
 */
async function run({ campaign, channel = 'email', leadsFile, limit = 50 } = {}) {
  const template = CAMPAIGN_TEMPLATES[campaign];
  if (!template) {
    const valid = Object.keys(CAMPAIGN_TEMPLATES).join(', ');
    throw new Error(`Unknown campaign "${campaign}". Valid: ${valid}`);
  }

  const channels = channel === 'both' ? ['email', 'sms'] : [channel];
  const filePath = leadsFile ? path.resolve(leadsFile) : latestLeadsFile();
  if (!filePath) throw new Error('No leads file found. Run "leads" first.');

  log.info(`Campaign: ${campaign} | channels: ${channels.join(',')} | file: ${path.basename(filePath)}`);

  const leads = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  const batch = leads.slice(0, limit);
  log.info(`Drafting for ${batch.length} leads…`);

  if (!process.env.ANTHROPIC_API_KEY) {
    log.warn('ANTHROPIC_API_KEY not set — generating template placeholders only.');
    return generatePlaceholders(batch, campaign, channels, template);
  }

  const client = new Anthropic();
  const drafts = [];

  for (const lead of batch) {
    const draft = { lead, campaign, generatedAt: new Date().toISOString(), messages: {} };

    for (const ch of channels) {
      try {
        draft.messages[ch] = await draftMessage(client, lead, template, ch);
      } catch (err) {
        log.error(`Draft failed for ${lead.address}: ${err.message}`);
        draft.messages[ch] = null;
      }
    }
    drafts.push(draft);
    // Brief pause between LLM calls — respect API rate limits
    await sleep(200);
  }

  const outPath = writeData('campaigns', `${campaign}-${channel}`, drafts);
  log.info(`${drafts.length} drafts written → ${outPath}`);
  return drafts;
}

// ── LLM drafting ──────────────────────────────────────────────────────────────

async function draftMessage(client, lead, template, channel) {
  const userPrompt = buildUserPrompt(lead, template, channel);

  const msg = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: channel === 'sms' ? 200 : 600,
    system: template.systemPrompt,
    messages: [{ role: 'user', content: userPrompt }],
  });

  return {
    content: msg.content[0]?.text?.trim() || '',
    channel,
    requiredInclusions: template.requiredInclusions[channel],
    model: msg.model,
    usage: msg.usage,
  };
}

function buildUserPrompt(lead, template, channel) {
  const propertyData = JSON.stringify({
    address: lead.address,
    price: lead.price,
    daysOnMarket: lead.daysOnMarket,
    type: lead.type,
    state: lead.state,
  }, null, 2);

  if (channel === 'sms') {
    return `Write a single SMS message (max ${template.smsMaxChars} chars) for the
following lead. MUST include: ${template.requiredInclusions.sms.join(', ')}.
Tone: ${template.tone}.

Property data (do NOT invent any additional details):
${propertyData}

Output only the SMS text, nothing else.`;
  }

  return `Write a personalised cold email (subject line + body) for the following lead.
Include ${template.emailSubjectVariants} subject line options labelled SUBJECT_1, SUBJECT_2, etc.
Then write the email body starting with BODY:.
MUST include: ${template.requiredInclusions.email.join(', ')}.
Tone: ${template.tone}.

Property data (do NOT invent any additional details):
${propertyData}

Output only the subject lines and body, nothing else.`;
}

// ── Placeholder generator (no API key) ───────────────────────────────────────

function generatePlaceholders(leads, campaign, channels, template) {
  return leads.map((lead) => ({
    lead,
    campaign,
    generatedAt: new Date().toISOString(),
    messages: Object.fromEntries(
      channels.map((ch) => [
        ch,
        {
          content: ch === 'sms'
            ? `Hi, I'm interested in your property at ${lead.address || '[ADDRESS]'}. [PERSONALISE] STOP to opt out.`
            : `SUBJECT_1: Quick question about ${lead.address || '[ADDRESS]'}\nBODY: Hi,\n\nI saw your listing at ${lead.address || '[ADDRESS]'} and wanted to reach out.\n[PERSONALISE THIS EMAIL]\n\nTo opt out, reply UNSUBSCRIBE.`,
          channel: ch,
          requiredInclusions: template.requiredInclusions[ch],
          model: 'placeholder',
        },
      ]),
    ),
  }));
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function latestLeadsFile() {
  const files = listFiles('leads');
  return files[0] || null;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ── CLI shim ──────────────────────────────────────────────────────────────────

async function cli(args) {
  const campaign = args._[0];
  if (!campaign) {
    const valid = Object.keys(CAMPAIGN_TEMPLATES).join(', ');
    console.error(`Usage: market <campaign> [--channel email|sms|both] [--leads FILE]\nValid campaigns: ${valid}`);
    process.exit(1);
  }
  const channel = args.channel || args.c || 'email';
  const leadsFile = args.leads || args.l || undefined;
  const limit = args.limit ? parseInt(args.limit, 10) : 50;
  return run({ campaign, channel, leadsFile, limit });
}

module.exports = { run, cli, CAMPAIGN_TEMPLATES };
