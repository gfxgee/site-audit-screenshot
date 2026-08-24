import fs from 'node:fs/promises';
import path from 'node:path';
import { ensureDir } from './utils.js';

/**
 * Read the site list.
 *
 * Accepts a plain one-URL-per-line file or a CSV with a `url` header (any
 * extra columns are ignored). Blank lines and `#` comments are skipped.
 */
export async function readSites(filePath) {
  let raw;
  try {
    raw = await fs.readFile(filePath, 'utf8');
  } catch (error) {
    throw new Error(`Cannot read site list "${filePath}": ${error.message}`);
  }

  const lines = raw
    .replace(/^﻿/, '') // strip UTF-8 BOM (Excel writes one)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'));

  if (lines.length === 0) {
    throw new Error(`Site list "${filePath}" is empty.`);
  }

  // Locate the `url` column when a header row is present.
  let urlIndex = 0;
  let startIndex = 0;
  const header = splitCsvLine(lines[0]).map((cell) => cell.trim().toLowerCase());
  if (header.includes('url')) {
    urlIndex = header.indexOf('url');
    startIndex = 1;
  }

  const seen = new Set();
  const sites = [];
  for (const line of lines.slice(startIndex)) {
    const cells = splitCsvLine(line);
    const value = (cells[urlIndex] ?? '').trim().replace(/^['"]|['"]$/g, '');
    if (!value) continue;

    const url = /^https?:\/\//i.test(value) ? value : `https://${value}`;
    try {
      new URL(url);
    } catch {
      console.warn(`[warn] Skipping invalid URL in ${filePath}: ${value}`);
      continue;
    }
    if (seen.has(url)) continue;
    seen.add(url);
    sites.push(url);
  }

  if (sites.length === 0) {
    throw new Error(`No usable URLs found in "${filePath}".`);
  }
  return sites;
}

/** Minimal RFC-4180-ish line splitter (handles quoted cells with commas). */
function splitCsvLine(line) {
  const cells = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (inQuotes) {
      if (char === '"') {
        if (line[i + 1] === '"') {
          current += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        current += char;
      }
    } else if (char === '"') {
      inQuotes = true;
    } else if (char === ',' || char === ';') {
      cells.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  cells.push(current);
  return cells;
}

function csvCell(value) {
  if (value === null || value === undefined) return '';
  const text = String(value).replace(/\r?\n/g, ' ');
  return /["',;]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export const RESULT_CSV_COLUMNS = [
  'url',
  'finalUrl',
  'status',
  'httpStatus',
  'loadTimeMs',
  'brokenImageCount',
  'jsErrorCount',
  'consoleErrorCount',
  'failedRequestCount',
  'horizontalOverflow',
  'issues',
  'screenshotPath',
  'checkedAt',
];

/** Flatten one result into the summary CSV row shape. */
export function resultToCsvRow(result) {
  return {
    url: result.url,
    finalUrl: result.finalUrl ?? '',
    status: result.status,
    httpStatus: result.httpStatus ?? '',
    loadTimeMs: result.loadTimeMs ?? '',
    brokenImageCount: result.brokenImages?.length ?? 0,
    jsErrorCount: result.jsErrors?.length ?? 0,
    consoleErrorCount: result.consoleErrors?.length ?? 0,
    failedRequestCount: result.failedRequests?.length ?? 0,
    horizontalOverflow: Boolean(result.horizontalOverflow),
    issues: (result.issues ?? []).join(' | '),
    screenshotPath: result.screenshotPath ?? '',
    checkedAt: result.checkedAt ?? '',
  };
}

export function buildResultsCsv(results) {
  const lines = [RESULT_CSV_COLUMNS.join(',')];
  for (const result of results) {
    const row = resultToCsvRow(result);
    lines.push(RESULT_CSV_COLUMNS.map((column) => csvCell(row[column])).join(','));
  }
  return `${lines.join('\n')}\n`;
}

/**
 * Write results.json + results.csv. Always called, even when sites failed, so
 * a partial run still produces readable reports.
 */
export async function writeReports({ dir, results, summary }) {
  await ensureDir(dir);
  const jsonPath = path.join(dir, 'results.json');
  const csvPath = path.join(dir, 'results.csv');

  await fs.writeFile(jsonPath, `${JSON.stringify({ summary, results }, null, 2)}\n`, 'utf8');
  await fs.writeFile(csvPath, buildResultsCsv(results), 'utf8');

  return { jsonPath, csvPath };
}
