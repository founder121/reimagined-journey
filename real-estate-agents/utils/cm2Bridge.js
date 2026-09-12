/**
 * cm2Bridge.js — Square Centimeter ↔ thecm2.com Integration Layer
 *
 * Connects the SC agent pipeline (Agent 2 leads, Agent 5 sales) to the
 * live CM2 outreach system at thecm2.com.
 *
 * Responsibilities:
 *  - Push qualified SC leads into thecm2.com investorLead.submit
 *  - Pull CM2 engine stats (sent today, replies, sequence active)
 *  - Sync CM2 reply data back into SC pipeline
 *  - Trigger CM2 WhatsApp follow-up for contacted leads
 *  - Log all bridge activity to data/tracker.md
 *
 * Commands:
 *  node utils/cm2Bridge.js push       — push all qualified, unsynced leads
 *  node utils/cm2Bridge.js status     — show live CM2 engine stats
 *  node utils/cm2Bridge.js sync       — pull CM2 replies into SC pipeline
 *  node utils/cm2Bridge.js whatsapp   — trigger WhatsApp follow-up for contacted leads
 */

'use strict';

const fs   = require('fs');
const path = require('path');

/* ── Config ──────────────────────────────────────────────────────────── */

const CM2_BASE_URL      = process.env.CM2_BASE_URL      || 'https://www.thecm2.com';
const CM2_API_KEY       = process.env.CM2_API_KEY        || '';   // set in .env if CM2 adds API auth
const PUSH_SCORE_MIN    = parseFloat(process.env.CM2_PUSH_SCORE_MIN || '6.0');
const RETRY_DELAY_MS    = parseInt(process.env.CM2_RETRY_DELAY_MS   || '30000', 10);
const REQUEST_TIMEOUT   = parseInt(process.env.CM2_REQUEST_TIMEOUT  || '10000', 10);

const VALID_CM2_BUDGETS = new Set(['£250k–£500k', '£500k–£1M', '£1M–£3M', '£3M+']);

/* ── Paths ───────────────────────────────────────────────────────────── */

const ROOT             = path.resolve(__dirname, '..');
const LEADS_QUALIFIED  = path.join(ROOT, 'data', 'leads', 'qualified');
const LEADS_CONTACTED  = path.join(ROOT, 'data', 'leads', 'contacted');
const LEADS_RAW        = path.join(ROOT, 'data', 'leads', 'raw');
const TRACKER_PATH     = path.join(ROOT, 'data', 'tracker.md');
const PUSH_LOG_PATH    = path.join(ROOT, 'data', 'cm2-push-log.json');

/* ── Utilities ───────────────────────────────────────────────────────── */

/**
 * Append a line to data/tracker.md in the same format as index.js logTrackerEntry.
 */
function logTracker(agentLabel, action, detail = '') {
  const line = `- ${new Date().toISOString()} | ${agentLabel} | cm2Bridge | ${action}${detail ? ' | ' + detail : ''}\n`;
  try { fs.appendFileSync(TRACKER_PATH, line); } catch (_) {}
  console.log(`[cm2Bridge] ${action}${detail ? ' — ' + detail : ''}`);
}

/**
 * Load or initialise the push log (tracks which leads have been pushed).
 * Structure: { [email]: { pushedAt, status, cm2LeadId? } }
 */
function loadPushLog() {
  try {
    if (fs.existsSync(PUSH_LOG_PATH)) {
      return JSON.parse(fs.readFileSync(PUSH_LOG_PATH, 'utf8'));
    }
  } catch (_) {}
  return {};
}

function savePushLog(log) {
  try { fs.writeFileSync(PUSH_LOG_PATH, JSON.stringify(log, null, 2)); } catch (_) {}
}

/**
 * Read all CSV files in a directory and return parsed lead objects.
 */
function readLeadsFromDir(dir) {
  const leads = [];
  if (!fs.existsSync(dir)) return leads;
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.csv'));
  for (const file of files) {
    const raw = fs.readFileSync(path.join(dir, file), 'utf8');
    const lines = raw.trim().split('\n');
    if (lines.length < 2) continue;
    const headers = parseCSVLine(lines[0]);
    for (let i = 1; i < lines.length; i++) {
      if (!lines[i].trim()) continue;
      const values = parseCSVLine(lines[i]);
      const lead = {};
      headers.forEach((h, idx) => { lead[h.trim()] = (values[idx] || '').trim(); });
      leads.push({ ...lead, _sourceFile: file });
    }
  }
  return leads;
}

