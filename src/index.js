import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { checkSite } from './checker.js';
import { config } from './config.js';
import { readSites, resultsToCsv } from './csv.js';
import { sendTeamsNotifications } from './teams.js';
import { ensureDirectory, errorMessage, formatDuration, hostLabel, screenshotNames } from './utils.js';

async function runWithConcurrency(items, limit, worker, recover) {
  const results = new Array(items.length);
  let nextIndex = 0;

  async function consume() {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) return;
      try {
        results[index] = await worker(items[index], index);
      } catch (error) {
        if (!recover) throw error;
        results[index] = await recover(error, items[index], index);
      }
    }
  }

  const workerCount = Math.min(Math.max(1, limit), items.length);
  await Promise.all(Array.from({ length: workerCount }, consume));
  return results;
}

async function writeReports(results) {
  await fs.writeFile(path.join(config.artifactsDir, 'results.json'), `${JSON.stringify(results, null, 2)}\n`, 'utf8');
  await fs.writeFile(path.join(config.artifactsDir, 'results.csv'), resultsToCsv(results), 'utf8');
}

function unexpectedResult(url, filename, error) {
  const checkedAt = new Date().toISOString();
  const message = errorMessage(error);
  console.error(`[BROKEN] ${hostLabel(url)} - Unexpected check failure: ${message}`);
  return {
    url, finalUrl: null, status: 'BROKEN', httpStatus: null, loadTimeMs: null,
    navigationError: message, timedOut: false, sslError: false, dnsError: false,
    brokenImages: [], jsErrors: [], consoleErrors: [], failedRequests: [],
    horizontalOverflow: false, suspiciousText: [],
    issues: [`Unexpected check failure: ${message}`],
    screenshotPath: `artifacts/screenshots/${filename}`, screenshotError: null,
    blankPageDetected: false, errorPageDetected: false,
    layout: { overflowPixels: 0, overflowElements: [], suspiciousCollapsed: false },
    pageMetrics: null, checkedAt,
  };
}

async function main() {
  const auditStartedAt = Date.now();
  const urls = await readSites(config.sitesPath);
  const filenames = screenshotNames(urls);
  await ensureDirectory(config.screenshotsDir);

  console.log(`Auditing ${urls.length} homepage${urls.length === 1 ? '' : 's'} with concurrency ${config.concurrency}.`);
  const browser = await chromium.launch({ headless: true });
  let results;

  try {
    results = await runWithConcurrency(urls, config.concurrency, async (url, index) => {
      const label = `[${index + 1}/${urls.length}]`;
      console.log(`${label} Checking ${url}`);
      const screenshotPath = path.join(config.screenshotsDir, filenames[index]);

      const result = await checkSite(browser, url, screenshotPath, config);
      const detail = result.issues[0] ?? `HTTP ${result.httpStatus ?? 'n/a'} - ${formatDuration(result.loadTimeMs ?? 0)}`;
      console.log(`[${result.status}] ${hostLabel(url)} - ${detail}`);
      return result;
    }, (error, url, index) => unexpectedResult(url, filenames[index], error));
  } finally {
    await browser.close();
  }

  await writeReports(results);
  const durationMs = Date.now() - auditStartedAt;
  await sendTeamsNotifications(results, durationMs, config);

  const totals = Object.fromEntries(['PASS', 'REVIEW', 'BROKEN'].map((status) => [status, results.filter((result) => result.status === status).length]));
  console.log(`Audit complete in ${formatDuration(durationMs)}: ${totals.PASS} PASS, ${totals.REVIEW} REVIEW, ${totals.BROKEN} BROKEN.`);
  console.log('Reports: artifacts/results.json and artifacts/results.csv');
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(`Fatal audit error: ${errorMessage(error)}`);
    process.exitCode = 1;
  });
}

export const indexInternals = { runWithConcurrency, unexpectedResult };
