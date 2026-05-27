'use strict';

jest.mock('child_process', () => ({
  execFileSync: jest.fn(),
}));
jest.mock('fs');

const MOCK_PUSH_LOG = {
  'a@a.com': { status: 'pushed_to_cm2',  pushedAt:   '2026-01-01T00:00:00Z' },
  'b@b.com': { status: 'push_failed',    error:      'HTTP 500' },
  'c@c.com': { status: 'replied_in_cm2', repliedAt:  '2026-01-02T00:00:00Z' },
};

/** Minimal fs mock setup shared across tests */
function setupFsMocks(fs, { pushLogExists = false, pushLogData = {} } = {}) {
  fs.existsSync.mockImplementation(p => {
    if (String(p).endsWith('cm2-push-log.json')) return pushLogExists;
    if (String(p).endsWith('scan-history.tsv')) return false;
    return false;
  });
  fs.readFileSync.mockImplementation(p => {
    if (String(p).endsWith('cm2-push-log.json')) return JSON.stringify(pushLogData);
    if (String(p).endsWith('scan-history.tsv')) return 'timestamp\tportals\tcount\n';
    return '';
  });
  fs.readdirSync.mockImplementation(() => []);
  fs.mkdirSync.mockImplementation(() => {});
  fs.appendFileSync.mockImplementation(() => {});
  fs.writeFileSync.mockImplementation(() => {});
  fs.statSync.mockImplementation(() => ({ isDirectory: () => false }));
}

beforeEach(() => {
  jest.clearAllMocks();
  // Reset module registry so leadPump and its deps are freshly required each test
  jest.resetModules();
});

/* ── Test 1: Pipeline runs all 6 steps in order ───────────────────────────── */

describe('leadPump.run() — pipeline steps', () => {
  test('runs all 6 steps and calls execFileSync 6 times', async () => {
    // Re-require mocks AFTER resetModules so we get the fresh instances
    const fs = require('fs');
    const { execFileSync } = require('child_process');
    setupFsMocks(fs);
    execFileSync.mockImplementation(() => Buffer.from(''));

    const pump = require('../utils/leadPump');
    await pump.run();

    expect(execFileSync).toHaveBeenCalledTimes(6);

    // Verify step order by checking the first argument of each call
    const calls = execFileSync.mock.calls;

    // All calls use 'node' as the executable
    calls.forEach(c => expect(c[0]).toBe('node'));

    // Step 1: scan
    expect(calls[0][1]).toEqual(['index.js', 'scan']);
    // Step 2: leads hmlr_uk_wide
    expect(calls[1][1]).toEqual(['index.js', 'leads', '--source', 'hmlr_uk_wide']);
    // Step 3: enrich
    expect(calls[2][1]).toEqual(['index.js', 'enrich']);
    // Step 4: cm2Bridge push
    expect(calls[3][1]).toEqual(['utils/cm2Bridge.js', 'push']);
    // Step 5: cm2Bridge sync
    expect(calls[4][1]).toEqual(['utils/cm2Bridge.js', 'sync']);
    // Step 6: cm2Bridge whatsapp
    expect(calls[5][1]).toEqual(['utils/cm2Bridge.js', 'whatsapp']);
  });
});

/* ── Test 2: Summary output contains required fields ──────────────────────── */

describe('leadPump.run() — summary output', () => {
  test('logs summary lines containing Pushed to CM2, Failed, and Replies', async () => {
    const fs = require('fs');
    const { execFileSync } = require('child_process');
    setupFsMocks(fs, { pushLogExists: true, pushLogData: MOCK_PUSH_LOG });
    execFileSync.mockImplementation(() => Buffer.from(''));

    const pump = require('../utils/leadPump');
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

    try {
      await pump.run();
    } finally {
      // intentionally left empty — restore after capturing output below
    }

    const allOutput = logSpy.mock.calls.map(c => c.join(' ')).join('\n');
    logSpy.mockRestore();

    expect(allOutput).toMatch(/Pushed to CM2/i);
    expect(allOutput).toMatch(/Failed/i);
    expect(allOutput).toMatch(/Replies/i);
  });
});

/* ── Test 3: Tracker.md is written after each step ───────────────────────── */

describe('leadPump.run() — tracker updates', () => {
  test('appends to tracker.md at least 6 times (once per step)', async () => {
    const fs = require('fs');
    const { execFileSync } = require('child_process');
    setupFsMocks(fs);
    execFileSync.mockImplementation(() => Buffer.from(''));

    const pump = require('../utils/leadPump');
    await pump.run();

    // appendFileSync is called for each step completion + the final summary line
    const trackerCalls = fs.appendFileSync.mock.calls.filter(c =>
      String(c[0]).endsWith('tracker.md')
    );
    expect(trackerCalls.length).toBeGreaterThanOrEqual(6);
  });
});

/* ── Test 4: Failed step does not stop the pipeline ──────────────────────── */

describe('leadPump.run() — error resilience', () => {
  test('continues running remaining steps when step 3 (enrich) throws', async () => {
    const fs = require('fs');
    const { execFileSync } = require('child_process');
    setupFsMocks(fs);

    let callCount = 0;
    execFileSync.mockImplementation(() => {
      callCount++;
      if (callCount === 3) {
        throw new Error('enrich failed: exit code 1');
      }
      return Buffer.from('');
    });

    const pump = require('../utils/leadPump');
    // Should resolve without throwing even though step 3 fails
    await expect(pump.run()).resolves.toBeUndefined();

    // All 6 steps attempted despite step 3 throwing
    expect(execFileSync).toHaveBeenCalledTimes(6);
  });
});
