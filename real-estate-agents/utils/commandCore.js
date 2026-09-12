'use strict';
/**
 * utils/commandCore.js
 * Square Centimeter Ltd — Command Core
 *
 * Orchestrates the full SC pipeline in two steps:
 *  1. leadPump    — run all pipeline stages
 *  2. julianBriefing — generate and (optionally) send the daily briefing email
 *
 * Usage:
 *   node utils/commandCore.js
 */

async function run() {
  console.log('\n══════════════════════════════════════════════════════════');
  console.log('  CM² COMMAND CORE — Square Centimeter Ltd');
  console.log(`  ${new Date().toISOString()}`);
  console.log('══════════════════════════════════════════════════════════\n');

  // Step 1: Lead Pump
  console.log('[ 1/2 ] Running Lead Pump…');
  const pump = require('./leadPump');
  await pump.run();

  // Step 2: Julian Briefing
  console.log('\n[ 2/2 ] Generating Julian briefing…');
  const briefing = require('./julianBriefing');
  await briefing.run();

  console.log('\n══════════════════════════════════════════════════════════');
  console.log('  COMMAND CORE COMPLETE');
  console.log('══════════════════════════════════════════════════════════\n');
}

/* ── Exports ───────────────────────────────────────────────────────────── */

module.exports = { run };

/* ── CLI entry point ───────────────────────────────────────────────────── */

if (require.main === module) {
  run().catch(err => {
    console.error('[CommandCore] Fatal:', err.message);
    process.exit(1);
  });
}
