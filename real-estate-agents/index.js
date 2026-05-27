#!/usr/bin/env node
'use strict';
/**
 * Square Centimeter Ltd — AI Agent Team
 * ════════════════════════════════════════════════════════════════════════════
 * CLI entry point.  Maps `sc <command>` to the five agent modules.
 *
 * Commands
 * ─────────
 *   sc scan      [--portal P]   [--area A]   [--min-price N] [--max-price N]
 *                [--pages N]    [--dry-run]
 *   sc leads     [--source S]   [--type T]   [--all]  [--limit N] [--dry-run]
 *   sc analyze   [--input F]    [--additional-property] [--non-uk-resident]
 *                [--ltv 0.65]   [--rate 0.045]  [--no-memo]
 *   sc market    [top5]         [--zone Z]   [--limit N]  [--yes]
 *   sc outreach  [--days N]     [--limit N]  [--yes]
 *   sc report    [--format text|json|md]
 *   sc list      [listings|portals|sources|all]
 *   sc status
 *   sc pipeline  [--portal P]   [--lead-type T] [--min-price N] [--limit N]
 */

const { program } = require('commander');
const fs          = require('fs');
const path        = require('path');
const readline    = require('readline');

const createLogger                         = require('./utils/logger');
const { DATA_DIR, REPORTS_DIR, OUTPUTS_DIR, listFiles } = require('./utils/fileStore');

const log = createLogger('sc');

// ── Agent imports ─────────────────────────────────────────────────────────────
const scout     = require('./agents/agent1-crawler');
const finder    = require('./agents/agent2-leads');
const analyst   = require('./agents/agent3-analyst');
const marketing = require('./agents/agent4-marketing');
const sales     = require('./agents/agent5-sales');

// ── Error handler ─────────────────────────────────────────────────────────────
/**
 * Wrap a Commander action so unhandled errors print a clean message,
 * log to data/tracker.md, and exit 1.
 */
function handle(fn) {
  return async (...args) => {
    try {
      await fn(...args);
    } catch (err) {
      log.error(err.message);
      if (process.env.LOG_LEVEL === 'debug') log.error(err.stack);
      logTrackerEntry(`ERROR | ${err.message}`);
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
  .option('-P, --portal <key>',    'Portal key or "all" (default: all)', 'all')
  .option('-a, --area <area>',     'Override area list (comma-separated names)')
  .option('--min-price <n>',       'Minimum price £ (default: 500000)', parseIntArg)
  .option('--max-price <n>',       'Maximum price £', parseIntArg)
  .option('-p, --pages <n>',       'Max pages per area', parseIntArg)
  .option('-n, --dry-run',         'Validate config only — no HTTP requests')
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

    logTrackerEntry(`Agent 1 | Scan complete — ${records.length} listings (PCL:${pcl} POL:${pol} Emerging:${emerging})`);

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
    if (!opts.source && !opts.type) {
      console.error('Specify --source <key> or --type <type>.\nRun "sc list sources" to see options.');
      process.exit(1);
    }

    let leads;

    if (opts.all && opts.type) {
      leads = await finder.runAll({ type: opts.type, limit: opts.limit, dryRun: opts.dryRun });
    } else {
      const sourceArg = opts.source ?? opts.type;
      leads = await finder.run({ source: sourceArg, limit: opts.limit, dryRun: opts.dryRun });
    }

    if (opts.dryRun) return;

    const highValue = leads.filter((l) => l.lead_score >= 7).length;
    logTrackerEntry(`Agent 2 | Leads run — ${leads.length} leads found (${highValue} high-value ≥7)`);

    console.log(`\n✅  Lead run complete`);
    console.log(`   ${leads.length} leads found  |  ${highValue} high-value (score ≥ 7)`);
    console.log(`   → data/leads/raw/leads-*-${todayStr()}.{json,csv}\n`);
  }));

// ── sc analyze ────────────────────────────────────────────────────────────────
program
  .command('analyze')
  .description('Agent 3 — Score prime London properties and generate investment memos')
  .option('-i, --input <file>',       'Listings JSON file (uses latest in data/raw/ if omitted)')
  .option('--additional-property',    'Apply 3 % SDLT additional-property surcharge (default: on)', true)
  .option('--non-uk-resident',        'Apply 2 % SDLT non-UK-resident surcharge (default: off)')
  .option('--ltv <fraction>',         'Mortgage LTV for cash-on-cash ROI (default: 0.65)', parseFloat)
  .option('--rate <pct>',             'Interest rate for cash-on-cash ROI (default: 0.045)', parseFloat)
  .option('--no-memo',                'Skip writing .md memos to reports/')
  .action(handle(async (opts) => {
    const analysisOpts = {
      additionalProperty: opts.additionalProperty !== false,
      nonUkResident:      !!opts.nonUkResident,
      mortgageLtv:        opts.ltv   ?? 0.65,
      mortgageRate:       opts.rate  ?? 0.045,
      writeMemo:          opts.memo  !== false,
    };

    let report;

    if (opts.input) {
      // Explicit file supplied
      report = await analyst.run({ ...analysisOpts, input: opts.input });
    } else {
      const rawFiles = safeListFiles('raw');
      if (rawFiles.length > 0) {
        // Use latest scan file
        console.log(`\n  Using latest scan: ${path.basename(rawFiles[0])}`);
        report = await analyst.run({ ...analysisOpts, input: rawFiles[0] });
      } else {
        // No scan data — prompt interactively for a single address
        console.log('\n  No listings found in data/raw/. Run "sc scan" first, or enter a property to analyse.\n');
        const property = await promptForProperty();
        if (!property) {
          console.log('  Cancelled. Run "sc scan" to collect listings, or provide --input <file>.\n');
          return;
        }
        report = await analyst.run({ ...analysisOpts, property });
      }
    }

    printAnalysisReport(report);
    logTrackerEntry(`Agent 3 | Analysis — ${report.totalAnalyzed} propert${report.totalAnalyzed === 1 ? 'y' : 'ies'} scored`);
  }));

