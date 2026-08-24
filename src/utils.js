import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

export async function ensureDirectory(directory) {
  await fs.mkdir(directory, { recursive: true });
}

export function limitPush(collection, value, maximum) {
  if (collection.length < maximum) collection.push(value);
}

export function relativePath(projectRoot, absolutePath) {
  return path.relative(projectRoot, absolutePath).split(path.sep).join('/');
}

function hostnameSlug(url) {
  return new URL(url).hostname
    .replace(/^www\./i, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '') || 'homepage';
}

export function screenshotNames(urls) {
  const counts = new Map();
  for (const url of urls) {
    const slug = hostnameSlug(url);
    counts.set(slug, (counts.get(slug) ?? 0) + 1);
  }

  return urls.map((url) => {
    const slug = hostnameSlug(url);
    if (counts.get(slug) === 1) return `${slug}.png`;
    const hash = crypto.createHash('sha256').update(url).digest('hex').slice(0, 8);
    return `${slug}-${hash}.png`;
  });
}

export function hostLabel(url) {
  try {
    return new URL(url).hostname.replace(/^www\./i, '');
  } catch {
    return url;
  }
}

export function formatDuration(milliseconds) {
  return `${(milliseconds / 1000).toFixed(1)}s`;
}

export function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
