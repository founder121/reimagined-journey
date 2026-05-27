'use strict';
const RobotsChecker = require('../utils/robotsChecker');

// We mock axios so no real network calls are made
jest.mock('axios');
const axios = require('axios');

const ROBOTS_TXT = `
User-agent: *
Disallow: /private/
Allow: /public/

User-agent: RealEstateResearchBot
Disallow: /blocked-for-bot/
Allow: /homes/
`;

describe('RobotsChecker', () => {
  beforeEach(() => {
    axios.get.mockResolvedValue({ status: 200, data: ROBOTS_TXT });
  });

  afterEach(() => jest.clearAllMocks());

  test('allows a permitted path', async () => {
    const checker = new RobotsChecker('RealEstateResearchBot/1.0');
    const ok = await checker.isAllowed('https://example.com/homes/TX_rb/');
    expect(ok).toBe(true);
  });

  test('blocks a disallowed path for the specific UA', async () => {
    const checker = new RobotsChecker('RealEstateResearchBot/1.0');
    const ok = await checker.isAllowed('https://example.com/blocked-for-bot/page');
    expect(ok).toBe(false);
  });

  test('blocks /private/ for wildcard UA', async () => {
    const checker = new RobotsChecker('SomeOtherBot/1.0');
    const ok = await checker.isAllowed('https://example.com/private/data');
    expect(ok).toBe(false);
  });

  test('caches robots.txt (only one HTTP fetch per origin)', async () => {
    const checker = new RobotsChecker('TestBot/1.0');
    await checker.isAllowed('https://example.com/homes/');
    await checker.isAllowed('https://example.com/public/');
    expect(axios.get).toHaveBeenCalledTimes(1);
  });

  test('fails open when robots.txt is unreachable', async () => {
    axios.get.mockRejectedValue(new Error('Network error'));
    const checker = new RobotsChecker('TestBot/1.0');
    const ok = await checker.isAllowed('https://broken.example.com/any/path');
    expect(ok).toBe(true);
  });
});