// ── sc market ─────────────────────────────────────────────────────────────────
program
  .command('market [subcommand]')
  .description('Agent 4 — Generate marketing content for top investment opportunities')
  .option('--zone <zone>',     'Override zone filter (PCL / POL / EMERGING)')
  .option('--limit <n>',       'Max deals to generate content for (default: 5)', parseIntArg)
  .option('-y, --yes',         'Skip confirmation prompt and proceed')
  .action(handle(async (subcommand = 'top5', opts) => {
    const limit = opts.limit ?? 5;

    // ── Resolve top deals from the latest scan ───────────────────────────────
    const rawFiles = safeListFiles('raw');
    if (!rawFiles.length) {
      console.log('\n  ⚠️  No listings found. Run "sc scan" first.\n');
      return;
    }

    console.log(`\n  Analysing latest scan for top ${limit} deal(s)…`);
    const analysisReport = await analyst.run({
      input:              rawFiles[0],
      additionalProperty: true,
      writeMemo:          false,   // memos written separately via "sc analyze"
    });

    let topDeals = (analysisReport.topDeals ?? [])
      .filter((d) => d.recommendation === 'ACQUIRE' || d.recommendation === 'MONITOR');

    if (opts.zone) {
      topDeals = topDeals.filter((d) => d.marketZone === opts.zone.toUpperCase());
    }

    topDeals = topDeals.slice(0, limit);

    if (!topDeals.length) {
      console.log('\n  ⚠️  No ACQUIRE / MONITOR deals available in the latest scan.\n');
      console.log('  Run "sc analyze" to score properties, or check data/raw/ for listings.\n');
      return;
    }

    // ── Show plan and confirm ────────────────────────────────────────────────
    console.log(`\n  📣  Marketing content to be generated for ${topDeals.length} deal(s):\n`);
    topDeals.forEach((d, i) => {
      const price = d.price ? `£${d.price.toLocaleString('en-GB')}` : 'no price';
      console.log(
        `  ${i + 1}. [${d.recommendation}/${d.score}] ${(d.address ?? 'N/A').slice(0, 45).padEnd(45)} — ${price}`,
      );
    });

    console.log('\n  ⚠️  CLAUDE.md constraint: confirm before publishing content.\n');

    if (!opts.yes) {
      const confirmed = await confirm('  Generate and save marketing content? [y/N]: ');
      if (!confirmed) {
        console.log('\n  Cancelled. Re-run with --yes to skip this prompt.\n');
        return;
      }
    }

    // ── Generate content for each deal ───────────────────────────────────────
    console.log('');
    let generated = 0;
    for (const deal of topDeals) {
      const label = (deal.address ?? deal.marketZone ?? 'property').slice(0, 50);
      process.stdout.write(`  Generating: ${label}… `);
      try {
        await marketing.run({ memo: deal, writeToDisk: true });
        process.stdout.write('✓\n');
        generated++;
      } catch (err) {
        process.stdout.write(`✗ (${err.message})\n`);
        logTrackerEntry(`Agent 4 | ERROR generating content for ${label}: ${err.message}`);
      }
    }

    logTrackerEntry(`Agent 4 | Marketing content generated for ${generated}/${topDeals.length} deal(s)`);

    console.log(`\n✅  Marketing content generated for ${generated} deal(s)`);
    console.log(`   → data/outputs/marketing-*/\n`);
  }));

