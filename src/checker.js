import path from 'node:path';
import { classify, isIgnoredUrl } from './classifier.js';
import { errorMessage, limitPush, relativePath } from './utils.js';

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
  await page.evaluate(async ({ viewportHeight, delay, maxSteps }) => {
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
  });
}

async function inspectPage(page) {
  return page.evaluate(() => {
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
    const overflowElements = [...document.querySelectorAll('body *')]
      .filter(isVisible)
      .map((element) => {
        const box = element.getBoundingClientRect();
        return { tag: element.tagName.toLowerCase(), left: Math.round(box.left), right: Math.round(box.right), width: Math.round(box.width) };
      })
      .filter((box) => box.width >= minimumMajorWidth && (box.left < -overflowTolerance || box.right > window.innerWidth + overflowTolerance))
      .slice(0, 10);

    const height = Math.max(body?.scrollHeight ?? 0, root.scrollHeight);
    const bodyVisible = Boolean(body && isVisible(body));
    const blankPageDetected = !bodyVisible || (
      visibleText.length < 40 && meaningfulElements.length < 2 && images.length === 0 && height < window.innerHeight * 1.2
    );
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
      brokenImages,
      blankPageDetected,
      layout: {
        overflowPixels,
        horizontalOverflow: overflowPixels > overflowTolerance && (
          overflowElements.length > 0 || overflowPixels > window.innerWidth * 0.05
        ),
        overflowElements,
        suspiciousCollapsed,
      },
    };
  });
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
    blankPageDetected: false,
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
      result.sslError = /(?:certificate|ERR_CERT|SSL)/i.test(result.navigationError);
      result.dnsError = /(?:ERR_NAME_NOT_RESOLVED|ENOTFOUND|DNS)/i.test(result.navigationError);
    }

    result.loadTimeMs = Date.now() - startedAt;
    result.finalUrl = page.url() === 'about:blank' ? null : page.url();

    if (!result.navigationError) {
      await page.waitForTimeout(config.postLoadWait);
      await lazyScroll(page, config);
      await page.waitForTimeout(config.postLoadWait);
    }

    let inspection;
    try {
      inspection = await inspectPage(page);
      result.brokenImages = inspection.brokenImages.slice(0, config.maxFailedRequests);
      result.horizontalOverflow = inspection.layout.horizontalOverflow;
      result.layout = inspection.layout;
      result.blankPageDetected = inspection.blankPageDetected;
      result.pageMetrics = {
        title: inspection.title,
        visibleTextLength: inspection.visibleTextLength,
        bodyVisible: inspection.bodyVisible,
        documentHeight: inspection.documentHeight,
        documentWidth: inspection.documentWidth,
        meaningfulElementCount: inspection.meaningfulElementCount,
        imageCount: inspection.imageCount,
      };
      result.suspiciousText = detectSuspiciousText(inspection, result.httpStatus);
      result.errorPageDetected = result.suspiciousText.length > 0;
    } catch (error) {
      if (!result.navigationError) result.navigationError = `Page inspection failed: ${errorMessage(error)}`;
    }

    try {
      await page.screenshot({ path: screenshotPath, fullPage: true });
    } catch (error) {
      result.screenshotError = errorMessage(error);
    }
  } finally {
    await context.close().catch(() => {});
  }

  const classification = classify(result);
  result.status = classification.status;
  result.issues = classification.issues;
  return result;
}
