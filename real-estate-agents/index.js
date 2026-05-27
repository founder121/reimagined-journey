#!/usr/bin/env node
'use strict';
/**
 * Square Centimeter Ltd — AI Agent Team
 * ════════════════════════════════════════════════════════════════════════════
 * CLI entry point.  Maps `sc <command>` to the five agent modules.
 *
 * Commands:
 *   sc scan      [--portal P]  [--area A]   [--min-price N] [--max-price N]
 *                [--pages N]   [--dry-run]
 *   sc leads     [--source S]  [--type T]   [--all]  [--limit N] [--dry-run]
 *   sc analyze   [--input F]   [--strategy buy-hold|flip|wholesale]
 *   sc market    <campaign>    [--channel email|sms|both]  [--leads F]
 *   sc outreach  [--leads F]   [--script cold-call|follow-up|offer]
 *   sc report                  [--format text|json|md]
 *   sc list      [portals|sources|all]
 *   sc status
 *   sc pipeline  [--state ST]  [--portal P]  [--limit N]
 */

const { program } = require('commander');
const fs   = require('fs');
const path = require('path');

const createLogger      = require('./utils/logger');
const { statusSummary, DATA_DIR, listFiles } = require('./utils/fileStore');

const log = createLogger('sc');

// ── Agent imports ─────────────────────────────────────────────────────────────
const scout     = require('./agents/agent1-crawler');
const finder    = require('./agents/agent2-leads');
const analyst   = require('./agents/agent3-analyst');
const marketing = require('./agents/agent4-marketing');
const sales     = require('./agents/agent5-sales');

// ── Error handler wrapper ─────────────────────────────────────────────────────
/**
 * Wrap a Commander action so all unhandled errors print a clean message
 * and exit 1 — instead of printing a raw stack trace.
 */
function handle(fn) {
  return async (...args) => {
    try {
      await fn(...args);
    } catch (err) {
      log.error(err.message);
      if (process.env.LOG_LEVEL === 'debug') log.error(err.stack);
      process.exit(1);
    }
  };
}

// ── CLI ───────────────────────────────────────────────────────────────────────

program
  .name('sc')
  .description('Square Centimeter Ltd — Prime London Property AI Agent Team')
  .version('1.0.0');

// ── sc scan ───────────────────────────────────────────────────────────────────
program
  .command('scan')
  .description('Agent 1 — Scan prime London listings from configured portals')
  .option('-P, --portal <key>',       'Portal key or "all" (default: all)', 'all')
  .option('-a, --area <area>',        'Override area list (comma-separated names)')
  .option('--min-price <n>',          'Minimum price £ (default: 500000)', parseIntArg)
  .option('--max-price <n>',          'Maximum price £', parseIntArg)
  .option('-p, --pages <n>',          'Max pages per area', parseIntArg)
  .option('-n, --dry-run',            'Validate config only — no HTTP requests')
  .action(handle(async (opts) => {
    const areas = opts.area ? opts.area.split(',').map((s) => s.trim()) : undefined;

    const records = await scout.run({
      portal:   opts.portal,
      areas,
      minPrice: opts.minPrice,
      maxPrice: opts.maxPrice,
      pages:    opts.pages,
      dryRun:   opts.dryRun,
    });

    if (opts.dryRun) return;

    const pcl      = records.filter((r) => r.marketZone === 'PCL').length;
    const pol      = records.filter((r) => r.marketZone === 'POL').length;
    const emerging = records.filter((r) => r.marketZone === 'EMERGING').length;
    const flagged  = records.filter((r) => r.flags?.length > 0).length;

    console.log(`\n✅  Scan complete`);
    console.log(`   ${records.length} listings  |  PCL: ${pcl}  POL: ${pol}  Emerging: ${emerging}`);
    console.log(`   ${flagged} flagged (motivated vendor / price reduced / short lease)`);
    console.log(`   → data/raw/listings-${todayStr()}.{json,csv}\n`);
  }));

