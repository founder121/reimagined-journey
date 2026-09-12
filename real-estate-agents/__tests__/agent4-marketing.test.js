'use strict';
/**
 * Unit tests for agent4-marketing.js (Marketing Content Generator — Square Centimeter Ltd)
 * All tests use in-memory fixtures — no network, no file I/O.
 * writeToDisk: false prevents any fs.mkdirSync / fs.writeFileSync / fs.renameSync calls.
 */

jest.mock('../utils/fileStore', () => ({
  writeData: jest.fn(() => '/tmp/mock-output.json'),
  listFiles:  jest.fn(() => []),
  DATA_DIR:  '/tmp/mock-data',
}));

// Prevent actual file writes from writeToDisk paths
jest.mock('fs', () => {
  const real = jest.requireActual('fs');
  return {
    ...real,
    mkdirSync:     jest.fn(),
    writeFileSync: jest.fn(),
    renameSync:    jest.fn(),
  };
});

const {
  generateDealBrief,
  generateLinkedInPost,
  generateNewsletter,
  generateBlogPost,
  sanitiseForPublic,
  SEO_KEYWORDS,
  run,
} = require('../agents/agent4-marketing');

// ── Fixtures ──────────────────────────────────────────────────────────────────

/** Fully-scored deal from agent3-analyst (PCL flat, ACQUIRE). */
const PCL_DEAL = {
  address:             'Flat 12, 45 Eaton Square, London SW1W 9BN',
  postcode:            'SW1W 9BN',
  portal:              'rightmove',
  listingUrl:          'https://www.rightmove.co.uk/property/12345678',
  price:               1_450_000,
  beds:                2,
  sqft:                950,
  pricePerSqft:        1_526,
  tenure:              'leasehold',
  leaseYearsRemaining: 120,
  serviceCharge:       8_400,
  groundRent:          250,
  marketZone:          'PCL',
  flags:               ['pcl'],
  epcRating:           'C',
  daysOnMarket:        45,
  recommendation:      'ACQUIRE',
  score:               79,
  scores: {
    capitalValue: 25, rentalYield: 15, neighbourhoodQuality: 18,
    investmentUpside: 7, marketConditions: 14,
  },
  sdlt:                  132_250,
  legalFees:              21_750,
  totalAcquisitionCost: 1_604_000,
  estimatedMonthlyRent:   4_800,
  estimatedAnnualRent:   57_600,
  managementFee:          6_912,
  voidProvision:         14_500,
  netAnnualIncome:       23_688,
  grossYieldPct:          3.97,
  netYieldPct:            1.63,
  cashOnCashRoiPct:      -1.23,
  fiveYearProjectedValue: 1_681_978,
  fiveYearGain:           231_978,
  fiveYearGainPct:         15.99,
  fiveYearProjection: [
    { year: 2027, projectedValue: 1_493_500 },
    { year: 2028, projectedValue: 1_538_305 },
    { year: 2029, projectedValue: 1_584_454 },
    { year: 2030, projectedValue: 1_631_987 },
    { year: 2031, projectedValue: 1_681_978 },
  ],
  warnings:   [],
  analysedAt: '2026-05-27T10:00:00.000Z',
};

// ─────────────────────────────────────────────────────────────────────────────

describe('agent4-marketing — generateDealBrief()', () => {
  test('brief is marked CONFIDENTIAL and contains all required investment fields', () => {
    const brief = generateDealBrief(PCL_DEAL);

    expect(typeof brief).toBe('string');
    expect(brief.length).toBeGreaterThan(500);

    // Confidentiality marking
    expect(brief).toContain('CONFIDENTIAL');

    // Advisory recommendation
    expect(brief).toContain('ACQUIRE');
    expect(brief).toContain('79');           // score

    // Full property address present in the brief (it IS a private document)
    expect(brief).toContain('Eaton Square');
    expect(brief).toContain('SW1W 9BN');

    // Financial fields
    expect(brief).toContain('SDLT');
    expect(brief).toContain('£1,450,000');
    expect(brief).toContain('Gross Yield');
    expect(brief).toContain('Net Yield');
    expect(brief).toContain('3.97');         // grossYieldPct
  });
});

