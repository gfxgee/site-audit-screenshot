import path from 'node:path';
import { classify, isFirstParty, isIgnoredUrl, scoreBlankPage } from './classifier.js';
import { errorMessage, limitPush, relativePath, withTimeout } from './utils.js';

/** Sibling .jpg path for a screenshot's .png path. */
export function emailImagePath(screenshotPath) {
  return screenshotPath.replace(/\.png$/i, '.jpg');
}

const ERROR_PAGE_PATTERNS = [
  /\binternal server error\b/i,
  /\bbad gateway\b/i,
  /\bservice unavailable\b/i,
  /\bgateway timeout\b/i,
  /\bapplication error\b/i,
  /\bthis site can['’]?t be reached\b/i,
  /\b(?:404\s*[-:]?\s*)?page not found\b/i,
  /\bserver error\b/i,
  /\ban unexpected error occurred\b/i,
  /\b(?:500\s*[-:]?\s*)internal server error\b/i,
];

async function lazyScroll(page, config) {
  await withTimeout(page.evaluate(async ({ viewportHeight, delay, maxSteps }) => {
    const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
    let steps = 0;
    let previousHeight = 0;
    let unchangedHeightCount = 0;

    while (steps < maxSteps) {
      const height = Math.max(document.body?.scrollHeight ?? 0, document.documentElement.scrollHeight);
      const nextPosition = Math.min(window.scrollY + Math.max(200, viewportHeight * 0.85), height);
      window.scrollTo({ top: nextPosition, behavior: 'instant' });
      await wait(delay);
      steps += 1;

      const currentHeight = Math.max(document.body?.scrollHeight ?? 0, document.documentElement.scrollHeight);
      unchangedHeightCount = currentHeight === previousHeight ? unchangedHeightCount + 1 : 0;
      previousHeight = currentHeight;
      if (window.scrollY + window.innerHeight >= currentHeight - 2 && unchangedHeightCount >= 2) break;
    }

    window.scrollTo({ top: 0, behavior: 'instant' });
  }, {
    viewportHeight: config.viewport.height,
    delay: config.scrollDelay,
    maxSteps: config.scrollMaxSteps,
  }),
  // The in-page loop is bounded by maxSteps * delay, but a page whose main
  // thread is blocked can stretch each await indefinitely.
  config.scrollMaxSteps * config.scrollDelay + config.evaluateTimeout,
  'Lazy-load scroll');
}

async function inspectPage(page, config) {
  return withTimeout(page.evaluate((maxInspectedElements) => {
    const isVisible = (element) => {
      const style = getComputedStyle(element);
      const box = element.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' && Number.parseFloat(style.opacity || '1') > 0 && box.width > 0 && box.height > 0;
    };

    const body = document.body;
    const root = document.documentElement;
    const visibleText = body && isVisible(body) ? (body.innerText || '').replace(/\s+/g, ' ').trim() : '';
    const meaningfulSelector = 'main, header, footer, nav, section, article, form, h1, h2, video, canvas, img';
    const meaningfulElements = [...document.querySelectorAll(meaningfulSelector)].filter(isVisible);
    const majorContainerCount = document.querySelectorAll(
      'main, header, footer, [role="main"], #main, #content, .content, .container',
    ).length;
    const images = [...document.images];
    const brokenImages = images
      .filter((image) => {
        const source = image.currentSrc || image.src;
        if (!source || source.startsWith('data:') || source.startsWith('blob:')) return false;
        if (!image.complete || image.naturalWidth !== 0) return false;
        const box = image.getBoundingClientRect();
        return box.width > 1 || box.height > 1 || isVisible(image);
      })
      .map((image) => ({
        src: image.currentSrc || image.src,
        alt: image.alt || '',
        reason: 'naturalWidth=0',
      }));

    const overflowPixels = Math.max(0, root.scrollWidth - window.innerWidth);
    const overflowTolerance = Math.max(20, Math.round(window.innerWidth * 0.02));
    const minimumMajorWidth = Math.max(300, window.innerWidth * 0.25);
    // Bounded, short-circuiting walk. isVisible() forces style and layout per
    // element, so scanning an entire large DOM is far too slow on a small
    // runner; stop after 10 hits or maxInspectedElements examined.
    const overflowElements = [];
    const candidates = document.querySelectorAll('body *');
    const examineLimit = Math.min(candidates.length, maxInspectedElements);
    for (let index = 0; index < examineLimit; index += 1) {
      if (overflowElements.length >= 10) break;
      const element = candidates[index];
      const box = element.getBoundingClientRect();
      // Cheap geometric rejections first, before any style resolution.
      if (box.width < minimumMajorWidth) continue;
      if (box.left >= -overflowTolerance && box.right <= window.innerWidth + overflowTolerance) continue;
      if (!isVisible(element)) continue;
      overflowElements.push({
        tag: element.tagName.toLowerCase(),
        left: Math.round(box.left),
        right: Math.round(box.right),
        width: Math.round(box.width),
      });
    }
    const inspectionTruncated = candidates.length > examineLimit;

    const height = Math.max(body?.scrollHeight ?? 0, root.scrollHeight);
    const bodyVisible = Boolean(body && isVisible(body));
    const suspiciousCollapsed = bodyVisible && height < 250 && visibleText.length < 120 && meaningfulElements.length < 3;

    return {
      title: document.title,
      visibleText,
      visibleTextLength: visibleText.length,
      bodyVisible,
      documentHeight: height,
      documentWidth: root.scrollWidth,
      meaningfulElementCount: meaningfulElements.length,
      imageCount: images.length,
      elementCount: candidates.length,
      inspectionTruncated,
      innerHeight: window.innerHeight,
      majorContainerCount,
      brokenImages,
      layout: {
        overflowPixels,
        horizontalOverflow: overflowPixels > overflowTolerance && (
          overflowElements.length > 0 || overflowPixels > window.innerWidth * 0.05
        ),
        overflowElements,
        suspiciousCollapsed,
      },
    };
  }, config.maxInspectedElements), config.evaluateTimeout, 'Page inspection');
}

function detectSuspiciousText(inspection, httpStatus) {
  const haystack = `${inspection.title}\n${inspection.visibleText}`;
  const titleLooksLikeError = ERROR_PAGE_PATTERNS.some((pattern) => pattern.test(inspection.title));
  const errorContext = titleLooksLikeError || httpStatus >= 400 || inspection.visibleTextLength < 3_000;
  const matches = errorContext
    ? ERROR_PAGE_PATTERNS.map((pattern) => haystack.match(pattern)?.[0]).filter(Boolean)
    : [];
  const genericFailure = /\bsomething went wrong\b/i.test(haystack) && (inspection.visibleTextLength < 1_500 || httpStatus >= 400);
  if (genericFailure) matches.push('something went wrong');
  return matches;
}

/**
 * Walk back through the main document's redirect chain.
 * Playwright links each redirect via request.redirectedFrom().
 */
function redirectChainOf(response) {
  const chain = [];
  let request = response.request().redirectedFrom();
  let guard = 0;
  while (request && guard < 30) {
    chain.unshift(request.url());
    request = request.redirectedFrom();
    guard += 1;
  }
  return chain;
}

function baseResult(url, screenshotPath, projectRoot) {
  return {
    url,
    finalUrl: null,
    status: 'BROKEN',
    httpStatus: null,
    loadTimeMs: null,
    navigationError: null,
    timedOut: false,
    sslError: false,
    dnsError: false,
    brokenImages: [],
    jsErrors: [],
    consoleErrors: [],
    failedRequests: [],
    horizontalOverflow: false,
    suspiciousText: [],
    issues: [],
    screenshotPath: relativePath(projectRoot, screenshotPath),
    screenshotError: null,
    emailImagePath: null,
    emailImageError: null,
    lazyScrollError: null,
    blankPageDetected: false,
    thinPageDetected: false,
    blankSignals: [],
    blankScore: 0,
    redirectedTo: null,
    redirectChain: [],
    redirectCount: 0,
    redirectLoop: false,
    redirectedOffDomain: false,
    errorPageDetected: false,
    layout: { overflowPixels: 0, overflowElements: [], suspiciousCollapsed: false },
    pageMetrics: null,
    checkedAt: new Date().toISOString(),
  };
}

export async function checkSite(browser, url, screenshotPath, config) {
  const result = baseResult(url, screenshotPath, config.projectRoot);
  const context = await browser.newContext({ viewport: config.viewport });
  const page = await context.newPage();
  let mainResponse;

  page.on('pageerror', (error) => limitPush(result.jsErrors, errorMessage(error), config.maxJsErrors));
  page.on('console', (message) => {
    if (message.type() === 'error') {
      limitPush(result.consoleErrors, { text: message.text(), location: message.location() }, config.maxConsoleErrors);
    }
  });
  page.on('requestfailed', (request) => {
    if (isIgnoredUrl(request.url())) return;
    limitPush(result.failedRequests, {
      url: request.url(),
      method: request.method(),
      resourceType: request.resourceType(),
      status: 0,
      failure: request.failure()?.errorText || 'Request failed',
    }, config.maxFailedRequests);
  });
  page.on('response', (response) => {
    if (response.status() < 400 || isIgnoredUrl(response.url())) return;
    const request = response.request();
    limitPush(result.failedRequests, {
      url: response.url(),
      method: request.method(),
      resourceType: request.resourceType(),
      status: response.status(),
      failure: '',
    }, config.maxFailedRequests);
  });

  const startedAt = Date.now();
  try {
    try {
      mainResponse = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: config.navigationTimeout });
      result.httpStatus = mainResponse?.status() ?? null;
    } catch (error) {
      result.navigationError = errorMessage(error);
      result.timedOut = /timeout/i.test(result.navigationError);
      // Chromium gives up after 20 hops and reports this. It is the exact
      // failure a looping homepage produces.
      result.redirectLoop = /ERR_TOO_MANY_REDIRECTS/i.test(result.navigationError);
      result.sslError = /(?:certificate|ERR_CERT|SSL)/i.test(result.navigationError);
      result.dnsError = /(?:ERR_NAME_NOT_RESOLVED|ENOTFOUND|DNS)/i.test(result.navigationError);
    }

    result.loadTimeMs = Date.now() - startedAt;
    result.finalUrl = page.url() === 'about:blank' ? null : page.url();

    if (mainResponse) {
      result.redirectChain = redirectChainOf(mainResponse);
      result.redirectCount = result.redirectChain.length;
      if (result.finalUrl && result.finalUrl !== result.url) {
        result.redirectedTo = result.finalUrl;
        // Landing on an unrelated domain means the homepage is gone: an
        // expired domain, a parking page, or a misconfigured redirect.
        result.redirectedOffDomain = !isFirstParty(result.finalUrl, result.url);
      }
    }

    if (!result.navigationError) {
      await page.waitForTimeout(config.postLoadWait);
      try {
        await lazyScroll(page, config);
      } catch (error) {
        // A stalled scroll pass must not lose the screenshot or the checks.
        result.lazyScrollError = errorMessage(error);
      }
      await page.waitForTimeout(config.postLoadWait);
    }

    let inspection;
    try {
      inspection = await inspectPage(page, config);
      result.brokenImages = inspection.brokenImages.slice(0, config.maxFailedRequests);
      result.horizontalOverflow = inspection.layout.horizontalOverflow;
      result.layout = inspection.layout;
      result.pageMetrics = {
        title: inspection.title,
        visibleTextLength: inspection.visibleTextLength,
        bodyVisible: inspection.bodyVisible,
        documentHeight: inspection.documentHeight,
        documentWidth: inspection.documentWidth,
        meaningfulElementCount: inspection.meaningfulElementCount,
        imageCount: inspection.imageCount,
        elementCount: inspection.elementCount,
        inspectionTruncated: inspection.inspectionTruncated,
        innerHeight: inspection.innerHeight,
        majorContainerCount: inspection.majorContainerCount,
      };

      // Blank/partial-render scoring lives in the classifier so every
      // PASS/REVIEW/BROKEN rule stays in one editable place.
      const blankness = scoreBlankPage(result.pageMetrics);
      result.blankPageDetected = blankness.blank;
      result.thinPageDetected = blankness.thin;
      result.blankSignals = blankness.signals;
      result.blankScore = blankness.score;
      result.suspiciousText = detectSuspiciousText(inspection, result.httpStatus);
      result.errorPageDetected = result.suspiciousText.length > 0;
    } catch (error) {
      if (!result.navigationError) result.navigationError = `Page inspection failed: ${errorMessage(error)}`;
    }

    try {
      await page.screenshot({ path: screenshotPath, fullPage: true, timeout: config.screenshotTimeout });
    } catch (error) {
      result.screenshotError = errorMessage(error);
    }

    // A JPEG copy of the same full-page view, for email delivery. The PNG
    // remains the archived artifact; JPEG is roughly 5x smaller, which is what
    // keeps a full set of screenshots inside mailbox size limits.
    try {
      await page.screenshot({
        path: emailImagePath(screenshotPath),
        fullPage: true,
        type: 'jpeg',
        quality: config.email.jpegQuality,
        timeout: config.screenshotTimeout,
      });
      result.emailImagePath = relativePath(config.projectRoot, emailImagePath(screenshotPath));
    } catch (error) {
      result.emailImageError = errorMessage(error);
    }
  } finally {
    await context.close().catch(() => {});
  }

  const classification = classify(result);
  result.status = classification.status;
  result.issues = classification.issues;
  return result;
}