// ── sc leads ──────────────────────────────────────────────────────────────────
program
  .command('leads')
  .description('Agent 2 — Find new HNW investor leads from public sources')
  .option('-s, --source <key>',  'Source key from lead-sources.yml')
  .option('-t, --type <type>',   'Run first enabled source of this type (cash_buyer, developer, …)')
  .option('-A, --all',           'Run all enabled sources of the given --type')
  .option('-l, --limit <n>',     'Max records per source', parseIntArg)
  .option('-n, --dry-run',       'Validate config only — no HTTP requests')
  .action(handle(async (opts) => {
    // Resolve what to run
    if (!opts.source && !opts.type) {
      console.error('Specify --source <key> or --type <type>.\nRun "sc list sources" to see options.');
      process.exit(1);
    }

    let leads;

    if (opts.all && opts.type) {
      // Run every enabled source for the given type
      leads = await finder.runAll({ type: opts.type, limit: opts.limit, dryRun: opts.dryRun });
    } else {
      // Single source (resolved by key or by type → first match)
      const sourceArg = opts.source ?? opts.type;
      leads = await finder.run({ source: sourceArg, limit: opts.limit, dryRun: opts.dryRun });
    }

    if (opts.dryRun) return;

    const highValue = leads.filter((l) => l.lead_score >= 7).length;
    console.log(`\n✅  Lead run complete`);
    console.log(`   ${leads.length} leads found  |  ${highValue} high-value (score ≥ 7)`);
    console.log(`   → data/leads/raw/leads-*-${todayStr()}.{json,csv}\n`);
  }));

// ── sc analyze ────────────────────────────────────────────────────────────────
program
  .command('analyze')
  .description('Agent 3 — Score prime London properties and generate investment memos')
  .option('-i, --input <file>',              'Listings JSON file (uses latest in data/raw/ if omitted)')
  .option('--additional-property',           'Apply 3 % SDLT additional-property surcharge (default: on)', true)
  .option('--non-uk-resident',               'Apply 2 % SDLT non-UK-resident surcharge (default: off)')
  .option('--ltv <fraction>',               'Mortgage LTV for cash-on-cash ROI (default: 0.65)', parseFloat)
  .option('--rate <pct>',                   'Interest rate for cash-on-cash ROI (default: 0.045)', parseFloat)
  .option('--no-memo',                      'Skip writing .md memos to reports/')
  .action(handle(async (opts) => {
    const report = await analyst.run({
      input:             opts.input,
      additionalProperty: opts.additionalProperty !== false,
      nonUkResident:     !!opts.nonUkResident,
      mortgageLtv:       opts.ltv   ?? 0.65,
      mortgageRate:      opts.rate  ?? 0.045,
      writeMemo:         opts.memo  !== false,
    });

    const top5 = (report.topDeals ?? []).slice(0, 5);
    console.log(`\n✅  Analysis complete — ${report.totalAnalyzed} propert${report.totalAnalyzed === 1 ? 'y' : 'ies'} scored`);
    if (top5.length) {
      console.log('\n   Top opportunities:');
      top5.forEach((d, i) => {
        const price = d.price ? `£${d.price.toLocaleString('en-GB')}` : 'no price';
        console.log(`   ${i + 1}. [${d.score}/100] ${d.recommendation.padEnd(7)} ${d.address ?? 'N/A'} — ${price}`);
      });
    }
    console.log(`   → reports/\n`);
  }));

// ── sc market ─────────────────────────────────────────────────────────────────
program
  .command('market [campaign]')
  .description('Agent 4 — Draft investor outreach and marketing content')
  .option('-c, --channel <channel>',  'email | sms | both', 'email')
  .option('-l, --leads <file>',       'Leads JSON file (uses latest if omitted)')
  .option('--limit <n>',              'Max leads to draft for', parseIntArg)
  .action(handle(async (campaign = 'motivated-sellers', opts) => {
    const drafts = await marketing.run({
      campaign,
      channel:   opts.channel,
      leadsFile: opts.leads,
      limit:     opts.limit,
    });
    console.log(`\n✅  Marketing drafts complete`);
    console.log(`   ${drafts.length} messages drafted | campaign: ${campaign} | channel: ${opts.channel}`);
    console.log(`   → outputs/marketing-${campaign}-${todayStr()}/\n`);
  }));

