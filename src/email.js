import fs from 'node:fs/promises';
import path from 'node:path';
import { errorMessage, formatDuration, hostLabel } from './utils.js';

/**
 * Email delivery of the audit report through the Resend API.
 *
 * One digest per run: a summary line, a report of every REVIEW/BROKEN site
 * and why, a table of all monitored sites, and the full-page screenshot of
 * every site attached.
 *
 * RESEND_API_KEY is read from the environment only. It is never logged, never
 * written to a report, and never included in an error message.
 */

const STATUS_COLOURS = { PASS: '#1a7f37', REVIEW: '#9a6700', BROKEN: '#b3261e' };

function websiteName(result) {
  return hostLabel(result.finalUrl || result.url);
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

export function buildSubject(results, config) {
  const counts = countStatuses(results);
  const prefix = config.email.subjectPrefix;
  if (counts.BROKEN > 0 || counts.REVIEW > 0) {
    const parts = [];
    if (counts.BROKEN > 0) parts.push(`${counts.BROKEN} broken`);
    if (counts.REVIEW > 0) parts.push(`${counts.REVIEW} to review`);
    return `${prefix}: ${parts.join(', ')} of ${results.length} sites`;
  }
  return `${prefix}: all ${results.length} sites OK`;
}

function countStatuses(results) {
  return {
    PASS: results.filter(({ status }) => status === 'PASS').length,
    REVIEW: results.filter(({ status }) => status === 'REVIEW').length,
    BROKEN: results.filter(({ status }) => status === 'BROKEN').length,
  };
}

/**
 * Read the JPEG copy of each full-page screenshot, largest-priority first,
 * stopping once the attachment budget is spent. Problem sites are attached
 * before healthy ones so a size cap can never hide the sites that matter.
 */
export async function collectAttachments(results, config) {
  const budgetBytes = config.email.attachmentBudgetMb * 1024 * 1024;
  const priority = { BROKEN: 0, REVIEW: 1, PASS: 2 };
  const ordered = [...results].sort(
    (a, b) => (priority[a.status] ?? 3) - (priority[b.status] ?? 3),
  );

  const attachments = [];
  const skipped = [];
  let usedBytes = 0;

  for (const result of ordered) {
    const relative = result.emailImagePath;
    if (!relative) {
      skipped.push({ name: websiteName(result), reason: 'no screenshot captured' });
      continue;
    }

    const absolute = path.resolve(config.projectRoot, relative);
    let content;
    try {
      content = await fs.readFile(absolute);
    } catch (error) {
      skipped.push({ name: websiteName(result), reason: `unreadable (${errorMessage(error)})` });
      continue;
    }

    if (usedBytes + content.length > budgetBytes) {
      skipped.push({
        name: websiteName(result),
        reason: `omitted to stay under the ${config.email.attachmentBudgetMb}MB attachment limit`,
      });
      continue;
    }

    usedBytes += content.length;
    attachments.push({
      filename: path.basename(absolute),
      content: content.toString('base64'),
      content_type: 'image/jpeg',
      // Resend uses snake_case; content_id is what lets the HTML body
      // reference the image inline via cid:. If a provider ignores it the
      // image simply arrives as a normal attachment.
      content_id: attachmentCid(result),
    });
  }

  return { attachments, skipped, usedBytes };
}

/** Stable Content-ID so the HTML body can embed each screenshot inline. */
function attachmentCid(result) {
  const base = result.emailImagePath ? path.basename(result.emailImagePath) : websiteName(result);
  return `shot-${base.replace(/[^a-zA-Z0-9]+/g, '-').toLowerCase()}`;
}

export function buildHtml(results, durationMs, { skipped }, config) {
  const counts = countStatuses(results);
  const problems = results.filter(({ status }) => status !== 'PASS');
  const checkedAt = new Date().toISOString();

  const badge = (status) =>
    `<span style="display:inline-block;padding:2px 8px;border-radius:10px;font-size:12px;` +
    `font-weight:600;color:#fff;background:${STATUS_COLOURS[status] ?? '#666'}">${escapeHtml(status)}</span>`;

  const summaryRow = `
    <p style="margin:0 0 4px;font-size:15px">
      <strong>${results.length}</strong> sites checked in ${escapeHtml(formatDuration(durationMs))} &mdash;
      <strong style="color:${STATUS_COLOURS.PASS}">${counts.PASS} PASS</strong>,
      <strong style="color:${STATUS_COLOURS.REVIEW}">${counts.REVIEW} REVIEW</strong>,
      <strong style="color:${STATUS_COLOURS.BROKEN}">${counts.BROKEN} BROKEN</strong>
    </p>
    <p style="margin:0 0 20px;color:#666;font-size:12px">Checked at ${escapeHtml(checkedAt)}</p>`;

  const issueReport = problems.length === 0
    ? `<p style="margin:0 0 20px;color:${STATUS_COLOURS.PASS}">No issues detected on any monitored homepage.</p>`
    : `
      <h2 style="font-size:16px;margin:24px 0 8px">Issues needing attention (${problems.length})</h2>
      ${problems.map((result) => `
        <div style="border-left:3px solid ${STATUS_COLOURS[result.status] ?? '#666'};padding:8px 12px;margin:0 0 12px;background:#fafafa">
          <div style="font-size:14px;font-weight:600;margin-bottom:4px">
            ${badge(result.status)}&nbsp; ${escapeHtml(websiteName(result))}
          </div>
          <div style="font-size:12px;color:#555;margin-bottom:6px">
            <a href="${escapeHtml(result.url)}" style="color:#0969da">${escapeHtml(result.url)}</a>
            &nbsp;&middot;&nbsp; HTTP ${escapeHtml(result.httpStatus ?? 'n/a')}
            &nbsp;&middot;&nbsp; ${escapeHtml(result.loadTimeMs ?? 'n/a')} ms
          </div>
          <ul style="margin:0;padding-left:18px;font-size:13px">
            ${(result.issues.length ? result.issues : ['No issue detail recorded'])
              .map((issue) => `<li>${escapeHtml(issue)}</li>`).join('')}
          </ul>
        </div>`).join('')}`;

  const table = `
    <h2 style="font-size:16px;margin:24px 0 8px">All monitored sites</h2>
    <table cellpadding="6" cellspacing="0" style="border-collapse:collapse;font-size:13px;width:100%">
      <thead>
        <tr style="background:#f0f0f0;text-align:left">
          <th>Status</th><th>Site</th><th>HTTP</th><th>Load</th><th>Issues</th>
        </tr>
      </thead>
      <tbody>
        ${results.map((result) => `
          <tr style="border-top:1px solid #e0e0e0">
            <td>${badge(result.status)}</td>
            <td><a href="${escapeHtml(result.url)}" style="color:#0969da">${escapeHtml(websiteName(result))}</a></td>
            <td>${escapeHtml(result.httpStatus ?? 'n/a')}</td>
            <td>${escapeHtml(result.loadTimeMs ?? 'n/a')} ms</td>
            <td>${escapeHtml(result.issues.join('; ') || '-')}</td>
          </tr>`).join('')}
      </tbody>
    </table>`;

  const mode = config.email.inlineScreenshots;
  const embedded = mode === 'none'
    ? []
    : results.filter((result) => mode === 'all' || result.status !== 'PASS');

  const shots = embedded.length === 0 ? '' : `
    <h2 style="font-size:16px;margin:28px 0 8px">Full-page screenshots</h2>
    ${embedded.map((result) => {
      const cid = attachmentCid(result);
      const attached = !skipped.some((entry) => entry.name === websiteName(result));
      return `
        <div style="margin:0 0 28px">
          <div style="font-size:14px;font-weight:600;margin-bottom:6px">
            ${badge(result.status)}&nbsp; ${escapeHtml(websiteName(result))}
          </div>
          ${attached
            ? `<img src="cid:${cid}" alt="${escapeHtml(websiteName(result))} homepage"
                 style="width:100%;max-width:640px;border:1px solid #ddd">`
            : `<p style="font-size:12px;color:#888;margin:0">Screenshot not attached &mdash; see the GitHub Actions artifact.</p>`}
        </div>`;
    }).join('')}`;

  const attachedNote = `
    <p style="font-size:12px;color:#888;margin:16px 0 0">
      All ${results.length} full-page screenshots are attached to this email as JPEG files.
      Full-resolution PNGs are in the GitHub Actions run artifact.
    </p>`;

  const skippedNote = skipped.length === 0 ? '' : `
    <p style="font-size:12px;color:#888;margin:16px 0 0">
      ${skipped.length} screenshot(s) not attached:
      ${escapeHtml(skipped.map((entry) => `${entry.name} (${entry.reason})`).join('; '))}.
      Every screenshot is always available in full resolution in the workflow artifact.
    </p>`;

  // An explicit light background is required: email clients that apply a dark
  // theme would otherwise render this dark text on a dark ground.
  return `<!doctype html><html><head><meta name="color-scheme" content="light only">
  <meta name="supported-color-schemes" content="light"></head>
  <body style="margin:0;padding:0;background-color:#ffffff">
    <table width="100%" cellpadding="0" cellspacing="0" bgcolor="#ffffff" style="background-color:#ffffff">
      <tr><td style="padding:24px;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#1a1a1a;background-color:#ffffff">
        <h1 style="font-size:20px;margin:0 0 12px;color:#1a1a1a">Homepage audit report</h1>
        ${summaryRow}${issueReport}${table}${shots}${attachedNote}${skippedNote}
      </td></tr>
    </table>
  </body></html>`;
}

export function buildText(results, durationMs) {
  const counts = countStatuses(results);
  const lines = [
    `Homepage audit: ${results.length} sites in ${formatDuration(durationMs)}`,
    `${counts.PASS} PASS, ${counts.REVIEW} REVIEW, ${counts.BROKEN} BROKEN`,
    '',
  ];

  const problems = results.filter(({ status }) => status !== 'PASS');
  if (problems.length === 0) {
    lines.push('No issues detected.', '');
  } else {
    lines.push(`Issues needing attention (${problems.length}):`);
    for (const result of problems) {
      lines.push(
        `  [${result.status}] ${websiteName(result)} - HTTP ${result.httpStatus ?? 'n/a'}, ${result.loadTimeMs ?? 'n/a'} ms`,
      );
      for (const issue of result.issues.length ? result.issues : ['No issue detail recorded']) {
        lines.push(`      - ${issue}`);
      }
    }
    lines.push('');
  }

  lines.push('All monitored sites:');
  for (const result of results) {
    lines.push(`  ${result.status.padEnd(6)} ${websiteName(result)} (HTTP ${result.httpStatus ?? 'n/a'})`);
  }
  return lines.join('\n');
}

/** POST one email to Resend. Never throws; never exposes the API key. */
async function postEmail(payload, config) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.email.timeout);
  try {
    const response = await fetch(`${config.email.apiBase}/emails`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${config.email.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new Error(`HTTP ${response.status} ${response.statusText}${detail ? ` - ${detail.slice(0, 300)}` : ''}`);
    }
    return await response.json().catch(() => ({}));
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Send the digest. Missing configuration logs a warning and skips sending;
 * a delivery failure is logged and swallowed. Neither fails the audit.
 */
export async function sendEmailReport(results, durationMs, config) {
  if (!config.email.apiKey) {
    console.warn('[Email] RESEND_API_KEY is not configured; the email report was skipped.');
    return { skipped: true };
  }
  if (config.email.to.length === 0) {
    console.warn('[Email] EMAIL_TO is not configured; the email report was skipped.');
    return { skipped: true };
  }

  const { attachments, skipped, usedBytes } = await collectAttachments(results, config);
  const payload = {
    from: config.email.from,
    to: config.email.to,
    subject: buildSubject(results, config),
    html: buildHtml(results, durationMs, { skipped }, config),
    text: buildText(results, durationMs),
    attachments,
  };

  const sizeMb = (usedBytes / 1048576).toFixed(1);
  try {
    const response = await postEmail(payload, config);
    console.log(
      `[Email] Report sent to ${config.email.to.length} recipient(s) with ` +
        `${attachments.length}/${results.length} screenshots (${sizeMb}MB)` +
        (response?.id ? ` - id ${response.id}` : ''),
    );
    return { skipped: false, sent: true, attachments: attachments.length };
  } catch (error) {
    console.error(`[Email] Could not send the audit report: ${errorMessage(error)}`);
    return { skipped: false, sent: false };
  }
}

export const emailInternals = {
  attachmentCid, buildHtml, buildSubject, buildText, collectAttachments, countStatuses, postEmail, websiteName,
};