// ── sc outreach ───────────────────────────────────────────────────────────────
program
  .command('outreach')
  .description('Agent 5 — Flag overdue leads and prepare briefing notes for Julian Noble')
  .option('--days <n>',    'Flag leads with no contact in this many days (default: 7)', parseIntArg)
  .option('-l, --limit <n>', 'Max leads to process', parseIntArg)
  .option('-y, --yes',     'Skip confirmation prompt and proceed')
  .action(handle(async (opts) => {
    const overdueAfterDays = opts.days ?? 7;

    // ── Detect overdue leads ─────────────────────────────────────────────────
    const checkResult = await sales.run({
      action:          'followup',
      overdueAfterDays,
      writeToDisk:     false,
    });

    const { overdue, qualified } = checkResult;

    console.log(`\n📋  Outreach Check — Square Centimeter Ltd`);
    console.log(`   ${qualified.length} qualified lead(s) in pipeline`);

    if (!overdue.length) {
      console.log(`   ✅  All leads contacted within ${overdueAfterDays} days — no action needed.\n`);
      logTrackerEntry(`Agent 5 | Outreach check — all ${qualified.length} lead(s) current (no overdue)`);
      return;
    }

    // ── Show overdue leads ───────────────────────────────────────────────────
    console.log(`\n   ⚠️  ${overdue.length} lead(s) overdue (no contact in ${overdueAfterDays}+ days):\n`);
    const display = opts.limit ? overdue.slice(0, opts.limit) : overdue;
    display.forEach((lead, i) => {
      const lastContact = lead.lastContactAt ?? lead.date_found ?? 'unknown';
      const budget      = lead.budget_range ?? 'Unknown';
      const score       = lead.qualificationScore != null ? `score: ${lead.qualificationScore}/100` : '';
      console.log(`   ${i + 1}. ${(lead.name ?? 'Anonymous').padEnd(30)} ${budget.padEnd(15)} last contact: ${lastContact}  ${score}`);
    });

    console.log('\n  ⚠️  CLAUDE.md constraint: confirm before outreach.\n');

    if (!opts.yes) {
      const confirmed = await confirm('  Generate briefing notes for overdue leads? [y/N]: ');
      if (!confirmed) {
        console.log('\n  Cancelled. Re-run with --yes to generate briefings.\n');
        return;
      }
    }

    // ── Generate briefing notes ──────────────────────────────────────────────
    const result = await sales.run({
      leads:       display,
      action:      'brief',
      writeToDisk: true,
    });

    logTrackerEntry(`Agent 5 | Outreach — ${result.briefings.length} briefing note(s) prepared for ${overdue.length} overdue lead(s)`);

    console.log(`\n✅  Outreach prep complete`);
    console.log(`   ${result.briefings.length} briefing note(s) prepared for Julian Noble`);
    console.log(`   → reports/\n`);
  }));

// ── sc report ─────────────────────────────────────────────────────────────────
program
  .command('report')
  .description('Generate full pipeline report and save to reports/pipeline-report-YYYY-MM-DD.md')
  .option('-f, --format <fmt>',  'text | json | md', 'text')
  .action(handle(async (opts) => {
    const report = buildPipelineReport();

    if (opts.format === 'json') {
      console.log(JSON.stringify(report, null, 2));
      return;
    }

    const markdown = formatReportMarkdown(report);

    // ── Always save .md file to reports/ (project root) ─────────────────────
    try {
      fs.mkdirSync(REPORTS_DIR, { recursive: true });
      const filename = `pipeline-report-${todayStr()}.md`;
      const dest     = path.join(REPORTS_DIR, filename);
      const tmp      = `${dest}.tmp`;
      fs.writeFileSync(tmp, markdown, 'utf8');
      fs.renameSync(tmp, dest);
      console.log(`\n  💾  Report saved: reports/${filename}`);
    } catch (err) {
      log.warn(`Could not save report file: ${err.message}`);
      logTrackerEntry(`ERROR | Report save failed: ${err.message}`);
    }

    if (opts.format === 'md') {
      console.log(markdown);
    } else {
      printReportText(report);
    }

    logTrackerEntry(`Agent All | Pipeline report generated — ${report.listings.totalRecords} listings, ${report.rawLeads.totalRecords} raw leads, ${report.qualifiedLeads.totalRecords} qualified, ${report.analysis.acquireCount} ACQUIRE`);
  }));

