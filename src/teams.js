import fs from 'node:fs/promises';
import path from 'node:path';
import { hostLabel } from './utils.js';

function websiteName(result) {
  return hostLabel(result.finalUrl || result.url);
}

async function screenshotFields(result, config) {
  const absolutePath = path.resolve(config.projectRoot, result.screenshotPath);
  const screenshotsRoot = `${path.resolve(config.screenshotsDir)}${path.sep}`.toLowerCase();
  if (!absolutePath.toLowerCase().startsWith(screenshotsRoot)) {
    throw new Error(`Screenshot is outside the configured screenshots directory: ${result.screenshotPath}`);
  }

  try {
    const content = await fs.readFile(absolutePath);
    return {
      screenshotIncluded: true,
      screenshotFileName: path.basename(absolutePath),
      screenshotContentType: 'image/png',
      screenshotContentBase64: content.toString('base64'),
    };
  } catch (error) {
    console.warn(`[Teams] Screenshot unavailable for ${result.url}; sending the alert without image content: ${error.message}`);
    return {
      screenshotIncluded: false,
      screenshotFileName: path.basename(absolutePath),
      screenshotContentType: 'image/png',
      screenshotContentBase64: null,
    };
  }
}

async function issuePayload(result, config) {
  const screenshot = await screenshotFields(result, config);
  const name = websiteName(result);
  const issueText = result.issues.join('; ');
  return {
    type: 'issue',
    title: `${result.status}: ${name}`,
    websiteName: name,
    status: result.status,
    url: result.url,
    finalUrl: result.finalUrl,
    httpStatus: result.httpStatus,
    loadTimeMs: result.loadTimeMs,
    issues: result.issues,
    issueText,
    brokenImageCount: result.brokenImages.length,
    jsErrorCount: result.jsErrors.length,
    consoleErrorCount: result.consoleErrors.length,
    failedRequestCount: result.failedRequests.length,
    horizontalOverflow: result.horizontalOverflow,
    navigationError: result.navigationError,
    screenshotPath: result.screenshotPath,
    ...screenshot,
    checkedAt: result.checkedAt,
    detailsText: [
      `Website: ${name}`,
      `Status: ${result.status}`,
      `Requested URL: ${result.url}`,
      `Final URL: ${result.finalUrl || 'Unavailable'}`,
      `HTTP status: ${result.httpStatus ?? 'Unavailable'}`,
      `Load time: ${result.loadTimeMs ?? 'Unavailable'} ms`,
      `Issues: ${issueText || 'No issue details'}`,
      `Broken images: ${result.brokenImages.length}; JavaScript errors: ${result.jsErrors.length}; Console errors: ${result.consoleErrors.length}; Failed requests: ${result.failedRequests.length}`,
      `Checked: ${result.checkedAt}`,
    ].join('\n'),
  };
}

function summaryPayload(results, durationMs) {
  const passed = results.filter(({ status }) => status === 'PASS').length;
  const review = results.filter(({ status }) => status === 'REVIEW').length;
  const broken = results.filter(({ status }) => status === 'BROKEN').length;
  const websites = results.map((result) => ({
    websiteName: websiteName(result),
    status: result.status,
    url: result.url,
    finalUrl: result.finalUrl,
    httpStatus: result.httpStatus,
    loadTimeMs: result.loadTimeMs,
    issues: result.issues,
    issueText: result.issues.join('; '),
    screenshotPath: result.screenshotPath,
  }));
  return {
    type: 'summary',
    title: 'Website audit summary',
    total: results.length,
    passed,
    review,
    broken,
    checkedAt: new Date().toISOString(),
    durationMs,
    durationText: `${(durationMs / 1000).toFixed(1)} seconds`,
    summaryText: `Total: ${results.length}; Passed: ${passed}; Review: ${review}; Broken: ${broken}; Duration: ${(durationMs / 1000).toFixed(1)} seconds`,
    websiteStatusText: websites.map((site) => (
      `${site.status}: ${site.websiteName} (HTTP ${site.httpStatus ?? 'n/a'}, ${site.loadTimeMs ?? 'n/a'} ms)${site.issueText ? ` — ${site.issueText}` : ''}`
    )).join('\n'),
    websites,
  };
}

async function postJson(webhookUrl, payload, timeout) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);
  } finally {
    clearTimeout(timer);
  }
}

export async function sendTeamsNotifications(results, durationMs, config) {
  const webhookUrl = process.env.TEAMS_WEBHOOK_URL;
  if (!webhookUrl) {
    console.warn('[Teams] TEAMS_WEBHOOK_URL is not configured; notifications skipped.');
    return;
  }

  for (const result of results.filter(({ status }) => status === 'REVIEW' || status === 'BROKEN')) {
    try {
      await postJson(webhookUrl, await issuePayload(result, config), config.teamsTimeout);
    } catch (error) {
      console.error(`[Teams] Could not send ${result.status} notification for ${result.url}: ${error.message}`);
    }
  }

  const summary = summaryPayload(results, durationMs);

  try {
    await postJson(webhookUrl, summary, config.teamsTimeout);
  } catch (error) {
    console.error(`[Teams] Could not send audit summary: ${error.message}`);
  }
}

export const teamsInternals = { issuePayload, postJson, screenshotFields, summaryPayload, websiteName };
