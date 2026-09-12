'use strict';
/**
 * __tests__/enrichLeads.test.js
 * Unit tests for utils/enrichLeads.js
 *
 * Tests:
 *   1. enrichOne — successful Companies House match
 *   2. enrichOne — 403 (network_blocked) fallback → needs_manual_enrichment
 *   3. enrichOne — timeout fallback → needs_manual_enrichment
 *   4. rescoreAccessibility — all six tiers
 *   5. recalculateScore — weighted math
 *   6. buildSearchQuery — priority order (company > name > postcode > address)
 *   7. parsePipelineLeads — parses pipeline.md task-list format
 *   8. CSV output — QUALIFIED_HEADERS coverage
 */

// ── Mocks ─────────────────────────────────────────────────────────────────────

jest.mock('../utils/safeHttp', () => ({
  get:                  jest.fn(),
  logNetworkFailure:    jest.fn(),
  DEFAULT_TIMEOUT_MS:   10_000,
}));

jest.mock('../utils/fileStore', () => ({
  listFiles: jest.fn(() => []),
  DATA_DIR:  '/tmp/enrich-test-data',
}));

jest.mock('../utils/logger', () => () => ({
  info:  jest.fn(),
  warn:  jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
}));

jest.mock('fs', () => {
  const real = jest.requireActual('fs');
  return {
    ...real,
    existsSync:    jest.fn(() => false),
    readFileSync:  jest.fn(() => '[]'),
    mkdirSync:     jest.fn(),
    writeFileSync: jest.fn(),
    renameSync:    jest.fn(),
    appendFileSync: jest.fn(),
    readdirSync:   jest.fn(() => []),
  };
});

// ── Imports (after mocks) ─────────────────────────────────────────────────────

const {
  enrichOne,
  buildSearchQuery,
  rescoreAccessibility,
  recalculateScore,
  parsePipelineLeads,
  QUALIFIED_HEADERS,
  WEIGHTS,
} = require('../utils/enrichLeads');

const { get: safeGet, logNetworkFailure } = require('../utils/safeHttp');
const fs = require('fs');

// ── Fixtures ──────────────────────────────────────────────────────────────────

const HNW_LEAD = {
  name:              'Mohammed Al-Rashid',
  company:           'Al-Rashid Family Office',
  nationality:       'Saudi Arabian',
  property_interest: 'Prime Central London 2–3 bed flat',
  budget_range:      '£2m–£5m',
  contact_email:     'm.alrashid@alrashidfo.com',
  contact_phone:     '+44 7911 123 456',
  linkedin_url:      null,
  motivation:        'overseas_portfolio_diversification',
  lead_score:        8.95,
  source_url:        'https://find-and-update.company-information.service.gov.uk/search?q=al-rashid',
  date_found:        '2026-05-27',
  status:            'new',
  type:              'family_office',
  score_intent:      9,
  score_capacity:    8,
  score_accessibility: 10,
  score_fit:         9,
  flags:             ['high_intent', 'high_budget', 'contactable', 'core_profile', 'international'],
};

const HMLR_LEAD = {
  name:              null,
  company:           null,
  nationality:       null,
  property_interest: 'London residential — SW3',
  budget_range:      '£2m–£5m',
  contact_email:     null,
  contact_phone:     null,
  linkedin_url:      null,
  motivation:        'recent_buyer',
  lead_score:        7.85,
  source_url:        'https://landregistry.data.gov.uk/data/ppi/...',
  date_found:        '2026-05-27',
  status:            'new',
  type:              'cash_buyer',
  score_intent:      10,
  score_capacity:    8,
  score_accessibility: 4,
  score_fit:         7,
  flags:             ['high_intent', 'high_budget'],
  address:           'FLAT 12, 42 CADOGAN SQUARE, LONDON',
  postcode:          'SW3X 0JP',
  price:             4200000,
  transactionId:     '{A1B2C3D4-E5F6-7890-ABCD-EF1234567890}',
};

/** Mock CH company search response */
const CH_COMPANY_RESPONSE = {
  items: [
    {
      company_name:    'AL-RASHID FAMILY OFFICE LTD',
      company_number:  '14567890',
      company_status:  'active',
      company_type:    'ltd',
      date_of_creation: '2021-06-15',
      sic_codes:       ['68100'],
      registered_office_address: {
        address_line_1: 'Flat 5, 12 Eaton Square',
        locality:       'London',
        postal_code:    'SW1W 9BH',
        country:        'England',
      },
    },
  ],
};

