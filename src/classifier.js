// A homepage normally needs at most a couple of hops (http->https->www).
const MAX_REASONABLE_REDIRECTS = 3;

const IGNORED_URL_PATTERNS = [
  /google-analytics\.com/i,
  /analytics\.google\.com/i,
  /googletagmanager\.com/i,
  /doubleclick\.net/i,
  /googleadservices\.com/i,
  /connect\.facebook\.net/i,
  /facebook\.com\/(?:tr|privacy_sandbox)/i,
  /hotjar\.(?:com|io)/i,
  /clarity\.ms/i,
  /bat\.bing\.com/i,
  /linkedin\.com\/(?:insight|px)/i,
  /px\.ads\.linkedin\.com/i,
  /snap\.licdn\.com/i,
  /tiktok\.com\/i18n\/pixel/i,
  /cookiebot\.com/i,
  /onetrust\.com/i,
  /cookielaw\.org/i,
  /\/webtracking\/webtracking(?:\.|\/)/i,
  /crazyegg\.com/i,
  /embed\.tawk\.to/i,
  /hs-scripts\.com/i,
  /favicon(?:\.ico)?(?:\?|$)/i,
];

const IGNORED_ERROR_PATTERNS = [
  /favicon/i,
  /third[- ]party cookie/i,
  /requestStorageAccess:\s*Permission denied/i,
  /blocked by client/i,
  /ERR_BLOCKED_BY_CLIENT/i,
  /google analytics/i,
  /googletagmanager/i,
  /facebook pixel/i,
  /ResizeObserver loop (?:limit exceeded|completed with undelivered notifications)/i,
];

export function isIgnoredUrl(url) {
  return IGNORED_URL_PATTERNS.some((pattern) => pattern.test(url));
}

export function isFirstParty(requestUrl, pageUrl) {
  try {
    const requestHost = new URL(requestUrl).hostname.replace(/^www\./i, '');
    const pageHost = new URL(pageUrl).hostname.replace(/^www\./i, '');
    return requestHost === pageHost || requestHost.endsWith(`.${pageHost}`) || pageHost.endsWith(`.${requestHost}`);
  } catch {
    return false;
  }
}

export function isMeaningfulError(message) {
  return !IGNORED_ERROR_PATTERNS.some((pattern) => pattern.test(message));
}

export function isMeaningfulConsole(entry) {
  return isMeaningfulError(entry.text) && !isIgnoredUrl(entry.location?.url ?? '');
}

/**
 * Resource types whose failure a visitor does not see.
 *
 * A font that fails to load falls back to a system font -- marstrand.no
 * references nine Segoe UI files its theme never shipped, and the page looks
 * fine. fetch/xhr are background calls with no rendered output. Flagging
 * these produced nine REVIEW alerts across thirteen healthy sites.
 */
const NON_RENDERING_RESOURCE_TYPES = new Set([
  'font', 'fetch', 'xhr', 'ping', 'beacon', 'csp_report',
  'websocket', 'eventsource', 'manifest', 'texttrack', 'other',
]);

/**
 * Blank / partial-render scoring.
 *
 * Several weak signals are weighted rather than requiring one hard condition,
 * so a homepage that renders only its header is caught while a deliberately
 * minimal landing page is not. Tune the weights here.
 */
export function scoreBlankPage(metrics) {
  if (!metrics) return { blank: false, thin: false, score: 0, signals: [] };

  const signals = [];
  let score = 0;
  const add = (points, reason) => { score += points; signals.push(reason); };

  const height = metrics.documentHeight ?? 0;
  const viewport = metrics.innerHeight || 900;

  if (metrics.bodyVisible === false) add(3, 'body is not visible');
  if ((metrics.visibleTextLength ?? 0) < 40) add(2, `only ${metrics.visibleTextLength ?? 0} characters of text`);
  else if ((metrics.visibleTextLength ?? 0) < 250) add(1, `little text (${metrics.visibleTextLength} characters)`);
  if ((metrics.meaningfulElementCount ?? 0) < 3) add(2, `${metrics.meaningfulElementCount ?? 0} content elements`);
  else if ((metrics.meaningfulElementCount ?? 0) < 10) add(1, `few content elements (${metrics.meaningfulElementCount})`);
  if (height > 0 && height < viewport * 0.6) add(1, `page only ${Math.round(height)}px tall`);
  if ((metrics.imageCount ?? 0) === 0) add(1, 'no images');
  if ((metrics.majorContainerCount ?? 0) === 0) add(1, 'no main/header/footer containers');
  if (!metrics.title) add(1, 'no page title');

  // Unambiguous: nothing is displayed at all.
  const hardBlank = metrics.bodyVisible === false
    || ((metrics.visibleTextLength ?? 0) < 40 && (metrics.meaningfulElementCount ?? 0) < 3);

  return { blank: hardBlank || score >= 5, thin: !hardBlank && score === 4, score, signals };
}

