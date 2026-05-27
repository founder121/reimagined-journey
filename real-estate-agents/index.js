#!/usr/bin/env node
'use strict';
/**
 * index.js — Real Estate AI Agent Team CLI
 * ─────────────────────────────────────────
 * Routes /realestate slash-commands to the appropriate agent module.
 *
 * Usage:
 *   node index.js <command> [args]
 *   node index.js --help
 *
 * Commands:
 *   crawl   <portal>  [--state ST] [--pages N]
 *   leads   <source>  [--state ST] [--limit N]
 *   analyze           [--input FILE] [--strategy buy-hold|flip|wholesale]
 *   market  <campaign>[--channel email|sms|both] [--leads FILE]
 *   sales             [--leads FILE] [--script cold-call|follow-up|offer] [--crm TYPE]
 *   status
 *   pipeline          [--state ST] [--portal PORTAL] [--limit N]
 */

const { program } = require('commander');
const path = require('path');
const createLogger = require('./utils/logger');
const { statusSummary } = require('./utils/fileStore');

const log = createLogger('index');

// ── Agent imports ─────────────────────────────────────────────────────────────
const crawler   = require('./agents/agent1-crawler');
const leads     = require('./agents/agent2-leads');
const analyst   = require('./agents/agent3-analyst');
const marketing = require('./agents/agent4-marketing');
const sales     = require('./agents/agent5-sales');

// ── CLI definition ────────────────────────────────────────────────────────────

program
  .name('realestate')
  .description('Real Estate AI Agent Team — multi-agent investment pipeline')
  .version('1.0.0');

// ── crawl ─────────────────────────────────────────────────────────────────────
program
  .command('crawl <portal>')
  .description('Crawl a real estate portal for property listings')
  .option('-s, --state <state>', 'US state abbreviation', 'TX')
  .option('-p, --pages <n>', 'max pages to crawl', parseInt)
  .action(async (portal, opts) => {
    try {
      const records = await crawler.run({ portal, state: opts.state, pages: opts.pages });
      console.log(`\n✅ Crawled ${records.length} properties from "${portal}" (${opts.state})`);
    } catch (err) {
      log.error(err.message);
      process.exit(1);
    }
  });

// ── leads ─────────────────────────────────────────────────────────────────────
program
  .command('leads <source>')
  .description('Harvest motivated-seller or buyer leads from a public source')
  .option('-s, --state <state>', 'US state abbreviation', 'TX')
  .option('--city <city>', 'city slug (for Craigslist-style sources)')
  .option('-l, --limit <n>', 'max records', parseInt)
  .option('--type <type>', 'lead type filter (fsbo|expired|preforeclosure|probate|cashbuyer|landlord)')
  .action(async (source, opts) => {
    try {
      // Allow passing a type name instead of a source key
      const resolvedSource = opts.type || source;
      const records = await leads.run({
        source: resolvedSource,
        state: opts.state,
        city: opts.city,
        limit: opts.limit,
      });
      console.log(`\n✅ Found ${records.length} leads from "${resolvedSource}" (${opts.state})`);
    } catch (err) {
      log.error(err.message);
      process.exit(1);
    }
  });

// ── analyze ───────────────────────────────────────────────────────────────────
program
  .command('analyze')
  .description('Run investment analysis on crawled properties')
  .option('-i, --input <file>', 'properties JSON file (uses latest if omitted)')
  .option('-s, --strategy <strategy>', 'buy-hold | flip | wholesale', 'buy-hold')
  .option('-n, --narratives', 'add LLM deal narratives (requires ANTHROPIC_API_KEY)')
  .action(async (opts) => {
    try {
      const report = await analyst.run({
        input: opts.input,
        strategy: opts.strategy,
        narratives: opts.narratives,
      });
      const top5 = report.topDeals.slice(0, 5);
      console.log(`\n✅ Analyzed ${report.totalAnalyzed} properties | strategy: ${report.strategy}`);
      console.log('\nTop 5 deals:');
      top5.forEach((d, i) =>
        console.log(`  ${i + 1}. [${d.score}/100] ${d.address || 'N/A'} — ${d.rawPrice || 'no price'}`),
      );
    } catch (err) {
      log.error(err.message);
      process.exit(1);
    }
  });