// ── sc list ───────────────────────────────────────────────────────────────────
program
  .command('list [what]')
  .description('List latest listings, configured portals, lead sources, or all  (listings | portals | sources | all)')
  .action(handle(async (what = 'all') => {
    const showListings = what === 'all' || what === 'listings';
    const showPortals  = what === 'all' || what === 'portals';
    const showSources  = what === 'all' || what === 'sources';

    // ── Latest listings ──────────────────────────────────────────────────────
    if (showListings) {
      const files = safeListFiles('raw');
      console.log('\n🏠  Latest Listings (data/raw/)\n');
      if (!files.length) {
        console.log('  (none — run "sc scan" to collect listings)\n');
      } else {
        const latestFile = files[0];
        try {
          const records  = JSON.parse(fs.readFileSync(latestFile, 'utf8'));
          const listings = Array.isArray(records) ? records : [];
          console.log(`  File: ${path.basename(latestFile)}  (${listings.length} listing${listings.length === 1 ? '' : 's'})\n`);
          if (listings.length) {
            console.log('  #   Zone     Rec      Score  Beds  Price              Address');
            console.log('  ' + '─'.repeat(82));
            const top = listings.slice(0, 20);
            top.forEach((l, i) => {
              const zone  = (l.marketZone ?? '?').padEnd(8);
              const rec   = (l.recommendation ?? '–').padEnd(8);
              const score = String(l.score ?? '–').padStart(5);
              const beds  = String(l.beds  ?? '?').padStart(4);
              const price = l.price ? `£${l.price.toLocaleString('en-GB')}` : '–';
              const addr  = (l.address ?? 'N/A').slice(0, 38);
              console.log(`  ${String(i + 1).padStart(2)}  ${zone} ${rec} ${score}  ${beds}  ${price.padEnd(18)} ${addr}`);
            });
            if (listings.length > 20) {
              console.log(`\n  … and ${listings.length - 20} more — see ${path.basename(latestFile)}`);
            }
          }
        } catch (err) {
          console.log(`  Could not read listings: ${err.message}`);
        }
        if (files.length > 1) {
          console.log(`\n  ${files.length - 1} older scan file${files.length > 2 ? 's' : ''} also available in data/raw/`);
        }
        console.log('');
      }
    }

    // ── Portals ──────────────────────────────────────────────────────────────
    if (showPortals) {
      const portals = scout.listPortals();
      console.log('\n📡  Portals (portals.yml)\n');
      console.log('  Key             Enabled  Areas  Req/s  JS    Base URL');
      console.log('  ' + '─'.repeat(70));
      for (const p of portals) {
        const enabled = p.enabled ? '✓' : '✗';
        const js      = p.jsRendered ? 'yes' : 'no';
        const rps     = (1 / (p.rateLimit ?? 1)).toFixed(1);
        console.log(
          `  ${p.key.padEnd(15)} ${enabled.padEnd(8)} ${String(p.areaCount).padEnd(6)} ` +
          `${rps.padEnd(6)} ${js.padEnd(5)} ${p.baseUrl}`,
        );
      }
    }

    // ── Lead Sources ─────────────────────────────────────────────────────────
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
          `${rps.padEnd(6)} ${s.maxRecords ?? '?'}`,
        );
      }
    }

    console.log('');
  }));

// ── sc status ─────────────────────────────────────────────────────────────────
program
  .command('status')
  .description('Show pipeline counts: raw leads, qualified, contacted, converted')
  .action(handle(async () => {
    // Data subdirs — contain timestamped JSON files (listings, raw leads)
    const jsonDirs = [
      { key: 'raw',       label: 'Listings        (data/raw/)' },
      { key: 'leads/raw', label: 'Raw leads       (data/leads/raw/)' },
    ];

    // Qualified/contacted — stored as .csv files (not JSON)
    const csvDirs = [
      { subdir: 'leads/qualified', label: 'Qualified leads (data/leads/qualified/)' },
      { subdir: 'leads/contacted', label: 'Contacted       (data/leads/contacted/)' },
    ];

    // Root-level directories — memos (.md) and marketing dirs
    const memoFiles   = safeListFilesMd(REPORTS_DIR);
    const outputDirs  = safeListOutputDirs();

    console.log('\n📊  Square Centimeter — Pipeline Status\n');
    console.log('  Directory                         Files  Records   Latest file');
    console.log('  ' + '─'.repeat(72));

    for (const { key, label } of jsonDirs) {
      const files   = safeListFiles(key);
      const latest  = files[0] ? path.basename(files[0]) : '(none)';
      const records = countRecords(files[0]);
      console.log(
        `  ${label.padEnd(36)} ${String(files.length).padStart(5)}  ` +
        `${String(records ?? '–').padStart(7)}   ${latest}`,
      );
    }

    for (const { subdir, label } of csvDirs) {
      const { files, records, latest } = safeListFilesCsv(subdir);
      console.log(
        `  ${label.padEnd(36)} ${String(files).padStart(5)}  ` +
        `${String(records ?? '–').padStart(7)}   ${latest}`,
      );
    }

    // Reports row — .md files from root reports/
    {
      const latest = memoFiles[0] ? path.basename(memoFiles[0]) : '(none)';
      console.log(
        `  ${'Reports         (reports/)'.padEnd(36)} ${String(memoFiles.length).padStart(5)}  ` +
        `${'–'.padStart(7)}   ${latest}`,
      );
    }
    // Outputs row — marketing subdirs from root outputs/
    {
      console.log(
        `  ${'Marketing output (outputs/)'.padEnd(36)} ${String(outputDirs.length).padStart(5)}  ` +
        `${'–'.padStart(7)}   ${outputDirs[0] ?? '(none)'}`,
      );
    }

    // ── Lead status breakdown ────────────────────────────────────────────────
    const statusCounts = countLeadStatuses();
    const statOrder    = ['new', 'contacted', 'responded', 'meeting_booked', 'converted', 'needs_manual_enrichment', 'dead'];
    const anyStatus    = statOrder.some((s) => (statusCounts[s] ?? 0) > 0);

    if (anyStatus) {
      console.log('\n  Lead Pipeline Breakdown:\n');
      for (const status of statOrder) {
        const n = statusCounts[status] ?? 0;
        if (n > 0) {
          const bar   = '█'.repeat(Math.min(n, 30));
          const emoji = { new: '🆕', contacted: '📬', responded: '💬', meeting_booked: '📅', converted: '✅', needs_manual_enrichment: '🔍', dead: '❌' }[status] ?? '•';
          console.log(`  ${emoji}  ${status.padEnd(24)} ${String(n).padStart(4)}  ${bar}`);
        }
      }
    }

    // ── Last scan ────────────────────────────────────────────────────────────
    const histPath = path.join(DATA_DIR, 'scan-history.tsv');
    if (fs.existsSync(histPath)) {
      const lines = fs.readFileSync(histPath, 'utf8').trim().split('\n');
      const last  = lines[lines.length - 1];
      if (last && !last.startsWith('timestamp')) {
        const [ts, portals, count] = last.split('\t');
        console.log(`\n  Last scan: ${ts}  |  portals: ${portals}  |  records: ${count}`);
      }
    }

    // ── Pipeline items for Julian Noble ─────────────────────────────────────
    const pipelinePath = path.join(DATA_DIR, 'pipeline.md');
    if (fs.existsSync(pipelinePath)) {
      const content   = fs.readFileSync(pipelinePath, 'utf8');
      // Only count task-list items at the start of a line (not inline code like `- [ ]`)
      const unchecked = (content.match(/^- \[ \]/gm) ?? []).length;
      if (unchecked > 0) {
        console.log(`\n  ⚠️   ${unchecked} item(s) awaiting Julian Noble's review — run "sc pipeline" to view`);
      }
    }

    console.log('');
  }));

