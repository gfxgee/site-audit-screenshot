import path from 'node:path';
import { config } from './config.js';
import {
  IGNORED_RESOURCE_TYPES,
  isIgnoredConsoleMessage,
  isIgnoredFailureReason,
  isIgnoredRequestUrl,
} from './ignore-list.js';
import { capList, ensureDir, isFirstParty, sleep, toPosixPath, truncate } from './utils.js';

/**
 * Audit a single homepage.
 *
 * Returns raw observations only — no PASS/REVIEW/BROKEN decision is made here.
 * Classification lives in `classifier.js` so the rules stay easy to tune.
 */
export async function auditSite({ browser, url, screenshotFile }) {
  const startedAt = Date.now();
  const observations = {
    url,
    finalUrl: null,
    httpStatus: null,
    statusText: null,
    redirectedTo: null,
    redirectChain: [],
    navigationError: null,
    navigationErrorType: null,
    timedOut: false,
    loadTimeMs: null,
    jsErrors: [],
    consoleErrors: [],
    failedRequests: [],
    brokenImages: [],
    ignoredCounts: { jsErrors: 0, consoleErrors: 0, failedRequests: 0, brokenImages: 0 },
    truncated: {},
    metrics: null,
    screenshotPath: null,
    screenshotError: null,
    checkedAt: new Date().toISOString(),
  };

  const jsErrors = [];
  const consoleErrors = [];
  const failedRequests = [];
  const imageRequestFailures = new Map();
  let ignoredConsole = 0;
  let ignoredRequests = 0;
  let ignoredJsErrors = 0;

  let context;
  let page;

  try {
    context = await browser.newContext({
      viewport: { width: config.viewport.width, height: config.viewport.height },
      userAgent: config.userAgent,
      locale: config.locale,
      timezoneId: config.timezone,
      deviceScaleFactor: 1,
      ignoreHTTPSErrors: false, // certificate problems are real findings
      serviceWorkers: 'block', // keeps request accounting predictable
    });
    context.setDefaultTimeout(config.navigationTimeout);
    context.setDefaultNavigationTimeout(config.navigationTimeout);

    page = await context.newPage();

    // --- instrumentation -------------------------------------------------
    page.on('pageerror', (error) => {
      const stack = error?.stack || '';
      // An analytics or ad script throwing inside its own file is that
      // vendor's problem, not a defect in the homepage being audited.
      const origin = firstUrlInStack(stack);
      if (origin && isIgnoredRequestUrl(origin)) {
        ignoredJsErrors += 1;
        return;
      }
      jsErrors.push({
        name: error?.name || 'Error',
        message: truncate(error?.message || String(error), 400),
        stack: truncate(stack.split('\n').slice(0, 3).join(' | '), 400),
        source: origin ? truncate(origin, 300) : null,
      });
    });

    page.on('console', (message) => {
      if (message.type() !== 'error') return;
      const text = message.text();
      const location = message.location()?.url || '';
      if (isIgnoredConsoleMessage(text, location)) {
        ignoredConsole += 1;
        return;
      }
      consoleErrors.push({
        text: truncate(text, 400),
        location: truncate(location, 300),
      });
    });

    page.on('requestfailed', (request) => {
      const failure = request.failure()?.errorText || 'request failed';
      const requestUrl = request.url();
      if (
        IGNORED_RESOURCE_TYPES.includes(request.resourceType()) ||
        isIgnoredFailureReason(failure) ||
        isIgnoredRequestUrl(requestUrl)
      ) {
        ignoredRequests += 1;
        return;
      }
      const entry = {
        url: truncate(requestUrl, 400),
        method: request.method(),
        resourceType: request.resourceType(),
        status: null,
        failure: truncate(failure, 200),
      };
      failedRequests.push(entry);
      if (request.resourceType() === 'image') {
        imageRequestFailures.set(requestUrl, failure);
      }
    });

    page.on('response', (response) => {
      const status = response.status();
      if (status < 400) return;

      const request = response.request();
      const requestUrl = response.url();
      // The main document status is reported separately as `httpStatus`.
      if (request.resourceType() === 'document' && request.isNavigationRequest()) return;
      if (IGNORED_RESOURCE_TYPES.includes(request.resourceType()) || isIgnoredRequestUrl(requestUrl)) {
        ignoredRequests += 1;
        return;
      }
      failedRequests.push({
        url: truncate(requestUrl, 400),
        method: request.method(),
        resourceType: request.resourceType(),
        status,
        failure: '',
      });
      if (request.resourceType() === 'image') {
        imageRequestFailures.set(requestUrl, `HTTP ${status}`);
      }
    });

    // --- navigation ------------------------------------------------------
    let response = null;
    try {
      response = await page.goto(url, {
        waitUntil: 'domcontentloaded',
        timeout: config.navigationTimeout,
      });
    } catch (error) {
      const message = error?.message || String(error);
      observations.navigationError = truncate(message.split('\n')[0], 400);
      observations.navigationErrorType = classifyNavigationError(message);
      observations.timedOut = observations.navigationErrorType === 'timeout';
    }

    observations.loadTimeMs = Date.now() - startedAt;

    if (response) {
      observations.httpStatus = response.status();
      observations.statusText = response.statusText() || null;
      observations.redirectChain = collectRedirectChain(response);
    }

    try {
      observations.finalUrl = page.url();
    } catch {
      observations.finalUrl = null;
    }
    if (observations.finalUrl && normalizeUrl(observations.finalUrl) !== normalizeUrl(url)) {
      observations.redirectedTo = observations.finalUrl;
    }

    const documentReachable = Boolean(observations.finalUrl) && observations.finalUrl !== 'about:blank';

    if (documentReachable) {
      // Let the initial render settle before touching the page.
      await sleep(config.postLoadWait);
      await safeCall(() => page.waitForLoadState('load', { timeout: 5000 }));

      if (config.lazyScroll.enabled) {
        await triggerLazyContent(page);
      }

      await sleep(config.finalRenderWait);

      observations.metrics = await collectPageMetrics(page);

      // --- screenshot ---------------------------------------------------
      const screenshotPath = path.join(config.screenshotsDir, screenshotFile);
      await ensureDir(path.dirname(screenshotPath));
      try {
        await page.screenshot({
          path: screenshotPath,
          fullPage: true,
          animations: 'disabled',
          scale: 'css',
          timeout: config.screenshotTimeout,
        });
        observations.screenshotPath = toPosixPath(screenshotPath);
      } catch (error) {
        // Extremely tall pages can defeat full-page capture; a viewport-only
        // screenshot is still better than none for triage.
        observations.screenshotError = truncate(error?.message || String(error), 300);
        try {
          await page.screenshot({ path: screenshotPath, fullPage: false, timeout: 15000 });
          observations.screenshotPath = toPosixPath(screenshotPath);
        } catch {
          observations.screenshotPath = null;
        }
      }
    }

    // Merge network-level image failures into the broken-image list.
    const domBrokenImages = observations.metrics?.brokenImages ?? [];
    observations.brokenImages = mergeBrokenImages(domBrokenImages, imageRequestFailures, url);
    observations.ignoredCounts.brokenImages = Math.max(
      0,
      domBrokenImages.length + imageRequestFailures.size - observations.brokenImages.length,
    );
  } finally {
    await safeCall(() => page?.close());
    await safeCall(() => context?.close());
  }

  // --- annotate + cap ----------------------------------------------------
  const baseUrl = observations.finalUrl || url;
  const annotatedFailures = dedupeFailures(failedRequests).map((entry) => ({
    ...entry,
    firstParty: isFirstParty(entry.url, baseUrl),
  }));

  const capped = {
    jsErrors: capList(dedupeJsErrors(jsErrors), config.maxJsErrors),
    consoleErrors: capList(dedupeConsoleErrors(consoleErrors), config.maxConsoleErrors),
    failedRequests: capList(annotatedFailures, config.maxFailedRequests),
    brokenImages: capList(observations.brokenImages, config.maxBrokenImages),
  };

  observations.jsErrors = capped.jsErrors.items;
  observations.consoleErrors = capped.consoleErrors.items;
  observations.failedRequests = capped.failedRequests.items;
  observations.brokenImages = capped.brokenImages.items;
  observations.truncated = Object.fromEntries(
    Object.entries(capped)
      .filter(([, value]) => value.truncated > 0)
      .map(([key, value]) => [key, value.truncated]),
  );
  observations.ignoredCounts.consoleErrors = ignoredConsole;
  observations.ignoredCounts.failedRequests = ignoredRequests;
  observations.ignoredCounts.jsErrors = ignoredJsErrors;
  observations.loadTimeMs ??= Date.now() - startedAt;

  return observations;
}

