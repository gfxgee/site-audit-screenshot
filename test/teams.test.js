import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { teamsInternals } from '../src/teams.js';

function auditResult(overrides = {}) {
  return {
    url: 'https://www.example.com/', finalUrl: 'https://example.com/', status: 'REVIEW',
    httpStatus: 200, loadTimeMs: 1234, issues: ['JavaScript error'],
    brokenImages: [], jsErrors: ['Example error'], consoleErrors: [], failedRequests: [],
    horizontalOverflow: false, navigationError: null,
    screenshotPath: 'artifacts/screenshots/example-com.png', checkedAt: '2026-08-24T00:00:00.000Z',
    ...overrides,
  };
}

test('issue payload includes website details and the actual screenshot bytes', async () => {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'site-audit-teams-'));
  const screenshotsDir = path.join(projectRoot, 'artifacts', 'screenshots');
  await fs.mkdir(screenshotsDir, { recursive: true });
  await fs.writeFile(path.join(screenshotsDir, 'example-com.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));

  try {
    const payload = await teamsInternals.issuePayload(auditResult(), { projectRoot, screenshotsDir });
    assert.equal(payload.websiteName, 'example.com');
    assert.equal(payload.title, 'REVIEW: example.com');
    assert.equal(payload.jsErrorCount, 1);
    assert.equal(payload.issueText, 'JavaScript error');
    assert.match(payload.detailsText, /Website: example\.com/);
    assert.match(payload.detailsText, /HTTP status: 200/);
    assert.equal(payload.screenshotIncluded, true);
    assert.equal(payload.screenshotContentBase64, 'iVBORw==');
  } finally {
    await fs.rm(projectRoot, { recursive: true, force: true });
  }
});

test('summary payload contains counts and a row for every website', () => {
  const results = [auditResult(), auditResult({
    url: 'https://healthy.example/', finalUrl: 'https://healthy.example/', status: 'PASS', issues: [],
  })];
  const payload = teamsInternals.summaryPayload(results, 2500);
  assert.equal(payload.total, 2);
  assert.equal(payload.passed, 1);
  assert.equal(payload.review, 1);
  assert.equal(payload.broken, 0);
  assert.equal(payload.durationText, '2.5 seconds');
  assert.equal(payload.summaryText, 'Total: 2; Passed: 1; Review: 1; Broken: 0; Duration: 2.5 seconds');
  assert.match(payload.websiteStatusText, /REVIEW: example\.com/);
  assert.match(payload.websiteStatusText, /PASS: healthy\.example/);
  assert.deepEqual(payload.websites.map(({ websiteName }) => websiteName), ['example.com', 'healthy.example']);
});
