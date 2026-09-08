import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { buildSubject, buildText, collectAttachments, emailInternals, sendEmailReport } from '../src/email.js';

const { buildHtml } = emailInternals;

function makeResult(overrides = {}) {
  return {
    url: 'https://example.com/',
    finalUrl: 'https://example.com/',
    status: 'PASS',
    httpStatus: 200,
    loadTimeMs: 1200,
    issues: [],
    brokenImages: [],
    jsErrors: [],
    consoleErrors: [],
    failedRequests: [],
    screenshotPath: 'artifacts/screenshots/example-com.png',
    emailImagePath: null,
    checkedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function makeConfig(projectRoot, overrides = {}) {
  return {
    projectRoot,
    email: {
      apiKey: 'test-key',
      apiBase: 'http://127.0.0.1:1/unused',
      from: 'onboarding@resend.dev',
      to: ['dev@example.com'],
      subjectPrefix: 'Homepage audit',
      timeout: 5000,
      jpegQuality: 70,
      attachmentBudgetMb: 12,
      inlineScreenshots: 'all',
      ...overrides,
    },
  };
}

test('subject summarises problems, or says all clear', () => {
  const config = makeConfig('/tmp');
  assert.equal(
    buildSubject([makeResult(), makeResult()], config),
    'Homepage audit: all 2 sites OK',
  );
  assert.equal(
    buildSubject([makeResult(), makeResult({ status: 'BROKEN' }), makeResult({ status: 'REVIEW' })], config),
    'Homepage audit: 1 broken, 1 to review of 3 sites',
  );
});

test('plain-text body lists every site and each issue', () => {
  const results = [
    makeResult({ url: 'https://ok.com/', finalUrl: 'https://ok.com/' }),
    makeResult({
      url: 'https://bad.com/', finalUrl: 'https://bad.com/', status: 'BROKEN',
      httpStatus: 500, issues: ['Homepage returned HTTP 500', 'Error page detected'],
    }),
  ];
  const body = buildText(results, 31_200);
  assert.match(body, /1 PASS, 0 REVIEW, 1 BROKEN/);
  assert.match(body, /Homepage returned HTTP 500/);
  assert.match(body, /Error page detected/);
  assert.match(body, /ok\.com/);
  assert.match(body, /bad\.com/);
});

test('html escapes site-controlled text so a page title cannot inject markup', () => {
  const results = [makeResult({ status: 'REVIEW', issues: ['<script>alert(1)</script>'] })];
  const html = buildHtml(results, 1000, { skipped: [] }, makeConfig('/tmp'));
  assert.ok(!html.includes('<script>alert(1)</script>'));
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
});

test('attachments are ordered BROKEN, then REVIEW, then PASS', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'email-order-'));
  const write = async (name) => {
    await fs.writeFile(path.join(dir, name), Buffer.alloc(1024, 1));
    return name;
  };
  const results = [
    makeResult({ url: 'https://p.com/', finalUrl: 'https://p.com/', emailImagePath: await write('p.jpg') }),
    makeResult({ url: 'https://b.com/', finalUrl: 'https://b.com/', status: 'BROKEN', emailImagePath: await write('b.jpg') }),
    makeResult({ url: 'https://r.com/', finalUrl: 'https://r.com/', status: 'REVIEW', emailImagePath: await write('r.jpg') }),
  ];

  const { attachments, skipped } = await collectAttachments(results, makeConfig(dir));
  assert.deepEqual(attachments.map((a) => a.filename), ['b.jpg', 'r.jpg', 'p.jpg']);
  assert.equal(skipped.length, 0);
  assert.equal(attachments[0].content_type, 'image/jpeg');
  assert.ok(attachments[0].content_id.startsWith('shot-'));
});

test('the attachment budget drops healthy sites first and records why', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'email-budget-'));
  const big = 700 * 1024;
  await fs.writeFile(path.join(dir, 'broken.jpg'), Buffer.alloc(big, 1));
  await fs.writeFile(path.join(dir, 'pass.jpg'), Buffer.alloc(big, 1));

  const results = [
    makeResult({ url: 'https://pass.com/', finalUrl: 'https://pass.com/', emailImagePath: 'pass.jpg' }),
    makeResult({ url: 'https://broken.com/', finalUrl: 'https://broken.com/', status: 'BROKEN', emailImagePath: 'broken.jpg' }),
  ];

  // Budget fits exactly one of the two files.
  const { attachments, skipped } = await collectAttachments(results, makeConfig(dir, { attachmentBudgetMb: 1 }));
  assert.deepEqual(attachments.map((a) => a.filename), ['broken.jpg']);
  assert.equal(skipped.length, 1);
  assert.equal(skipped[0].name, 'pass.com');
  assert.match(skipped[0].reason, /attachment limit/);
});