/**
 * Scroll gradually to the bottom to trigger lazy-loaded homepage content,
 * then return to the top. Nothing is clicked and no menus are opened.
 */
async function triggerLazyContent(page) {
  const { stepDelay, stepRatio, maxSteps } = config.lazyScroll;
  try {
    const step = Math.max(200, Math.round(config.viewport.height * stepRatio));
    for (let i = 0; i < maxSteps; i += 1) {
      const atBottom = await page.evaluate((delta) => {
        window.scrollBy(0, delta);
        const scrolled = window.scrollY + window.innerHeight;
        const total = Math.max(
          document.documentElement.scrollHeight,
          document.body ? document.body.scrollHeight : 0,
        );
        return scrolled >= total - 2;
      }, step);
      await sleep(stepDelay);
      if (atBottom) break;
    }
    await page.evaluate(() => window.scrollTo(0, 0));
    await sleep(stepDelay);
  } catch {
    // A page that navigates away or closes mid-scroll is handled by the
    // navigation/metrics checks; scrolling itself is best-effort.
  }
}

/** Collect blank-page, layout and broken-image signals from the rendered DOM. */
async function collectPageMetrics(page) {
  const options = {
    overshootPx: config.thresholds.oversizedElementOvershootPx,
    maxOversized: config.maxOversizedElements,
    maxImages: config.maxBrokenImages * 2,
    textScanLength: config.thresholds.errorTextScanLength,
  };

  try {
    return await page.evaluate((opts) => {
      const doc = document;
      const body = doc.body;
      const html = doc.documentElement;
      const bodyStyle = body ? window.getComputedStyle(body) : null;

      const bodyVisible = Boolean(
        body &&
          bodyStyle &&
          bodyStyle.display !== 'none' &&
          bodyStyle.visibility !== 'hidden' &&
          Number(bodyStyle.opacity) !== 0,
      );

      const visibleText = body ? (body.innerText || '').replace(/\s+/g, ' ').trim() : '';

      const meaningfulElements = doc.querySelectorAll(
        'p, h1, h2, h3, h4, h5, li, img, picture, svg, video, a, button, input, textarea, select, table, form, section, article, iframe',
      ).length;
      const majorContainers = doc.querySelectorAll(
        'main, header, footer, nav, section, article, [role="main"], #main, #content, .content, .container',
      ).length;

      const innerWidth = window.innerWidth;
      const innerHeight = window.innerHeight;
      const scrollWidth = html.scrollWidth;
      const bodyScrollWidth = body ? body.scrollWidth : 0;
      const documentHeight = Math.max(html.scrollHeight, body ? body.scrollHeight : 0);

      // --- broken images -------------------------------------------------
      const brokenImages = [];
      const images = Array.from(doc.images || []);
      for (const img of images) {
        if (brokenImages.length >= opts.maxImages) break;
        const src = img.currentSrc || img.getAttribute('src') || '';
        if (!src) continue; // empty src carries no signal
        if (src.startsWith('data:')) continue; // inline image
        if (!img.complete) continue; // still loading / lazy, never resolved
        if (img.naturalWidth > 0) continue; // loaded fine

        const rect = img.getBoundingClientRect();
        const style = window.getComputedStyle(img);
        const hidden =
          style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0;
        const attrWidth = Number(img.getAttribute('width')) || 0;
        const attrHeight = Number(img.getAttribute('height')) || 0;
        const tracker = (attrWidth > 0 && attrWidth <= 3) || (attrHeight > 0 && attrHeight <= 3);
        const lazy = (img.getAttribute('loading') || '').toLowerCase() === 'lazy';
        const hasBox = rect.width > 1 && rect.height > 1;
        const sized = attrWidth > 3 || attrHeight > 3;

        brokenImages.push({
          src,
          alt: img.getAttribute('alt') || '',
          reason: 'naturalWidth=0',
          meaningful: !hidden && !tracker && (hasBox || sized || !lazy),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
        });
      }

      // --- oversized elements --------------------------------------------
      const clippedByAncestor = (element) => {
        let node = element.parentElement;
        let depth = 0;
        while (node && node !== html && depth < 40) {
          const style = window.getComputedStyle(node);
          const overflowX = style.overflowX || style.overflow;
          if (overflowX === 'hidden' || overflowX === 'clip' || overflowX === 'auto') return true;
          node = node.parentElement;
          depth += 1;
        }
        return false;
      };

      const oversizedElements = [];
      const candidates = body ? Array.from(body.querySelectorAll('*')).slice(0, 3000) : [];
      for (const element of candidates) {
        if (oversizedElements.length >= opts.maxOversized) break;
        const rect = element.getBoundingClientRect();
        // Only large, visible blocks matter — ignore tiny decorative overhang.
        if (rect.width < 240 || rect.height < 80) continue;
        const overshootRight = rect.right - innerWidth;
        const overshootLeft = -rect.left;
        const overshoot = Math.max(overshootRight, overshootLeft);
        if (overshoot < opts.overshootPx) continue;
        const style = window.getComputedStyle(element);
        if (
          style.display === 'none' ||
          style.visibility === 'hidden' ||
          Number(style.opacity) === 0 ||
          style.position === 'fixed'
        ) {
          continue;
        }
        if (clippedByAncestor(element)) continue;

        oversizedElements.push({
          selector:
            element.tagName.toLowerCase() +
            (element.id ? `#${element.id}` : '') +
            (typeof element.className === 'string' && element.className.trim()
              ? `.${element.className.trim().split(/\s+/).slice(0, 2).join('.')}`
              : ''),
          width: Math.round(rect.width),
          overshootPx: Math.round(overshoot),
        });
      }

      const headings = Array.from(doc.querySelectorAll('h1, h2'))
        .slice(0, 6)
        .map((node) => (node.innerText || node.textContent || '').replace(/\s+/g, ' ').trim())
        .filter(Boolean);

      return {
        title: (doc.title || '').trim(),
        bodyVisible,
        textLength: visibleText.length,
        textSample: visibleText.slice(0, opts.textScanLength),
        headings,
        meaningfulElements,
        majorContainers,
        imageCount: images.length,
        innerWidth,
        innerHeight,
        scrollWidth,
        bodyScrollWidth,
        documentHeight,
        // Take the widest of <html> and <body>: a body that overflows while
        // <html> has `overflow-x: hidden` still produces a broken-looking,
        // wider-than-viewport page (and a wider full-page screenshot).
        horizontalOverflowPx: Math.max(0, Math.max(scrollWidth, bodyScrollWidth) - innerWidth),
        brokenImages,
        oversizedElements,
      };
    }, options);
  } catch (error) {
    return { evaluateError: truncate(error?.message || String(error), 300) };
  }
}

