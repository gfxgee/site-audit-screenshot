/**
 * Central configuration.
 *
 * Every value can be overridden with an environment variable so the same code
 * runs locally and on GitHub Actions without edits.
 */

const int = (value, fallback) => {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
};

const bool = (value, fallback) => {
  if (value === undefined || value === null || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).trim().toLowerCase());
};

export const config = {
  // --- input / output -----------------------------------------------------
  sitesFile: process.env.SITES_FILE || 'sites.csv',
  artifactsDir: process.env.ARTIFACTS_DIR || 'artifacts',
  screenshotsDir: process.env.SCREENSHOTS_DIR || 'artifacts/screenshots',

  // --- browser ------------------------------------------------------------
  viewport: {
    width: int(process.env.VIEWPORT_WIDTH, 1440),
    height: int(process.env.VIEWPORT_HEIGHT, 900),
  },
  userAgent:
    process.env.USER_AGENT ||
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
      'Chrome/131.0.0.0 Safari/537.36',
  locale: process.env.LOCALE || 'en-US',
  timezone: process.env.TIMEZONE_ID || 'Europe/Oslo',
  headless: bool(process.env.HEADLESS, true),

  // --- timing -------------------------------------------------------------
  navigationTimeout: int(process.env.NAVIGATION_TIMEOUT, 30000),
  // Settling time after DOMContentLoaded, before the lazy-load scroll pass.
  postLoadWait: int(process.env.POST_LOAD_WAIT, 2000),
  // Extra render delay after scrolling back to the top, before the screenshot.
  finalRenderWait: int(process.env.FINAL_RENDER_WAIT, 1200),
  // Lazy-load scroll pass.
  lazyScroll: {
    enabled: bool(process.env.LAZY_SCROLL, true),
    stepDelay: int(process.env.LAZY_SCROLL_DELAY, 350),
    // Fraction of a viewport height scrolled per step.
    stepRatio: Number.parseFloat(process.env.LAZY_SCROLL_STEP_RATIO || '0.85') || 0.85,
    maxSteps: int(process.env.LAZY_SCROLL_MAX_STEPS, 40),
  },
  screenshotTimeout: int(process.env.SCREENSHOT_TIMEOUT, 45000),

  // --- concurrency --------------------------------------------------------
  concurrency: Math.max(1, int(process.env.CONCURRENCY, 3)),

  // --- report size caps ---------------------------------------------------
  maxJsErrors: int(process.env.MAX_JS_ERRORS, 20),
  maxConsoleErrors: int(process.env.MAX_CONSOLE_ERRORS, 20),
  maxFailedRequests: int(process.env.MAX_FAILED_REQUESTS, 30),
  maxBrokenImages: int(process.env.MAX_BROKEN_IMAGES, 25),
  maxOversizedElements: int(process.env.MAX_OVERSIZED_ELEMENTS, 5),

  // --- detection thresholds ----------------------------------------------
  thresholds: {
    // Horizontal overflow: ignore small decorative overhang.
    overflowTolerancePx: int(process.env.OVERFLOW_TOLERANCE_PX, 32),
    // Overflow considered "major" (relative to viewport width) -> REVIEW.
    majorOverflowRatio:
      Number.parseFloat(process.env.MAJOR_OVERFLOW_RATIO || '0.05') || 0.05,
    // A large element must stick out this far past the viewport to count.
    oversizedElementOvershootPx: int(process.env.OVERSIZED_ELEMENT_OVERSHOOT_PX, 200),
    // Blank-page signals.
    blankTextLength: int(process.env.BLANK_TEXT_LENGTH, 40),
    lowTextLength: int(process.env.LOW_TEXT_LENGTH, 250),
    blankElementCount: int(process.env.BLANK_ELEMENT_COUNT, 5),
    lowElementCount: int(process.env.LOW_ELEMENT_COUNT, 15),
    // Page height below this fraction of the viewport counts as "very short".
    shortPageRatio: Number.parseFloat(process.env.SHORT_PAGE_RATIO || '0.6') || 0.6,
    // Blank score at or above this value classifies the page as blank.
    blankScore: int(process.env.BLANK_SCORE, 5),
    // Body text shorter than this may be scanned for error-page phrases.
    errorTextScanLength: int(process.env.ERROR_TEXT_SCAN_LENGTH, 2000),
    // Minimum number of meaningful first-party request failures for REVIEW.
    firstPartyFailureLimit: int(process.env.FIRST_PARTY_FAILURE_LIMIT, 1),
  },

  // --- Teams --------------------------------------------------------------
  teams: {
    // Read only from the environment. Never hardcode or log this value.
    webhookUrl: process.env.TEAMS_WEBHOOK_URL || '',
    timeout: int(process.env.TEAMS_TIMEOUT, 15000),
    retries: int(process.env.TEAMS_RETRIES, 2),
    // Small pause between individual alerts to stay friendly to Power Automate.
    delayBetweenPosts: int(process.env.TEAMS_POST_DELAY, 500),
  },
};

export default config;