// ── sc pipeline ───────────────────────────────────────────────────────────────
program
  .command('pipeline')
  .description('Show data/pipeline.md — items awaiting Julian Noble\'s review')
  .option('-P, --portal <key>',      'Portal to scan (used when running full pipeline)', 'rightmove')
  .option('-t, --lead-type <type>',  'Lead type to source', 'cash_buyer')
  .option('--min-price <n>',         'Minimum listing price £', parseIntArg)
  .option('-l, --limit <n>',         'Record cap per stage', parseIntArg)
  .option('--run',                   'Execute full end-to-end pipeline (scan→leads→analyze→market→outreach)')
  .action(handle(async (opts) => {
    if (!opts.run) {
      // ── Display pipeline.md ────────────────────────────────────────────────
      const pipelinePath = path.join(DATA_DIR, 'pipeline.md');
      console.log('\n📋  Pipeline — Items Awaiting Review (data/pipeline.md)\n');

      if (!fs.existsSync(pipelinePath)) {
        console.log('  (no pipeline items yet — run agents to generate recommendations)\n');
        return;
      }

      const content   = fs.readFileSync(pipelinePath, 'utf8');
      // Match only start-of-line task items to avoid false positives from inline code
      const unchecked = (content.match(/^- \[ \]/gm) ?? []).length;
      const checked   = (content.match(/^- \[x\]/gim) ?? []).length;

      console.log(content);
      console.log(`\n  ${unchecked} pending  |  ${checked} resolved\n`);
      return;
    }

    // ── Full end-to-end pipeline ───────────────────────────────────────────
    console.log('\n🚀  Starting full pipeline — Square Centimeter Ltd\n');

    // Stage 1: Scan
    console.log('Stage 1/5 — Scanning listings…');
    const listings = await scout.run({
      portal:   opts.portal,
      minPrice: opts.minPrice,
      pages:    opts.limit ? Math.ceil(opts.limit / 24) : 3,
    });
    console.log(`  ✓ ${listings.length} listings collected\n`);

    // Stage 2: Leads
    console.log('Stage 2/5 — Finding investor leads…');
    const leads = await finder.runAll({ type: opts.leadType ?? 'cash_buyer', limit: opts.limit });
    console.log(`  ✓ ${leads.length} leads found\n`);

    // Stage 3: Analyse
    console.log('Stage 3/5 — Running investment analysis…');
    const analysisReport = await analyst.run({ additionalProperty: true });
    const topScore       = analysisReport.topDeals?.[0]?.score ?? 'N/A';
    console.log(`  ✓ ${analysisReport.totalAnalyzed ?? 0} properties analysed | top score: ${topScore}\n`);

    // Stage 4: Marketing — generate content for top ACQUIRE/MONITOR deals
    console.log('Stage 4/5 — Drafting marketing content for top deals…');
    const top5 = (analysisReport.topDeals ?? [])
      .filter((d) => d.recommendation === 'ACQUIRE' || d.recommendation === 'MONITOR')
      .slice(0, 5);

    if (top5.length) {
      for (const deal of top5) {
        try {
          await marketing.run({ memo: deal, writeToDisk: true });
        } catch (err) {
          log.warn(`[pipeline] Marketing failed for ${deal.address ?? 'unknown'}: ${err.message}`);
        }
      }
      console.log(`  ✓ Marketing content generated for ${top5.length} deal(s)\n`);
    } else {
      console.log('  ✓ No ACQUIRE / MONITOR deals — skipping marketing content\n');
    }

    // Stage 5: Qualify leads and prepare briefing notes
    console.log('Stage 5/5 — Qualifying leads and preparing briefing notes…');
    const qualResult = await sales.run({
      leads:       leads,
      action:      'all',
      writeToDisk: true,
    });
    console.log(`  ✓ ${qualResult.qualified.length} lead(s) qualified | ${qualResult.briefings.length} briefing note(s) prepared\n`);

    logTrackerEntry(`Pipeline | Full run complete — ${listings.length} listings, ${leads.length} leads, ${analysisReport.totalAnalyzed ?? 0} analysed, ${top5.length} deals marketed, ${qualResult.qualified.length} leads qualified`);

    console.log('✅  Pipeline complete. Run "sc status" to see all output files.\n');
    console.log('   Next: run "sc report" to generate the full pipeline report.\n');
  }));