// ── sc outreach ───────────────────────────────────────────────────────────────
program
  .command('outreach')
  .description('Agent 5 — Prepare investor outreach and qualification list')
  .option('-l, --leads <file>',       'Leads JSON file (uses latest if omitted)')
  .option('-s, --script <type>',      'cold-call | follow-up | offer', 'cold-call')
  .option('--crm <format>',           'hubspot | podio | generic', 'generic')
  .option('--limit <n>',              'Max leads to process', parseIntArg)
  .action(handle(async (opts) => {
    const results = await sales.run({
      leadsFile: opts.leads,
      script:    opts.script,
      crm:       opts.crm,
      limit:     opts.limit,
    });
    console.log(`\n✅  Outreach prep complete`);
    console.log(`   ${results.length} contact briefs generated | script: ${opts.script}`);
    console.log(`   → data/leads/qualified/\n`);
  }));

// ── sc report ─────────────────────────────────────────────────────────────────
program
  .command('report')
  .description('Generate a full pipeline summary across all agents')
  .option('-f, --format <fmt>',  'text | json | md', 'text')
  .action(handle(async (opts) => {
    const report = buildPipelineReport();

    if (opts.format === 'json') {
      console.log(JSON.stringify(report, null, 2));
      return;
    }

    if (opts.format === 'md') {
      console.log(formatReportMarkdown(report));
      return;
    }

    printReportText(report);
  }));

// ── sc list ───────────────────────────────────────────────────────────────────
program
  .command('list [what]')
  .description('List configured portals, lead sources, or both  (portals | sources | all)')
  .action(handle(async (what = 'all') => {
    const showPortals = what === 'all' || what === 'portals';
    const showSources = what === 'all' || what === 'sources';

    if (showPortals) {
      const portals = scout.listPortals();
      console.log('\n📡  Portals (portals.yml)\n');
      console.log(
        '  Key             Enabled  Areas  Req/s  JS    Base URL'
      );
      console.log('  ' + '─'.repeat(70));
      for (const p of portals) {
        const enabled  = p.enabled ? '✓' : '✗';
        const js       = p.jsRendered ? 'yes' : 'no';
        const rps      = (1 / (p.rateLimit ?? 1)).toFixed(1);
        console.log(
          `  ${p.key.padEnd(15)} ${enabled.padEnd(8)} ${String(p.areaCount).padEnd(6)} ` +
          `${rps.padEnd(6)} ${js.padEnd(5)} ${p.baseUrl}`
        );
      }
    }

    if (showSources) {
      const sources = finder.listSources();
      console.log('\n🔍  Lead Sources (lead-sources.yml)\n');
      console.log('  Key                          Enabled  Type             Req/s  Max');
      console.log('  ' + '─'.repeat(72));
      for (const s of sources) {
        const enabled = s.enabled ? '✓' : '✗';
        const rps     = (1 / (s.rateLimit ?? 1)).toFixed(1);
        console.log(
          `  ${s.key.padEnd(28)} ${enabled.padEnd(8)} ${s.type.padEnd(16)} ` +
          `${rps.padEnd(6)} ${s.maxRecords ?? '?'}`
        );
      }
    }

    console.log('');
  }));