/**
 * Minimal CSV line parser — handles quoted fields.
 */
function parseCSVLine(line) {
  const result = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') { inQuotes = !inQuotes; continue; }
    if (ch === ',' && !inQuotes) { result.push(current); current = ''; continue; }
    current += ch;
  }
  result.push(current);
  return result;
}

/**
 * Fetch with timeout — returns { ok, status, data } or throws on network error.
 */
async function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    clearTimeout(timer);
    let data = null;
    try { data = await res.json(); } catch (_) {}
    return { ok: res.ok, status: res.status, data };
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
}

/* ── Field Mapping ───────────────────────────────────────────────────── */

/**
 * Map an SC agent lead record to the CM2 investorLead.submit schema.
 *
 * SC fields (from agent2-leads.js output):
 *   name, company, property_address, phone, email, linkedin_url,
 *   motivation_reason, motivation_score, estimated_equity,
 *   budget_range, property_interest, nationality, lead_score, status
 *
 * CM2 schema (from drizzle/schema.ts):
 *   name, email, whatsapp, country, investorType, investmentBudget,
 *   investmentInterest, mandateInterest, source
 */
function mapLeadToCM2(lead) {
  // Map SC budget ranges to CM2 budget tiers
  const budgetMap = {
    '500k-1m':  '£500k–£1M',
    '1m-2m':    '£1M–£3M',
    '2m-5m':    '£1M–£3M',
    '5m+':      '£3M+',
    '500000':   '£500k–£1M',
    '1000000':  '£1M–£3M',
    '3000000':  '£3M+',
  };

  // Resolve budget
  const rawBudget = (lead.budget_range || lead.estimated_equity || '').toLowerCase()
    .replace(/[£,\s]/g, '');
  let budget = budgetMap[rawBudget] ||
    (rawBudget.includes('5m') || rawBudget.includes('5000000') ? '£3M+' :
     rawBudget.includes('3m') || rawBudget.includes('3000000') ? '£3M+' :
     rawBudget.includes('2m') || rawBudget.includes('2000000') ? '£1M–£3M' :
     rawBudget.includes('1m') || rawBudget.includes('1000000') ? '£1M–£3M' : '£500k–£1M');

  // FIX 1: Validate against CM2 schema — re-derive from price if invalid
  if (!VALID_CM2_BUDGETS.has(budget)) {
    const price = parseFloat(String(lead.price || '').replace(/[£, ]/g, '')) || 0;
    if (price >= 3_000_000)      budget = '£3M+';
    else if (price >= 1_000_000) budget = '£1M–£3M';
    else if (price >= 500_000)   budget = '£500k–£1M';
    else if (price >= 250_000)   budget = '£250k–£500k';
    else                          budget = '£500k–£1M';
  }

  // Resolve mandateInterest from motivation_reason
  const mandateMap = {
    'sdlt':            'SDLT for Non-Residents',
    'golden_visa':     'UAE Golden Visa',
    'golden visa':     'UAE Golden Visa',
    'yield':           'London Entry & Yield',
    'saadiyat':        'Saadiyat Cultural District',
    'heritage':        'London Heritage & Trophy',
    'trophy':          'London Heritage & Trophy',
    'aldar':           'Aldar Coastal Residences',
    'coastal':         'Aldar Coastal Residences',
    'wellness':        'Dubai Wellness Communities',
    'dubai':           'Dubai Wellness Communities',
  };
  const motivationLower = (lead.motivation_reason || '').toLowerCase();
  // FIX 4: Check lead.mandate_interest directly before falling back to mandateMap
  const mandateInterest = lead.mandate_interest ||
    (Object.entries(mandateMap).find(([key]) => motivationLower.includes(key))?.[1] || null);

  // Resolve investmentInterest
  const interestRaw = (lead.property_interest || motivationLower || '').toLowerCase();
  const investmentInterest =
    interestRaw.includes('uae') || interestRaw.includes('dubai') || interestRaw.includes('abu dhabi') ? 'UAE' :
    interestRaw.includes('egypt') ? 'Egypt' :
    interestRaw.includes('both') || interestRaw.includes('multiple') ? 'Both' : 'London';

  return {
    name:               lead.name             || 'Unknown',
    email:              lead.email            || '',
    whatsapp:           lead.phone            || lead.contact_phone || '',
    country:            lead.nationality      || 'United Kingdom',
    investorType:       'Investor',
    investmentBudget:   budget,
    investmentInterest,
    mandateInterest,
    source:             'sc-agent-pipeline',
    // Extended fields for CM2 notification email context
    notes: [
      lead.property_address ? `SC property: ${lead.property_address}` : null,
      lead.lead_score        ? `SC score: ${lead.lead_score}/10`       : null,
      lead.motivation_reason ? `Motivation: ${lead.motivation_reason}` : null,
      lead.linkedin_url      ? `LinkedIn: ${lead.linkedin_url}`        : null,
    ].filter(Boolean).join(' | ') || undefined,
  };
}

