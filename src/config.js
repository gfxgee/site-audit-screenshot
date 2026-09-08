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
  emailMaxAttachmentBytes: positiveInteger('EMAIL_MAX_ATTACHMENT_BYTES', 12 * 1024 * 1024),
});