test('a missing screenshot is reported, not fatal', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'email-missing-'));
  const results = [
    makeResult({ emailImagePath: null }),
    makeResult({ url: 'https://gone.com/', finalUrl: 'https://gone.com/', emailImagePath: 'nope.jpg' }),
  ];
  const { attachments, skipped } = await collectAttachments(results, makeConfig(dir));
  assert.equal(attachments.length, 0);
  assert.equal(skipped.length, 2);
  assert.match(skipped[0].reason, /no screenshot captured/);
  assert.match(skipped[1].reason, /unreadable/);
});

test('missing configuration skips sending instead of throwing', async () => {
  const noKey = makeConfig('/tmp', { apiKey: '' });
  assert.deepEqual(await sendEmailReport([makeResult()], 1000, noKey), { skipped: true });

  const noRecipient = makeConfig('/tmp', { to: [] });
  assert.deepEqual(await sendEmailReport([makeResult()], 1000, noRecipient), { skipped: true });
});

test('sends one digest with the expected Resend request shape', async () => {
  const http = await import('node:http');
  const received = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      received.push({ url: req.url, method: req.method, auth: req.headers.authorization, body: JSON.parse(body) });
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ id: 'email_123' }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'email-send-'));
  await fs.writeFile(path.join(dir, 'a.jpg'), Buffer.alloc(2048, 7));
  const results = [
    makeResult({ emailImagePath: 'a.jpg' }),
    makeResult({ url: 'https://r.com/', finalUrl: 'https://r.com/', status: 'REVIEW', issues: ['2 broken images'] }),
  ];

  const config = makeConfig(dir, { apiBase: `http://127.0.0.1:${port}`, to: ['a@example.com', 'b@example.com'] });
  const outcome = await sendEmailReport(results, 31_200, config);
  server.close();

  assert.deepEqual(outcome, { skipped: false, sent: true, attachments: 1 });
  assert.equal(received.length, 1, 'exactly one digest email');
  const [request] = received;
  assert.equal(request.method, 'POST');
  assert.equal(request.url, '/emails');
  assert.equal(request.auth, 'Bearer test-key');
  assert.deepEqual(request.body.to, ['a@example.com', 'b@example.com']);
  assert.equal(request.body.from, 'onboarding@resend.dev');
  assert.match(request.body.subject, /1 to review of 2 sites/);
  assert.equal(request.body.attachments.length, 1);
  assert.match(request.body.html, /Full-page screenshots/);
  assert.match(request.body.html, /2 broken images/);
  assert.ok(request.body.text.includes('2 broken images'));
});

test('a Resend error is swallowed so the audit still succeeds', async () => {
  const http = await import('node:http');
  const server = http.createServer((req, res) => {
    res.writeHead(422, { 'content-type': 'application/json' })
      .end(JSON.stringify({ message: 'domain is not verified' }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  const config = makeConfig(os.tmpdir(), { apiBase: `http://127.0.0.1:${port}` });
  const outcome = await sendEmailReport([makeResult()], 1000, config);
  server.close();
  assert.deepEqual(outcome, { skipped: false, sent: false });
});

test('EMAIL_INLINE_SCREENSHOTS controls inline embedding, never attachments', () => {
  const results = [
    makeResult({ url: 'https://ok.com/', finalUrl: 'https://ok.com/', emailImagePath: 'ok.jpg' }),
    makeResult({ url: 'https://bad.com/', finalUrl: 'https://bad.com/', status: 'BROKEN', emailImagePath: 'bad.jpg' }),
  ];
  const render = (inlineScreenshots) =>
    buildHtml(results, 1000, { skipped: [] }, makeConfig('/tmp', { inlineScreenshots }));

  const all = render('all');
  assert.equal((all.match(/<img src="cid:/g) || []).length, 2);

  const issues = render('issues');
  assert.equal((issues.match(/<img src="cid:/g) || []).length, 1);
  assert.match(issues, /cid:shot-bad-jpg/);

  const none = render('none');
  assert.equal((none.match(/<img src="cid:/g) || []).length, 0);
  assert.ok(!none.includes('Full-page screenshots</h2>'));

  // The attachment promise in the body must hold in every mode.
  for (const html of [all, issues, none]) {
    assert.match(html, /All 2 full-page screenshots are attached/);
  }
});
