'use strict';
// Set env before module loads
process.env.CM2_RETRY_DELAY_MS = '0';
process.env.CM2_BASE_URL = 'https://test.cm2.com';
process.env.CM2_PUSH_SCORE_MIN = '5.0';
process.env.CM2_REQUEST_TIMEOUT = '100';

jest.mock('fs');
const fs = require('fs');
const { mapLeadToCM2, commandPush, commandSync } = require('../utils/cm2Bridge');

/* ── Helpers ──────────────────────────────────────────────────────────────── */

const LEAD_CSV = 'name,email,lead_score,transactionId\nAli Hassan,ali@example.com,7.0,TX-001\n';

function setupFsMocks({ pushLog = {}, hasPushLog = false, qualCSV = LEAD_CSV }) {
  fs.existsSync.mockImplementation(p => {
    if (String(p).endsWith('cm2-push-log.json')) return hasPushLog;
    return true;
  });
  fs.readdirSync.mockImplementation(p => {
    if (String(p).includes('qualified')) return qualCSV ? ['leads.csv'] : [];
    return [];
  });
  fs.readFileSync.mockImplementation(p => {
    if (String(p).endsWith('cm2-push-log.json')) return JSON.stringify(pushLog);
    if (String(p).endsWith('.csv')) return qualCSV;
    return '';
  });
  fs.writeFileSync.mockImplementation(() => {});
  fs.appendFileSync.mockImplementation(() => {});
  fs.mkdirSync.mockImplementation(() => {});
}

/* ── Test 1: mapLeadToCM2 field mapping ───────────────────────────────────── */

describe('mapLeadToCM2 — field mapping', () => {
  test('maps SC lead fields to CM2 schema correctly', () => {
    const result = mapLeadToCM2({
      name: 'Ali Hassan',
      email: 'ali@example.com',
      phone: '+971501234567',
      nationality: 'UAE',
      budget_range: '2m-5m',
      motivation_reason: 'yield',
      property_interest: 'London',
    });
    expect(result.name).toBe('Ali Hassan');
    expect(result.email).toBe('ali@example.com');
    expect(result.whatsapp).toBe('+971501234567');
    expect(result.country).toBe('UAE');
    expect(result.source).toBe('sc-agent-pipeline');
    expect(result.investorType).toBe('Investor');
  });
});

/* ── Test 2: budget range resolution ──────────────────────────────────────── */

describe('mapLeadToCM2 — budget range resolution', () => {
  const cases = [
    ['500k-1m',  '£500k–£1M'],
    ['1m-2m',    '£1M–£3M'],
    ['2m-5m',    '£1M–£3M'],
    ['5m+',      '£3M+'],
    ['3000000',  '£3M+'],
  ];

  test.each(cases)('budget_range %s → investmentBudget %s', (input, expected) => {
    const result = mapLeadToCM2({ budget_range: input });
    expect(result.investmentBudget).toBe(expected);
  });
});

/* ── Test 3: mandateInterest mapping ──────────────────────────────────────── */

describe('mapLeadToCM2 — mandateInterest mapping', () => {
  const cases = [
    ['sdlt',        'SDLT for Non-Residents'],
    ['golden_visa', 'UAE Golden Visa'],
    ['yield',       'London Entry & Yield'],
    ['heritage',    'London Heritage & Trophy'],
    ['unrelated',   null],
  ];

  test.each(cases)('motivation_reason %s → mandateInterest %s', (motivation, expected) => {
    const result = mapLeadToCM2({ motivation_reason: motivation });
    expect(result.mandateInterest).toBe(expected);
  });
});

/* ── Test 4: commandPush — duplicate skip ─────────────────────────────────── */

describe('commandPush — duplicate skip', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    global.fetch = jest.fn();
    jest.useFakeTimers();
  });
  afterEach(() => jest.useRealTimers());

  test('skips lead already in push log as pushed_to_cm2', async () => {
    const pushLog = {
      'ali@example.com': { status: 'pushed_to_cm2', pushedAt: '2026-01-01T00:00:00Z' },
    };
    setupFsMocks({ pushLog, hasPushLog: true });
    const p = commandPush();
    await jest.runAllTimersAsync();
    await p;
    expect(global.fetch).not.toHaveBeenCalled();
  });
});

/* ── Test 5: commandPush — push_failed retry logic ────────────────────────── */

describe('commandPush — push_failed retry logic', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    global.fetch = jest.fn();
    jest.useFakeTimers();
  });
  afterEach(() => jest.useRealTimers());

  test('retries once after initial push failure', async () => {
    setupFsMocks({ pushLog: {}, hasPushLog: false });
    global.fetch
      .mockRejectedValueOnce(new Error('network error'))
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ result: { data: { json: { id: 'cm2-001' } } } }),
      });
    const p = commandPush();
    await jest.runAllTimersAsync();
    await p;
    // 2 push attempts + 1 WIRE 1 investment model trigger (fired immediately since delay=0)
    expect(global.fetch).toHaveBeenCalledTimes(3);
  });
});

/* ── Test 6: commandSync — reply detection ────────────────────────────────── */

describe('commandSync — reply detection', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    global.fetch = jest.fn();
    jest.useFakeTimers();
  });
  afterEach(() => jest.useRealTimers());

  test('detects genuine reply and updates push log to replied_in_cm2', async () => {
    const pushLog = {
      'ali@example.com': {
        status: 'pushed_to_cm2',
        pushedAt: '2026-01-01T00:00:00Z',
        leadName: 'Ali Hassan',
      },
    };
    setupFsMocks({ pushLog, hasPushLog: true });
    global.fetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        result: {
          data: {
            json: {
              genuineReply: true,
              repliedAt: '2026-02-01T10:00:00Z',
              replyContent: 'Interested',
            },
          },
        },
      }),
    });
    const p = commandSync();
    await jest.runAllTimersAsync();
    await p;
    // 1 getLeadStatus call + 1 WIRE 3c Manus notify call
    expect(global.fetch).toHaveBeenCalledTimes(2);
    const savedArg = fs.writeFileSync.mock.calls.find(
      c => c[0]?.toString().endsWith('cm2-push-log.json')
    )?.[1];
    expect(savedArg).toContain('replied_in_cm2');
  });
});
