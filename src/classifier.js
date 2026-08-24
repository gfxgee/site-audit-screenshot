import { config } from './config.js';

export const STATUS = {
  PASS: 'PASS',
  REVIEW: 'REVIEW',
  BROKEN: 'BROKEN',
};

/**
 * Error / crash page phrases.
 *
 * Matching is contextual on purpose: bare numbers like "404" or "500" are
 * never matched on their own, so a homepage saying "500 customers" stays PASS.
 * Edit freely — each entry is a regex tested against the page title, the
 * headings, and (only for short pages) the visible body text.
 */
export const ERROR_PAGE_PATTERNS = [
  /internal server error/i,
  /bad gateway/i,
  /service (temporarily )?unavailable/i,
  /gateway time-?out/i,
  /application error/i,
  /something went wrong/i,
  /this site can-?.?t be reached/i,
  /page not found/i,
  /server error/i,
  /an unexpected error (has )?occurred/i,
  /error establishing a database connection/i,
  /database connection (error|failed)/i,
  /site is experiencing technical difficulties/i,
  /there has been a critical error/i,
  /account (has been )?suspended/i,
  /502 bad gateway/i,
  /http error 5\d\d/i,
  // "404 - Not Found", "500: Internal Server Error", ...
  /\b(400|401|403|404|405|408|410|500|501|502|503|504)\b\s*[-–—:|]{0,2}\s*(page\s+)?(not found|forbidden|unauthorized|error|internal server error|bad gateway|service unavailable|gateway time-?out|request time-?out|gone)/i,
  // "Not Found - 404", "Internal Server Error (500)"
  /(not found|forbidden|unauthorized|internal server error|bad gateway|service unavailable|gateway time-?out)\s*[-–—:|(]{0,2}\s*\b(400|401|403|404|500|502|503|504)\b/i,
];

/**
 * Turn raw observations into a status plus a human-readable issue list.
 *
 * Guiding rules:
 *   - BROKEN means "a visitor cannot use this homepage".
 *   - REVIEW means "it loads, but something looks wrong — a human should look".
 *   - When uncertain, prefer REVIEW over BROKEN.
 *   - Third-party analytics / ads / consent noise never changes the status.
 */
export function classify(observations) {
  const t = config.thresholds;
  const metrics = observations.metrics || {};
  const issues = [];
  const brokenReasons = [];

  // --- error / crash page text ------------------------------------------
  const suspiciousText = detectErrorPageText(metrics, t.errorTextScanLength);

  // --- blank page --------------------------------------------------------
  const blank = detectBlankPage(metrics, t);

  // --- layout ------------------------------------------------------------
  const layout = detectLayoutProblems(metrics, t);

  // --- navigation --------------------------------------------------------
  if (observations.navigationError) {
    const label =
      {
        timeout: `Navigation timed out after ${config.navigationTimeout}ms`,
        dns: 'DNS lookup failed (host could not be resolved)',
        ssl: 'TLS/certificate error prevented loading',
        connection: 'Connection failed (refused/reset/timed out)',
        network: 'Network unreachable',
        'redirect-loop': 'Too many redirects',
        protocol: 'Protocol-level error (empty or invalid response)',
      }[observations.navigationErrorType] || 'Navigation failed';
    brokenReasons.push(`${label}: ${observations.navigationError}`);
  }

  // --- HTTP status -------------------------------------------------------
  const httpStatus = observations.httpStatus;
  if (typeof httpStatus === 'number') {
    if (httpStatus >= 500) {
      brokenReasons.push(`Homepage returned HTTP ${httpStatus}`);
    } else if (httpStatus === 404 || httpStatus === 410) {
      brokenReasons.push(`Homepage returned HTTP ${httpStatus} (not found)`);
    } else if (httpStatus === 401 || httpStatus === 403) {
      brokenReasons.push(`Homepage returned HTTP ${httpStatus} (access denied)`);
    } else if (httpStatus >= 400) {
      issues.push(`Homepage returned HTTP ${httpStatus}`);
    }
  } else if (!observations.navigationError) {
    issues.push('No HTTP response was captured for the main document');
  }

  // --- server / application error page ----------------------------------
  if (suspiciousText.length > 0) {
    brokenReasons.push(`Error page detected (${suspiciousText[0]})`);
  }

  // --- blank / non-rendering page ---------------------------------------
  if (blank.isBlank) {
    brokenReasons.push(`Homepage is effectively blank (${blank.reasons.join(', ')})`);
  } else if (blank.isThin) {
    issues.push(`Homepage rendered very little content (${blank.reasons.join(', ')})`);
  }

  if (metrics.evaluateError) {
    issues.push(`Page inspection failed: ${metrics.evaluateError}`);
  }

  // --- broken images -----------------------------------------------------
  const brokenImages = observations.brokenImages || [];
  const firstPartyImages = brokenImages.filter((image) => image.firstParty);
  if (firstPartyImages.length > 0) {
    issues.push(
      `${firstPartyImages.length} broken image${firstPartyImages.length === 1 ? '' : 's'}`,
    );
  } else if (brokenImages.length > 0) {
    issues.push(`${brokenImages.length} broken third-party image(s)`);
  }

  // --- failed requests ---------------------------------------------------
  const failedRequests = observations.failedRequests || [];
  const firstPartyFailures = failedRequests.filter((entry) => entry.firstParty);
  if (firstPartyFailures.length >= t.firstPartyFailureLimit && firstPartyFailures.length > 0) {
    const critical = firstPartyFailures.filter((entry) =>
      ['document', 'script', 'stylesheet'].includes(entry.resourceType),
    );
    issues.push(
      `${firstPartyFailures.length} failed first-party request${
        firstPartyFailures.length === 1 ? '' : 's'
      }${critical.length > 0 ? ` (${critical.length} script/stylesheet)` : ''}`,
    );
  }

  // --- JavaScript / console errors --------------------------------------
  const jsErrors = observations.jsErrors || [];
  if (jsErrors.length > 0) {
    issues.push(`${jsErrors.length} JavaScript error${jsErrors.length === 1 ? '' : 's'}: ${jsErrors[0].message}`);
  }

  const consoleErrors = observations.consoleErrors || [];
  if (consoleErrors.length > 0) {
    issues.push(
      `${consoleErrors.length} console error${consoleErrors.length === 1 ? '' : 's'}: ${consoleErrors[0].text}`,
    );
  }

  // --- layout ------------------------------------------------------------
  issues.push(...layout.issues);

  // --- screenshot --------------------------------------------------------
  if (!observations.screenshotPath && !observations.navigationError) {
    issues.push('Screenshot could not be captured');
  }

  // --- final decision ----------------------------------------------------
  let status = STATUS.PASS;
  if (brokenReasons.length > 0) {
    status = STATUS.BROKEN;
  } else if (issues.length > 0) {
    status = STATUS.REVIEW;
  }

  return {
    status,
    issues: [...brokenReasons, ...issues],
    suspiciousText,
    horizontalOverflow: layout.horizontalOverflow,
    signals: {
      blank,
      layout: layout.signals,
      firstPartyFailureCount: firstPartyFailures.length,
      firstPartyBrokenImageCount: firstPartyImages.length,
    },
  };
}

/** Contextual error-page phrase matching over title, headings and short bodies. */
function detectErrorPageText(metrics, maxBodyScan) {
  const hits = [];
  const sources = [];

  if (metrics.title) sources.push({ source: 'title', text: metrics.title });
  for (const heading of metrics.headings || []) {
    sources.push({ source: 'heading', text: heading });
  }
  // Long marketing pages legitimately contain phrases like "something went
  // wrong"; only scan the body when the page is short enough that the phrase
  // is very likely to BE the page.
  if (metrics.textSample && (metrics.textLength ?? 0) <= maxBodyScan) {
    sources.push({ source: 'body', text: metrics.textSample });
  }

  for (const { source, text } of sources) {
    for (const pattern of ERROR_PAGE_PATTERNS) {
      const match = pattern.exec(text);
      if (match) {
        const phrase = `${match[0].replace(/\s+/g, ' ').trim()} (${source})`;
        if (!hits.includes(phrase)) hits.push(phrase);
      }
    }
  }
  return hits.slice(0, 5);
}

/**
 * Blank-page detection using several weighted signals rather than a single
 * threshold, so a deliberately minimalist landing page is not called broken.
 */
function detectBlankPage(metrics, t) {
  if (!metrics || metrics.textLength === undefined) {
    return { isBlank: false, isThin: false, score: 0, reasons: [] };
  }

  const reasons = [];
  let score = 0;

  if (metrics.bodyVisible === false) {
    score += 3;
    reasons.push('body is hidden');
  }
  if (metrics.textLength < t.blankTextLength) {
    score += 2;
    reasons.push(`only ${metrics.textLength} chars of visible text`);
  } else if (metrics.textLength < t.lowTextLength) {
    score += 1;
    reasons.push(`little visible text (${metrics.textLength} chars)`);
  }
  if (metrics.meaningfulElements < t.blankElementCount) {
    score += 2;
    reasons.push(`${metrics.meaningfulElements} content elements`);
  } else if (metrics.meaningfulElements < t.lowElementCount) {
    score += 1;
    reasons.push(`few content elements (${metrics.meaningfulElements})`);
  }
  if (metrics.documentHeight < (metrics.innerHeight || 900) * t.shortPageRatio) {
    score += 1;
    reasons.push(`page only ${Math.round(metrics.documentHeight)}px tall`);
  }
  if ((metrics.imageCount ?? 0) === 0) {
    score += 1;
    reasons.push('no images');
  }
  if ((metrics.majorContainers ?? 0) === 0) {
    score += 1;
    reasons.push('no major content containers');
  }
  if (!metrics.title) {
    score += 1;
    reasons.push('no page title');
  }

  const hardBlank =
    metrics.bodyVisible === false ||
    (metrics.textLength < t.blankTextLength && metrics.meaningfulElements < t.blankElementCount);

  return {
    isBlank: hardBlank || score >= t.blankScore,
    isThin: !hardBlank && score >= t.blankScore - 2 && score < t.blankScore,
    score,
    reasons,
  };
}

/** Deterministic layout checks: horizontal overflow and oversized elements. */
function detectLayoutProblems(metrics, t) {
  const issues = [];
  const innerWidth = metrics.innerWidth || config.viewport.width;
  const overflowPx = metrics.horizontalOverflowPx ?? 0;
  const majorOverflowPx = Math.max(t.overflowTolerancePx, innerWidth * t.majorOverflowRatio);

  // The flag is recorded whenever overflow exceeds the tolerance, but only
  // *major* overflow becomes an issue — small decorative overhang is normal.
  const horizontalOverflow = overflowPx > t.overflowTolerancePx;
  if (overflowPx > majorOverflowPx) {
    issues.push(`Major horizontal overflow: page is ${Math.round(overflowPx)}px wider than the viewport`);
  }

  // A body wider than <html> means the overflow is being clipped rather than
  // fixed — worth naming in the issue text because it is easy to miss.
  const bodyClipped =
    (metrics.bodyScrollWidth ?? 0) > (metrics.scrollWidth ?? 0) + t.overflowTolerancePx;
  if (bodyClipped && overflowPx > majorOverflowPx) {
    issues.push(
      `Body is ${Math.round(metrics.bodyScrollWidth)}px wide but clipped by the document ` +
        `(${Math.round(metrics.scrollWidth)}px) - hidden horizontal overflow`,
    );
  }

  const oversized = metrics.oversizedElements || [];
  if (oversized.length > 0) {
    issues.push(
      `${oversized.length} large element(s) extend outside the viewport (e.g. ${oversized[0].selector} +${oversized[0].overshootPx}px)`,
    );
  }

  const collapsed =
    (metrics.meaningfulElements ?? 0) > 25 &&
    (metrics.documentHeight ?? 0) > 0 &&
    metrics.documentHeight < (metrics.innerHeight || config.viewport.height) * 0.5;
  if (collapsed) {
    issues.push(`Layout looks collapsed (${Math.round(metrics.documentHeight)}px tall with ${metrics.meaningfulElements} elements)`);
  }

  return {
    issues,
    horizontalOverflow,
    signals: {
      overflowPx: Math.round(overflowPx),
      majorOverflow: overflowPx > majorOverflowPx,
      bodyClipped,
      oversizedElements: oversized.length,
      collapsed,
    },
  };
}

/**
 * Assemble the documented result record from observations + verdict.
 * Field order matches the schema in the README.
 */
export function buildResult(observations, verdict) {
  return {
    url: observations.url,
    finalUrl: observations.finalUrl,
    status: verdict.status,
    httpStatus: observations.httpStatus,
    loadTimeMs: observations.loadTimeMs,
    navigationError: observations.navigationError,
    navigationErrorType: observations.navigationErrorType,
    redirectedTo: observations.redirectedTo,
    redirectChain: observations.redirectChain,
    brokenImages: observations.brokenImages,
    jsErrors: observations.jsErrors,
    consoleErrors: observations.consoleErrors,
    failedRequests: observations.failedRequests,
    horizontalOverflow: verdict.horizontalOverflow,
    suspiciousText: verdict.suspiciousText,
    issues: verdict.issues,
    screenshotPath: observations.screenshotPath,
    screenshotError: observations.screenshotError,
    checkedAt: observations.checkedAt,
    signals: verdict.signals,
    metrics: summarizeMetrics(observations.metrics),
    ignoredCounts: observations.ignoredCounts,
    truncated: observations.truncated,
  };
}

/** Keep the JSON report readable — drop the large text sample. */
function summarizeMetrics(metrics) {
  if (!metrics) return null;
  const { textSample, brokenImages, ...rest } = metrics;
  return rest;
}
