import assert from 'node:assert/strict';
import test from 'node:test';
import { withTimeout } from '../src/utils.js';
import { indexInternals } from '../src/index.js';

const { runWithConcurrency, unexpectedResult } = indexInternals;

test('withTimeout resolves a fast promise untouched', async () => {
  assert.equal(await withTimeout(Promise.resolve('ok'), 1000, 'fast'), 'ok');
});

test('withTimeout rejects a stalled promise with a labelled error', async () => {
  const neverSettles = new Promise(() => {});
  await assert.rejects(
    () => withTimeout(neverSettles, 40, 'Page inspection'),
    /Page inspection exceeded 40ms/,
  );
});

test('withTimeout propagates the original rejection', async () => {
  await assert.rejects(
    () => withTimeout(Promise.reject(new Error('boom')), 1000, 'x'),
    /boom/,
  );
});

test('withTimeout clears its timer so the process can exit', async () => {
  // A leaked timer would keep the event loop alive; node:test would hang.
  for (let i = 0; i < 5; i += 1) {
    await withTimeout(Promise.resolve(i), 60_000, 'quick');
  }
  assert.ok(true);
});

test('a stalled site is recorded BROKEN and the run continues', async () => {
  const urls = ['https://fast-1.com/', 'https://stalls.com/', 'https://fast-2.com/'];
  const siteTimeout = 50;

  const results = await runWithConcurrency(
    urls,
    2,
    async (url, index) => withTimeout(
      url === 'https://stalls.com/' ? new Promise(() => {}) : Promise.resolve({ url, status: 'PASS', issues: [] }),
      siteTimeout,
      `Audit of ${url}`,
    ),
    (error, url, index) => unexpectedResult(url, `site-${index}.png`, error),
  );

  assert.equal(results.length, 3, 'every site produces a result');
  assert.equal(results[0].status, 'PASS');
  assert.equal(results[2].status, 'PASS', 'a stalled site does not block later sites');

  const stalled = results[1];
  assert.equal(stalled.status, 'BROKEN');
  assert.equal(stalled.url, 'https://stalls.com/');
  assert.match(stalled.issues[0], /exceeded 50ms/);
  assert.match(stalled.navigationError, /Audit of https:\/\/stalls\.com\//);
});
