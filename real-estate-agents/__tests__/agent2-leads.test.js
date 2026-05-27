'use strict';
/**
 * Unit tests for agent2-leads.js (Investor Lead Finder)
 * HTTP and file system are mocked.
 */

jest.mock('axios');
jest.mock('../utils/fileStore', () => ({
  writeData:  jest.fn(() => '/tmp/mock-leads.json'),
  listFiles:  jest.fn(() => []),
  DATA_DIR:   '/tmp/mock-data',
}));
jest.mock('child_process', () => ({
  execSync: jest.fn(() => Buffer.from('<html><body></body></html>'))
}));
// RobotsChecker uses axios — mock it so it never interferes with HTTP mocks
jest.mock('../utils/robotsChecker', () =>
  jest.fn().mockImplementation(() => ({
    isAllowed: jest.fn().mockResolvedValue(true),
  }))
);
jest.mock('fs', () => {
  const real = jest.requireActual('fs');
  return {
    ...real,
    appendFileSync: jest.fn(),
    existsSync:     jest.fn(() => false),
    mkdirSync:      jest.fn(),
    writeFileSync:  jest.fn(),
    renameSync:     jest.fn(),
    readFileSync:   (filePath, ...args) => {
      // Allow YAML config files to be read normally
      if (filePath.includes('lead-sources.yml')) {
        return real.readFileSync(filePath, ...args);
      }
      throw new Error(`Unexpected readFileSync: ${filePath}`);
    },
  };
});

const finder = require('../agents/agent2-leads');

describe('agent2-leads — listSources()', () => {
  test('returns all configured sources', () => {
    const sources = finder.listSources();
    expect(Array.isArray(sources)).toBe(true);
    expect(sources.length).toBeGreaterThan(0);
    for (const s of sources) {
      expect(s).toHaveProperty('key');
      expect(s).toHaveProperty('type');
      expect(s).toHaveProperty('enabled');
    }
  });

  test('enabledOnly=true filters disabled sources', () => {
    const all     = finder.listSources(false);
    const enabled = finder.listSources(true);
    expect(enabled.length).toBeLessThanOrEqual(all.length);
    expect(enabled.every((s) => s.enabled)).toBe(true);
  });
});

describe('agent2-leads — run() dry-run', () => {
  test('dry-run for a known source returns [] without HTTP calls', async () => {
    const axios = require('axios');
    const leads = await finder.run({ source: 'land_registry_price_paid', dryRun: true });
    expect(leads).toEqual([]);
    expect(axios.get).not.toHaveBeenCalled();
  });

  test('dry-run throws for unknown source', async () => {
    await expect(
      finder.run({ source: 'nonexistent_source', dryRun: true })
    ).rejects.toThrow('Unknown source/type');
  });
});

describe('agent2-leads — lead scoring', () => {
  const axios = require('axios');

  // Return unique transaction IDs on each call so deduplication doesn't
  // collapse all postcodes onto the same two records.
  let callIndex = 0;
  beforeEach(() => {
    callIndex = 0;
    axios.get.mockImplementation(() => {
      const idx = callIndex++;
      return Promise.resolve({
        status: 200,
        data: {
          result: {
            items: [
              {
                transactionId:  { value: `TX-${idx}-A` },
                pricePaid:      { value: 1850000 },
                dateOfTransfer: { value: '2024-11-15' },
                postcode:       { value: 'SW3 4RT' },
                propertyType:   { value: 'F' },
                newBuild:       { value: 'N' },
                estateType:     { value: 'L' },
                ppdCategory:    { value: 'A' },
                paon:           { value: `Flat ${idx}` },
                street:         { value: 'Milner Street' },
                town:           { value: 'London' },
              },
              {
                transactionId:  { value: `TX-${idx}-B` },
                pricePaid:      { value: 6500000 },
                dateOfTransfer: { value: '2024-10-20' },
                postcode:       { value: 'W1K 3JH' },
                propertyType:   { value: 'D' },
                newBuild:       { value: 'N' },
                estateType:     { value: 'F' },
                ppdCategory:    { value: 'A' },
                paon:           { value: String(10 + idx) },
                street:         { value: 'South Audley Street' },
                town:           { value: 'London' },
              },
            ],
          },
        },
      });
    });
  });

  afterEach(() => jest.clearAllMocks());

  test('lead_score is between 1 and 10', async () => {
    const leads = await finder.run({ source: 'land_registry_price_paid', limit: 10 });
    for (const lead of leads) {
      expect(lead.lead_score).toBeGreaterThanOrEqual(1);
      expect(lead.lead_score).toBeLessThanOrEqual(10);
    }
  });

  test('high-budget transaction scores higher on capacity', async () => {
    const leads = await finder.run({ source: 'land_registry_price_paid', limit: 4 });
    // Each outcode call returns one £1.85m and one £6.5m record.
    // Find a representative pair to compare.
    const lowBudget  = leads.find((l) => l.price === 1_850_000);
    const highBudget = leads.find((l) => l.price === 6_500_000);
    expect(lowBudget).toBeDefined();
    expect(highBudget).toBeDefined();
    expect(highBudget.score_capacity).toBeGreaterThan(lowBudget.score_capacity);
    expect(highBudget.lead_score).toBeGreaterThanOrEqual(lowBudget.lead_score);
  });

  test('all leads have required CLAUDE.md CSV columns', async () => {
    const leads = await finder.run({ source: 'land_registry_price_paid', limit: 10 });
    const required = [
      'name', 'company', 'nationality', 'property_interest', 'budget_range',
      'contact_email', 'contact_phone', 'linkedin_url', 'motivation',
      'lead_score', 'source_url', 'date_found', 'status',
    ];
    for (const lead of leads) {
      for (const col of required) {
        expect(lead).toHaveProperty(col);
      }
    }
  });

  test('status is always a valid lifecycle value', async () => {
    const leads = await finder.run({ source: 'land_registry_price_paid', limit: 10 });
    const valid  = ['new', 'contacted', 'responded', 'meeting_booked', 'converted', 'dead'];
    for (const lead of leads) {
      expect(valid).toContain(lead.status);
    }
  });
});
