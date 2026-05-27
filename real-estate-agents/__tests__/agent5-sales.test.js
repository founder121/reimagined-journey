'use strict';
/**
 * Unit tests for agent5-sales.js (Client Relations — Square Centimeter Ltd)
 * All tests use in-memory fixtures — no network, no file I/O.
 * writeToDisk: false prevents any fs.appendFileSync / mkdirSync / writeFileSync calls.
 */

jest.mock('../utils/fileStore', () => ({
  writeData: jest.fn(() => '/tmp/mock.csv'),
  listFiles:  jest.fn(() => []),
  DATA_DIR:  '/tmp/mock-data',
}));

// Prevent actual file writes from writeToDisk paths
jest.mock('fs', () => {
  const real = jest.requireActual('fs');
  return {
    ...real,
    appendFileSync: jest.fn(),
    mkdirSync:      jest.fn(),
    writeFileSync:  jest.fn(),
    renameSync:     jest.fn(),
  };
});

const {
  qualifyLead,
  generateBriefingNote,
  generateIcal,
  checkOverdue,
  parseBudgetMin,
  run,
  BUDGET_THRESHOLD_MIN,
  QUALIFICATION_FIELDS,
} = require('../agents/agent5-sales');

// ── Fixtures ──────────────────────────────────────────────────────────────────

/**
 * HNW overseas investor — £2m–£5m, Knightsbridge / Mayfair PCL interest,
 * Saudi nationality → infers 'overseas' residency, PCL location.
 */
const HNW_LEAD = {
  name:              'Mohammed Al-Rashid',
  company:           'Al-Rashid Family Office',
  nationality:       'Saudi Arabian',
  property_interest: 'Prime Central London 2-3 bed flat, Knightsbridge or Mayfair',
  budget_range:      '£2m–£5m',
  contact_email:     'mar@alrashidfo.com',
  motivation:        'overseas portfolio diversification',
  lead_score:        8,
  source_url:        'https://linkedin.com/in/malrashid',
  date_found:        '2026-05-01',
  status:            'new',
};

/**
 * Under-budget UK lead — triggers disqualification.
 */
const LOW_BUDGET_LEAD = {
  name:              'Jane Smith',
  nationality:       'British',
  property_interest: 'London one-bed flat, flexible location',
  budget_range:      'under £500k',
  contact_email:     'jane.smith@example.com',
  lead_score:        3,
  date_found:        '2026-05-20',
  status:            'new',
};

// ─────────────────────────────────────────────────────────────────────────────

describe('agent5-sales — qualifyLead() HNW overseas investor', () => {
  test('£2m+ PCL non-resident lead is qualified with score ≥ 60', () => {
    const result = qualifyLead(HNW_LEAD);

    // Basic shape
    expect(typeof result).toBe('object');
    expect(result).toHaveProperty('qualificationScore');
    expect(result).toHaveProperty('qualified');
    expect(result).toHaveProperty('scoreBreakdown');

    // Must be qualified
    expect(result.qualified).toBe(true);

    // Composite score ≥ 60 (budget=8×0.40 + residency=9×0.20 + location=10×0.20 at minimum)
    expect(result.qualificationScore).toBeGreaterThanOrEqual(60);

    // Location inferred as PCL from "Knightsbridge or Mayfair"
    expect(result.locationPreference).toBe('PCL');

    // Residency inferred as overseas (Saudi national, non-British)
    expect(result.residencyStatus).toBe('overseas');

    // International flag present; contactable flag present (email supplied)
    expect(result.flags).toContain('international');
    expect(result.flags).toContain('contactable');

    // Budget parsed correctly
    expect(result.budgetMin).toBeGreaterThanOrEqual(2_000_000);

    // Score breakdown dimensions all within 0–10
    for (const dim of Object.keys(QUALIFICATION_FIELDS)) {
      expect(result.scoreBreakdown[dim]).toBeGreaterThanOrEqual(0);
      expect(result.scoreBreakdown[dim]).toBeLessThanOrEqual(10);
    }
  });
});

