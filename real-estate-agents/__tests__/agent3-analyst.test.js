'use strict';
/**
 * Unit tests for agent3-analyst.js (Investment Analyst — Square Centimeter Ltd)
 * All tests are pure in-memory — no network, no file I/O.
 * writeMemo: false prevents any fs.writeFileSync / fs.renameSync calls.
 */

jest.mock('../utils/fileStore', () => ({
  writeData: jest.fn(() => '/tmp/mock-report.json'),
  listFiles:  jest.fn(() => []),
  DATA_DIR:  '/tmp/mock-data',
}));

const analyst = require('../agents/agent3-analyst');
const { analyzeProperty, computeSdlt } = analyst;

// ── Fixture properties ────────────────────────────────────────────────────────

/** Well-priced 2-bed PCL flat — should score ACQUIRE. */
const PCL_FLAT = {
  address:             'Flat 12, 45 Eaton Square, London SW1W 9BN',
  postcode:            'SW1W 9BN',
  portal:              'rightmove',
  listingUrl:          'https://www.rightmove.co.uk/property/12345678',
  price:               1_450_000,
  beds:                2,
  sqft:                950,
  tenure:              'leasehold',
  leaseYearsRemaining: 120,
  serviceCharge:       8_400,
  groundRent:          250,
  marketZone:          'PCL',
  flags:               ['pcl'],
  epcRating:           'C',
  daysOnMarket:        45,
  capturedAt:          '2026-05-27T10:00:00.000Z',
};

/** Same flat with critically short lease — should trigger flag + warning. */
const SHORT_LEASE_FLAT = {
  ...PCL_FLAT,
  address:             'Flat 3, 10 Cadogan Place, London SW1X 9RX',
  leaseYearsRemaining: 72,   // < 85 — critical threshold
  serviceCharge:       12_000,
  flags:               ['pcl'],
};

/** POL freehold house — higher yield than PCL flat, different zone. */
const POL_HOUSE = {
  address:             '22 Elspeth Road, London SW11 3AE',
  postcode:            'SW11 3AE',
  portal:              'rightmove',
  listingUrl:          'https://www.rightmove.co.uk/property/87654321',
  price:               2_100_000,
  beds:                4,
  sqft:                2_400,
  tenure:              'freehold',
  leaseYearsRemaining: null,
  serviceCharge:       0,
  groundRent:          0,
  marketZone:          'POL',
  flags:               ['pol'],
  epcRating:           'D',
  daysOnMarket:        91,
  capturedAt:          '2026-05-27T10:00:00.000Z',
};

// ── Test suite ────────────────────────────────────────────────────────────────

