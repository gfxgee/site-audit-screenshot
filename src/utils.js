import fs from 'node:fs/promises';
import path from 'node:path';

/** Multi-label public suffixes we care about, so eTLD+1 stays correct. */
const MULTI_PART_SUFFIXES = new Set([
  'co.uk',
  'org.uk',
  'gov.uk',
  'ac.uk',
  'co.nz',
  'co.za',
  'com.au',
  'net.au',
  'org.au',
  'com.br',
  'com.mx',
  'com.ph',
  'com.sg',
  'co.jp',
  'co.in',
  'co.kr',
]);

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));

/** Create a directory (and parents) if it does not already exist. */
export async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
}

/**
 * Turn a URL into a safe, hostname-based file stem.
 *   https://digitalfeet.com/  -> digitalfeet-com
 *   https://point.taken.no/en -> point-taken-no
 */
export function hostnameSlug(url) {
  let hostname;
  try {
    hostname = new URL(url).hostname;
  } catch {
    hostname = String(url);
  }
  const slug = hostname
    .toLowerCase()
    .replace(/^www\./, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'site';
}

/**
 * Screenshot filename derived from the hostname, kept unique when several
 * URLs would collapse onto the same hostname (e.g. a path-based variant).
 * `used` is a Set that the caller keeps across all sites.
 */
export function screenshotFileName(url, used = new Set()) {
  const base = hostnameSlug(url);
  let name = `${base}.png`;
  if (!used.has(name)) {
    used.add(name);
    return name;
  }

  // Try to disambiguate with the path, then fall back to a counter.
  let pathSlug = '';
  try {
    pathSlug = new URL(url).pathname.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  } catch {
    pathSlug = '';
  }
  if (pathSlug) {
    name = `${base}-${pathSlug.toLowerCase()}.png`;
    if (!used.has(name)) {
      used.add(name);
      return name;
    }
  }

  let counter = 2;
  while (used.has(`${base}-${counter}.png`)) counter += 1;
  name = `${base}-${counter}.png`;
  used.add(name);
  return name;
}

/** Registrable domain (eTLD+1) for same-site comparisons. */
export function registrableDomain(hostname) {
  const host = String(hostname || '')
    .toLowerCase()
    .replace(/\.$/, '');
  if (!host || /^\d+\.\d+\.\d+\.\d+$/.test(host)) return host;

  const labels = host.split('.');
  if (labels.length <= 2) return host;

  const lastTwo = labels.slice(-2).join('.');
  if (MULTI_PART_SUFFIXES.has(lastTwo)) {
    return labels.slice(-3).join('.');
  }
  return lastTwo;
}

/** True when `url` belongs to the same registrable domain as `baseUrl`. */
export function isFirstParty(url, baseUrl) {
  try {
    const a = registrableDomain(new URL(url).hostname);
    const b = registrableDomain(new URL(baseUrl).hostname);
    return Boolean(a) && a === b;
  } catch {
    return false;
  }
}

/** Short display host, e.g. digitalfeet.com. */
export function displayHost(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return String(url);
  }
}

/**
 * Collapse newlines/tabs so a browser message stays on one line in the
 * terminal, the CSV and the Teams payload.
 */
export function oneLine(value) {
  return String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function truncate(value, max = 300) {
  const text = oneLine(value);
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** Cap an array and report how many entries were dropped. */
export function capList(list, max) {
  const items = Array.isArray(list) ? list : [];
  if (items.length <= max) return { items, truncated: 0 };
  return { items: items.slice(0, max), truncated: items.length - max };
}

export function formatSeconds(ms) {
  if (!Number.isFinite(ms)) return 'n/a';
  return `${(ms / 1000).toFixed(1)}s`;
}

export function formatDuration(ms) {
  if (!Number.isFinite(ms)) return 'n/a';
  const totalSeconds = Math.round(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
}

/** POSIX-style relative path, so reports look the same on Windows and Linux. */
export function toPosixPath(filePath) {
  return path.relative(process.cwd(), filePath).split(path.sep).join('/');
}

/**
 * Run `worker` over `items` with at most `limit` in flight.
 * Results come back in input order; a rejected worker rejects the whole run,
 * so callers should handle their own per-item errors.
 */
export async function runWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;

  const runners = Array.from({ length: Math.min(Math.max(1, limit), items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await worker(items[index], index);
    }
  });

  await Promise.all(runners);
  return results;
}
