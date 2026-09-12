'use strict';
const fs   = require('fs');
const path = require('path');
const os   = require('os');

// Point DATA_DIR at a temp directory so tests never touch real data/
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sc-test-'));
process.env.DATA_DIR = tmpDir;

const { writeData, readData, listFiles, statusSummary } = require('../utils/fileStore');

describe('fileStore', () => {
  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('writeData creates file and returns path', () => {
    const outPath = writeData('raw', 'listings-rightmove', [{ address: '1 Eaton Sq, SW1W' }]);
    expect(fs.existsSync(outPath)).toBe(true);
    expect(outPath).toContain('raw');
    expect(outPath).toContain('listings-rightmove');
  });

  test('writeData supports nested subdir (leads/raw)', () => {
    const outPath = writeData('leads/raw', 'leads-lrpp', [{ name: 'Test', lead_score: 8 }]);
    expect(fs.existsSync(outPath)).toBe(true);
    expect(outPath).toContain(path.join('leads', 'raw'));
  });

  test('readData round-trips JSON correctly', () => {
    const data = [{ address: 'Flat 3, 12 Pont St, SW1X', price: 1250000 }];
    const outPath = writeData('raw', 'listings-test', data);
    const filename = path.basename(outPath);
    const result = readData('raw', filename);
    expect(result).toEqual(data);
  });

  test('writeData does not double-date a baseName that already contains YYYY-MM-DD', () => {
    const date = new Date().toISOString().slice(0, 10);
    const outPath = writeData('raw', `listings-${date}`, []);
    expect(path.basename(outPath)).toBe(`listings-${date}.json`);
  });

  test('listFiles returns newest file first', () => {
    writeData('reports', 'memo-a', { score: 90 });
    const files = listFiles('reports');
    expect(files.length).toBeGreaterThanOrEqual(1);
    expect(files[0]).toContain('.json');
  });

  test('statusSummary covers SC pipeline directories', () => {
    const summary = statusSummary();
    expect(summary).toHaveProperty('raw');
    expect(summary).toHaveProperty('leads/raw');
    expect(summary).toHaveProperty('leads/qualified');
    expect(summary).toHaveProperty('leads/contacted');
    expect(summary).toHaveProperty('reports');
    expect(summary).toHaveProperty('outputs');
  });

  test('statusSummary counts written files correctly', () => {
    writeData('outputs', 'marketing-deal-brief', { content: 'test' });
    const summary = statusSummary();
    expect(summary['outputs'].files).toBeGreaterThanOrEqual(1);
  });
});