describe('agent3-analyst — analyzeProperty()', () => {
  test('well-priced PCL flat scores ACQUIRE with all dimensions within bounds', () => {
    const deal = analyzeProperty(PCL_FLAT);

    // Top-line recommendation
    expect(deal.score).toBeGreaterThanOrEqual(65);
    expect(deal.recommendation).toBe('ACQUIRE');

    // Each dimension within its declared maximum
    expect(deal.scores.capitalValue).toBeGreaterThanOrEqual(0);
    expect(deal.scores.capitalValue).toBeLessThanOrEqual(25);

    expect(deal.scores.rentalYield).toBeGreaterThanOrEqual(0);
    expect(deal.scores.rentalYield).toBeLessThanOrEqual(25);

    expect(deal.scores.neighbourhoodQuality).toBeGreaterThanOrEqual(0);
    expect(deal.scores.neighbourhoodQuality).toBeLessThanOrEqual(20);

    expect(deal.scores.investmentUpside).toBeGreaterThanOrEqual(0);
    expect(deal.scores.investmentUpside).toBeLessThanOrEqual(15);

    expect(deal.scores.marketConditions).toBeGreaterThanOrEqual(0);
    expect(deal.scores.marketConditions).toBeLessThanOrEqual(15);

    // Dimension sum equals total score
    const dimSum = Object.values(deal.scores).reduce((a, b) => a + b, 0);
    expect(deal.score).toBe(dimSum);
  });

  test('short lease < 85 years triggers flag, warning, and reduced neighbourhood score', () => {
    const shortLease = analyzeProperty(SHORT_LEASE_FLAT);
    const fullLease  = analyzeProperty(PCL_FLAT);

    // Flag set automatically
    expect(shortLease.flags).toContain('short_lease');

    // Warning references the actual years remaining
    const leaseWarning = shortLease.warnings.find((w) => w.includes('72'));
    expect(leaseWarning).toBeDefined();

    // Short lease penalty reduces neighbourhood quality score
    expect(shortLease.scores.neighbourhoodQuality).toBeLessThan(
      fullLease.scores.neighbourhoodQuality,
    );

    // Short lease penalty also reduces investment upside score
    expect(shortLease.scores.investmentUpside).toBeLessThan(
      fullLease.scores.investmentUpside,
    );
  });

  test('all required financial fields are present and non-null for a priced property', () => {
    const deal = analyzeProperty(PCL_FLAT);

    const required = [
      'sdlt',
      'legalFees',
      'totalAcquisitionCost',
      'estimatedMonthlyRent',
      'estimatedAnnualRent',
      'grossYieldPct',
      'netYieldPct',
      'cashOnCashRoiPct',
      'fiveYearProjectedValue',
      'fiveYearGainPct',
      'fiveYearProjection',
    ];

    for (const field of required) {
      expect(deal).toHaveProperty(field);
      expect(deal[field]).not.toBeNull();
    }

    // 5-year projection table: 5 annual entries
    expect(deal.fiveYearProjection).toHaveLength(5);
    expect(deal.fiveYearProjection[0]).toHaveProperty('year');
    expect(deal.fiveYearProjection[0]).toHaveProperty('projectedValue');

    // SDLT must be positive for a >£125 k PCL acquisition
    expect(deal.sdlt).toBeGreaterThan(0);

    // Total acquisition cost = price + SDLT + legal fees
    expect(deal.totalAcquisitionCost).toBe(
      deal.price + deal.sdlt + deal.legalFees,
    );
  });
});

describe('agent3-analyst — computeSdlt()', () => {
  test('standard residential rates: £500,000 → £15,000', () => {
    // £0–£125 k at 0 % = £0
    // £125 k–£250 k at 2 % = £2,500
    // £250 k–£500 k at 5 % = £12,500
    // Total = £15,000
    expect(computeSdlt(500_000, false, false)).toBe(15_000);
  });

  test('additional property + non-UK surcharge (+5 %): £500,000 → £40,000', () => {
    // Every band gains +5 % (3 % additional + 2 % non-UK):
    // £0–£125 k at 5 % = £6,250
    // £125 k–£250 k at 7 % = £8,750
    // £250 k–£500 k at 10 % = £25,000
    // Total = £40,000
    expect(computeSdlt(500_000, true, true)).toBe(40_000);
  });
});

describe('agent3-analyst — run()', () => {
  test('multiple properties are ranked by score descending', async () => {
    const report = await analyst.run({
      // Deliberately pass in unsorted order
      property:  [SHORT_LEASE_FLAT, POL_HOUSE, PCL_FLAT],
      writeMemo: false,
    });

    expect(report.totalAnalyzed).toBe(3);
    expect(Array.isArray(report.allDeals)).toBe(true);
    expect(Array.isArray(report.topDeals)).toBe(true);

    // Scores must be non-increasing
    const scores = report.allDeals.map((d) => d.score);
    for (let i = 1; i < scores.length; i++) {
      expect(scores[i - 1]).toBeGreaterThanOrEqual(scores[i]);
    }

    // Every deal has a valid recommendation string
    for (const deal of report.allDeals) {
      expect(['ACQUIRE', 'MONITOR', 'PASS']).toContain(deal.recommendation);
      expect(deal.score).toBeGreaterThanOrEqual(0);
      expect(deal.score).toBeLessThanOrEqual(100);
    }
  });
});