// ── sc enrich ─────────────────────────────────────────────────────────────────
program
  .command('enrich')
  .description('Enrich raw leads via Companies House API → data/leads/qualified/')
  .option('--min-score <n>',  'Minimum lead_score to process (default: 7)', parseFloat)
  .option('-l, --limit <n>',  'Cap on leads to enrich', parseIntArg)
  .option('--api-key <key>',  'Companies House API key (overrides COMPANIES_HOUSE_API_KEY env)')
  .option('--no-pipeline',    'Skip data/pipeline.md — only process data/leads/raw/')
  .option('-n, --dry-run',    'Parse leads only — no Companies House API calls')
  .action(handle(async (opts) => {
    const enrich = require('./utils/enrichLeads');

    const result = await enrich.run({
      minScore:        opts.minScore ?? 7,
      limit:           opts.limit,
      apiKey:          opts.apiKey,
      includePipeline: opts.pipeline !== false,
      dryRun:          opts.dryRun,
    });

    if (opts.dryRun) {
      console.log(`\n  [DRY RUN] Would enrich ${result.total} lead(s) — no Companies House calls made.\n`);
      return;
    }

    logTrackerEntry(`sc enrich | processed=${result.total} ch_matched=${result.enriched} needs_review=${result.needsReview}`);

    console.log(`\n✅  Enrichment complete`);
    console.log(`   ${result.total} lead(s) processed`);
    console.log(`   ${result.enriched} matched Companies House`);
    if (result.needsReview > 0) {
      console.log(`   ⚠️  ${result.needsReview} need manual review (status: needs_manual_enrichment)`);
    }
    console.log(`   → data/leads/qualified/qualified-${todayStr()}.csv\n`);
  }));

// ── Parse ─────────────────────────────────────────────────────────────────────
program.parse(process.argv);

// ─────────────────────────────────────────────────────────────────────────────
// Helper utilities
// ─────────────────────────────────────────────────────────────────────────────

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

/** Count records in the most-recent JSON file for a subdir. */
function countRecords(filePath) {
  if (!filePath || !filePath.endsWith('.json')) return null;
  try {
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return Array.isArray(data) ? data.length : 1;
  } catch (_) { return null; }
}

/**
 * Count qualified lead statuses from all CSV files in data/leads/qualified/.
 * Returns an object keyed by status value.
 * Note: qualified leads are stored as .csv (not .json), so listFiles() is bypassed.
 */
function countLeadStatuses() {
  const counts = {};
  const dir    = path.join(DATA_DIR, 'leads', 'qualified');

  if (!fs.existsSync(dir)) return counts;

  let files;
  try {
    files = fs.readdirSync(dir)
      .filter((f) => f.endsWith('.csv'))
      .map((f) => path.join(dir, f));
  } catch (_) { return counts; }

  for (const f of files) {
    try {
      const lines = fs.readFileSync(f, 'utf8').trim().split('\n');
      if (lines.length < 2) continue;
      const headers   = parseCsvLine(lines[0]);
      const statusIdx = headers.indexOf('status');
      if (statusIdx === -1) continue;
      for (let i = 1; i < lines.length; i++) {
        const cols   = parseCsvLine(lines[i]);
        const status = cols[statusIdx]?.trim();
        if (status) counts[status] = (counts[status] ?? 0) + 1;
      }
    } catch (_) { /* skip corrupt files */ }
  }
  return counts;
}

/** Minimal CSV line parser (handles quoted fields). */
function parseCsvLine(line) {
  const fields = [];
  let field    = '';
  let inQuote  = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuote) {
      if (ch === '"' && line[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"')                    inQuote = false;
      else                                    field  += ch;
    } else {
      if (ch === '"')  { inQuote = true; }
      else if (ch === ',') { fields.push(field); field = ''; }
      else                   field += ch;
    }
  }
  fields.push(field);
  return fields;
}

/**
 * Append a timestamped entry to data/tracker.md.
 * Best-effort — never throws.
 */
function logTrackerEntry(message) {
  try {
    const line     = `- ${new Date().toISOString()} | ${message}\n`;
    const filePath = path.join(DATA_DIR, 'tracker.md');
    fs.appendFileSync(filePath, line, 'utf8');
  } catch (_) { /* best effort */ }
}

/**
 * Prompt a y/N question on stdin.
 * Returns false immediately in non-TTY environments.
 */
async function confirm(question) {
  if (!process.stdin.isTTY) return false;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(/^y(es)?$/i.test(answer.trim()));
    });
  });
}

/**
 * Interactively prompt for a property address and key fields.
 * Used by "sc analyze" when no input file is available.
 * Returns null if the user skips the address.
 */
