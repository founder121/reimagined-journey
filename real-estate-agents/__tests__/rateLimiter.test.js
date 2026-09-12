'use strict';
const RateLimiter = require('../utils/rateLimiter');

describe('RateLimiter', () => {
  test('resolves immediately on first call', async () => {
    const rl = new RateLimiter({ defaultDelay: 100 });
    const start = Date.now();
    await rl.wait('example.com');
    expect(Date.now() - start).toBeLessThan(50);
  });

  test('waits between consecutive calls', async () => {
    const rl = new RateLimiter({ defaultDelay: 150 });
    await rl.wait('test.com');
    const start = Date.now();
    await rl.wait('test.com');
    expect(Date.now() - start).toBeGreaterThanOrEqual(100);
  });

  test('per-domain override is respected', async () => {
    const rl = new RateLimiter({ defaultDelay: 500, domains: { 'fast.com': 50 } });
    await rl.wait('fast.com');
    const start = Date.now();
    await rl.wait('fast.com');
    expect(Date.now() - start).toBeLessThan(200);
  });

  test('different domains do not interfere', async () => {
    const rl = new RateLimiter({ defaultDelay: 200 });
    await rl.wait('alpha.com');
    const start = Date.now();
    await rl.wait('beta.com'); // first call on beta — should not wait
    expect(Date.now() - start).toBeLessThan(50);
  });
});