// ── sc status ─────────────────────────────────────────────────────────────────
program
  .command('status')
  .description('Show data file counts and latest activity')
  .action(handle(async () => {
    const dirs = [
      { key: 'raw',              label: 'Listings        (data/raw/)' },
      { key: 'leads/raw',        label: 'Raw leads       (data/leads/raw/)' },
      { key: 'leads/qualified',  label: 'Qualified leads (data/leads/qualified/)' },
      { key: 'leads/contacted',  label: 'Contacted       (data/leads/contacted/)' },
      { key: 'reports',          label: 'Investment memos (reports/)' },
      { key: 'outputs',          label: 'Marketing output (outputs/)' },
    ];

    console.log('\n📊  Square Centimeter — Data Status\n');
    console.log('  Directory                         Files  Records   Latest file');
    console.log('  ' + '─'.repeat(72));

    for (const { key, label } of dirs) {
      const files = safeListFiles(key);
      const latest  = files[0] ? path.basename(files[0]) : '(none)';
      const records = countRecords(files[0]);
      console.log(
        `  ${label.padEnd(36)} ${String(files.length).padStart(5)}  ` +
        `${String(records ?? '–').padStart(7)}   ${latest}`
      );
    }

    // Scan history last entry
    const histPath = path.join(DATA_DIR, 'scan-history.tsv');
    if (fs.existsSync(histPath)) {
      const lines = fs.readFileSync(histPath, 'utf8').trim().split('\n');
      const last  = lines[lines.length - 1];
      if (last && !last.startsWith('timestamp')) {
        const [ts, portals, count] = last.split('\t');
        console.log(`\n  Last scan: ${ts}  |  portals: ${portals}  |  records: ${count}`);
      }
    }

    // Pipeline items
    const pipelinePath = path.join(DATA_DIR, 'pipeline.md');
    if (fs.existsSync(pipelinePath)) {
      const content   = fs.readFileSync(pipelinePath, 'utf8');
      const unchecked = (content.match(/\- \[ \]/g) ?? []).length;
      if (unchecked > 0) {
        console.log(`\n  ⚠️   ${unchecked} item(s) awaiting Julian Noble's review in data/pipeline.md`);
      }
    }

    console.log('');
  }));

// ── sc pipeline ───────────────────────────────────────────────────────────────
program
  .command('pipeline')
  .description('Run the full end-to-end pipeline: scan → leads → analyze → market → outreach')
  .option('-P, --portal <key>',       'Portal to scan', 'rightmove')
  .option('-t, --lead-type <type>',   'Lead type to source', 'cash_buyer')
  .option('--min-price <n>',          'Minimum listing price £', parseIntArg)
  .option('--strategy <strategy>',    'Analysis strategy', 'buy-hold')
  .option('--campaign <campaign>',    'Marketing campaign', 'motivated-sellers')
  .option('-l, --limit <n>',          'Record cap per stage', parseIntArg)
  .action(handle(async (opts) => {
    console.log('\n🚀  Starting full pipeline — Square Centimeter Ltd\n');

    // ── Stage 1: Scan ────────────────────────────────────────────────────
    console.log('Stage 1/5 — Scanning listings…');
    const listings = await scout.run({
      portal:   opts.portal,
      minPrice: opts.minPrice,
      pages:    opts.limit ? Math.ceil(opts.limit / 24) : 3,
    });
    console.log(`  ✓ ${listings.length} listings collected\n`);

    // ── Stage 2: Leads ───────────────────────────────────────────────────
    console.log('Stage 2/5 — Finding investor leads…');
    const leads = await finder.runAll({ type: opts.leadType ?? 'cash_buyer', limit: opts.limit });
    console.log(`  ✓ ${leads.length} leads found\n`);

    // ── Stage 3: Analyse ─────────────────────────────────────────────────
    console.log('Stage 3/5 — Running investment analysis…');
    const report = await analyst.run({ additionalProperty: true });
    console.log(`  ✓ ${report.totalAnalyzed ?? 0} properties analysed | top score: ${report.topDeals?.[0]?.score ?? 'N/A'}\n`);

    // ── Stage 4: Marketing ───────────────────────────────────────────────
    console.log('Stage 4/5 — Drafting marketing content…');
    const drafts = await marketing.run({ campaign: opts.campaign, limit: opts.limit ?? 50 });
    console.log(`  ✓ ${drafts.length} drafts prepared\n`);

    // ── Stage 5: Outreach prep ───────────────────────────────────────────
    console.log('Stage 5/5 — Preparing outreach briefs…');
    const scripts = await sales.run({ script: 'cold-call', limit: opts.limit ?? 25 });
    console.log(`  ✓ ${scripts.length} contact briefs generated\n`);

    console.log('✅  Pipeline complete. Run "sc status" to see all output files.\n');
  }));

