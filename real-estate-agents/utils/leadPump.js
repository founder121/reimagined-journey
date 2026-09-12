'use strict';
/**
 * utils/leadPump.js
 * Square Centimeter Ltd — Lead Pump
 *
 * Runs the full SC pipeline once, in sequence, and exits when done.
 * No scheduling — designed to be called from commandCore.js or cron.
 *
 * Pipeline:
 *  1. node index.js scan
 *  2. node index.js leads --source hmlr_uk_wide
 *  3. node index.js enrich
 *  4. node utils/cm2Bridge.js push
 *  5. node utils/cm2Bridge.js sync
 *  6. node utils/cm2Bridge.js whatsapp
 */

const fs            = require('fs');
const path          = require('path');
const { execFileSync } = require('child_process');

/* ── Paths ─────────────────────────────────────────────────────────────── */

const ROOT          = path.resolve(__dirname, '..');
const DATA_DIR      = path.join(ROOT, 'data');
const PUSH_LOG_PATH = path.join(DATA_DIR, 'cm2-push-log.json');
const TRACKER_PATH  = path.join(DATA_DIR, 'tracker.md');

/* ── Pipeline definition ───────────────────────────────────────────────── */

const STEPS = [
  { name: 'scan',               args: ['index.js', 'scan'],                                  timeout: 90_000  },
  { name: 'leads hmlr_uk_wide', args: ['index.js', 'leads', '--source', 'hmlr_uk_wide'],     timeout: 180_000 },
  { name: 'enrich',             args: ['index.js', 'enrich'],                                timeout: 60_000  },
  { name: 'cm2Bridge push',     args: ['utils/cm2Bridge.js', 'push'],                        timeout: 300_000 },
  { name: 'cm2Bridge sync',     args: ['utils/cm2Bridge.js', 'sync'],                        timeout: 120_000 },
  { name: 'cm2Bridge whatsapp', args: ['utils/cm2Bridge.js', 'whatsapp'],                    timeout: 120_000 },
];

/* ── Tracker helper ────────────────────────────────────────────────────── */

function appendTracker(line) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.appendFileSync(TRACKER_PATH, line + '\n', 'utf8');
  } catch (_) { /* best effort */ }
}

/* ── Summary helpers ───────────────────────────────────────────────────── */

/** Count non-.gitkeep files in a directory. */
function countFiles(dir, ext) {
  try {
    if (!fs.existsSync(dir)) return 0;
    const entries = fs.readdirSync(dir);
    return entries.filter(f => {
      if (f === '.gitkeep') return false;
      if (ext) return f.endsWith(ext);
      return !fs.statSync(path.join(dir, f)).isDirectory();
    }).length;
  } catch (_) { return 0; }
}

/** Count data rows (lines minus header) across all .csv files in a directory. */
function countQualifiedCSVRows(dir) {
  try {
    if (!fs.existsSync(dir)) return 0;
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.csv'));
    let total = 0;
    for (const file of files) {
      try {
        const content = fs.readFileSync(path.join(dir, file), 'utf8');
        const lines   = content.split('\n').filter(l => l.trim() !== '');
        total += Math.max(0, lines.length - 1); // subtract header
      } catch (_) { /* skip */ }
    }
    return total;
  } catch (_) { return 0; }
}

/** Count non-empty, non-header lines in scan-history.tsv. */
function countScanHistory() {
  try {
    const tsvPath = path.join(DATA_DIR, 'scan-history.tsv');
    if (!fs.existsSync(tsvPath)) return 0;
    const lines = fs.readFileSync(tsvPath, 'utf8')
      .split('\n')
      .filter(l => l.trim() !== '');
    return Math.max(0, lines.length - 1); // subtract header
  } catch (_) { return 0; }
}