// ── market ────────────────────────────────────────────────────────────────────
program
  .command('market <campaign>')
  .description('Draft personalised outreach campaigns for leads')
  .option('-c, --channel <channel>', 'email | sms | both', 'email')
  .option('-l, --leads <file>', 'leads JSON file (uses latest if omitted)')
  .option('--limit <n>', 'max leads to draft for', parseInt)
  .action(async (campaign, opts) => {
    try {
      const drafts = await marketing.run({
        campaign,
        channel: opts.channel,
        leadsFile: opts.leads,
        limit: opts.limit,
      });
      console.log(`\n✅ Drafted ${drafts.length} messages | campaign: ${campaign} | channel: ${opts.channel}`);
    } catch (err) {
      log.error(err.message);
      process.exit(1);
    }
  });

// ── sales ─────────────────────────────────────────────────────────────────────
program
  .command('sales')
  .description('Generate call scripts and CRM notes for leads')
  .option('-l, --leads <file>', 'leads JSON file (uses latest if omitted)')
  .option('-s, --script <type>', 'cold-call | follow-up | offer', 'cold-call')
  .option('--crm <format>', 'hubspot | podio | generic', 'generic')
  .option('--limit <n>', 'max leads to process', parseInt)
  .action(async (opts) => {
    try {
      const results = await sales.run({
        leadsFile: opts.leads,
        script: opts.script,
        crm: opts.crm,
        limit: opts.limit,
      });
      console.log(`\n✅ Generated ${results.length} scripts | type: ${opts.script} | crm: ${opts.crm}`);
    } catch (err) {
      log.error(err.message);
      process.exit(1);
    }
  });

// ── status ────────────────────────────────────────────────────────────────────
program
  .command('status')
  .description('Print a summary of all data files and recent agent runs')
  .action(() => {
    const summary = statusSummary();
    console.log('\n📊 Real Estate Agent Team — Data Status\n');
    console.log('  Directory         Files   Latest file');
    console.log('  ─────────────── ─────── ─────────────────────────────────');
    for (const [dir, info] of Object.entries(summary)) {
      const files = String(info.files).padStart(7);
      const latest = info.latestFile || '(none)';
      console.log(`  ${dir.padEnd(16)} ${files}   ${latest}`);
    }
    console.log('');
  });

// ── pipeline ──────────────────────────────────────────────────────────────────
program
  .command('pipeline')
  .description('Run the full end-to-end pipeline: crawl → leads → analyze → market → sales')
  .option('-s, --state <state>', 'US state abbreviation', 'TX')
  .option('-P, --portal <portal>', 'portal to crawl', 'zillow')
  .option('--lead-source <source>', 'lead source key', 'fsbo_zillow')
  .option('-n, --limit <n>', 'max records per stage', parseInt)
  .option('--strategy <strategy>', 'analysis strategy', 'buy-hold')
  .option('--campaign <campaign>', 'marketing campaign', 'motivated-sellers')
  .option('--channel <channel>', 'marketing channel', 'email')
  .action(async (opts) => {
    console.log('\n🚀 Starting full pipeline…\n');

    try {
      // Stage 1: Crawl
      console.log('Stage 1/5 — Crawling properties…');
      const properties = await crawler.run({
        portal: opts.portal,
        state: opts.state,
        pages: opts.limit ? Math.ceil(opts.limit / 20) : 3,
      });
      console.log(`  ✓ ${properties.length} properties crawled\n`);

      // Stage 2: Leads
      console.log('Stage 2/5 — Finding leads…');
      const leadRecords = await leads.run({
        source: opts.leadSource,
        state: opts.state,
        limit: opts.limit,
      });
      console.log(`  ✓ ${leadRecords.length} leads found\n`);

      // Stage 3: Analyze
      console.log('Stage 3/5 — Analyzing deals…');
      const report = await analyst.run({ strategy: opts.strategy });
      console.log(`  ✓ ${report.totalAnalyzed} properties analyzed | top score: ${report.topDeals[0]?.score ?? 'N/A'}\n`);

      // Stage 4: Marketing drafts
      console.log('Stage 4/5 — Drafting marketing messages…');
      const drafts = await marketing.run({
        campaign: opts.campaign,
        channel: opts.channel,
        limit: opts.limit || 50,
      });
      console.log(`  ✓ ${drafts.length} messages drafted\n`);

      // Stage 5: Sales scripts
      console.log('Stage 5/5 — Generating sales scripts…');
      const scripts = await sales.run({
        script: 'cold-call',
        limit: opts.limit || 25,
      });
      console.log(`  ✓ ${scripts.length} scripts generated\n`);

      console.log('✅ Pipeline complete! Run "status" to see all output files.');
    } catch (err) {
      log.error(`Pipeline failed: ${err.message}`);
      process.exit(1);
    }
  });

// ── Parse ─────────────────────────────────────────────────────────────────────
program.parse(process.argv);

// Show help if no command given
if (process.argv.length < 3) {
  program.help();
}
