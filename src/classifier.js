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

function meaningfulFailedRequests(result) {
  const pageUrl = result.finalUrl || result.url;
  return result.failedRequests.filter((failure) => {
    if (isIgnoredUrl(failure.url)) return false;
    if (!isFirstParty(failure.url, pageUrl)) return false;
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
  if (result.blankPageDetected) brokenIssues.push('Homepage appears effectively blank');

  if (result.brokenImages.length > 0) {
    reviewIssues.push(`${result.brokenImages.length} meaningful broken image${result.brokenImages.length === 1 ? '' : 's'}`);
  }

  const failedRequests = meaningfulFailedRequests(result);
  if (failedRequests.length > 0) {
    reviewIssues.push(`${failedRequests.length} failed first-party request${failedRequests.length === 1 ? '' : 's'}`);
  }

  const jsErrorCount = result.jsErrors.filter(isMeaningfulError).length;
  if (jsErrorCount > 0) reviewIssues.push(`${jsErrorCount} meaningful JavaScript error${jsErrorCount === 1 ? '' : 's'}`);

  const consoleErrorCount = result.consoleErrors.filter(isMeaningfulConsole).length;
  if (consoleErrorCount > 0) reviewIssues.push(`${consoleErrorCount} suspicious console error${consoleErrorCount === 1 ? '' : 's'}`);

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

export const classifierInternals = { IGNORED_URL_PATTERNS, IGNORED_ERROR_PATTERNS };
