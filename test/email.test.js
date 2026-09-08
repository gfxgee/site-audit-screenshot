import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import nodemailer from 'nodemailer';
import { buildEmailMessages, recipients, sendEmailNotifications } from '../src/email.js';

async function fixture(t) {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'audit-email-'));
  t.after(() => fs.rm(projectRoot, { recursive: true, force: true }));
  const artifactsDir = path.join(projectRoot, 'artifacts');
  const screenshotsDir = path.join(artifactsDir, 'screenshots');
  await fs.mkdir(screenshotsDir, { recursive: true });
  await fs.writeFile(path.join(artifactsDir, 'results.csv'), 'url,status\nhttps://example.com/,PASS\n');
  await fs.writeFile(path.join(artifactsDir, 'results.json'), '[]');
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1sAAAAASUVORK5CYII=', 'base64');
  await fs.writeFile(path.join(screenshotsDir, 'example.png'), png);
  return {
    config: { projectRoot, artifactsDir, screenshotsDir, emailMaxAttachmentBytes: 1024 * 1024 }, png,
    result: { url: 'https://example.com/', status: 'PASS', httpStatus: 200, loadTimeMs: 100,
      issues: [], checkedAt: '2026-09-08T00:00:00Z', screenshotPath: 'artifacts/screenshots/example.png' },
  };
}
const env = { SMTP_HOST: 'smtp.example.com', SMTP_USER: 'gee@digitalfeet.com', SMTP_PASS: 'test-secret' };

test('email contains all recipients, results, and actual screenshot MIME attachment, including PASS sites', async (t) => {
  const { config, result, png } = await fixture(t);
  const [message] = await buildEmailMessages([result, { ...result, status: 'BROKEN', issues: ['DNS failure'], screenshotError: 'Failed' }], 1500, config, env.SMTP_USER);
  assert.deepEqual(message.to, ['gee@digitalfeet.com', 'romeo@digitalfeet.com', 'jason@digitalfeet.com', 'levi@digitalfeet.com']);
  assert.equal(message.from, 'gee@digitalfeet.com');
  assert.match(message.text, /1 PASS, 0 REVIEW, 1 BROKEN/);
  assert.match(message.text, /DNS failure/);
  assert.match(message.text, /Screenshots unavailable for: https:\/\/example.com\//);
  assert.deepEqual(message.attachments.map((a) => a.filename), ['results.csv', 'results.json', 'example.png']);
  assert.deepEqual(message.attachments[2].content, png);
  const transport = nodemailer.createTransport({ streamTransport: true, buffer: true });
  const { message: mime } = await transport.sendMail(message);
  assert.match(mime.toString(), /Content-Type: image\/png; name=example.png/);
  assert.match(mime.toString(), /Content-Disposition: attachment; filename=example.png/);
  assert.ok(mime.toString().replace(/\r?\n/g, '').includes(png.toString('base64')));
});

test('splits attachments without dropping any and rejects an oversized single attachment before sending', async (t) => {
  const { config, result } = await fixture(t);
  config.emailMaxAttachmentBytes = 80;
  const messages = await buildEmailMessages([result], 100, config, env.SMTP_USER);
  assert.equal(messages.length, 2);
  assert.match(messages[1].subject, /part 2\/2/);
  assert.equal(messages.flatMap((m) => m.attachments).length, 3);
  for (const message of messages) assert.ok(message.attachments.reduce((sum, a) => sum + a.content.length, 0) <= 80);
  config.emailMaxAttachmentBytes = 10;
  await assert.rejects(buildEmailMessages([result], 100, config, env.SMTP_USER), /exceeds EMAIL_MAX_ATTACHMENT_BYTES/);
});

test('missing and failed screenshots are disclosed and stale files are not attached', async (t) => {
  const { config, result } = await fixture(t);
  for (const override of [{ screenshotError: 'Failed' }, { screenshotPath: 'artifacts/screenshots/missing.png' }]) {
    const [message] = await buildEmailMessages([{ ...result, ...override }], 100, config, env.SMTP_USER);
    assert.equal(message.attachments.length, 2);
    assert.match(message.text, /Screenshots unavailable/);
  }
  await assert.rejects(buildEmailMessages([{ ...result, screenshotPath: 'package.json' }], 100, config, env.SMTP_USER), /outside/);
});

test('unconfigured local sending skips but required or partial configuration fails', async () => {
  const unusedTransport = () => { throw new Error('Should not create transport'); };
  await sendEmailNotifications([], 0, {}, {}, unusedTransport);
  await assert.rejects(sendEmailNotifications([], 0, {}, { EMAIL_REQUIRED: 'true' }, unusedTransport), /configuration missing/);
  await assert.rejects(sendEmailNotifications([], 0, {}, { SMTP_HOST: 'smtp.example.com' }, unusedTransport), /SMTP_USER, SMTP_PASS/);
});

test('requires encrypted SMTP, checks acceptance for all recipients, and closes transport on failure', async (t) => {
  const { config, result } = await fixture(t);
  let closed = 0;
  for (const port of ['465', '587']) {
    await sendEmailNotifications([result], 100, config, { ...env, SMTP_PORT: port }, (options) => {
      assert.equal(options.secure, port === '465');
      assert.equal(options.requireTLS, true);
      return { sendMail: async () => ({ accepted: [...recipients], rejected: [] }), close: () => closed++ };
    });
  }
  await assert.rejects(sendEmailNotifications([result], 100, config, env, () => ({
    sendMail: async () => ({ accepted: recipients.slice(1), rejected: [recipients[0]] }), close: () => closed++,
  })), /not accepted for all/);
  await assert.rejects(sendEmailNotifications([result], 100, config, env, () => ({
    sendMail: async () => { throw new Error('test-secret'); }, close: () => closed++,
  })), (error) => !error.message.includes('test-secret') && error.message.includes('failed'));
  assert.equal(closed, 4);
});
