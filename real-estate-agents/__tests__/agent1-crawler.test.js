'use strict';
/**
 * Unit tests for agent1-crawler.js (Property Scout)
 * All HTTP calls are mocked — no real network access.
 */

jest.mock('axios');
jest.mock('../utils/fileStore', () => ({
  writeData: jest.fn(() => '/tmp/mock.json'),
  DATA_DIR:  '/tmp/mock-data',
}));
// Mock execSync so agent-browser is never invoked in tests
jest.mock('child_process', () => ({
  execSync: jest.fn(() => Buffer.from(''))
}));
// Mock RobotsChecker so robots.txt checks never consume axios mock calls
jest.mock('../utils/robotsChecker', () =>
  jest.fn().mockImplementation(() => ({
    isAllowed: jest.fn().mockResolvedValue(true),
  }))
);

const axios = require('axios');
const path  = require('path');
const fs    = require('fs');

// Full-page HTML fixture that matches Rightmove-style selectors.
// Must be > 1500 chars to pass the looksBlocked() length check.
const LISTING_CARDS = `
<li class="l-searchResult">
  <address class="propertyCard-address">Flat 12, 45 Eaton Square, SW1W 9BN</address>
  <span class="propertyCard-priceValue">£1,450,000</span>
  <span class="bedrooms">2</span>
  <a class="propertyCard-link" href="/property/12345678">View</a>
  <div class="propertyCard-branchSummary-addedOrReduced">Added 91 days ago</div>
  <p class="propertyCard-description">A beautifully presented two bedroom apartment situated in the heart of Belgravia, moments from Sloane Square. The property benefits from a private balcony, concierge service and underground parking.</p>
</li>
<li class="l-searchResult">
  <address class="propertyCard-address">4 Chelsea Manor St, SW3 5RZ</address>
  <span class="propertyCard-priceValue">£2,100,000</span>
  <span class="bedrooms">3</span>
  <a class="propertyCard-link" href="/property/87654321">View</a>
  <p class="propertyCard-description">An exceptional three bedroom lateral apartment in the prestigious Chelsea Manor Street, SW3. Set on the second floor of a handsome period building this apartment occupies the entire floor providing lateral living.</p>
</li>
`;

// Pad to a realistic page size (>1500 chars) so looksBlocked() does not trigger
const PADDING = `<!-- rightmove search results page v3 -->\n${'<!-- padding -->'.repeat(120)}`;
const SAMPLE_HTML = `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><title>Property for Sale - Rightmove</title></head><body><main id="l-container">${LISTING_CARDS}${PADDING}</main></body></html>`;

// Empty page (signals last page)
const EMPTY_HTML = `<html><body><div id="noResults">No results found</div></body></html>`;

const crawler = require('../agents/agent1-crawler');

describe('agent1-crawler — listPortals()', () => {
  test('returns at least the portals configured in portals.yml', () => {
    const portals = crawler.listPortals();
    expect(Array.isArray(portals)).toBe(true);
    expect(portals.length).toBeGreaterThan(0);
    // Each entry must have key and baseUrl
    for (const p of portals) {
      expect(p).toHaveProperty('key');
      expect(p).toHaveProperty('baseUrl');
      expect(p).toHaveProperty('enabled');
    }
  });

  test('enabledOnly=true filters out disabled portals', () => {
    const all     = crawler.listPortals(false);
    const enabled = crawler.listPortals(true);
    expect(enabled.length).toBeLessThanOrEqual(all.length);
    expect(enabled.every((p) => p.enabled)).toBe(true);
  });
});

describe('agent1-crawler — run() dry-run', () => {
  test('dry-run returns [] without making HTTP calls', async () => {
    const records = await crawler.run({ portal: 'rightmove', dryRun: true });
    expect(records).toEqual([]);
    expect(axios.get).not.toHaveBeenCalled();
  });
});

describe('agent1-crawler — HTML parsing', () => {
  beforeEach(() => {
    axios.get.mockResolvedValue({ status: 200, data: SAMPLE_HTML });
  });

  afterEach(() => jest.clearAllMocks());

  test('parses address and price correctly from sample HTML', async () => {
    // Use the 'rightmove' portal config (first enabled area only)
    const records = await crawler.run({
      portal:  'rightmove',
      areas:   [{ name: 'Belgravia & Pimlico', locationId: 'OUTCODE%5E1036', zone: 'PCL' }],
      pages:   1,
    });

    expect(records.length).toBe(2);
    expect(records[0].price).toBe(1_450_000);
    expect(records[0].beds).toBe(2);
    expect(records[1].price).toBe(2_100_000);
  });

  test('extracts PCL postcode and assigns correct market zone', async () => {
    const records = await crawler.run({
      portal: 'rightmove',
      areas:  [{ name: 'Test', locationId: 'OUTCODE%5E1036', zone: 'PCL' }],
      pages:  1,
    });
    expect(records[0].postcode).toBe('SW1W 9BN');
    expect(records[0].marketZone).toBe('PCL');
    expect(records[0].flags).toContain('pcl');
  });

  test('flags motivated_vendor when DOM >= 90', async () => {
    const records = await crawler.run({
      portal: 'rightmove',
      areas:  [{ name: 'Test', locationId: 'X', zone: 'PCL' }],
      pages:  1,
    });
    // First listing has "91 days ago" in DOM field
    expect(records[0].daysOnMarket).toBe(91);
    expect(records[0].flags).toContain('motivated_vendor');
  });

  test('stops crawling area when empty page is returned', async () => {
    // First call returns listings, second returns empty page
    axios.get
      .mockResolvedValueOnce({ status: 200, data: SAMPLE_HTML })
      .mockResolvedValueOnce({ status: 200, data: EMPTY_HTML });

    const records = await crawler.run({
      portal: 'rightmove',
      areas:  [{ name: 'Test', locationId: 'X', zone: 'PCL' }],
      pages:  5,  // up to 5 pages, but should stop at 2
    });

    expect(axios.get).toHaveBeenCalledTimes(2);
    expect(records.length).toBe(2); // only from page 1
  });

  // Retry delay is 6 s × exponential — increase test timeout accordingly
  test('continues to next page on fetch error (does not abort whole scan)', async () => {
    axios.get
      .mockRejectedValueOnce(new Error('network error'))  // page 1 fails
      .mockResolvedValueOnce({ status: 200, data: SAMPLE_HTML })  // page 2 ok
      .mockResolvedValueOnce({ status: 200, data: EMPTY_HTML });   // page 3 empty

    const records = await crawler.run({
      portal: 'rightmove',
      areas:  [{ name: 'Test', locationId: 'X', zone: 'PCL' }],
      pages:  3,
    });

    // Should still get results from page 2
    expect(records.length).toBe(2);
  }, 20_000);
});
