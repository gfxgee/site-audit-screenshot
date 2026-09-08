import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { checkSite } from './checker.js';
import { config } from './config.js';
import { readSites, resultsToCsv } from './csv.js';
import { sendEmailReport } from './email.js';
import { ensureDirectory, errorMessage, formatDuration, hostLabel, screenshotNames, withTimeout } from './utils.js';

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
    emailImagePath: null, emailImageError: null, lazyScrollError: null,
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

      // Hard per-site ceiling. NAVIGATION_TIMEOUT only bounds page.goto, so
      // without this one unresponsive page stalls a worker until the GitHub
      // job hits its own 30-minute limit and cancels the whole run.
      const result = await withTimeout(
        checkSite(browser, url, screenshotPath, config),
        config.siteTimeout,
        `Audit of ${url}`,
      );
      const detail = result.issues[0] ?? `HTTP ${result.httpStatus ?? 'n/a'} - ${formatDuration(result.loadTimeMs ?? 0)}`;
      console.log(`[${result.status}] ${hostLabel(url)} - ${detail}`);
      return result;
    }, (error, url, index) => unexpectedResult(url, filenames[index], error));
  } finally {
    // A site abandoned by the per-site timeout can leave a context mid-call,
    // which makes browser.close() itself hang. Bound it too.
    await withTimeout(browser.close(), 30_000, 'Browser close').catch((error) => {
      console.warn(`Browser did not close cleanly: ${errorMessage(error)}`);
    });
  }

  await writeReports(results);
  const durationMs = Date.now() - auditStartedAt;

  const emailStartedAt = Date.now();
  await sendEmailReport(results, durationMs, config);
  console.log(`Email step took ${formatDuration(Date.now() - emailStartedAt)}.`);

  const totals = Object.fromEntries(['PASS', 'REVIEW', 'BROKEN'].map((status) => [status, results.filter((result) => result.status === status).length]));
  console.log(`Audit complete in ${formatDuration(durationMs)}: ${totals.PASS} PASS, ${totals.REVIEW} REVIEW, ${totals.BROKEN} BROKEN.`);
  console.log('Reports: artifacts/results.json and artifacts/results.csv');
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main()
    .catch((error) => {
      console.error(`Fatal audit error: ${errorMessage(error)}`);
      process.exitCode = 1;
    })
    .finally(async () => {
      // Exit explicitly. An abandoned Chromium child process can keep the
      // event loop alive indefinitely, which previously let the GitHub job
      // run to its 30-minute ceiling after the audit had already finished.
      // Flush stdout first so the final lines are not truncated.
      await new Promise((resolve) => process.stdout.write('', resolve));
      process.exit(process.exitCode ?? 0);
    });
}

export const indexInternals = { runWithConcurrency, unexpectedResult };