function meaningfulFailedRequests(result) {
  const pageUrl = result.finalUrl || result.url;
  return result.failedRequests.filter((failure) => {
    if (isIgnoredUrl(failure.url)) return false;
    if (!isFirstParty(failure.url, pageUrl)) return false;
    if (NON_RENDERING_RESOURCE_TYPES.has(failure.resourceType)) return false;
    if (failure.resourceType === 'image' && result.brokenImages.some((image) => image.src === failure.url)) return false;
    if (failure.resourceType === 'media' && /ERR_ABORTED/i.test(failure.failure)) return false;
    return failure.status >= 400 || Boolean(failure.failure);
  });
}

export function classify(result) {
  const brokenIssues = [];
  const reviewIssues = [];

  if (result.navigationError) brokenIssues.push(`Navigation failed: ${result.navigationError}`);
  if (result.httpStatus === 404) brokenIssues.push('Homepage returned HTTP 404');
  if (result.httpStatus >= 500) brokenIssues.push(`Homepage returned HTTP ${result.httpStatus}`);
  if (result.errorPageDetected) brokenIssues.push('Server or application error page detected');
  if (result.blankPageDetected) {
    const why = (result.blankSignals ?? []).join(', ');
    brokenIssues.push(`Homepage appears effectively blank${why ? ` (${why})` : ''}`);
  } else if (result.thinPageDetected) {
    reviewIssues.push(`Homepage rendered very little content (${(result.blankSignals ?? []).join(', ')})`);
  }

  // Redirect failures. A homepage that loops, or lands on an unrelated
  // domain, is broken for a visitor even when the final response is 200.
  if (result.redirectLoop) {
    brokenIssues.push('Redirect loop - the homepage never resolves (too many redirects)');
  }
  if (result.redirectedOffDomain) {
    brokenIssues.push(`Homepage redirects off-domain to ${result.finalUrl}`);
  }
  if (!result.redirectLoop && (result.redirectCount ?? 0) > MAX_REASONABLE_REDIRECTS) {
    reviewIssues.push(`${result.redirectCount} redirects before the homepage resolved`);
  }

  if (result.brokenImages.length > 0) {
    reviewIssues.push(`${result.brokenImages.length} meaningful broken image${result.brokenImages.length === 1 ? '' : 's'}`);
  }

  const failedRequests = meaningfulFailedRequests(result);
  if (failedRequests.length > 0) {
    reviewIssues.push(`${failedRequests.length} failed first-party request${failedRequests.length === 1 ? '' : 's'}`);
  }

  // JavaScript and console errors are recorded in the report and shown in the
  // email as context, but they deliberately do NOT set the status. On real
  // marketing sites they are near-universal and correlate poorly with what a
  // visitor sees: infosoft.no throws "jQuery is not defined" and renders
  // perfectly. The screenshot is the evidence that matters.

  if (result.horizontalOverflow) reviewIssues.push(`Horizontal overflow (${result.layout.overflowPixels}px)`);
  if (result.layout.suspiciousCollapsed) reviewIssues.push('Suspiciously collapsed page layout');
  if (result.screenshotError) reviewIssues.push(`Screenshot failed: ${result.screenshotError}`);
  if (result.httpStatus >= 400 && result.httpStatus !== 404 && result.httpStatus < 500) {
    reviewIssues.push(`Homepage returned HTTP ${result.httpStatus}`);
  }

  if (brokenIssues.length > 0) return { status: 'BROKEN', issues: [...brokenIssues, ...reviewIssues] };
  if (reviewIssues.length > 0) return { status: 'REVIEW', issues: reviewIssues };
  return { status: 'PASS', issues: [] };
}

export const classifierInternals = { IGNORED_URL_PATTERNS, IGNORED_ERROR_PATTERNS, NON_RENDERING_RESOURCE_TYPES, MAX_REASONABLE_REDIRECTS };