/** Load push log and count entries by status. */
function countPushLogByStatus() {
  const counts = {
    pushed_to_cm2:  0,
    push_failed:    0,
    replied_in_cm2: 0,
    whatsapp:       0,
  };
  try {
    if (!fs.existsSync(PUSH_LOG_PATH)) return counts;
    const log = JSON.parse(fs.readFileSync(PUSH_LOG_PATH, 'utf8'));
    for (const entry of Object.values(log)) {
      const status = entry.status || '';
      if (status === 'pushed_to_cm2')  counts.pushed_to_cm2++;
      if (status === 'push_failed')    counts.push_failed++;
      if (status === 'replied_in_cm2') counts.replied_in_cm2++;
      if (entry.whatsappTriggeredAt)   counts.whatsapp++;
    }
  } catch (_) { /* best effort */ }
  return counts;
}

/* ── Main run ──────────────────────────────────────────────────────────── */

async function run() {
  console.log('\n[LeadPump] Starting pipeline…');

  for (let i = 0; i < STEPS.length; i++) {
    const step      = STEPS[i];
    const stepNum   = i + 1;
    const startTime = Date.now();
    const label     = `step ${stepNum} — ${step.name}`;

    console.log(`\n[LeadPump] [ ${stepNum}/${STEPS.length} ] ${step.name}`);

    try {
      execFileSync('node', step.args, { cwd: ROOT, stdio: 'inherit', timeout: step.timeout || 120_000 });
    } catch (err) {
      console.error(`[LeadPump] ${label} ERROR: ${err.message}`);
      appendTracker(
        `- ${new Date().toISOString()} | LeadPump | step ${stepNum} ERROR | ${step.name} | ${err.message}`
      );
      // Continue to next step — pipeline is best-effort
    }

    const elapsed = Date.now() - startTime;
    appendTracker(
      `- ${new Date().toISOString()} | LeadPump | step ${stepNum} complete | ${step.name} | elapsed: ${elapsed}ms`
    );
    console.log(`[LeadPump] ${label} done (${elapsed}ms)`);
  }

  /* ── Summary ──────────────────────────────────────────────────────────── */

  const rawDir       = path.join(DATA_DIR, 'raw');
  const leadsRawDir  = path.join(DATA_DIR, 'leads', 'raw');
  const qualifiedDir = path.join(DATA_DIR, 'leads', 'qualified');

  const listingsScanned = countFiles(rawDir);
  const rawLeads        = countFiles(leadsRawDir);
  const afterDedup      = countScanHistory();
  const enriched        = countQualifiedCSVRows(qualifiedDir);
  const pushCounts      = countPushLogByStatus();

  const ts = new Date().toISOString();

  console.log('\n' + '═'.repeat(40));
  console.log(`CM² LEAD PUMP — ${ts}`);
  console.log('═'.repeat(40));
  console.log(`Listings scanned:        ${listingsScanned}  (count files in data/raw/)`);
  console.log(`Raw leads found:         ${rawLeads}  (count files in data/leads/raw/)`);
  console.log(`After dedup:             ${afterDedup}  (read scan-history.tsv lines - 1)`);
  console.log(`Enriched:                ${enriched}  (count rows in data/leads/qualified/ CSVs)`);
  console.log(`Pushed to CM2:           ${pushCounts.pushed_to_cm2}  (count cm2-push-log.json entries with status pushed_to_cm2)`);
  console.log(`Failed pushes:           ${pushCounts.push_failed}  (count push_failed entries)`);
  console.log(`Replies synced:          ${pushCounts.replied_in_cm2}  (count replied_in_cm2 entries)`);
  console.log(`WhatsApp triggered:      ${pushCounts.whatsapp}  (count entries with whatsappTriggeredAt set)`);
  console.log('═'.repeat(40) + '\n');

  appendTracker(
    `- ${ts} | LeadPump | pipeline complete | listings=${listingsScanned} rawLeads=${rawLeads} enriched=${enriched} pushed=${pushCounts.pushed_to_cm2} failed=${pushCounts.push_failed} replies=${pushCounts.replied_in_cm2} whatsapp=${pushCounts.whatsapp}`
  );
}

/* ── Exports ───────────────────────────────────────────────────────────── */

module.exports = { run };

/* ── CLI entry point ───────────────────────────────────────────────────── */

if (require.main === module) {
  run().catch(err => {
    console.error('[LeadPump] Fatal:', err.message);
    process.exit(1);
  });
}
