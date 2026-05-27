'use strict';
/**
 * utils/fileStore.js
 * Thin wrapper for reading / writing JSON data files in the data/ directory.
 * Ensures:
 *   – Output directories exist before write
 *   – Files are never silently overwritten (timestamped filenames)
 *   – Atomic writes (write to .tmp then rename)
 */

const fs = require('fs');
const path = require('path');
const createLogger = require('./logger');
const log = createLogger('fileStore');

const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.resolve(__dirname, '..', 'data');

/**
 * Write records to a timestamped JSON file.
 * Supports nested subdirs: subdir='leads/raw' creates data/leads/raw/.
 * The baseName should NOT contain a date — one is appended automatically.
 *
 * @param {string} subdir   e.g. 'raw', 'leads/raw', 'reports', 'outputs'
 * @param {string} baseName e.g. 'listings-rightmove'  (date + .json appended)
 * @param {any}    data     JSON-serialisable value
 * @returns {string} absolute path of written file
 */
function writeData(subdir, baseName, data) {
  const dir = path.join(DATA_DIR, subdir);
  fs.mkdirSync(dir, { recursive: true });

  const date = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  // Avoid double-dating if baseName already ends with YYYY-MM-DD
  const filename = /\d{4}-\d{2}-\d{2}$/.test(baseName)
    ? `${baseName}.json`
    : `${baseName}-${date}.json`;
  const dest = path.join(dir, filename);
  const tmp = `${dest}.tmp`;

  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, dest);

  log.info(`Wrote ${Array.isArray(data) ? data.length : 1} records → ${dest}`);
  return dest;
}

/**
 * Read a JSON file from the data directory.
 * @param {string} subdir
 * @param {string} filename  exact filename (with .json)
 * @returns {any}
 */
function readData(subdir, filename) {
  const filePath = path.join(DATA_DIR, subdir, filename);
  const raw = fs.readFileSync(filePath, 'utf8');
  return JSON.parse(raw);
}

/**
 * List all JSON files in a data subdirectory, newest first.
 * @param {string} subdir
 * @returns {string[]} absolute paths
 */
function listFiles(subdir) {
  const dir = path.join(DATA_DIR, subdir);
  if (!fs.existsSync(dir)) return [];

  return fs.readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => path.join(dir, f))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
}

/**
 * Return a summary of record counts for all data subdirectories.
 * Covers the Square Centimeter pipeline directories.
 * @returns {Record<string, { files: number, latestFile: string|null }>}
 */
function statusSummary() {
  const dirs = [
    'raw',
    'leads/raw',
    'leads/qualified',
    'leads/contacted',
    'reports',
    'outputs',
  ];
  const summary = {};
  for (const d of dirs) {
    const files = listFiles(d);
    summary[d] = {
      files: files.length,
      latestFile: files[0] ? path.basename(files[0]) : null,
    };
  }
  return summary;
}

module.exports = { writeData, readData, listFiles, statusSummary, DATA_DIR };
