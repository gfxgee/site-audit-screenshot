import assert from 'node:assert/strict';
import test from 'node:test';
import { classify, scoreBlankPage } from '../src/classifier.js';

function result(overrides = {}) {
  return {
    url: 'https://example.com/', finalUrl: 'https://example.com/', httpStatus: 200,
    navigationError: null, errorPageDetected: false, blankPageDetected: false,
    thinPageDetected: false, blankSignals: [],
    redirectLoop: false, redirectedOffDomain: false, redirectCount: 0,
    brokenImages: [], failedRequests: [], jsErrors: [], consoleErrors: [],
    horizontalOverflow: false, screenshotError: null,
    layout: { overflowPixels: 0, suspiciousCollapsed: false }, ...overrides,
  };
}

test('JavaScript errors no longer set the status', () => {
  const classification = classify(result({
    jsErrors: ['ReferenceError: jQuery is not defined', 'TypeError: undefined is not a function'],
  }));
  assert.equal(classification.status, 'PASS');
  assert.deepEqual(classification.issues, []);
});

test('console errors no longer set the status', () => {
  const classification = classify(result({
    consoleErrors: [{ text: 'eapps.Platform throws: APP_VIEWS_LIMIT_REACHED', location: {} }],
  }));
  assert.equal(classification.status, 'PASS');
});

test('failed font requests are ignored (fallback font is not an incident)', () => {
  // marstrand.no references nine Segoe UI files its theme never shipped.
  const failedRequests = Array.from({ length: 9 }, (_, i) => ({
    url: `https://example.com/wp-content/uploads/avia_fonts/segoeui-${i}.ttf`,
    status: 0, failure: 'net::ERR_FAILED', resourceType: 'font',
  }));
  assert.equal(classify(result({ failedRequests })).status, 'PASS');
});

test('background fetch/xhr failures are ignored', () => {
  for (const resourceType of ['fetch', 'xhr']) {
    const classification = classify(result({
      failedRequests: [{ url: 'https://example.com/api/thing', status: 500, failure: '', resourceType }],
    }));
    assert.equal(classification.status, 'PASS', resourceType);
  }
});

test('rendering-relevant first-party failures still review', () => {
  for (const resourceType of ['script', 'stylesheet', 'image']) {
    const classification = classify(result({
      failedRequests: [{ url: 'https://example.com/thing', status: 404, failure: '', resourceType }],
    }));
    assert.equal(classification.status, 'REVIEW', resourceType);
  }
});

test('a redirect loop is BROKEN', () => {
  const classification = classify(result({
    navigationError: 'page.goto: net::ERR_TOO_MANY_REDIRECTS at https://example.com/',
    redirectLoop: true, httpStatus: null,
  }));
  assert.equal(classification.status, 'BROKEN');
  assert.ok(classification.issues.some((i) => /Redirect loop/.test(i)));
});

test('redirecting off-domain is BROKEN even on a 200', () => {
  const classification = classify(result({
    finalUrl: 'https://parking.sedoparking.com/example.com', redirectedOffDomain: true, httpStatus: 200,
  }));
  assert.equal(classification.status, 'BROKEN');
  assert.ok(classification.issues.some((i) => /redirects off-domain/.test(i)));
});

test('a normal http->https->www redirect chain stays PASS', () => {
  assert.equal(classify(result({ redirectCount: 2, redirectedTo: 'https://www.example.com/' })).status, 'PASS');
});

test('an excessive redirect chain reviews', () => {
  assert.equal(classify(result({ redirectCount: 7 })).status, 'REVIEW');
});

// --- blank scoring -------------------------------------------------------

test('a truly empty page scores blank', () => {
  const { blank } = scoreBlankPage({
    visibleTextLength: 0, meaningfulElementCount: 0, imageCount: 0,
    majorContainerCount: 0, documentHeight: 150, innerHeight: 900, title: '', bodyVisible: true,
  });
  assert.equal(blank, true);
});

test('a hidden body scores blank', () => {
  const { blank } = scoreBlankPage({
    visibleTextLength: 4000, meaningfulElementCount: 200, imageCount: 30,
    majorContainerCount: 10, documentHeight: 6000, innerHeight: 900, title: 'Home', bodyVisible: false,
  });
  assert.equal(blank, true);
});

test('a header-only partial render is caught, which the old rule missed', () => {
  // Old rule needed text<40 AND elements<2 AND images===0 AND short page.
  const metrics = {
    visibleTextLength: 30, meaningfulElementCount: 5, imageCount: 1,
    majorContainerCount: 1, documentHeight: 200, innerHeight: 900, title: 'Home', bodyVisible: true,
  };
  const { blank, thin, score } = scoreBlankPage(metrics);
  assert.ok(blank || thin, `expected a flag, got score ${score}`);
});

test('a deliberately minimal landing page is NOT flagged', () => {
  const { blank, thin } = scoreBlankPage({
    visibleTextLength: 220, meaningfulElementCount: 8, imageCount: 1,
    majorContainerCount: 2, documentHeight: 900, innerHeight: 900, title: 'Coming soon', bodyVisible: true,
  });
  assert.equal(blank, false);
  assert.equal(thin, false);
});

test('every real monitored homepage scores healthy', () => {
  // Shapes taken from an actual 13-site run.
  const real = [
    { visibleTextLength: 1046, meaningfulElementCount: 40, imageCount: 11, majorContainerCount: 6, documentHeight: 2379 },
    { visibleTextLength: 3448, meaningfulElementCount: 90, imageCount: 52, majorContainerCount: 8, documentHeight: 5601 },
    { visibleTextLength: 9394, meaningfulElementCount: 120, imageCount: 72, majorContainerCount: 9, documentHeight: 9655 },
  ];
  for (const metrics of real) {
    const { blank, thin } = scoreBlankPage({ ...metrics, innerHeight: 900, title: 'Home', bodyVisible: true });
    assert.equal(blank, false);
    assert.equal(thin, false);
  }
});
