import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function positiveInteger(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;

  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer; received "${raw}"`);
  }
  return parsed;
}

function boundedInteger(name, fallback, minimum, maximum) {
  const value = positiveInteger(name, fallback);
  if (value < minimum || value > maximum) {
    throw new Error(`${name} must be between ${minimum} and ${maximum}; received "${value}"`);
  }
  return value;
}

// An unset GitHub Actions variable arrives as an empty string, so empty is
// treated the same as absent and falls back to the default.
function text(name, fallback = '') {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const trimmed = raw.trim();
  return trimmed === '' ? fallback : trimmed;
}

function choice(name, fallback, allowed) {
  const value = text(name, fallback).toLowerCase();
  if (!allowed.includes(value)) {
    throw new Error(`${name} must be one of ${allowed.join(', ')}; received "${value}"`);
  }
  return value;
}

/** Split a comma/semicolon separated recipient list. */
function addressList(name) {
  return text(name)
    .split(/[,;]/)
    .map((address) => address.trim())
    .filter(Boolean);
}

export const config = Object.freeze({
  projectRoot,
  sitesPath: path.join(projectRoot, 'sites.csv'),
  artifactsDir: path.join(projectRoot, 'artifacts'),
  screenshotsDir: path.join(projectRoot, 'artifacts', 'screenshots'),
  viewport: {
    width: positiveInteger('VIEWPORT_WIDTH', 1440),
    height: positiveInteger('VIEWPORT_HEIGHT', 900),
  },
  navigationTimeout: positiveInteger('NAVIGATION_TIMEOUT', 30_000),
  postLoadWait: positiveInteger('POST_LOAD_WAIT', 2_000),
  concurrency: positiveInteger('CONCURRENCY', 3),
  maxJsErrors: positiveInteger('MAX_JS_ERRORS', 20),
  maxConsoleErrors: positiveInteger('MAX_CONSOLE_ERRORS', 20),
  maxFailedRequests: positiveInteger('MAX_FAILED_REQUESTS', 30),
  scrollDelay: positiveInteger('SCROLL_DELAY', 250),
  scrollMaxSteps: positiveInteger('SCROLL_MAX_STEPS', 100),

  // --- email report (Resend) ---------------------------------------------
  // The API key is read from the environment only; it is never logged.
  email: Object.freeze({
    apiKey: text('RESEND_API_KEY'),
    apiBase: text('RESEND_API_BASE', 'https://api.resend.com'),
    from: text('EMAIL_FROM', 'onboarding@resend.dev'),
    to: addressList('EMAIL_TO'),
    subjectPrefix: text('EMAIL_SUBJECT_PREFIX', 'Homepage audit'),
    timeout: positiveInteger('EMAIL_TIMEOUT', 60_000),
    // Full-page screenshots are re-encoded as JPEG for delivery. PNG stays
    // the archived artifact; JPEG keeps a 13-site email inside mailbox limits.
    jpegQuality: boundedInteger('EMAIL_JPEG_QUALITY', 70, 1, 100),
    // Total raw attachment budget in MB before base64 overhead (~+33%).
    // Mail providers commonly reject messages over 25MB.
    attachmentBudgetMb: boundedInteger('EMAIL_ATTACHMENT_BUDGET_MB', 12, 1, 35),
    // Which screenshots to embed in the body. Every screenshot is attached
    // regardless; this only controls inline display, because a full-page
    // shot renders ~2,700px tall and 13 of them make a very long email.
    //   all    - embed every site (default)
    //   issues - embed only REVIEW/BROKEN sites
    //   none   - attachments only
    inlineScreenshots: choice('EMAIL_INLINE_SCREENSHOTS', 'all', ['all', 'issues', 'none']),
  }),
});