/** Map a Playwright navigation error message onto a coarse cause. */
function classifyNavigationError(message = '') {
  const text = String(message);
  if (/Timeout|timed out/i.test(text)) return 'timeout';
  if (/ERR_NAME_NOT_RESOLVED|ERR_NAME_RESOLUTION_FAILED|DNS/i.test(text)) return 'dns';
  if (/ERR_CERT|SSL|ERR_SSL|CERTIFICATE|ERR_BAD_SSL/i.test(text)) return 'ssl';
  if (/ERR_CONNECTION_REFUSED|ERR_CONNECTION_RESET|ERR_CONNECTION_CLOSED|ERR_CONNECTION_TIMED_OUT/i.test(text)) {
    return 'connection';
  }
  if (/ERR_ADDRESS_UNREACHABLE|ERR_INTERNET_DISCONNECTED|ERR_NETWORK/i.test(text)) return 'network';
  if (/ERR_TOO_MANY_REDIRECTS/i.test(text)) return 'redirect-loop';
  if (/ERR_EMPTY_RESPONSE|ERR_HTTP2|ERR_QUIC/i.test(text)) return 'protocol';
  return 'navigation';
}

/** First http(s) URL mentioned in a stack trace — i.e. where the code lives. */
function firstUrlInStack(stack) {
  const match = /https?:\/\/[^\s)]+/.exec(String(stack || ''));
  if (!match) return null;
  // Strip the trailing :line:column that stack frames append.
  return match[0].replace(/:\d+:\d+$/, '');
}