/* ── Push ────────────────────────────────────────────────────────────── */

/**
 * Push a single lead to CM2. Returns { success, cm2LeadId?, error? }.
 */
async function pushLeadToCM2(lead) {
  const payload = mapLeadToCM2(lead);

  // WIRE 2: flag phone-eligible leads for WhatsApp follow-up in CM2 payload
  if (payload.whatsapp) payload.whatsappFollowUpEligible = true;

  // FIX 3: email is optional — HMLR leads use source:'sc-agent-pipeline' without email

  const headers = {
    'Content-Type': 'application/json',
    ...(CM2_API_KEY ? { 'x-api-key': CM2_API_KEY } : {}),
  };

  try {
    const result = await fetchWithTimeout(
      `${CM2_BASE_URL}/api/trpc/investorLead.submit`,
      {
        method:  'POST',
        headers,
        body:    JSON.stringify({ json: payload }),
      }
    );

    if (result.ok) {
      const cm2LeadId = result.data?.result?.data?.json?.id || null;
      return { success: true, cm2LeadId };
    }

    // 409 Conflict = duplicate — treat as success (already in CM2)
    if (result.status === 409) {
      return { success: true, cm2LeadId: null, duplicate: true };
    }

    return {
      success: false,
      error: `HTTP ${result.status}`,
      data:  result.data,
    };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

/**
 * Main push command — pushes all qualified leads not yet in CM2.
 */
async function commandPush() {
  console.log('\n[cm2Bridge] ── /sc push ─────────────────────────────────');
  logTracker('Agent 5', 'push started', `score_min=${PUSH_SCORE_MIN}`);

  const pushLog = loadPushLog();

  // Load qualified leads
  const leads = readLeadsFromDir(LEADS_QUALIFIED);
  console.log(`[cm2Bridge] Found ${leads.length} qualified leads`);

  if (leads.length === 0) {
    console.log('[cm2Bridge] No qualified leads to push.');
    logTracker('Agent 5', 'push complete', '0 leads to push');
    return;
  }

  let pushed = 0, skipped = 0, failed = 0, duplicates = 0;

  for (const lead of leads) {
    // FIX 2: transactionId is primary dedup key; email is secondary
    const transactionId = (lead.transactionId || lead.transaction_id || '').trim();
    const email         = (lead.email || '').trim().toLowerCase();
    const dedupeKey     = transactionId || email;
    const score         = parseFloat(lead.lead_score || lead.motivation_score || '0');

    // FIX 2: Skip if no dedup key at all
    if (!dedupeKey) { skipped++; continue; }

    // Skip if score below threshold
    if (score < PUSH_SCORE_MIN) {
      console.log(`[cm2Bridge] Skip (score ${score} < ${PUSH_SCORE_MIN}): ${dedupeKey}`);
      skipped++;
      continue;
    }

    // FIX 2: Check both transactionId and email for prior push
    if (transactionId && pushLog[transactionId]?.status === 'pushed_to_cm2') {
      console.log(`[cm2Bridge] Skip (already pushed by txId): ${transactionId}`);
      skipped++;
      continue;
    }
    if (email && pushLog[email]?.status === 'pushed_to_cm2') {
      console.log(`[cm2Bridge] Skip (already pushed by email): ${email}`);
      skipped++;
      continue;
    }

    // Skip if already in contacted dir (email-keyed only)
    if (email) {
      const contactedLeads = readLeadsFromDir(LEADS_CONTACTED);
      const alreadyContacted = contactedLeads.some(
        l => (l.email || '').trim().toLowerCase() === email
      );
      if (alreadyContacted) {
        console.log(`[cm2Bridge] Skip (already contacted): ${email}`);
        skipped++;
        continue;
      }
    }

    console.log(`[cm2Bridge] Pushing: ${lead.name || dedupeKey} (score ${score})`);

    // First attempt
    let result = await pushLeadToCM2(lead);

    // Retry once after delay if failed
    if (!result.success && !result.duplicate) {
      console.log(`[cm2Bridge] Retrying in ${RETRY_DELAY_MS / 1000}s…`);
      await new Promise(r => setTimeout(r, RETRY_DELAY_MS));
      result = await pushLeadToCM2(lead);
    }

    if (result.duplicate) {
      console.log(`[cm2Bridge] Duplicate (already in CM2): ${dedupeKey}`);
      const dupEntry = { pushedAt: new Date().toISOString(), status: 'duplicate_in_cm2' };
      if (transactionId) pushLog[transactionId] = dupEntry;
      if (email)         pushLog[email]         = dupEntry;
      duplicates++;
    } else if (result.success) {
      console.log(`[cm2Bridge] ✓ Pushed: ${dedupeKey}${result.cm2LeadId ? ' → CM2 ID ' + result.cm2LeadId : ''}`);
      const entry = {
        pushedAt:      new Date().toISOString(),
        status:        'pushed_to_cm2',
        cm2LeadId:     result.cm2LeadId,
        leadName:      lead.name,
        score,
        ...(transactionId ? { transactionId } : {}),
        ...(email         ? { email }         : {}),
      };
      if (transactionId) pushLog[transactionId] = entry;
      if (email)         pushLog[email]         = entry;
      logTracker('Agent 5', 'lead pushed to CM2', `${lead.name || dedupeKey} | score ${score}${result.cm2LeadId ? ' | cm2_id=' + result.cm2LeadId : ''}`);
      pushed++;
      // WIRE 1: trigger investment model after RETRY_DELAY_MS (30s) if email is known
      if (email) {
        const _email = email, _leadId = result.cm2LeadId;
        setTimeout(async () => {
          try {
            await fetchWithTimeout(`${CM2_BASE_URL}/api/trpc/investmentModel.trigger`, {
              method:  'POST',
              headers: { 'Content-Type': 'application/json' },
              body:    JSON.stringify({ json: { email: _email, leadId: _leadId } }),
            });
            logTracker('Agent 5', 'investment model triggered', _email);
          } catch (_) {}
        }, RETRY_DELAY_MS);
      }
    } else {
      console.error(`[cm2Bridge] ✗ Failed: ${dedupeKey} — ${result.error}`);
      const failEntry = { pushedAt: new Date().toISOString(), status: 'push_failed', error: result.error };
      if (transactionId) pushLog[transactionId] = failEntry;
      if (email)         pushLog[email]         = failEntry;
      logTracker('Agent 5', 'push failed', `${dedupeKey} | ${result.error}`);
      failed++;
    }

    savePushLog(pushLog);

    // Polite rate limiting — 1 second between pushes
    await new Promise(r => setTimeout(r, 1000));
  }

  const summary = `pushed=${pushed} duplicates=${duplicates} skipped=${skipped} failed=${failed}`;
  console.log(`\n[cm2Bridge] Push complete — ${summary}`);
  logTracker('Agent 5', 'push complete', summary);
}

/* ── Status ──────────────────────────────────────────────────────────── */

/**
 * Fetch live CM2 engine stats and merge with local SC pipeline counts.
 */
async function commandStatus() {
  console.log('\n[cm2Bridge] ── /sc cm2status ────────────────────────────');

  // Local SC counts
  const localListings  = countFilesInDir(path.join(ROOT, 'data', 'raw'));
  const localLeads     = readLeadsFromDir(LEADS_RAW).length;
  const localQualified = readLeadsFromDir(LEADS_QUALIFIED).length;
  const localMarketing = countFilesInDir(path.join(ROOT, 'outputs'));
  const pushLog        = loadPushLog();
  const pushedCount    = Object.values(pushLog).filter(v => v.status === 'pushed_to_cm2').length;

  // CM2 stats (best-effort — graceful fallback if network blocked)
  let cm2Stats = null;
  try {
    const result = await fetchWithTimeout(
      `${CM2_BASE_URL}/api/trpc/outreach.getStats`
    );
    if (result.ok && result.data) {
      cm2Stats = result.data?.result?.data?.json || result.data;
    }
  } catch (err) {
    console.log(`[cm2Bridge] CM2 API unreachable (${err.message}) — showing local stats only`);
  }

  console.log('\n── Square Centimeter Agent Pipeline ─────────────────────');
  console.log(`  Listings scanned:        ${localListings}`);
  console.log(`  Raw leads:               ${localLeads}`);
  console.log(`  Qualified leads:         ${localQualified}`);
  console.log(`  Marketing packs:         ${localMarketing}`);
  console.log(`  Pushed to CM2:           ${pushedCount}`);

  console.log('\n── thecm2.com Outreach Engine ───────────────────────────');
  if (cm2Stats) {
    console.log(`  Sent today:              ${cm2Stats.sentToday         ?? '—'}`);
    console.log(`  All-time sent:           ${cm2Stats.totalSent         ?? '—'}`);
    console.log(`  Genuine replies:         ${cm2Stats.genuineReplies    ?? '—'}`);
    console.log(`  Bounce rate:             ${cm2Stats.bounceRate        ?? '—'}`);
    console.log(`  Sequence active leads:   ${cm2Stats.sequenceActive    ?? '—'}`);
    console.log(`  Daily cap remaining:     ${cm2Stats.capRemaining      ?? '—'}`);
    console.log(`  OUTREACH_PAUSED:         ${cm2Stats.paused ?? false}`);
  } else {
    console.log('  (CM2 API not reachable — run locally or check VPN)');
  }

  console.log('\n── Push Log Summary ─────────────────────────────────────');
  const byStatus = {};
  for (const v of Object.values(pushLog)) {
    byStatus[v.status] = (byStatus[v.status] || 0) + 1;
  }
  for (const [status, count] of Object.entries(byStatus)) {
    console.log(`  ${status.padEnd(28)} ${count}`);
  }
  console.log('');
}

/* ── Sync ────────────────────────────────────────────────────────────── */

/**
 * Pull CM2 reply data back into SC pipeline.
 * Updates lead status in data/leads/contacted/ to "responded" if CM2 shows a reply.
 */
async function commandSync() {
  console.log('\n[cm2Bridge] ── /sc sync ─────────────────────────────────');
  logTracker('Agent 5', 'sync started');

  const pushLog = loadPushLog();
  // FIX 2: only sync entries keyed by email (transactionId keys have no CM2 lookup)
  const pushedEmails = Object.entries(pushLog)
    .filter(([key, v]) => v.status === 'pushed_to_cm2' && key.includes('@'))
    .map(([email]) => email);

  if (pushedEmails.length === 0) {
    console.log('[cm2Bridge] No pushed leads to sync.');
    return;
  }

  console.log(`[cm2Bridge] Checking ${pushedEmails.length} pushed leads for replies…`);

  let synced = 0;

  for (const email of pushedEmails) {
    try {
      const result = await fetchWithTimeout(
        `${CM2_BASE_URL}/api/trpc/outreach.getLeadStatus?input=${encodeURIComponent(JSON.stringify({ json: { email } }))}`
      );

      if (!result.ok || !result.data) continue;

      const leadData = result.data?.result?.data?.json;
      if (!leadData) continue;

      if (leadData.genuineReply || leadData.replied) {
        // Update push log
        pushLog[email].status       = 'replied_in_cm2';
        pushLog[email].repliedAt    = leadData.repliedAt || new Date().toISOString();
        pushLog[email].replyContent = leadData.replyContent || '';

        // WIRE 3a: log genuine reply to tracker
        logTracker('Agent 5', 'GENUINE REPLY from CM2', `${email} | repliedAt=${pushLog[email].repliedAt}`);
        console.log(`[cm2Bridge] ✓ Reply synced: ${email}`);

        // WIRE 3b: generate meeting briefing .md
        try {
          const briefingDate = new Date().toISOString().slice(0, 10);
          const slug         = email.replace(/@/g, '-at-').replace(/[^a-z0-9-]/gi, '-');
          const briefingPath = path.join(LEADS_QUALIFIED, `briefing-${slug}-${briefingDate}.md`);
          fs.mkdirSync(LEADS_QUALIFIED, { recursive: true });
          const leadName = pushLog[email].leadName || email;
          fs.writeFileSync(briefingPath, [
            `# Meeting Briefing — ${leadName}`,
            `_Prepared by CM2 Bridge · ${new Date().toISOString()}_`,
            '',
            `## Contact`,
            `- **Email:** ${email}`,
            `- **CM2 Lead ID:** ${pushLog[email].cm2LeadId || '—'}`,
            '',
            `## Reply`,
            `- **Replied at:** ${pushLog[email].repliedAt}`,
            `- **Content:** ${leadData.replyContent || '(see CM2 dashboard)'}`,
            '',
            `## SC Pipeline Notes`,
            `- **Lead score:** ${pushLog[email].score || '—'}`,
            `- **Pushed at:** ${pushLog[email].pushedAt || '—'}`,
          ].join('\n'), 'utf8');
          logTracker('Agent 5', 'meeting briefing written', briefingPath);
        } catch (briefErr) {
          logTracker('Agent 5', 'briefing write error', briefErr.message);
        }

        // WIRE 3c: POST Manus push notification
        try {
          const leadName = pushLog[email].leadName || email;
          await fetchWithTimeout('https://manus.app/api/notify', {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify({ title: 'CM2 Genuine Reply', body: `${leadName} replied`, tag: 'cm2-reply', email }),
          });
        } catch (_) {}

        synced++;
      }
    } catch (_) {}

    await new Promise(r => setTimeout(r, 500));
  }

  savePushLog(pushLog);
  const summary = `synced=${synced} of ${pushedEmails.length}`;
  console.log(`\n[cm2Bridge] Sync complete — ${summary}`);
  logTracker('Agent 5', 'sync complete', summary);
}

/* ── WhatsApp ────────────────────────────────────────────────────────── */

/**
 * Trigger CM2's WhatsApp follow-up engine for contacted leads.
 * CM2's whatsappFollowUpEngine sends Julian a Manus push notification
 * with a one-tap WhatsApp deep-link pre-filled with the lead's name + project.
 */
async function commandWhatsapp() {
  console.log('\n[cm2Bridge] ── /sc whatsapp ─────────────────────────────');
  logTracker('Agent 5', 'whatsapp trigger started');

  const pushLog = loadPushLog();
  const eligibleEmails = Object.entries(pushLog)
    .filter(([, v]) => v.status === 'pushed_to_cm2' && !v.whatsappTriggeredAt)
    .map(([email, v]) => ({ email, ...v }));

  if (eligibleEmails.length === 0) {
    console.log('[cm2Bridge] No leads eligible for WhatsApp follow-up.');
    return;
  }

  console.log(`[cm2Bridge] Triggering WhatsApp follow-up for ${eligibleEmails.length} leads…`);
  let triggered = 0;

  for (const entry of eligibleEmails) {
    try {
      const result = await fetchWithTimeout(
        `${CM2_BASE_URL}/api/trpc/whatsapp.triggerFollowUp`,
        {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({ json: { email: entry.email } }),
        }
      );

      if (result.ok) {
        pushLog[entry.email].whatsappTriggeredAt = new Date().toISOString();
        logTracker('Agent 5', 'WhatsApp follow-up triggered', `${entry.leadName || entry.email}`);
        console.log(`[cm2Bridge] ✓ WhatsApp triggered: ${entry.leadName || entry.email}`);
        triggered++;
      } else {
        console.log(`[cm2Bridge] ✗ WhatsApp trigger failed: ${entry.email} — HTTP ${result.status}`);
      }
    } catch (err) {
      console.log(`[cm2Bridge] ✗ WhatsApp trigger error: ${entry.email} — ${err.message}`);
    }

    savePushLog(pushLog);
    await new Promise(r => setTimeout(r, 1000));
  }

  const summary = `triggered=${triggered} of ${eligibleEmails.length}`;
  console.log(`\n[cm2Bridge] WhatsApp complete — ${summary}`);
  logTracker('Agent 5', 'whatsapp trigger complete', summary);
}

/* ── Helpers ─────────────────────────────────────────────────────────── */

function countFilesInDir(dir) {
  try {
    if (!fs.existsSync(dir)) return 0;
    return fs.readdirSync(dir).filter(f =>
      !f.startsWith('.') && !fs.statSync(path.join(dir, f)).isDirectory()
    ).length;
  } catch (_) { return 0; }
}

/* ── Export (for use in index.js and webServer.js) ───────────────────── */

module.exports = {
  pushLeadToCM2,
  mapLeadToCM2,
  commandPush,
  commandStatus,
  commandSync,
  commandWhatsapp,
  loadPushLog,
};

/* ── CLI entry point ─────────────────────────────────────────────────── */

if (require.main === module) {
  const command = process.argv[2] || 'status';

  const commands = {
    push:      commandPush,
    status:    commandStatus,
    cm2status: commandStatus,
    sync:      commandSync,
    whatsapp:  commandWhatsapp,
  };

  const fn = commands[command];
  if (!fn) {
    console.error(`[cm2Bridge] Unknown command: ${command}`);
    console.error(`  Usage: node utils/cm2Bridge.js [push|status|sync|whatsapp]`);
    process.exit(1);
  }

  fn().catch(err => {
    console.error('[cm2Bridge] Fatal error:', err.message);
    logTracker('System', 'fatal error', err.message);
    process.exit(1);
  });
}