describe('agent5-sales — qualifyLead() under-budget lead', () => {
  test('under-£500k lead is disqualified with under_budget flag', () => {
    const result = qualifyLead(LOW_BUDGET_LEAD);

    // Must NOT be qualified
    expect(result.qualified).toBe(false);

    // under_budget flag set
    expect(result.flags).toContain('under_budget');

    // budgetMin is below threshold
    expect(result.budgetMin).toBeLessThan(BUDGET_THRESHOLD_MIN);

    // Disqualify reason populated
    expect(typeof result.disqualifyReason).toBe('string');
    expect(result.disqualifyReason.length).toBeGreaterThan(0);

    // Should NOT have international flag (British nationality)
    expect(result.flags).not.toContain('international');

    // contactable flag present (email supplied)
    expect(result.flags).toContain('contactable');
  });
});

describe('agent5-sales — generateBriefingNote()', () => {
  test('note is CONFIDENTIAL and contains Investment Profile + Suggested Approach sections', () => {
    const qualified = qualifyLead(HNW_LEAD);
    const note      = generateBriefingNote(qualified);

    expect(typeof note).toBe('string');
    expect(note.length).toBeGreaterThan(500);

    // Confidentiality marking
    expect(note).toContain('CONFIDENTIAL');

    // Lead summary section with the lead name
    expect(note).toContain('Al-Rashid');

    // Investment Profile section header
    expect(note).toMatch(/##\s+Investment Profile/i);

    // Qualification Assessment section header and score present
    expect(note).toMatch(/##\s+Qualification Assessment/i);
    expect(note).toContain(`${qualified.qualificationScore}`);

    // Suggested Approach section header
    expect(note).toMatch(/##\s+Suggested Approach/i);

    // Three numbered approach points (label format is "**Opening:**" with colon inside bold)
    expect(note).toMatch(/1\.\s+\*\*Opening:/);
    expect(note).toMatch(/3\.\s+\*\*Advisory angle:/i);

    // Must NOT expose raw address or deal-specific data (not a public document but still follows confidentiality)
    // Briefing note DOES show the lead name — that's correct; what it should NOT do is embed listing addresses
    // We confirm it contains relevant zone/budget guidance
    expect(note.toLowerCase()).toMatch(/pcl|prime central/);
  });
});

describe('agent5-sales — generateIcal()', () => {
  test('returns valid RFC 5545 VCALENDAR with required components', () => {
    const qualified = qualifyLead(HNW_LEAD);
    const dtstart   = new Date('2026-06-01T10:00:00Z');
    const dtend     = new Date('2026-06-01T11:00:00Z');
    const ical      = generateIcal(qualified, { dtstart, dtend, eventType: 'call' });

    expect(typeof ical).toBe('string');
    expect(ical.length).toBeGreaterThan(100);

    // Required VCALENDAR wrapper
    expect(ical).toContain('BEGIN:VCALENDAR');
    expect(ical).toContain('END:VCALENDAR');

    // Required VEVENT wrapper
    expect(ical).toContain('BEGIN:VEVENT');
    expect(ical).toContain('END:VEVENT');

    // Required date/time fields
    expect(ical).toContain('DTSTAMP:');
    expect(ical).toContain('DTSTART:20260601T100000Z');
    expect(ical).toContain('DTEND:20260601T110000Z');

    // UID present and contains domain
    expect(ical).toMatch(/UID:.+@squarecentimeter\.co\.uk/);

    // SUMMARY present
    expect(ical).toContain('SUMMARY:');

    // ORGANIZER for Julian Noble
    expect(ical).toContain('julian@squarecentimeter.co.uk');

    // Line endings are CRLF (RFC 5545)
    expect(ical).toContain('\r\n');
  });

  test('viewing event type uses correct SUMMARY prefix', () => {
    const qualified = qualifyLead(HNW_LEAD);
    const ical      = generateIcal(qualified, { eventType: 'viewing' });

    expect(ical).toMatch(/SUMMARY:Property Viewing/);
  });
});

describe('agent5-sales — checkOverdue()', () => {
  test('lead with date_found 10 days ago is overdue; lead 3 days ago is not', () => {
    const nowMs            = Date.now();
    const tenDaysAgoIso    = new Date(nowMs - 10 * 86_400_000).toISOString();
    const threeDaysAgoIso  = new Date(nowMs -  3 * 86_400_000).toISOString();

    const oldLead = {
      name:       'Overdue Lead',
      status:     'new',
      date_found: tenDaysAgoIso,
    };
    const recentLead = {
      name:       'Recent Lead',
      status:     'new',
      date_found: threeDaysAgoIso,
    };
    const convertedLead = {
      name:       'Converted Lead',
      status:     'converted',
      date_found: tenDaysAgoIso,   // old, but converted → skip
    };

    const overdue = checkOverdue([oldLead, recentLead, convertedLead], 7);

    // Only the 10-day-old active lead should be overdue
    expect(overdue).toHaveLength(1);
    expect(overdue[0].name).toBe('Overdue Lead');

    // Verify recent lead is absent
    const names = overdue.map((l) => l.name);
    expect(names).not.toContain('Recent Lead');
    expect(names).not.toContain('Converted Lead');
  });

  test('lead with lastContactAt 10 days ago (overrides date_found) is overdue', () => {
    const nowMs              = Date.now();
    const tenDaysAgoIso      = new Date(nowMs - 10 * 86_400_000).toISOString();
    const yesterday          = new Date(nowMs -      86_400_000).toISOString();

    const contactedOldLead = {
      name:          'Stale Contact',
      status:        'contacted',
      date_found:    yesterday,          // recently found…
      lastContactAt: tenDaysAgoIso,      // …but last touched 10 days ago
    };

    const overdue = checkOverdue([contactedOldLead], 7);
    expect(overdue).toHaveLength(1);
    expect(overdue[0].name).toBe('Stale Contact');
  });
});

describe('agent5-sales — run()', () => {
  test('returns qualified, overdue, and briefings arrays with writeToDisk: false', async () => {
    const leads  = [HNW_LEAD, LOW_BUDGET_LEAD];
    const result = await run({ leads, action: 'qualify', writeToDisk: false });

    // Shape
    expect(result).toHaveProperty('action', 'qualify');
    expect(result).toHaveProperty('processedAt');
    expect(result).toHaveProperty('qualified');
    expect(result).toHaveProperty('overdue');
    expect(result).toHaveProperty('briefings');

    // processedAt is a valid ISO string
    expect(() => new Date(result.processedAt)).not.toThrow();

    // qualified contains only the HNW lead; LOW_BUDGET_LEAD is disqualified
    expect(Array.isArray(result.qualified)).toBe(true);
    expect(result.qualified.length).toBeGreaterThanOrEqual(1);
    const qualNames = result.qualified.map((l) => l.name);
    expect(qualNames).toContain('Mohammed Al-Rashid');
    expect(qualNames).not.toContain('Jane Smith');

    // overdue is an array (empty because listFiles mock returns [])
    expect(Array.isArray(result.overdue)).toBe(true);

    // briefings is empty for action: 'qualify'
    expect(Array.isArray(result.briefings)).toBe(true);
    expect(result.briefings).toHaveLength(0);
  });

  test('action: "brief" generates briefing notes for qualified leads', async () => {
    const leads  = [HNW_LEAD];
    const result = await run({ leads, action: 'brief', writeToDisk: false });

    expect(result.briefings.length).toBeGreaterThanOrEqual(1);

    const briefing = result.briefings[0];
    expect(briefing).toHaveProperty('lead');
    expect(briefing).toHaveProperty('note');
    expect(typeof briefing.note).toBe('string');
    expect(briefing.note).toContain('CONFIDENTIAL');
  });
});
