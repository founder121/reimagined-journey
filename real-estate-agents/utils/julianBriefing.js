'use strict';
/**
 * utils/julianBriefing.js
 * Square Centimeter Ltd — Julian Briefing
 *
 * Generates an HTML briefing email and saves it to reports/briefing-[date].html.
 * If SENDGRID_API_KEY is present in the environment, also sends via SendGrid.
 *
 * All data is read from local files only, except:
 *  - CM2 API stats (best-effort, falls back to '—')
 *  - SendGrid API (only if SENDGRID_API_KEY is set)
 */

const fs   = require('fs');
const path = require('path');

/* ── Paths ─────────────────────────────────────────────────────────────── */

const ROOT          = path.resolve(__dirname, '..');
const DATA_DIR      = path.join(ROOT, 'data');
const REPORTS_DIR   = path.join(ROOT, 'reports');
const TRACKER_PATH  = path.join(DATA_DIR, 'tracker.md');
const PUSH_LOG_PATH = path.join(DATA_DIR, 'cm2-push-log.json');
const LEADS_RAW_DIR = path.join(DATA_DIR, 'leads', 'raw');

/* ── Config ────────────────────────────────────────────────────────────── */

const CM2_BASE_URL = process.env.CM2_BASE_URL || 'https://www.thecm2.com';
const REQUEST_TIMEOUT_MS = 8000;

/* ── Data helpers ──────────────────────────────────────────────────────── */

/** Read last N lines from a text file. Returns [] if file missing. */
function readLastLines(filePath, n) {
  try {
    if (!fs.existsSync(filePath)) return [];
    const content = fs.readFileSync(filePath, 'utf8');
    const lines   = content.split('\n').filter(l => l.trim() !== '');
    return lines.slice(-n);
  } catch (_) { return []; }
}

/** Load push log. Returns {} if missing or invalid. */
function loadPushLog() {
  try {
    if (!fs.existsSync(PUSH_LOG_PATH)) return {};
    return JSON.parse(fs.readFileSync(PUSH_LOG_PATH, 'utf8'));
  } catch (_) { return {}; }
}

/** Count push log entries by status field. */
function countPushLogByStatus(pushLog) {
  const counts = {
    pushed_to_cm2:  0,
    push_failed:    0,
    replied_in_cm2: 0,
    whatsapp:       0,
  };
  for (const entry of Object.values(pushLog)) {
    const status = entry.status || '';
    if (status === 'pushed_to_cm2')  counts.pushed_to_cm2++;
    if (status === 'push_failed')    counts.push_failed++;
    if (status === 'replied_in_cm2') counts.replied_in_cm2++;
    if (entry.whatsappTriggeredAt)   counts.whatsapp++;
  }
  return counts;
}

/** Count files in a directory created/modified in last 24hrs (by mtime). */
function countRecentFiles(dir, extFilter) {
  try {
    if (!fs.existsSync(dir)) return 0;
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    return fs.readdirSync(dir).filter(f => {
      if (f === '.gitkeep') return false;
      if (extFilter && !f.endsWith(extFilter)) return false;
      try {
        return fs.statSync(path.join(dir, f)).mtimeMs >= cutoff;
      } catch (_) { return false; }
    }).length;
  } catch (_) { return 0; }
}

/** Get memo files starting with 'memo-' created today. */
function getTodayMemoFiles() {
  try {
    if (!fs.existsSync(REPORTS_DIR)) return [];
    const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
    return fs.readdirSync(REPORTS_DIR)
      .filter(f => f.startsWith('memo-') && f.endsWith('.md') && f.includes(today));
  } catch (_) { return []; }
}

/** Extract ERROR lines from tracker.md in the last 24hrs. */
function getRecentErrors(trackerLines) {
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  return trackerLines.filter(line => {
    if (!/ERROR/i.test(line)) return false;
    // Try to parse ISO timestamp from start of line
    const match = line.match(/(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)/);
    if (!match) return true; // include if we can't parse the date
    try {
      return new Date(match[1]).getTime() >= cutoff;
    } catch (_) { return true; }
  });
}

/** Get replies from push log in the last 24hrs. */
function getRecentReplies(pushLog) {
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  const replies = [];
  for (const [email, entry] of Object.entries(pushLog)) {
    if (entry.status !== 'replied_in_cm2') continue;
    const ts = entry.repliedAt ? new Date(entry.repliedAt).getTime() : 0;
    if (ts >= cutoff) {
      replies.push({ email, name: entry.leadName || email, repliedAt: entry.repliedAt || '', score: entry.score });
    }
  }
  return replies;
}

/* ── CM2 API fetch ─────────────────────────────────────────────────────── */

async function fetchCM2Stats() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res  = await fetch(`${CM2_BASE_URL}/api/trpc/outreach.getStats`, { signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) return null;
    const data = await res.json();
    return data?.result?.data?.json || data || null;
  } catch (_) {
    clearTimeout(timer);
    return null;
  }
}

