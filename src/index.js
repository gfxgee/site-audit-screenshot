#!/usr/bin/env node
import { chromium } from 'playwright';
import { auditSite } from './checker.js';
import { STATUS, buildResult, classify } from './classifier.js';
import { config } from './config.js';
import { readSites, writeReports } from './csv.js';
import { sendTeamsReport } from './teams.js';
import {
  displayHost,
  ensureDir,
  formatDuration,
  formatSeconds,
  runWithConcurrency,
  screenshotFileName,
} from './utils.js';

const EXIT_OK = 0;
const EXIT_EXECUTION_FAILURE = 1;

async function main() {
  const startedAt = Date.now();
  console.log('Website Homepage Audit');
  console.log(
    `viewport ${config.viewport.width}x${config.viewport.height} | ` +
      `concurrency ${config.concurrency} | nav timeout ${config.navigationTimeout}ms`,
  );

  const sites = await readSites(config.sitesFile);
  console.log(`Loaded ${sites.length} site(s) from ${config.sitesFile}\n`);

  await ensureDir(config.artifactsDir);
  await ensureDir(config.screenshotsDir);

  // Pre-compute screenshot names so uniqueness is decided single-threaded.
  const usedNames = new Set();
  const targets = sites.map((url) => ({ url, screenshotFile: screenshotFileName(url, usedNames) }));

  let browser;
  let results = [];

  try {
    browser = await chromium.launch({
      headless: config.headless,
      args: ['--disable-dev-shm-usage', '--no-sandbox'],
    });

    let completed = 0;
    results = await runWithConcurrency(targets, config.concurrency, async (target) => {
      const position = ++completed;
      console.log(`[${position}/${targets.length}] Checking ${target.url}`);

      let result;
      try {
        const observations = await auditSite({
          browser,
          url: target.url,
          screenshotFile: target.screenshotFile,
        });
        result = buildResult(observations, classify(observations));
      } catch (error) {
        // A crash while auditing one site must never stop the others.
        result = auditFailureResult(target.url, error);
        console.error(`   audit error for ${target.url}: ${result.navigationError}`);
      }

      console.log(`   ${formatResultLine(result)}\n`);
      return result;
    });
  } catch (error) {
    // Browser could not start / crashed for everyone: a genuine execution
    // failure. Still write whatever we have before exiting non-zero.
    console.error(`\n[fatal] Playwright/Chromium failure: ${error?.message || error}`);
    await safeWriteReports(results, buildSummary(results, startedAt));
    return EXIT_EXECUTION_FAILURE;
  } finally {
    if (browser) {
      await browser.close().catch(() => {});
    }
  }

  const summary = buildSummary(results, startedAt);
  const reportPaths = await writeReports({
    dir: config.artifactsDir,
    results,
    summary,
  });

  printSummary(results, summary, reportPaths);

  await sendTeamsReport(results, summary);

  return EXIT_OK;
}

function auditFailureResult(url, error) {
  const message = (error?.message || String(error)).split('\n')[0];
  const observations = {
    url,
    finalUrl: null,
    httpStatus: null,
    loadTimeMs: null,
    navigationError: `Audit error: ${message}`,
    navigationErrorType: 'audit-error',
    redirectedTo: null,
    redirectChain: [],
    brokenImages: [],
    jsErrors: [],
    consoleErrors: [],
    failedRequests: [],
    metrics: null,
    screenshotPath: null,
    screenshotError: null,
    ignoredCounts: { jsErrors: 0, consoleErrors: 0, failedRequests: 0, brokenImages: 0 },
    truncated: {},
    checkedAt: new Date().toISOString(),
  };
  return buildResult(observations, classify(observations));
}

function buildSummary(results, startedAt) {
  const count = (status) => results.filter((result) => result?.status === status).length;
  return {
    total: results.length,
    passed: count(STATUS.PASS),
    review: count(STATUS.REVIEW),
    broken: count(STATUS.BROKEN),
    durationMs: Date.now() - startedAt,
    checkedAt: new Date().toISOString(),
    viewport: `${config.viewport.width}x${config.viewport.height}`,
  };
}

/** One-line terminal verdict, e.g. "[PASS] digitalfeet.com - HTTP 200 - 2.3s". */
function formatResultLine(result) {
  const host = displayHost(result.url);
  const parts = [];
  if (typeof result.httpStatus === 'number') parts.push(`HTTP ${result.httpStatus}`);
  if (Number.isFinite(result.loadTimeMs)) parts.push(formatSeconds(result.loadTimeMs));

  if (result.status === STATUS.PASS) {
    return `[PASS] ${host} - ${parts.join(' - ')}`;
  }
  const reason = result.issues?.[0] || 'unspecified issue';
  return `[${result.status}] ${host} - ${[...parts, reason].filter(Boolean).join(' - ')}`;
}

function printSummary(results, summary, reportPaths) {
  console.log('------------------------------------------------------------');
  console.log(
    `Done in ${formatDuration(summary.durationMs)}: ` +
      `${summary.total} checked | ${summary.passed} PASS | ${summary.review} REVIEW | ${summary.broken} BROKEN`,
  );

  for (const result of results) {
    if (!result || result.status === STATUS.PASS) continue;
    console.log(`  ${result.status.padEnd(6)} ${displayHost(result.url)}`);
    for (const issue of result.issues.slice(0, 5)) {
      console.log(`         - ${issue}`);
    }
  }

  console.log(`Reports: ${reportPaths.jsonPath}, ${reportPaths.csvPath}`);
  console.log(`Screenshots: ${config.screenshotsDir}`);
  console.log('------------------------------------------------------------');
}

async function safeWriteReports(results, summary) {
  try {
    await writeReports({ dir: config.artifactsDir, results: results ?? [], summary });
  } catch (error) {
    console.error(`[fatal] Could not write reports: ${error?.message || error}`);
  }
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    console.error(`\n[fatal] ${error?.stack || error?.message || error}`);
    process.exit(EXIT_EXECUTION_FAILURE);
  });
