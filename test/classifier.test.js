import assert from 'node:assert/strict';
import test from 'node:test';
import { classify, isIgnoredUrl, isMeaningfulConsole } from '../src/classifier.js';

function result(overrides = {}) {
  return {
    url: 'https://example.com/', finalUrl: 'https://example.com/', httpStatus: 200,
    navigationError: null, errorPageDetected: false, blankPageDetected: false,
    brokenImages: [], failedRequests: [], jsErrors: [], consoleErrors: [],
    horizontalOverflow: false, screenshotError: null,
    layout: { overflowPixels: 0, suspiciousCollapsed: false }, ...overrides,
  };
}

test('passes a healthy homepage', () => {
  assert.deepEqual(classify(result()), { status: 'PASS', issues: [] });
});

test('marks navigation failures and 5xx responses broken', () => {
  assert.equal(classify(result({ navigationError: 'ERR_NAME_NOT_RESOLVED' })).status, 'BROKEN');
  assert.equal(classify(result({ httpStatus: 503 })).status, 'BROKEN');
});

test('marks meaningful first-party failures for review', () => {
  const classification = classify(result({
    failedRequests: [{ url: 'https://example.com/app.js', status: 500, failure: '', resourceType: 'script' }],
  }));
  assert.equal(classification.status, 'REVIEW');
});

test('ignores common tracker and favicon failures', () => {
  assert.equal(isIgnoredUrl('https://www.google-analytics.com/g/collect'), true);
  assert.equal(isIgnoredUrl('https://example.com/favicon.ico'), true);
  const classification = classify(result({
    failedRequests: [{ url: 'https://www.google-analytics.com/g/collect', status: 0, failure: 'blocked', resourceType: 'fetch' }],
  }));
  assert.equal(classification.status, 'PASS');
});

test('ignores browser privacy noise and console errors from known trackers', () => {
  assert.equal(isMeaningfulConsole({ text: 'requestStorageAccess: Permission denied.', location: {} }), false);
  assert.equal(isMeaningfulConsole({
    text: 'Failed to load resource: net::ERR_CERT_COMMON_NAME_INVALID',
    location: { url: 'https://embed.tawk.to/example/default' },
  }), false);
});

test('does not review normally aborted first-party autoplay media', () => {
  const classification = classify(result({
    failedRequests: [{
      url: 'https://example.com/intro.mp4', status: 0, failure: 'net::ERR_ABORTED', resourceType: 'media',
    }],
  }));
  assert.equal(classification.status, 'PASS');
});

test('reviews a first-party image request failure even when no rendered image remains', () => {
  const classification = classify(result({
    failedRequests: [{
      url: 'https://example.com/removed-image.jpg', status: 404, failure: '', resourceType: 'image',
    }],
  }));
  assert.equal(classification.status, 'REVIEW');
});