/** Mock CH officers response */
const CH_OFFICERS_RESPONSE = {
  items: [
    {
      name:         'AL-RASHID, Ahmed Abdullah',
      officer_role: 'director',
      nationality:  'Saudi Arabian',
      country_of_residence: 'Saudi Arabia',
      name_elements: { forename: 'Ahmed', surname: 'AL-RASHID' },
    },
  ],
};

// ── Test 1: Successful Companies House enrichment ─────────────────────────────

describe('enrichOne', () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  test('Test 1 — successful CH match: enriches name, address, director, rescores accessibility', async () => {
    safeGet
      .mockResolvedValueOnce({ ok: true,  data: CH_COMPANY_RESPONSE,  status: 200 })  // company search
      .mockResolvedValueOnce({ ok: true,  data: CH_OFFICERS_RESPONSE, status: 200 }); // officers

    const result = await enrichOne(HMLR_LEAD, { key: null, dryRun: false });

    expect(result.ch_enriched).toBe(true);
    expect(result.ch_enrichment_note).toBe('matched');
    expect(result.ch_company_number).toBe('14567890');
    expect(result.ch_company_name).toBe('AL-RASHID FAMILY OFFICE LTD');
    expect(result.ch_director_name).toBe('Ahmed AL-RASHID');
    expect(result.ch_director_nationality).toBe('Saudi Arabian');
    expect(result.ch_registered_address).toContain('Eaton Square');
    // Anonymous HMLR lead should now have company populated
    expect(result.company).toBe('AL-RASHID FAMILY OFFICE LTD');
    // Accessibility re-scored from 4 (source_url only) → 6 (director + company known)
    expect(result.score_accessibility).toBe(6);
    // Lead score should have increased
    expect(result.lead_score).toBeGreaterThan(HMLR_LEAD.lead_score);
    // CH-enriched flag added
    expect(result.flags).toContain('ch_enriched');
    // Profile URL correct
    expect(result.ch_profile_url).toContain('14567890');
  });

  // ── Test 2: 403 network_blocked fallback ─────────────────────────────────────

  test('Test 2 — 403 response: marks lead as needs_manual_enrichment', async () => {
    safeGet.mockResolvedValue({
      ok:        false,
      status:    403,
      errorType: 'network_blocked',
      error:     'Request failed with status code 403',
      data:      null,
    });

    const result = await enrichOne(HNW_LEAD, { key: null });

    expect(result.ch_enriched).toBe(false);
    expect(result.ch_enrichment_note).toBe('ch_api_blocked');
    expect(result.status).toBe('needs_manual_enrichment');
    // Original lead data should be preserved
    expect(result.name).toBe(HNW_LEAD.name);
    expect(result.lead_score).toBe(HNW_LEAD.lead_score);
    // logNetworkFailure should have been called
    expect(logNetworkFailure).toHaveBeenCalled();
  });

  // ── Test 3: Timeout fallback ──────────────────────────────────────────────────

  test('Test 3 — timeout: marks lead as needs_manual_enrichment with timeout note', async () => {
    safeGet.mockResolvedValue({
      ok:        false,
      status:    null,
      errorType: 'timeout',
      error:     'timeout of 10000ms exceeded',
      data:      null,
    });

    const result = await enrichOne(HMLR_LEAD, { key: null });

    expect(result.ch_enriched).toBe(false);
    expect(result.ch_enrichment_note).toBe('ch_search_timeout');
    expect(result.status).toBe('needs_manual_enrichment');
    // No CH fields should be set
    expect(result.ch_company_number).toBeUndefined();
    expect(result.ch_director_name).toBeUndefined();
  });

  // ── Test 4 (inline): dry run ──────────────────────────────────────────────────

  test('dry run: returns lead without making HTTP calls', async () => {
    const result = await enrichOne(HNW_LEAD, { key: null, dryRun: true });
    expect(safeGet).not.toHaveBeenCalled();
    expect(result.ch_enriched).toBe(false);
    expect(result.ch_enrichment_note).toBe('dry_run');
    expect(result.ch_query).toBe('Al-Rashid Family Office');
  });
});

