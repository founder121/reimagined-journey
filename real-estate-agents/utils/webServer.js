'use strict';
/**
 * Square Centimeter Ltd — Web UI Server
 * ══════════════════════════════════════════════════════════════════════════════
 * Express server on port 3000 serving the SC agent chat interface.
 *
 * Routes
 * ──────
 *   GET  /             → public/index.html  (chat UI)
 *   GET  /api/agents   → agent metadata list
 *   GET  /api/status   → pipeline summary counts
 *   POST /api/chat     → { agentId, message }    → SSE stream
 *   POST /api/voice    → { agentId, transcript } → SSE stream
 *                         (Web Speech API transcribes on client; this endpoint
 *                          receives the text result and routes to the chat handler)
 *
 * SSE event format
 * ────────────────
 *   { type: 'status', text: string }   — progress pill in the UI
 *   { type: 'chunk',  text: string }   — streaming text to append
 *   { type: 'error',  text: string }   — error message to display
 *   { type: 'done'                  }  — stream finished
 */

const express      = require('express');
const path         = require('path');
const fs           = require('fs');

const createLogger = require('./logger');
const { DATA_DIR, OUTPUTS_DIR, listFiles } = require('./fileStore');
const { loadPushLog } = require('./cm2Bridge');

const scout     = require('../agents/agent1-crawler');
const finder    = require('../agents/agent2-leads');
const analyst   = require('../agents/agent3-analyst');
const marketing = require('../agents/agent4-marketing');
const sales     = require('../agents/agent5-sales');

const log  = createLogger('webServer');
const PORT = Number(process.env.PORT) || 3000;

const app = express();

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));

// ─────────────────────────────────────────────────────────────────────────────
// Agent metadata
// ─────────────────────────────────────────────────────────────────────────────

