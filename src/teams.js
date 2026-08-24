import { config } from './config.js';
import { sleep } from './utils.js';

/**
 * Microsoft Teams delivery via an existing Power Automate webhook.
 *
 * The webhook URL is read only from process.env.TEAMS_WEBHOOK_URL and is
 * never logged, echoed or written to any report. When the variable is absent
 * the audit continues normally and posting is skipped.
 */

export function isTeamsConfigured() {
  return Boolean(config.teams.webhookUrl);
}

/** Build the per-site alert payload (REVIEW / BROKEN only). */
export function buildIssuePayload(result) {
  return {
    type: 'issue',
    status: result.status,
    url: result.url,
    finalUrl: result.finalUrl,
    httpStatus: result.httpStatus,
    loadTimeMs: result.loadTimeMs,
    issues: result.issues ?? [],
    screenshotPath: result.screenshotPath,
    checkedAt: result.checkedAt,
  };
}

/** Build the single run summary payload. */
export function buildSummaryPayload(summary) {
  return {
    type: 'summary',
    total: summary.total,
    passed: summary.passed,
    review: summary.review,
    broken: summary.broken,
    durationMs: summary.durationMs,
    checkedAt: summary.checkedAt,
  };
}

/**
 * POST one JSON payload. Never throws: failures are logged (without the
 * webhook URL) and reported through the return value.
 */
export async function postToTeams(payload, { label = 'payload' } = {}) {
  if (!isTeamsConfigured()) {
    return { ok: false, skipped: true, reason: 'TEAMS_WEBHOOK_URL not set' };
  }

  const attempts = Math.max(1, config.teams.retries + 1);
  let lastError = 'unknown error';

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(config.teams.webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(config.teams.timeout),
      });

      if (response.ok) {
        return { ok: true, status: response.status };
      }

      // Power Automate returns the failure detail in the body; keep it short
      // and never include the request URL.
      const detail = await safeText(response);
      lastError = `HTTP ${response.status}${detail ? ` - ${detail}` : ''}`;
      // 4xx other than 429 will not get better on retry.
      if (response.status < 500 && response.status !== 429) break;
    } catch (error) {
      lastError = sanitize(error?.message || String(error));
    }

    if (attempt < attempts) {
      await sleep(500 * attempt);
    }
  }

  console.error(`[teams] Failed to post ${label}: ${lastError}`);
  return { ok: false, skipped: false, reason: lastError };
}

/**
 * Post alerts for every REVIEW / BROKEN result, then the run summary.
 * Always resolves — Teams problems must not fail the audit.
 */
export async function sendTeamsReport(results, summary) {
  if (!isTeamsConfigured()) {
    console.warn(
      '[teams] TEAMS_WEBHOOK_URL is not set - skipping Teams notifications. ' +
        'Screenshots and reports were still saved.',
    );
    return { skipped: true, sent: 0, failed: 0 };
  }

  const alertable = results.filter((result) => result.status !== 'PASS');
  let sent = 0;
  let failed = 0;

  for (const result of alertable) {
    const outcome = await postToTeams(buildIssuePayload(result), {
      label: `${result.status} alert`,
    });
    if (outcome.ok) sent += 1;
    else failed += 1;
    if (config.teams.delayBetweenPosts > 0) {
      await sleep(config.teams.delayBetweenPosts);
    }
  }

  const summaryOutcome = await postToTeams(buildSummaryPayload(summary), { label: 'summary' });
  if (summaryOutcome.ok) sent += 1;
  else failed += 1;

  console.log(
    `[teams] Posted ${sent} message(s)` +
      (failed > 0 ? `, ${failed} failed (see errors above)` : '') +
      ` - ${alertable.length} issue alert(s) + 1 summary.`,
  );

  return { skipped: false, sent, failed };
}

async function safeText(response) {
  try {
    const text = await response.text();
    return sanitize(text).slice(0, 200);
  } catch {
    return '';
  }
}

/** Defensive scrub: make sure no URL-looking token can leak into a log line. */
function sanitize(text) {
  return String(text ?? '')
    .replace(/https?:\/\/[^\s"']+/g, '[url redacted]')
    .replace(/\s+/g, ' ')
    .trim();
}