// ── Parse ─────────────────────────────────────────────────────────────────────
program.parse(process.argv);

// ── Helpers ───────────────────────────────────────────────────────────────────

function parseIntArg(val) {
  const n = parseInt(val, 10);
  return isNaN(n) ? undefined : n;
}

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

function safeListFiles(subdir) {
  try { return listFiles(subdir); } catch (_) { return []; }
}

/** Count records in the most-recent JSON file for a subdir */
function countRecords(filePath) {
  if (!filePath || !filePath.endsWith('.json')) return null;
  try {
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return Array.isArray(data) ? data.length : 1;
  } catch (_) { return null; }
}

// ── Report builders ───────────────────────────────────────────────────────────

function buildPipelineReport() {
  const rawFiles = safeListFiles('raw');
  const leadFiles = safeListFiles('leads/raw');
  const qualFiles = safeListFiles('leads/qualified');
  const reportFiles = safeListFiles('reports');

  const totalListings = rawFiles.reduce((n, f) => n + (countRecords(f) ?? 0), 0);
  const totalLeads    = leadFiles.reduce((n, f) => n + (countRecords(f) ?? 0), 0);
  const totalQual     = qualFiles.reduce((n, f) => n + (countRecords(f) ?? 0), 0);

  return {
    generatedAt:    new Date().toISOString(),
    listings:       { files: rawFiles.length,    totalRecords: totalListings, latestFile: rawFiles[0]   ? path.basename(rawFiles[0])   : null },
    rawLeads:       { files: leadFiles.length,   totalRecords: totalLeads,   latestFile: leadFiles[0]  ? path.basename(leadFiles[0])  : null },
    qualifiedLeads: { files: qualFiles.length,   totalRecords: totalQual,    latestFile: qualFiles[0]  ? path.basename(qualFiles[0])  : null },
    memos:          { files: reportFiles.length,                              latestFile: reportFiles[0]? path.basename(reportFiles[0]): null },
  };
}

function printReportText(r) {
  const line = (label, val) => console.log(`  ${label.padEnd(30)} ${val}`);
  console.log('\n📋  Square Centimeter — Pipeline Report');
  console.log(`    Generated: ${r.generatedAt}\n`);
  line('Listings collected:',  `${r.listings.totalRecords} records across ${r.listings.files} files`);
  line('Latest scan:',         r.listings.latestFile ?? '(none)');
  line('Raw leads:',           `${r.rawLeads.totalRecords} leads across ${r.rawLeads.files} files`);
  line('Qualified leads:',     `${r.qualifiedLeads.totalRecords} in pipeline`);
  line('Investment memos:',    `${r.memos.files} memos`);
  console.log('');
}

function formatReportMarkdown(r) {
  return [
    '# Square Centimeter — Pipeline Report',
    `_Generated: ${r.generatedAt}_`,
    '',
    '| Stage | Files | Records | Latest |',
    '|-------|------:|--------:|--------|',
    `| Listings | ${r.listings.files} | ${r.listings.totalRecords} | ${r.listings.latestFile ?? '–'} |`,
    `| Raw Leads | ${r.rawLeads.files} | ${r.rawLeads.totalRecords} | ${r.rawLeads.latestFile ?? '–'} |`,
    `| Qualified Leads | ${r.qualifiedLeads.files} | ${r.qualifiedLeads.totalRecords} | ${r.qualifiedLeads.latestFile ?? '–'} |`,
    `| Investment Memos | ${r.memos.files} | – | ${r.memos.latestFile ?? '–'} |`,
    '',
  ].join('\n');
}