async function promptForProperty() {
  if (!process.stdin.isTTY) return null;
  const rl  = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q) => new Promise((res) => rl.question(q, res));
  try {
    console.log('  Enter property details (press Enter to skip optional fields):\n');
    const address  = await ask('  Address: ');
    if (!address.trim()) return null;

    const priceStr  = await ask('  Price £ (e.g. 1500000): ');
    const bedsStr   = await ask('  Bedrooms: ');
    const sqftStr   = await ask('  Sqft: ');
    const zoneStr   = await ask('  Market Zone (PCL / POL / EMERGING): ');
    const tenureStr = await ask('  Tenure (freehold / leasehold): ');
    const epcStr    = await ask('  EPC Rating (A–G): ');
    const domStr    = await ask('  Days on Market: ');

    return {
      address:      address.trim(),
      price:        parseIntArg(priceStr)  ?? undefined,
      beds:         parseIntArg(bedsStr)   ?? undefined,
      sqft:         parseIntArg(sqftStr)   ?? undefined,
      marketZone:   zoneStr.trim().toUpperCase()  || 'UNKNOWN',
      tenure:       tenureStr.trim().toLowerCase() || 'unknown',
      epcRating:    epcStr.trim().toUpperCase()   || undefined,
      daysOnMarket: parseIntArg(domStr)    ?? undefined,
    };
  } finally {
    rl.close();
  }
}

// ── Analysis output helper ────────────────────────────────────────────────────

function printAnalysisReport(report) {
  const top5 = (report.topDeals ?? []).slice(0, 5);
  console.log(`\n✅  Analysis complete — ${report.totalAnalyzed} propert${report.totalAnalyzed === 1 ? 'y' : 'ies'} scored`);
  if (top5.length) {
    console.log('\n   Top opportunities:\n');
    top5.forEach((d, i) => {
      const price = d.price ? `£${d.price.toLocaleString('en-GB')}` : 'no price';
      const rec   = (d.recommendation ?? '–').padEnd(7);
      const addr  = (d.address ?? 'N/A').slice(0, 45);
      console.log(`   ${i + 1}. [${d.score}/100] ${rec} ${addr} — ${price}`);
    });
  }
  const acquireCount = (report.allDeals ?? report.topDeals ?? []).filter((d) => d.recommendation === 'ACQUIRE').length;
  if (acquireCount > 0) {
    console.log(`\n   🟢  ${acquireCount} ACQUIRE recommendation${acquireCount > 1 ? 's' : ''}`);
  }
  console.log(`   → reports/\n`);
}

// ── Report builders ───────────────────────────────────────────────────────────

/**
 * Build a full pipeline report by reading data from disk.
 * Counts: listings, raw leads, qualified leads, investment memos, ACQUIRE count.
 */
function buildPipelineReport() {
  const rawFiles    = safeListFiles('raw');
  const leadFiles   = safeListFiles('leads/raw');
  const reportFiles = safeListFilesMd(REPORTS_DIR);
  const outputDirs  = safeListOutputDirs();

  // Qualified leads are stored as .csv — use the CSV-aware counter
  const qualCsv   = safeListFilesCsv('leads/qualified');

  const totalListings = rawFiles.reduce((n, f)  => n + (countRecords(f) ?? 0), 0);
  const totalLeads    = leadFiles.reduce((n, f) => n + (countRecords(f) ?? 0), 0);
  const totalQual     = qualCsv.records ?? 0;

  // Count memos and ACQUIRE recommendations from markdown files
  const memoFiles    = reportFiles.filter((f) => path.basename(f).startsWith('memo-'));
  const acquireCount = memoFiles.filter((f) => {
    try {
      // Only read the first 600 bytes — recommendation is always in the header
      const buf = Buffer.alloc(600);
      const fd  = fs.openSync(f, 'r');
      const n   = fs.readSync(fd, buf, 0, 600, 0);
      fs.closeSync(fd);
      return /\bACQUIRE\b/.test(buf.slice(0, n).toString('utf8'));
    } catch (_) { return false; }
  }).length;

  const statusCounts = countLeadStatuses();

  return {
    generatedAt:    new Date().toISOString(),
    listings: {
      files:        rawFiles.length,
      totalRecords: totalListings,
      latestFile:   rawFiles[0]  ? path.basename(rawFiles[0])  : null,
    },
    rawLeads: {
      files:        leadFiles.length,
      totalRecords: totalLeads,
      latestFile:   leadFiles[0] ? path.basename(leadFiles[0]) : null,
    },
    qualifiedLeads: {
      files:        qualCsv.files,
      totalRecords: totalQual,
      latestFile:   qualCsv.latest !== '(none)' ? qualCsv.latest : null,
    },
    leadStatus:     statusCounts,
    analysis: {
      memoCount:    memoFiles.length,
      acquireCount,
      latestMemo:   memoFiles[0] ? path.basename(memoFiles[0]) : null,
    },
    marketing: {
      outputDirs:   outputDirs.length,
    },
  };
}

