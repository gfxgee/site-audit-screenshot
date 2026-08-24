function issuePayload(result) {
  return {
    type: 'issue',
    status: result.status,
    url: result.url,
    finalUrl: result.finalUrl,
    httpStatus: result.httpStatus,
    loadTimeMs: result.loadTimeMs,
    issues: result.issues,
    screenshotPath: result.screenshotPath,
    checkedAt: result.checkedAt,
  };
}

async function postJson(webhookUrl, payload, timeout) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);
  } finally {
    clearTimeout(timer);
  }
}

export async function sendTeamsNotifications(results, durationMs, config) {
  const webhookUrl = process.env.TEAMS_WEBHOOK_URL;
  if (!webhookUrl) {
    console.warn('[Teams] TEAMS_WEBHOOK_URL is not configured; notifications skipped.');
    return;
  }

  for (const result of results.filter(({ status }) => status === 'REVIEW' || status === 'BROKEN')) {
    try {
      await postJson(webhookUrl, issuePayload(result), config.teamsTimeout);
    } catch (error) {
      console.error(`[Teams] Could not send ${result.status} notification for ${result.url}: ${error.message}`);
    }
  }

  const summary = {
    type: 'summary',
    total: results.length,
    passed: results.filter(({ status }) => status === 'PASS').length,
    review: results.filter(({ status }) => status === 'REVIEW').length,
    broken: results.filter(({ status }) => status === 'BROKEN').length,
    checkedAt: new Date().toISOString(),
    durationMs,
  };

  try {
    await postJson(webhookUrl, summary, config.teamsTimeout);
  } catch (error) {
    console.error(`[Teams] Could not send audit summary: ${error.message}`);
  }
}

export const teamsInternals = { issuePayload, postJson };
