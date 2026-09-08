import fs from 'node:fs/promises';
import path from 'node:path';
import nodemailer from 'nodemailer';
import { hostLabel } from './utils.js';

export const recipients = Object.freeze([
  'gee@digitalfeet.com', 'romeo@digitalfeet.com',
  'jason@digitalfeet.com', 'levi@digitalfeet.com',
]);

export async function buildEmailMessages(results, durationMs, config, from) {
  const attachments = await Promise.all(['results.csv', 'results.json'].map(async (filename) => ({
    filename, content: await fs.readFile(path.join(config.artifactsDir, filename)),
    contentType: filename.endsWith('.csv') ? 'text/csv' : 'application/json',
  })));
  const missing = [];
  for (const result of results) {
    if (!result.screenshotPath || result.screenshotError) {
      missing.push(result.url);
      continue;
    }
    const absolutePath = path.resolve(config.projectRoot, result.screenshotPath);
    const relative = path.relative(config.screenshotsDir, absolutePath);
    if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new Error('Screenshot is outside the configured screenshots directory.');
    }
    try {
      attachments.push({ filename: path.basename(absolutePath), content: await fs.readFile(absolutePath), contentType: 'image/png' });
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      missing.push(result.url);
    }
  }
  const totals = ['PASS', 'REVIEW', 'BROKEN'].map((status) => `${results.filter((r) => r.status === status).length} ${status}`).join(', ');
  const text = [
    'Website audit results',
    `${results.length} websites: ${totals}`,
    `Duration: ${(durationMs / 1000).toFixed(1)} seconds`, '',
    ...results.map((r) => [
      `${r.status}: ${hostLabel(r.finalUrl || r.url)}`,
      `URL: ${r.url}`, `Final URL: ${r.finalUrl || 'Unavailable'}`,
      `HTTP: ${r.httpStatus ?? 'Unavailable'} | Load time: ${r.loadTimeMs ?? 'Unavailable'} ms`,
      `Issues: ${r.issues.join('; ') || 'None'}`, `Checked: ${r.checkedAt}`, '',
    ].join('\n')),
    ...(missing.length ? [`Screenshots unavailable for: ${missing.join(', ')}`] : []),
    'CSV/JSON reports and available screenshots are attached across the numbered parts of this email.',
  ].join('\n');
  const batches = [[]];
  let bytes = 0;
  for (const attachment of attachments) {
    if (attachment.content.length > config.emailMaxAttachmentBytes) {
      throw new Error(`Attachment ${attachment.filename} exceeds EMAIL_MAX_ATTACHMENT_BYTES; reports and screenshots remain in audit artifacts.`);
    }
    if (bytes + attachment.content.length > config.emailMaxAttachmentBytes) {
      batches.push([]);
      bytes = 0;
    }
    batches.at(-1).push(attachment);
    bytes += attachment.content.length;
  }
  return batches.map((batch, index) => ({
    from, to: [...recipients],
    subject: `Website audit: ${totals}${batches.length > 1 ? ` (part ${index + 1}/${batches.length})` : ''}`,
    text, attachments: batch, disableFileAccess: true, disableUrlAccess: true,
  }));
}

export async function sendEmailNotifications(results, durationMs, config, env = process.env, createTransport = nodemailer.createTransport) {
  const keys = ['SMTP_HOST', 'SMTP_USER', 'SMTP_PASS'];
  const missing = keys.filter((key) => !env[key]);
  if (missing.length) {
    if (env.EMAIL_REQUIRED === 'true' || keys.some((key) => env[key])) {
      throw new Error(`Email configuration missing: ${missing.join(', ')}. Audit artifacts were saved.`);
    }
    console.warn('[Email] SMTP is not configured; notifications skipped. Audit artifacts were saved.');
    return;
  }
  const port = Number(env.SMTP_PORT || 587);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('SMTP_PORT must be an integer from 1 to 65535.');
  const messages = await buildEmailMessages(results, durationMs, config, env.EMAIL_FROM || 'gee@digitalfeet.com');
  const transport = createTransport({
    host: env.SMTP_HOST, port, secure: port === 465, requireTLS: true,
    auth: { user: env.SMTP_USER, pass: env.SMTP_PASS },
    connectionTimeout: 30_000, greetingTimeout: 30_000, socketTimeout: 60_000,
    disableFileAccess: true, disableUrlAccess: true,
  });
  try {
    for (let index = 0; index < messages.length; index += 1) {
      let info;
      try {
        info = await transport.sendMail(messages[index]);
      } catch {
        // Avoid logging provider responses that may contain credentials or message content.
        throw new Error(`Email part ${index + 1}/${messages.length} failed. Check SMTP settings and provider limits; audit artifacts were saved.`);
      }
      if (info.rejected?.length || info.accepted?.length !== recipients.length) {
        throw new Error(`Email part ${index + 1}/${messages.length} was not accepted for all recipients; audit artifacts were saved.`);
      }
      console.log(`[Email] Part ${index + 1}/${messages.length} accepted by SMTP for all ${recipients.length} recipients.`);
    }
  } finally {
    transport.close();
  }
}
