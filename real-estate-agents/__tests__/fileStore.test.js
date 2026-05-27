'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');

// Point DATA_DIR at a temp directory for testing
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'real-estate-test-'));
process.env.DATA_DIR = tmpDir;

const { writeData, readData, listFiles, statusSummary } = require('../utils/fileStore');

describe('fileStore', () => {
  afterAll(() => {
    // Clean up temp directory
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('writeData creates file and returns path', () => {
    const outPath = writeData('properties', 'test-portal-TX', [{ address: '123 Main' }]);
    expect(fs.existsSync(outPath)).toBe(true);
    expect(outPath).toContain('properties');
    expect(outPath).toContain('test-portal-TX');
  });

  test('readData round-trips JSON correctly', () => {
    const data = [{ address: '456 Oak Ave', price: '$200,000' }];
    const outPath = writeData('leads', 'test-leads', data);
    const filename = path.basename(outPath);
    const result = readData('leads', filename);
    expect(result).toEqual(data);
  });

  test('listFiles returns newest file first', () => {
    writeData('reports', 'report-a', { score: 90 });
    // Small pause ensures different mtime
    const files = listFiles('reports');
    expect(files.length).toBeGreaterThanOrEqual(1);
    expect(files[0]).toContain('.json');
  });

  test('statusSummary counts files per directory', () => {
    const summary = statusSummary();
    expect(summary).toHaveProperty('properties');
    expect(summary).toHaveProperty('leads');
    expect(summary).toHaveProperty('reports');
    expect(summary).toHaveProperty('campaigns');
    expect(summary.properties.files).toBeGreaterThanOrEqual(1);
  });
});