function printReportText(r) {
  const line = (label, val) => console.log(`  ${label.padEnd(34)} ${val}`);
  console.log('\n📋  Square Centimeter — Pipeline Report');
  console.log(`    Generated: ${r.generatedAt}\n`);
  line('Properties scanned:',    `${r.listings.totalRecords} records across ${r.listings.files} file${r.listings.files === 1 ? '' : 's'}`);
  line('Latest scan file:',      r.listings.latestFile ?? '(none)');
  line('Leads found:',           `${r.rawLeads.totalRecords} leads across ${r.rawLeads.files} file${r.rawLeads.files === 1 ? '' : 's'}`);
  line('Qualified leads:',       `${r.qualifiedLeads.totalRecords}`);
  const statusSummaryStr = Object.entries(r.leadStatus)
    .sort((a, b) => b[1] - a[1])
    .map(([s, n]) => `${s}: ${n}`)
    .join('  |  ');
  if (statusSummaryStr) {
    line('  Status breakdown:',  statusSummaryStr);
  }
  line('Deals analysed:',        `${r.analysis.memoCount} investment memo${r.analysis.memoCount === 1 ? '' : 's'}`);
  line('ACQUIRE recommendations:', `${r.analysis.acquireCount}`);
  line('Marketing content sets:', `${r.marketing.outputDirs}`);
  console.log('');
}

function formatReportMarkdown(r) {
  const statusRows = Object.entries(r.leadStatus)
    .sort((a, b) => b[1] - a[1])
    .map(([s, n]) => `| ${s} | ${n} |`)
    .join('\n');

  return [
    '# Square Centimeter Ltd — Pipeline Report',
    `_Generated: ${r.generatedAt}_`,
    '',
    '## Property Pipeline',
    '',
    '| Stage | Files | Records | Latest |',
    '|-------|------:|--------:|--------|',
    `| Properties Scanned | ${r.listings.files} | ${r.listings.totalRecords} | ${r.listings.latestFile ?? '–'} |`,
    `| Raw Leads | ${r.rawLeads.files} | ${r.rawLeads.totalRecords} | ${r.rawLeads.latestFile ?? '–'} |`,
    `| Qualified Leads | ${r.qualifiedLeads.files} | ${r.qualifiedLeads.totalRecords} | ${r.qualifiedLeads.latestFile ?? '–'} |`,
    `| Investment Memos | ${r.analysis.memoCount} | – | ${r.analysis.latestMemo ?? '–'} |`,
    `| Marketing Content Sets | ${r.marketing.outputDirs} | – | – |`,
    '',
    `## Deal Recommendations`,
    '',
    `| Recommendation | Count |`,
    `|---|---|`,
    `| 🟢 ACQUIRE | **${r.analysis.acquireCount}** |`,
    `| 📄 Total memos | ${r.analysis.memoCount} |`,
    '',
    ...(statusRows ? [
      '## Lead Status Breakdown',
      '',
      '| Status | Count |',
      '|--------|------:|',
      statusRows,
      '',
    ] : []),
    '---',
    '_Prepared by SC Agent Team v1.0.0 | Square Centimeter Ltd | CONFIDENTIAL_',
    '',
  ].join('\n');
}

// ── Filesystem helpers ────────────────────────────────────────────────────────

/**
 * List CSV files in a data subdirectory and count their rows.
 * Used for data/leads/qualified/ and data/leads/contacted/ which store .csv
 * (not .json), so listFiles() doesn't find them.
 * @param {string} subdir  Relative to DATA_DIR
 * @returns {{ files: number, records: number|null, latest: string }}
 */
function safeListFilesCsv(subdir) {
  try {
    const dir = path.join(DATA_DIR, subdir);
    if (!fs.existsSync(dir)) return { files: 0, records: null, latest: '(none)' };

    const sorted = fs.readdirSync(dir)
      .filter((f) => f.endsWith('.csv'))
      .sort((a, b) => {
        try {
          return fs.statSync(path.join(dir, b)).mtimeMs - fs.statSync(path.join(dir, a)).mtimeMs;
        } catch (_) { return 0; }
      });

    if (!sorted.length) return { files: 0, records: null, latest: '(none)' };

    // Count data rows (non-header lines) across all CSV files
    let totalRows = 0;
    for (const f of sorted) {
      try {
        const lines = fs.readFileSync(path.join(dir, f), 'utf8').trim().split('\n');
        totalRows += Math.max(0, lines.length - 1);   // subtract header row
      } catch (_) { /* skip corrupt */ }
    }

    return { files: sorted.length, records: totalRows, latest: sorted[0] };
  } catch (_) {
    return { files: 0, records: null, latest: '(none)' };
  }
}

/** List .md files in an absolute directory path, newest first. */
function safeListFilesMd(absDir) {
  try {
    if (!fs.existsSync(absDir)) return [];
    return fs.readdirSync(absDir)
      .filter((f) => f.endsWith('.md'))
      .map((f)    => path.join(absDir, f))
      .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  } catch (_) { return []; }
}

/** List marketing output subdirs in outputs/ (project root). */
function safeListOutputDirs() {
  try {
    if (!fs.existsSync(OUTPUTS_DIR)) return [];
    return fs.readdirSync(OUTPUTS_DIR)
      .filter((d) => fs.statSync(path.join(OUTPUTS_DIR, d)).isDirectory())
      .filter((d) => d.startsWith('marketing-'));
  } catch (_) { return []; }
}
