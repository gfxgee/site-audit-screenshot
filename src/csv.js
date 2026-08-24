import fs from 'node:fs/promises';

function parseRow(line) {
  const fields = [];
  let field = '';
  let quoted = false;

  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (character === '"' && quoted && line[index + 1] === '"') {
      field += '"';
      index += 1;
    } else if (character === '"') {
      quoted = !quoted;
    } else if (character === ',' && !quoted) {
      fields.push(field);
      field = '';
    } else {
      field += character;
    }
  }
  fields.push(field);
  return fields.map((value) => value.trim());
}

export async function readSites(filePath) {
  const contents = (await fs.readFile(filePath, 'utf8')).replace(/^\uFEFF/, '');
  const rows = contents.split(/\r?\n/).filter((line) => line.trim() !== '').map(parseRow);

  if (rows.length === 0 || rows[0][0].toLowerCase() !== 'url') {
    throw new Error(`${filePath} must begin with a "url" header`);
  }

  const urls = rows.slice(1).map(([url]) => url).filter(Boolean);
  if (urls.length === 0) throw new Error(`${filePath} does not contain any websites`);

  return urls.map((url) => {
    const parsed = new URL(url);
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      throw new Error(`Unsupported URL protocol in ${url}`);
    }
    return parsed.href;
  });
}

function escapeCsv(value) {
  const text = value === null || value === undefined ? '' : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export function resultsToCsv(results) {
  const columns = [
    'url', 'finalUrl', 'status', 'httpStatus', 'loadTimeMs', 'brokenImageCount',
    'jsErrorCount', 'consoleErrorCount', 'failedRequestCount',
    'horizontalOverflow', 'issues', 'screenshotPath', 'checkedAt',
  ];

  const rows = results.map((result) => ({
    url: result.url,
    finalUrl: result.finalUrl,
    status: result.status,
    httpStatus: result.httpStatus,
    loadTimeMs: result.loadTimeMs,
    brokenImageCount: result.brokenImages.length,
    jsErrorCount: result.jsErrors.length,
    consoleErrorCount: result.consoleErrors.length,
    failedRequestCount: result.failedRequests.length,
    horizontalOverflow: result.horizontalOverflow,
    issues: result.issues.join(' | '),
    screenshotPath: result.screenshotPath,
    checkedAt: result.checkedAt,
  }));

  return [
    columns.join(','),
    ...rows.map((row) => columns.map((column) => escapeCsv(row[column])).join(',')),
  ].join('\n') + '\n';
}