/* ── HTML helpers ──────────────────────────────────────────────────────── */

function esc(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function sectionTitle(title) {
  return `<h2 style="color:#C9A84C;font-size:13px;font-weight:700;letter-spacing:0.12em;text-transform:uppercase;border-bottom:1px solid #C9A84C;padding-bottom:6px;margin:28px 0 14px;">${esc(title)}</h2>`;
}

function stat(label, value) {
  return `<tr>
    <td style="padding:5px 14px 5px 0;color:#94a3b8;font-size:13px;white-space:nowrap;">${esc(label)}</td>
    <td style="padding:5px 0;color:#e2e8f0;font-size:13px;font-weight:600;">${esc(value)}</td>
  </tr>`;
}

function pill(text, color) {
  return `<span style="display:inline-block;padding:2px 9px;border-radius:12px;background:${color};color:#fff;font-size:11px;font-weight:700;">${esc(text)}</span>`;
}

/* ── Build HTML ────────────────────────────────────────────────────────── */

function buildHTML(data) {
  const {
    dateStr, dayName,
    pushCounts, recentRawCount, recentReplies,
    cm2Stats, memoFiles,
    errorLines, recentActivityLines,
  } = data;

  const cmStatVal = (key, label) =>
    cm2Stats ? stat(label, cm2Stats[key] ?? '—') : stat(label, '—');

  const repliesSection = recentReplies.length === 0
    ? '<p style="color:#64748b;font-size:13px;font-style:italic;">No genuine replies in the last 24 hours.</p>'
    : recentReplies.map(r => `
        <div style="padding:8px 12px;margin-bottom:6px;background:#161d27;border-left:3px solid #C9A84C;border-radius:4px;">
          <span style="color:#e2e8f0;font-size:13px;font-weight:600;">${esc(r.name)}</span>
          ${r.score != null ? pill(`Score ${r.score}`, '#C9A84C') : ''}
          <span style="color:#64748b;font-size:12px;margin-left:8px;">${esc(r.repliedAt)}</span>
        </div>`).join('\n');

  const memosSection = memoFiles.length === 0
    ? '<p style="color:#64748b;font-size:13px;font-style:italic;">No new investment memos today.</p>'
    : memoFiles.map(f => `
        <div style="padding:6px 12px;margin-bottom:4px;background:#161d27;border-left:3px solid #334155;border-radius:4px;">
          <span style="color:#e2e8f0;font-size:13px;">${esc(f)}</span>
        </div>`).join('\n');

  const errorsSection = errorLines.length === 0
    ? '<p style="color:#64748b;font-size:13px;font-style:italic;">No errors in the last 24 hours.</p>'
    : errorLines.map(l => `
        <div style="padding:5px 10px;margin-bottom:4px;background:#1a0a0a;border-left:3px solid #ef4444;border-radius:4px;word-break:break-all;">
          <span style="color:#fca5a5;font-size:12px;font-family:monospace;">${esc(l)}</span>
        </div>`).join('\n');

  const activitySection = recentActivityLines.length === 0
    ? '<p style="color:#64748b;font-size:13px;font-style:italic;">No recent activity.</p>'
    : recentActivityLines.map(l => `
        <div style="padding:4px 0;border-bottom:1px solid #1e293b;">
          <span style="color:#94a3b8;font-size:12px;font-family:monospace;">${esc(l)}</span>
        </div>`).join('\n');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>CM² Intelligence — ${esc(dayName)}, ${esc(dateStr)}</title>
</head>
<body style="margin:0;padding:0;background:#0d1117;font-family:-apple-system,system-ui,sans-serif;">
  <div style="max-width:680px;margin:0 auto;padding:32px 20px 48px;">

    <!-- Header -->
    <div style="text-align:center;margin-bottom:32px;">
      <h1 style="color:#C9A84C;font-size:22px;font-weight:800;letter-spacing:0.08em;margin:0 0 6px;">CM² Intelligence</h1>
      <p style="color:#64748b;font-size:13px;margin:0;">${esc(dayName)}, ${esc(dateStr)}</p>
    </div>

    <!-- Pipeline Today -->
    ${sectionTitle('Pipeline Today')}
    <table style="border-collapse:collapse;width:100%;">
      ${stat('Pushed to CM2', pushCounts.pushed_to_cm2)}
      ${stat('Push failures', pushCounts.push_failed)}
      ${stat('Replies synced', pushCounts.replied_in_cm2)}
      ${stat('WhatsApp triggered', pushCounts.whatsapp)}
      ${stat('New raw leads (24hr)', recentRawCount)}
    </table>

    <!-- Genuine Replies -->
    ${sectionTitle('Genuine Replies (last 24hrs)')}
    ${repliesSection}

    <!-- CM2 Outreach Status -->
    ${sectionTitle('CM2 Outreach Status')}
    <table style="border-collapse:collapse;width:100%;">
      ${cmStatVal('sentToday',      'Sent today')}
      ${cmStatVal('totalSent',      'All-time sent')}
      ${cmStatVal('genuineReplies', 'Genuine replies')}
      ${cmStatVal('bounceRate',     'Bounce rate')}
      ${cmStatVal('sequenceActive', 'Sequence active leads')}
      ${cmStatVal('capRemaining',   'Daily cap remaining')}
    </table>
    ${!cm2Stats ? '<p style="color:#64748b;font-size:12px;font-style:italic;margin-top:6px;">CM2 API unavailable — showing cached / local data only.</p>' : ''}

    <!-- Investment Properties -->
    ${sectionTitle('Investment Properties — New Memos Today')}
    ${memosSection}

    <!-- Exceptions -->
    ${sectionTitle('Exceptions (last 24hrs)')}
    ${errorsSection}

    <!-- Recent Activity -->
    ${sectionTitle('Recent Activity')}
    ${activitySection}

    <!-- Signature -->
    <div style="margin-top:40px;padding-top:20px;border-top:1px solid #1e293b;color:#475569;font-size:12px;text-align:center;">
      Julian Noble | Square Centimeter Ltd |
      <a href="mailto:invest@thecm2.com" style="color:#C9A84C;text-decoration:none;">invest@thecm2.com</a>
    </div>

  </div>
</body>
</html>`;
}

/* ── Send via SendGrid ─────────────────────────────────────────────────── */

async function sendEmail(subject, html) {
  const apiKey = process.env.SENDGRID_API_KEY;
  if (!apiKey) return false;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const res = await fetch('https://api.sendgrid.com/v3/mail/send', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        personalizations: [{ to: [{ email: 'invest@thecm2.com' }] }],
        from: { email: 'invest@thecm2.com', name: 'Square Centimeter' },
        subject,
        content: [{ type: 'text/html', value: html }],
      }),
      signal: controller.signal,
    });
    clearTimeout(timer);
    return res.ok || res.status === 202;
  } catch (err) {
    clearTimeout(timer);
    console.error(`[JulianBriefing] SendGrid error: ${err.message}`);
    return false;
  }
}

/* ── Main run ──────────────────────────────────────────────────────────── */

async function run() {
  console.log('\n[JulianBriefing] Building briefing…');

  // ── Collect data ─────────────────────────────────────────────────────────

  const now          = new Date();
  const dateStr      = now.toISOString().slice(0, 10);
  const dayName      = now.toLocaleDateString('en-GB', { weekday: 'long', timeZone: 'UTC' });

  const trackerLines       = readLastLines(TRACKER_PATH, 30);
  const recentActivityLines = trackerLines.slice(-10);
  const errorLines          = getRecentErrors(trackerLines);

  const pushLog       = loadPushLog();
  const pushCounts    = countPushLogByStatus(pushLog);
  const recentReplies = getRecentReplies(pushLog);

  const recentRawCount = countRecentFiles(LEADS_RAW_DIR, '.csv');
  const memoFiles      = getTodayMemoFiles();

  // CM2 stats — best effort
  console.log('[JulianBriefing] Fetching CM2 stats…');
  const cm2Stats = await fetchCM2Stats();
  if (cm2Stats) {
    console.log('[JulianBriefing] CM2 stats received.');
  } else {
    console.log('[JulianBriefing] CM2 stats unavailable — showing "—" in report.');
  }

  // ── Build HTML ────────────────────────────────────────────────────────────

  const html = buildHTML({
    dateStr, dayName,
    pushCounts, recentRawCount, recentReplies,
    cm2Stats, memoFiles,
    errorLines, recentActivityLines,
  });

  // ── Save to disk ──────────────────────────────────────────────────────────

  try {
    fs.mkdirSync(REPORTS_DIR, { recursive: true });
  } catch (_) { /* ignore */ }

  const outFile = path.join(REPORTS_DIR, `briefing-${dateStr}.html`);
  fs.writeFileSync(outFile, html, 'utf8');
  console.log(`[JulianBriefing] Saved: ${outFile}`);

  // ── Send email (if SENDGRID_API_KEY set) ──────────────────────────────────

  const subject = `CM² Intelligence — ${dayName}, ${dateStr}`;

  if (process.env.SENDGRID_API_KEY) {
    console.log('[JulianBriefing] Sending email via SendGrid…');
    const sent = await sendEmail(subject, html);
    if (sent) {
      console.log('[JulianBriefing] Email sent to invest@thecm2.com');
    } else {
      console.error('[JulianBriefing] Email send failed — HTML saved locally.');
    }
  } else {
    console.log('[JulianBriefing] SENDGRID_API_KEY not set — email not sent (HTML saved locally).');
  }

  console.log('[JulianBriefing] Done.\n');
}

/* ── Exports ───────────────────────────────────────────────────────────── */

module.exports = { run };

/* ── CLI entry point ───────────────────────────────────────────────────── */

if (require.main === module) {
  run().catch(err => {
    console.error('[JulianBriefing] Fatal:', err.message);
    process.exit(1);
  });
}
