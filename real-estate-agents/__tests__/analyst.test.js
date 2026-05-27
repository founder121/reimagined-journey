'use strict';
/**
 * Unit tests for agent3-analyst.js
 * Uses the sample properties fixture — no real HTTP calls needed.
 */
const path = require('path');
const analyst = require('../agents/agent3-analyst');

// Prevent actual file writes during tests
// Note: jest.mock factory cannot reference outer-scope variables; use require() inline.
jest.mock('../utils/fileStore', () => ({
  writeData: jest.fn(() => '/tmp/mock-report.json'),
  listFiles: jest.fn(() => [
    require('path').resolve(
      __dirname,
      '../data/properties/sample-zillow-TX-2024-01-15.json',
    ),
  ]),
}));

describe('agent3-analyst', () => {
  test('runs buy-hold analysis without error', async () => {
    const report = await analyst.run({
      input: path.resolve(
        __dirname,
        '../data/properties/sample-zillow-TX-2024-01-15.json',
      ),
      strategy: 'buy-hold',
    });

    expect(report).toBeDefined();
    expect(report.strategy).toBe('buy-hold');
    expect(report.totalAnalyzed).toBe(3);
    expect(Array.isArray(report.topDeals)).toBe(true);
  });

  test('runs flip analysis without error', async () => {
    const report = await analyst.run({
      input: path.resolve(
        __dirname,
        '../data/properties/sample-zillow-TX-2024-01-15.json',
      ),
      strategy: 'flip',
    });
    expect(report.strategy).toBe('flip');
    expect(report.topDeals.length).toBeGreaterThan(0);
    // Every deal should have an mao field
    for (const deal of report.topDeals) {
      expect('mao' in deal).toBe(true);
    }
  });

  test('deals are sorted by score descending', async () => {
    const report = await analyst.run({
      input: path.resolve(
        __dirname,
        '../data/properties/sample-zillow-TX-2024-01-15.json',
      ),
      strategy: 'wholesale',
    });
    const scores = report.allDeals.map((d) => d.score);
    for (let i = 1; i < scores.length; i++) {
      expect(scores[i - 1]).toBeGreaterThanOrEqual(scores[i]);
    }
  });

  test('throws on unknown strategy', async () => {
    await expect(
      analyst.run({
        input: path.resolve(
          __dirname,
          '../data/properties/sample-zillow-TX-2024-01-15.json',
        ),
        strategy: 'not-a-strategy',
      }),
    ).rejects.toThrow('Unknown strategy');
  });
});