describe('agent4-marketing — sanitiseForPublic()', () => {
  test('strips address, postcode, and listingUrl; keeps zone, beds, recommendation', () => {
    const ctx = sanitiseForPublic(PCL_DEAL);

    // Sensitive fields removed
    expect(ctx).not.toHaveProperty('address');
    expect(ctx).not.toHaveProperty('postcode');
    expect(ctx).not.toHaveProperty('listingUrl');
    expect(ctx).not.toHaveProperty('sdlt');
    expect(ctx).not.toHaveProperty('legalFees');

    // Public fields retained
    expect(ctx.zone).toBe('PCL');
    expect(ctx.beds).toBe(2);
    expect(ctx.recommendation).toBe('ACQUIRE');
    expect(ctx.priceRange).toMatch(/£1m/);   // £1,450,000 → "£1m–£2m"
    expect(ctx.tenure).toBe('leasehold');
  });
});

describe('agent4-marketing — generateLinkedInPost()', () => {
  test('does NOT contain property address, postcode, or exact price', () => {
    const ctx  = sanitiseForPublic(PCL_DEAL);
    const post = generateLinkedInPost(ctx);

    expect(typeof post).toBe('string');
    expect(post.length).toBeGreaterThan(100);

    // Must NOT expose the specific property
    expect(post).not.toContain('Eaton Square');
    expect(post).not.toContain('SW1W 9BN');
    expect(post).not.toContain('1,450,000');
    expect(post).not.toContain('1450000');

    // Should contain SC hashtags
    expect(post).toContain('#');
    expect(post.toLowerCase()).toMatch(/london|pcl|property/);
  });
});

describe('agent4-marketing — generateNewsletter()', () => {
  test('contains all required newsletter sections and is anonymised', () => {
    const ctx        = sanitiseForPublic(PCL_DEAL);
    const newsletter = generateNewsletter(ctx);

    expect(typeof newsletter).toBe('string');
    expect(newsletter.length).toBeGreaterThan(300);

    // Required structural sections
    expect(newsletter).toMatch(/market pulse/i);
    expect(newsletter).toMatch(/advisory|perspective/i);
    expect(newsletter).toMatch(/unsubscribe/i);

    // Anonymised deal commentary present
    expect(newsletter.toLowerCase()).toContain('pcl');

    // Must NOT reveal the specific address
    expect(newsletter).not.toContain('Eaton Square');
    expect(newsletter).not.toContain('SW1W 9BN');
  });
});

describe('agent4-marketing — generateBlogPost()', () => {
  test('contains at least two target SEO keywords', () => {
    const post = generateBlogPost('PCL');

    expect(typeof post).toBe('string');
    expect(post.length).toBeGreaterThan(500);

    const lower = post.toLowerCase();
    const hits  = SEO_KEYWORDS.filter((kw) => lower.includes(kw.toLowerCase()));
    expect(hits.length).toBeGreaterThanOrEqual(2);
  });
});

describe('agent4-marketing — run()', () => {
  test('returns all four output types with non-empty string content', async () => {
    const result = await run({ memo: PCL_DEAL, writeToDisk: false });

    expect(result).toHaveProperty('generatedAt');
    expect(result).toHaveProperty('outputs');
    expect(result.zone).toBe('PCL');
    expect(result.recommendation).toBe('ACQUIRE');

    const types = ['deal-brief', 'linkedin', 'newsletter', 'blog'];
    for (const t of types) {
      expect(result.outputs).toHaveProperty(t);
      expect(typeof result.outputs[t].content).toBe('string');
      expect(result.outputs[t].content.length).toBeGreaterThan(50);
    }

    // writeToDisk: false → no outputDir, no file writes
    expect(result.outputDir).toBeNull();
  });
});