// ── Test 4: rescoreAccessibility ─────────────────────────────────────────────

describe('rescoreAccessibility', () => {
  test('email + phone → 10', () => {
    expect(rescoreAccessibility({ contact_email: 'a@b.com', contact_phone: '+44 7911 000' })).toBe(10);
  });

  test('email only → 10', () => {
    expect(rescoreAccessibility({ contact_email: 'a@b.com' })).toBe(10);
  });

  test('phone only → 9', () => {
    expect(rescoreAccessibility({ contact_phone: '+44 7911 000' })).toBe(9);
  });

  test('linkedin_url only → 8', () => {
    expect(rescoreAccessibility({ linkedin_url: 'https://linkedin.com/in/test' })).toBe(8);
  });

  test('CH director + company number → 6', () => {
    expect(rescoreAccessibility({
      ch_director_name: 'Ahmed Al-Rashid',
      ch_company_number: '14567890',
    })).toBe(6);
  });

  test('CH company number only (no director) → 5', () => {
    expect(rescoreAccessibility({ ch_company_number: '14567890' })).toBe(5);
  });

  test('source_url only → 4', () => {
    expect(rescoreAccessibility({ source_url: 'https://example.com' })).toBe(4);
  });

  test('nothing → 2', () => {
    expect(rescoreAccessibility({})).toBe(2);
  });
});

// ── Test 5: recalculateScore ──────────────────────────────────────────────────

describe('recalculateScore', () => {
  test('correct weighted composite for a known lead', () => {
    const lead = {
      score_intent:        10,
      score_capacity:       8,
      score_accessibility:  6,    // post-enrichment (was 4)
      score_fit:            7,
    };
    // 10×0.40 + 8×0.25 + 6×0.20 + 7×0.15
    // = 4.00 + 2.00 + 1.20 + 1.05 = 8.25
    expect(recalculateScore(lead)).toBe(8.25);
  });

  test('uses CLAUDE.md weights', () => {
    // Check the exported WEIGHTS constants match CLAUDE.md
    expect(WEIGHTS.investment_intent_signal).toBe(0.40);
    expect(WEIGHTS.capital_capacity        ).toBe(0.25);
    expect(WEIGHTS.accessibility           ).toBe(0.20);
    expect(WEIGHTS.strategic_fit           ).toBe(0.15);
  });

  test('handles missing score fields gracefully (treats as 0)', () => {
    expect(recalculateScore({})).toBe(0);
    expect(recalculateScore({ score_intent: 5 })).toBeCloseTo(5 * 0.40, 5);
  });

  test('enrichment improves score when accessibility increases', () => {
    const before = recalculateScore({ score_intent: 10, score_capacity: 8, score_accessibility: 4, score_fit: 7 });
    const after  = recalculateScore({ score_intent: 10, score_capacity: 8, score_accessibility: 6, score_fit: 7 });
    expect(after).toBeGreaterThan(before);
  });
});

// ── Test 6: buildSearchQuery ──────────────────────────────────────────────────

describe('buildSearchQuery', () => {
  test('company name takes priority', () => {
    expect(buildSearchQuery({
      company:  'Acme Property Ltd',
      name:     'John Smith',
      postcode: 'SW1W 9BH',
    })).toBe('Acme Property Ltd');
  });

  test('director name used when no company', () => {
    expect(buildSearchQuery({
      name:     'Mohammed Al-Rashid',
      postcode: 'SW1W 9BH',
    })).toBe('Mohammed Al-Rashid');
  });

  test('postcode used when no name or company (HMLR lead)', () => {
    expect(buildSearchQuery({ postcode: 'SW3X 0JP' })).toBe('SW3X 0JP');
  });

  test('extracts postcode from freeform address', () => {
    const query = buildSearchQuery({
      address: 'FLAT 12, 42 CADOGAN SQUARE, LONDON, SW3X 0JP',
    });
    expect(query).toBe('SW3X 0JP');
  });

  test('falls back to first two address segments if no postcode', () => {
    const query = buildSearchQuery({ address: '42 CADOGAN SQUARE, LONDON' });
    expect(query).toBe('42 CADOGAN SQUARE LONDON');
  });

  test('returns null when no data available', () => {
    expect(buildSearchQuery({})).toBeNull();
    expect(buildSearchQuery({ status: 'new' })).toBeNull();
  });
});