function collectRedirectChain(response) {
  const chain = [];
  let request = response.request().redirectedFrom();
  let guard = 0;
  while (request && guard < 20) {
    chain.unshift(request.url());
    request = request.redirectedFrom();
    guard += 1;
  }
  return chain;
}

function normalizeUrl(value) {
  try {
    const parsed = new URL(value);
    const pathname = parsed.pathname.replace(/\/+$/, '');
    return `${parsed.protocol}//${parsed.hostname.replace(/^www\./, '')}${pathname}${parsed.search}`;
  } catch {
    return String(value || '');
  }
}

/**
 * Combine DOM-detected broken images with images that failed at the network
 * level, dropping known third-party pixels and non-meaningful entries.
 */
function mergeBrokenImages(domImages, requestFailures, baseUrl) {
  const merged = [];
  const seen = new Set();

  for (const image of domImages) {
    if (!image.meaningful) continue;
    if (isIgnoredRequestUrl(image.src)) continue;
    const key = image.src;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push({
      src: truncate(image.src, 400),
      alt: truncate(image.alt, 120),
      reason: image.reason,
      firstParty: isFirstParty(image.src, baseUrl),
    });
  }

  for (const [src, failure] of requestFailures) {
    if (seen.has(src)) continue;
    if (isIgnoredRequestUrl(src)) continue;
    seen.add(src);
    merged.push({
      src: truncate(src, 400),
      alt: '',
      reason: `request failed (${truncate(failure, 80)})`,
      firstParty: isFirstParty(src, baseUrl),
    });
  }

  return merged;
}

function dedupeFailures(entries) {
  const seen = new Set();
  return entries.filter((entry) => {
    const key = `${entry.url}|${entry.status ?? ''}|${entry.failure ?? ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function dedupeJsErrors(entries) {
  const seen = new Set();
  return entries.filter((entry) => {
    const key = `${entry.name}|${entry.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function dedupeConsoleErrors(entries) {
  const seen = new Set();
  return entries.filter((entry) => {
    const key = `${entry.text}|${entry.location}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function safeCall(fn) {
  try {
    await fn();
  } catch {
    // Cleanup and best-effort waits must never mask the real result.
  }
}