const AGENTS = [
  {
    id:          'agent1',
    name:        'Property Scout',
    emoji:       '🔍',
    tagline:     'Prime London listing scanner',
    description: 'Scans Rightmove, Zoopla, OnTheMarket, Knight Frank, Savills and developer sites for prime London residential listings.',
    examples: [
      'Scan all portals',
      'Scan Rightmove for Mayfair properties',
      'Dry-run scan to validate config',
      'Scan with min price £2m',
    ],
  },
  {
    id:          'agent2',
    name:        'Lead Finder',
    emoji:       '🎯',
    tagline:     'HNW investor lead sourcing',
    description: 'Finds and scores international HNW investor leads from Companies House, Land Registry, LinkedIn and professional networks.',
    examples: [
      'Find all investor leads',
      'Find leads from Companies House',
      'Find leads limit 10',
      'Find cash buyer leads',
    ],
  },
  {
    id:          'agent3',
    name:        'Investment Analyst',
    emoji:       '📊',
    tagline:     'Deal scoring & investment memos',
    description: 'Scores properties 0–100 with ACQUIRE / MONITOR / PASS, calculates SDLT, yields, cash-on-cash ROI, and 5-year capital projection.',
    examples: [
      'Analyse latest listings',
      'Analyse for overseas buyer',
      'Analyse additional property no memo',
      'Analyse with LTV 0.7',
    ],
  },
  {
    id:          'agent4',
    name:        'Marketing',
    emoji:       '📣',
    tagline:     'Investment content generation',
    description: 'Generates deal briefs, LinkedIn thought-leadership posts, investor newsletters, and SEO blog posts for each scored property.',
    examples: [
      'Generate all content',
      'Generate deal briefs only',
      'Generate LinkedIn post',
      'Generate newsletter',
    ],
  },
  {
    id:          'agent5',
    name:        'Client Relations',
    emoji:       '🤝',
    tagline:     'Lead qualification & follow-up',
    description: 'Qualifies inbound leads, prepares meeting briefing notes for Julian Noble, and flags overdue follow-ups.',
    examples: [
      'Qualify leads',
      'Prepare briefing notes',
      'Check overdue follow-ups',
      'Run all client relations',
    ],
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// SSE helpers
// ─────────────────────────────────────────────────────────────────────────────

function initSSE(res) {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');  // disable nginx/proxy buffering
  res.flushHeaders();
}

/** Write one SSE message. */
function sendSSE(res, payload) {
  if (!res.writableEnded) {
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  }
}

/** Send done event and end response. */
function endSSE(res) {
  sendSSE(res, { type: 'done' });
  res.end();
}

// ─────────────────────────────────────────────────────────────────────────────
// API: static metadata
// ─────────────────────────────────────────────────────────────────────────────

app.get('/api/agents', (_req, res) => res.json(AGENTS));

app.get('/api/status', (_req, res) => {
  try {
    const listings  = safeListFiles('raw').length;
    const rawLeads  = safeListFiles('leads/raw').length;

    // Qualified leads — CSV-based directory
    const qualDir = path.join(DATA_DIR, 'leads', 'qualified');
    let qualified = 0;
    if (fs.existsSync(qualDir)) {
      fs.readdirSync(qualDir).filter(f => f.endsWith('.csv')).forEach(f => {
        try {
          const lines = fs.readFileSync(path.join(qualDir, f), 'utf8').split('\n').filter(Boolean);
          qualified += Math.max(0, lines.length - 1);
        } catch (_) { /* ignore */ }
      });
    }

    // Pipeline items awaiting review
    let pipeline = 0;
    const pipelineFile = path.join(DATA_DIR, 'pipeline.md');
    if (fs.existsSync(pipelineFile)) {
      const content = fs.readFileSync(pipelineFile, 'utf8');
      pipeline = (content.match(/^- \[ \]/gm) || []).length;
    }

    // Marketing output directories
    let marketing = 0;
    if (fs.existsSync(OUTPUTS_DIR)) {
      marketing = fs.readdirSync(OUTPUTS_DIR).filter(d => d.startsWith('marketing-')).length;
    }

    res.json({ listings, leads: rawLeads, qualified, pipeline, marketing });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/cm2-status', (_req, res) => {
  try {
    const pushLog   = loadPushLog();
    const entries   = Object.values(pushLog);
    const sent      = entries.filter(e => e.status === 'pushed_to_cm2').length;
    const replies   = entries.filter(e => e.status === 'replied_in_cm2').length;
    const failed    = entries.filter(e => e.status === 'push_failed').length;
    const duplicate = entries.filter(e => e.status === 'duplicate_in_cm2').length;
    res.json({ sent, replies, failed, duplicate, total: entries.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/status', (_req, res) => {
  try {
    const listings  = safeListFiles('raw').length;
    const rawLeads  = safeListFiles('leads/raw').length;
    const pushLog   = loadPushLog();
    const entries   = Object.values(pushLog);
    const cm2Sent   = entries.filter(e => e.status === 'pushed_to_cm2').length;
    const cm2Reply  = entries.filter(e => e.status === 'replied_in_cm2').length;

    // Tracker.md last 10 lines
    let trackerLines = [];
    const trackerPath = path.join(DATA_DIR, 'tracker.md');
    if (fs.existsSync(trackerPath)) {
      trackerLines = fs.readFileSync(trackerPath, 'utf8')
        .split('\n').filter(Boolean).slice(-10);
    }

    // Push log summary
    const byStatus = {};
    for (const e of entries) byStatus[e.status] = (byStatus[e.status] || 0) + 1;

    res.setHeader('Content-Type', 'text/html');
    res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta http-equiv="refresh" content="60"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>SC Agent Pipeline — Status</title>
<style>
  body{background:#0d1117;color:#e2e8f0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif;padding:24px;max-width:860px;margin:0 auto}
  h1{color:#c9a84c;font-size:20px;margin-bottom:4px}
  h2{color:#8a6f2f;font-size:13px;font-weight:700;text-transform:uppercase;letter-spacing:.08em;margin:24px 0 8px}
  .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:10px;margin-bottom:16px}
  .stat{background:#161c27;border:1px solid #2d3558;border-radius:8px;padding:12px;text-align:center}
  .stat-n{font-size:28px;font-weight:700;color:#c9a84c;display:block}
  .stat-l{font-size:11px;color:#6b7280}
  pre{background:#161c27;border:1px solid #2d3558;border-radius:6px;padding:12px;font-size:12px;overflow-x:auto;white-space:pre-wrap;color:#e2e8f0}
  .refresh{font-size:11px;color:#4b5563;margin-top:20px}
</style>
</head>
<body>
<h1>Square Centimeter — Agent Pipeline Status</h1>
<p style="color:#4b5563;font-size:12px">Auto-refresh every 60s · ${new Date().toISOString()}</p>

<h2>Pipeline Summary</h2>
<div class="grid">
  <div class="stat"><span class="stat-n">${listings}</span><span class="stat-l">Listings scanned</span></div>
  <div class="stat"><span class="stat-n">${rawLeads}</span><span class="stat-l">Lead files</span></div>
  <div class="stat"><span class="stat-n">${cm2Sent}</span><span class="stat-l">Pushed to CM2</span></div>
  <div class="stat"><span class="stat-n">${cm2Reply}</span><span class="stat-l">CM2 replies</span></div>
</div>

<h2>CM2 Push Log</h2>
<pre>${Object.entries(byStatus).map(([s, n]) => `${s.padEnd(25)} ${n}`).join('\n') || '(empty)'}</pre>

<h2>Recent Activity (tracker.md)</h2>
<pre>${trackerLines.map(l => l.replace(/</g, '&lt;')).join('\n') || '(no entries yet)'}</pre>

<p class="refresh">Page auto-refreshes every 60 seconds.</p>
</body>
</html>`);
  } catch (err) {
    res.status(500).send(`<pre>Error: ${err.message}</pre>`);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// API: chat (SSE)
// ─────────────────────────────────────────────────────────────────────────────

app.post('/api/chat', async (req, res) => {
  const { agentId, message } = req.body ?? {};

  if (!agentId || typeof message !== 'string' || !message.trim()) {
    return res.status(400).json({ error: 'agentId and message are required' });
  }
  if (!AGENTS.find(a => a.id === agentId)) {
    return res.status(400).json({ error: `Unknown agentId: "${agentId}"` });
  }

  log.info(`[chat] ${agentId} — "${message.slice(0, 80)}"`);
  await handleChat(agentId, message.trim(), res);
});

// ─────────────────────────────────────────────────────────────────────────────
// API: voice (client-transcribed via Web Speech API → proxy to chat handler)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The browser runs the Web Speech API and sends the resulting transcript here.
 * This endpoint treats the transcript exactly like a typed message.
 *
 * Request body: { agentId: string, transcript: string }
 * Response:     SSE stream (same format as /api/chat)
 */
app.post('/api/voice', async (req, res) => {
  const { agentId, transcript } = req.body ?? {};

  if (!agentId || typeof transcript !== 'string' || !transcript.trim()) {
    return res.status(400).json({ error: 'agentId and transcript are required' });
  }
  if (!AGENTS.find(a => a.id === agentId)) {
    return res.status(400).json({ error: `Unknown agentId: "${agentId}"` });
  }

  log.info(`[voice] ${agentId} — "${transcript.slice(0, 80)}"`);

  // Log voice interactions to tracker.md (source: "voice")
  try {
    const line = `- ${new Date().toISOString()} | Web UI voice | ${agentId} | source: voice | "${transcript.slice(0, 120)}"\n`;
    fs.appendFileSync(path.join(DATA_DIR, 'tracker.md'), line, 'utf8');
  } catch (_) { /* best effort */ }

  await handleChat(agentId, transcript.trim(), res);
});

// ─────────────────────────────────────────────────────────────────────────────
// Shared chat handler
// ─────────────────────────────────────────────────────────────────────────────

async function handleChat(agentId, message, res) {
  initSSE(res);

  // Keep connection alive with periodic comments during long agent runs
  const heartbeat = setInterval(() => {
    if (!res.writableEnded) res.write(': heartbeat\n\n');
  }, 20_000);

  res.on('close', () => clearInterval(heartbeat));

  try {
    const agentResult = await runAgent(agentId, message, res);
    if (agentResult === null) return; // already ended by runAgent

    clearInterval(heartbeat);

    if (process.env.ANTHROPIC_API_KEY) {
      await streamWithLLM(agentId, message, agentResult, res);
    } else {
      await streamFormatted(agentId, agentResult, res);
    }
  } catch (err) {
    clearInterval(heartbeat);
    log.error(`[chat] Error in ${agentId}: ${err.message}`);
    sendSSE(res, { type: 'error', text: `⚠️ ${err.message}` });
    endSSE(res);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Core agent executor
// ─────────────────────────────────────────────────────────────────────────────

async function runAgent(agentId, message, res) {
  const msg = message.toLowerCase();

  switch (agentId) {

    // ── Agent 1: Property Scout ───────────────────────────────────────────────
    case 'agent1': {
      const PORTAL_KEYS = ['rightmove', 'zoopla', 'onthemarket', 'knight frank', 'savills'];
      const portal      = PORTAL_KEYS.find(p => msg.includes(p)) ?? 'all';
      const dryRun      = msg.includes('dry') || msg.includes('test') || msg.includes('validate');

      const areaRe   = /(?:scan|search)\s+(?:for\s+)?(?:in\s+)?([a-z\s]+?)(?:\s+from|\s+on|\s+portal|with|min|max|$)/i;
      const areaHit  = message.match(areaRe)?.[1]?.trim();
      const skipWords = new Set(['all', 'portals', 'listings', 'properties', 'for', 'prime', 'london']);
      const areas    = areaHit && !skipWords.has(areaHit.toLowerCase()) ? [areaHit] : undefined;

      const minPrice = extractMoney(msg, /min(?:imum)?\s*(?:price)?\s*£?([\d,.]+[km]?)/i)
                    ?? extractMoney(msg, /from\s*£?([\d,.]+[km]?)/i);
      const maxPrice = extractMoney(msg, /max(?:imum)?\s*(?:price)?\s*£?([\d,.]+[km]?)/i)
                    ?? extractMoney(msg, /under\s*£?([\d,.]+[km]?)/i);

      sendSSE(res, { type: 'status', text: `🔍 Scanning ${portal === 'all' ? 'all portals' : portal}…` });

      const records = await scout.run({ portal, areas, minPrice, maxPrice, dryRun });
      sendSSE(res, { type: 'status', text: `✅ Scan complete — ${records.length} listings` });

      return { records: records.slice(0, 20), total: records.length, portal, dryRun };
    }

    // ── Agent 2: Investor Lead Finder ─────────────────────────────────────────
    case 'agent2': {
      const SOURCE_KEYS  = ['companies_house', 'land_registry', 'land registry', 'linkedin', 'lrpp'];
      const sourceHit    = SOURCE_KEYS.find(s => msg.includes(s));
      const source       = sourceHit?.replace(/\s/g, '_');
      const limitMatch   = msg.match(/limit\s+(\d+)/i) ?? msg.match(/(\d+)\s+leads?/i);
      const limit        = limitMatch ? parseInt(limitMatch[1], 10) : undefined;
      const dryRun       = msg.includes('dry') || msg.includes('test');

      sendSSE(res, { type: 'status', text: `🎯 Finding investor leads${source ? ` from ${source}` : ''}…` });

      const leads = source
        ? await finder.run({ source, limit, dryRun })
        : await finder.runAll({ limit, dryRun });

      sendSSE(res, { type: 'status', text: `✅ Found ${leads.length} lead(s)` });
      return { leads: leads.slice(0, 15), total: leads.length, source: source ?? 'all' };
    }

    // ── Agent 3: Investment Analyst ───────────────────────────────────────────
    case 'agent3': {
      const rawFiles = safeListFiles('raw');
      if (!rawFiles.length) {
        sendSSE(res, { type: 'error', text: '⚠️ No listings found. Run Agent 1 (Property Scout) first.' });
        endSSE(res);
        return null;
      }

      const additionalProperty = !(msg.includes('no additional') || msg.includes('first home'));
      const nonUkResident      = msg.includes('overseas') || msg.includes('non-uk') ||
                                 msg.includes('international') || msg.includes('non uk');
      const ltvHit             = msg.match(/ltv\s*([\d.]+)/i);
      const mortgageLtv        = ltvHit
        ? parseFloat(ltvHit[1]) / (parseFloat(ltvHit[1]) > 1 ? 100 : 1)
        : 0.65;
      const writeMemo          = !msg.includes('no memo') && !msg.includes('skip memo');

      sendSSE(res, { type: 'status', text: `📊 Analysing ${path.basename(rawFiles[0])}…` });

      const result = await analyst.run({
        input: rawFiles[0],
        additionalProperty,
        nonUkResident,
        mortgageLtv,
        writeMemo,
      });

      sendSSE(res, { type: 'status', text: `✅ ${result.totalAnalyzed} properties scored` });
      return result;
    }

    // ── Agent 4: Marketing ────────────────────────────────────────────────────
    case 'agent4': {
      const rawFiles = safeListFiles('raw');
      if (!rawFiles.length) {
        sendSSE(res, { type: 'error', text: '⚠️ No listings found. Run Agent 1 first.' });
        endSSE(res);
        return null;
      }

      sendSSE(res, { type: 'status', text: `📊 Loading and scoring listings…` });

      const analysisResult = await analyst.run({ input: rawFiles[0], writeMemo: false });
      const topDeals = (analysisResult.topDeals ?? [])
        .filter(d => ['ACQUIRE', 'MONITOR'].includes(d.recommendation))
        .slice(0, 5);

      if (!topDeals.length) {
        sendSSE(res, { type: 'error', text: '⚠️ No ACQUIRE / MONITOR deals found in latest listings.' });
        endSSE(res);
        return null;
      }

      // Parse requested content types from message
      const TYPE_ALIASES = {
        'deal brief': 'deal-brief',
        'deal-brief': 'deal-brief',
        'linkedin':   'linkedin',
        'newsletter': 'newsletter',
        'blog':       'blog',
      };
      const reqTypes = Object.entries(TYPE_ALIASES)
        .filter(([kw]) => msg.includes(kw))
        .map(([, v]) => v);
      const types = reqTypes.length ? [...new Set(reqTypes)] : undefined;

      const outputs = [];
      for (const deal of topDeals) {
        const label = (deal.address ?? 'property').slice(0, 45);
        sendSSE(res, { type: 'status', text: `📣 Generating content: ${label}…` });
        const r = await marketing.run({ memo: deal, allMemos: topDeals, types, writeToDisk: true });
        outputs.push({ address: deal.address, recommendation: deal.recommendation, outputDir: r.outputDir });
      }

      return { outputs, dealsProcessed: topDeals.length };
    }

    // ── Agent 5: Client Relations ─────────────────────────────────────────────
    case 'agent5': {
      let action = 'qualify';
      if (msg.includes('follow') || msg.includes('overdue') || msg.includes('check')) {
        action = 'followup';
      } else if (msg.includes('brief') || msg.includes('meeting') || msg.includes('julian')) {
        action = 'brief';
      } else if (msg.includes('all')) {
        action = 'all';
      }

      const limitMatch = msg.match(/limit\s+(\d+)/i) ?? msg.match(/(\d+)\s+leads?/i);
      const limit      = limitMatch ? parseInt(limitMatch[1], 10) : undefined;

      sendSSE(res, { type: 'status', text: `🤝 Running ${action}…` });

      const result = await sales.run({ action, limit, writeToDisk: true });
      const n      = (result.qualified ?? []).length;
      sendSSE(res, { type: 'status', text: `✅ ${action} complete — ${n} lead(s) processed` });

      return result;
    }

    default:
      sendSSE(res, { type: 'error', text: `Unknown agent: ${agentId}` });
      endSSE(res);
      return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Response streaming — LLM mode (ANTHROPIC_API_KEY set)
// ─────────────────────────────────────────────────────────────────────────────

async function streamWithLLM(agentId, message, agentResult, res) {
  const Anthropic = require('@anthropic-ai/sdk');
  const client    = new Anthropic();
  const agent     = AGENTS.find(a => a.id === agentId);

  sendSSE(res, { type: 'status', text: '✍️ Formatting response…' });

  const systemPrompt =
    `You are a professional assistant for Square Centimeter Ltd, a boutique prime London \
residential property advisory firm directed by Julian Noble. \
Present agent results clearly in investment-grade Markdown. \
Use tables for financial data. Use British English. \
Be concise but complete. Start with a one-line executive summary.`;

  const userPrompt =
    `The user sent to ${agent.name}: "${message}"\n\n` +
    `Agent result (JSON):\n\`\`\`json\n${JSON.stringify(agentResult, null, 2).slice(0, 8000)}\n\`\`\`\n\n` +
    `Format this as a professional Markdown response for Julian Noble.`;

  const stream = client.messages.stream({
    model:      'claude-sonnet-4-6',
    max_tokens: 2000,
    system:     systemPrompt,
    messages:   [{ role: 'user', content: userPrompt }],
  });

  for await (const event of stream) {
    if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
      sendSSE(res, { type: 'chunk', text: event.delta.text });
    }
  }

  endSSE(res);
}

// ─────────────────────────────────────────────────────────────────────────────
// Response streaming — template mode (no API key)
// ─────────────────────────────────────────────────────────────────────────────

async function streamFormatted(agentId, result, res) {
  const text = formatResult(agentId, result);
  const CHUNK = 25;
  for (let i = 0; i < text.length; i += CHUNK) {
    sendSSE(res, { type: 'chunk', text: text.slice(i, i + CHUNK) });
    await sleep(6);
  }
  endSSE(res);
}

// ── Result formatters ─────────────────────────────────────────────────────────

function formatResult(agentId, result) {
  switch (agentId) {
    case 'agent1': return fmt1(result);
    case 'agent2': return fmt2(result);
    case 'agent3': return fmt3(result);
    case 'agent4': return fmt4(result);
    case 'agent5': return fmt5(result);
    default:       return '```json\n' + JSON.stringify(result, null, 2) + '\n```';
  }
}

function fmt1({ records, total, portal, dryRun }) {
  if (dryRun) {
    return `## Dry Run Complete ✅\n\nPortal **${portal}** configuration validated. No HTTP requests made.`;
  }
  if (!records?.length) {
    return `## Scan Complete\n\nNo listings found for portal: **${portal}**.\n\n_Check network access or try a different portal._`;
  }
  const rows = records.slice(0, 10).map(r => {
    const price = r.price ? `£${Number(r.price).toLocaleString('en-GB')}` : '—';
    return `| ${(r.address ?? 'N/A').slice(0, 38)} | ${price} | ${r.beds ?? '—'} | ${r.tenure ?? '—'} | ${r.marketZone ?? '—'} |`;
  }).join('\n');
  return `## Scan Results — ${portal}\n\n**${total} listing(s)** found${total > 10 ? ` (showing first 10)` : ''}.\n\n| Address | Price | Beds | Tenure | Zone |\n|---|---|---|---|---|\n${rows}\n\n_Run **Agent 3 (Investment Analyst)** to score these listings._`;
}

function fmt2({ leads, total, source }) {
  if (!leads?.length) {
    return `## Lead Search Complete\n\nNo leads found from source: **${source}**.\n\n_Check network access or try a different source._`;
  }
  const rows = leads.slice(0, 8).map(l => {
    const score = l.lead_score ?? '—';
    return `| ${(l.name ?? 'Anonymous').slice(0, 28)} | ${l.lead_type ?? '—'} | ${l.budget_range ?? '—'} | ${score} | ${l.status ?? 'new'} |`;
  }).join('\n');
  return `## Investor Leads — ${source}\n\n**${total} lead(s)** found${total > 8 ? ` (showing top 8)` : ''}.\n\n| Name | Type | Budget | Score | Status |\n|---|---|---|---|---|\n${rows}\n\n_Run **Agent 5 (Client Relations)** to qualify these leads._`;
}

function fmt3({ topDeals, totalAnalyzed }) {
  if (!topDeals?.length) {
    return `## Analysis Complete\n\n**${totalAnalyzed ?? 0}** properties analysed. No ACQUIRE / MONITOR deals found at current thresholds.`;
  }
  const ICONS = { ACQUIRE: '🟢', MONITOR: '🟡', PASS: '🔴' };
  const rows  = topDeals.map(d => {
    const price = d.price ? `£${Number(d.price).toLocaleString('en-GB')}` : '—';
    const yld   = d.grossYieldPct ? `${d.grossYieldPct}%` : '—';
    const icon  = ICONS[d.recommendation] ?? '';
    return `| ${(d.address ?? 'N/A').slice(0, 38)} | ${icon} ${d.recommendation ?? '—'} | ${d.score ?? '—'}/100 | ${yld} | ${price} |`;
  }).join('\n');
  return `## Analysis Results\n\n**${totalAnalyzed}** properties scored. **${topDeals.length}** ACQUIRE / MONITOR deal(s):\n\n| Address | Rec | Score | Yield | Price |\n|---|---|---|---|---|\n${rows}\n\n_Investment memos saved to \`reports/\`. Run **Agent 4 (Marketing)** to generate content packs._`;
}

function fmt4({ outputs, dealsProcessed }) {
  if (!outputs?.length) {
    return `## Marketing Generation Complete\n\nNo content generated.`;
  }
  const lines = outputs.map(o => {
    const dir = o.outputDir?.split('/').pop() ?? 'outputs/';
    return `- **${o.recommendation ?? '?'}** — ${(o.address ?? 'Property').slice(0, 50)}\n  → \`${dir}/\``;
  }).join('\n');
  return `## Marketing Content Generated ✅\n\nContent packs for **${dealsProcessed}** deal(s):\n\n${lines}\n\nEach pack contains: \`deal-brief.md\` · \`linkedin-post.txt\` · \`email-newsletter.md\` · \`blog-post.md\``;
}

function fmt5({ action, qualified, overdue, briefings }) {
  const parts = [];
  if (qualified?.length) {
    const rows = qualified.slice(0, 6).map(l =>
      `| ${(l.name ?? 'Anonymous').slice(0, 28)} | ${l.budget_range ?? '—'} | ${l.lead_score ?? '—'} | ${l.status ?? '—'} |`
    ).join('\n');
    parts.push(`**${qualified.length} lead(s) qualified:**\n\n| Name | Budget | Score | Status |\n|---|---|---|---|\n${rows}`);
  }
  if (overdue?.length) {
    const list = overdue.slice(0, 5).map(l => `- ⚠️ ${l.name ?? 'Anonymous'} — last contact: ${l.date_found ?? 'unknown'}`).join('\n');
    parts.push(`**${overdue.length} overdue follow-up(s):**\n${list}`);
  }
  if (briefings?.length) {
    parts.push(`**${briefings.length} meeting briefing note(s)** prepared for Julian Noble.`);
  }
  if (!parts.length) {
    return `## Client Relations — ${action}\n\nNo leads to process. Run **Agent 2 (Lead Finder)** to discover new leads.`;
  }
  return `## Client Relations — ${action}\n\n${parts.join('\n\n')}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Utility helpers
// ─────────────────────────────────────────────────────────────────────────────

function safeListFiles(subdir) {
  try { return listFiles(subdir); } catch (_) { return []; }
}

/**
 * Extract a £-amount from a matched regex group.
 * Handles: "2m" → 2_000_000, "500k" → 500_000, "1,500,000" → 1_500_000
 */
function extractMoney(text, pattern) {
  const m = text.match(pattern);
  if (!m) return undefined;
  const raw = m[1].toLowerCase().replace(/,/g, '');
  if (raw.endsWith('m')) return Math.round(parseFloat(raw) * 1_000_000);
  if (raw.endsWith('k')) return Math.round(parseFloat(raw) * 1_000);
  const n = parseFloat(raw);
  return isNaN(n) ? undefined : n;
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// ─────────────────────────────────────────────────────────────────────────────
// Start
// ─────────────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  const apiKey = process.env.ANTHROPIC_API_KEY ? '✅ Anthropic API' : '⚠️  template mode (no ANTHROPIC_API_KEY)';
  log.info(`Square Centimeter — Web UI  http://localhost:${PORT}  [${apiKey}]`);
  log.info(`API: POST /api/chat | POST /api/voice | GET /api/agents | GET /api/status`);
});

module.exports = app;  // exported for testing