// ── Test 7: parsePipelineLeads ────────────────────────────────────────────────

describe('parsePipelineLeads', () => {
  const PIPELINE_MD = `# Square Centimeter Ltd — Pipeline Review Items

Items marked \`- [ ]\` require Julian Noble's attention before action is taken.

## Batch 2026-05-27

- [ ] **Mohammed Al-Rashid** | Score 8.95/10 | family_office | overseas_portfolio_diversification | https://find-and-update.company-information.service.gov.uk/search?q=al-rashid
- [ ] **Unknown** | Score 7.85/10 | cash_buyer | recent_buyer | https://landregistry.data.gov.uk/data/ppi/...
- [x] **Resolved Lead** | Score 6.0/10 | hnw_investor | press_mention | https://example.com
`;

  beforeEach(() => {
    fs.existsSync.mockImplementation((p) => p.includes('pipeline.md'));
    fs.readFileSync.mockImplementation((p) => {
      if (String(p).includes('pipeline.md')) return PIPELINE_MD;
      return '[]';
    });
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  test('parses unchecked items only', () => {
    const leads = parsePipelineLeads();
    // Only unchecked (- [ ]) items are parsed; resolved (- [x]) items are skipped
    expect(leads).toHaveLength(2);
  });

  test('maps "Unknown" name to null', () => {
    const leads = parsePipelineLeads();
    const hmlr  = leads.find((l) => l.type === 'cash_buyer');
    expect(hmlr).toBeDefined();
    expect(hmlr.name).toBeNull();
  });

  test('parses name, type, motivation, lead_score, source_url', () => {
    const leads  = parsePipelineLeads();
    const foLead = leads.find((l) => l.type === 'family_office');
    expect(foLead.name).toBe('Mohammed Al-Rashid');
    expect(foLead.type).toBe('family_office');
    expect(foLead.motivation).toBe('overseas_portfolio_diversification');
    expect(foLead.lead_score).toBe(8.95);
    expect(foLead.source_url).toContain('al-rashid');
  });

  test('sets score_intent = 10 for recent_buyer motivation', () => {
    const leads  = parsePipelineLeads();
    const buyer  = leads.find((l) => l.motivation === 'recent_buyer');
    expect(buyer.score_intent).toBe(10);
  });

  test('returns empty array when pipeline.md does not exist', () => {
    fs.existsSync.mockReturnValue(false);
    const leads = parsePipelineLeads();
    expect(leads).toEqual([]);
  });
});

// ── Test 8: CSV column coverage ───────────────────────────────────────────────

describe('QUALIFIED_HEADERS', () => {
  test('contains all required CLAUDE.md standard columns', () => {
    const required = ['name', 'company', 'nationality', 'property_interest',
      'budget_range', 'contact_email', 'contact_phone', 'linkedin_url',
      'motivation', 'lead_score', 'source_url', 'date_found', 'status'];
    for (const col of required) {
      expect(QUALIFIED_HEADERS).toContain(col);
    }
  });

  test('contains SC-specific extension columns', () => {
    expect(QUALIFIED_HEADERS).toContain('property_address');
    expect(QUALIFIED_HEADERS).toContain('estimated_equity');
  });

  test('contains all CH enrichment columns', () => {
    const chCols = [
      'ch_enriched', 'ch_enrichment_note',
      'ch_company_number', 'ch_company_name',
      'ch_director_name', 'ch_director_nationality',
      'ch_registered_address', 'ch_profile_url',
    ];
    for (const col of chCols) {
      expect(QUALIFIED_HEADERS).toContain(col);
    }
  });

  test('contains HMLR property columns for cash-buyer leads', () => {
    const hmlrCols = ['postcode', 'address', 'price', 'dateOfTransfer',
      'propertyType', 'estateType', 'newBuild', 'transactionId'];
    for (const col of hmlrCols) {
      expect(QUALIFIED_HEADERS).toContain(col);
    }
  });

  test('no duplicate column names', () => {
    const seen = new Set();
    for (const col of QUALIFIED_HEADERS) {
      expect(seen.has(col)).toBe(false);
      seen.add(col);
    }
  });
});
