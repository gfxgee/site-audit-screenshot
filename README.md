# Website Homepage Audit

This repository automatically opens each monitored homepage in Playwright Chromium, checks for common technical and rendering failures, and captures a full-page screenshot at a 1440×900 desktop viewport. It runs locally or entirely on GitHub-hosted Actions runners; no paid browser service is required.

The audit visits only the exact homepage URLs supplied in `sites.csv`. It does not crawl or click into other pages.

## Websites

Monitored homepages are stored in [`sites.csv`](sites.csv):

```csv
url
https://digitalfeet.com/
```

To add a website, add one absolute `http://` or `https://` URL on a new row. Keep the `url` header. Screenshots use safe hostname-based names; duplicate hostnames receive a stable URL hash so files cannot overwrite one another.

## What it checks

For every homepage, the audit records the requested and final URL, main-document HTTP status, redirect destination, load time, navigation/timeout/SSL/DNS errors, broken rendered images, JavaScript errors, console errors, failed requests, error-page phrases, blank-page signals, and basic layout overflow signals.

After the initial render, the page is scrolled gradually to trigger lazy-loaded homepage content, returned to the top, and captured with a true full-page screenshot. Cookie banners and normal first-visit popups are left as a visitor would see them. Common analytics, advertising, tracking, cookie-management, telemetry, and favicon failures are filtered to reduce false positives.

Results are classified as:

- `PASS`: the homepage loaded without a significant detected issue.
- `REVIEW`: the homepage loaded but has a meaningful broken image, first-party request failure, script/console error, screenshot problem, or suspicious layout condition.
- `BROKEN`: navigation failed, the main document returned 404 or 5xx, an obvious error page was detected, or the page is effectively blank.

Ambiguous partial failures are intentionally classified as `REVIEW`, not `BROKEN`.

## Local setup

Node.js 22 or newer is required (the current Node.js 24 LTS line is used in GitHub Actions).

```bash
npm install
npx playwright install chromium
npm run check
```

Run the deterministic classification tests with:

```bash
npm test
```

The audit works without Microsoft Teams configured. In that case it still creates every screenshot and report, logs one warning, and skips notifications.

## Configuration

All configuration is optional and supplied through environment variables:

| Variable | Default | Purpose |
| --- | ---: | --- |
| `VIEWPORT_WIDTH` | `1440` | Browser viewport width in pixels |
| `VIEWPORT_HEIGHT` | `900` | Browser viewport height in pixels |
| `NAVIGATION_TIMEOUT` | `30000` | Homepage navigation timeout in milliseconds |
| `POST_LOAD_WAIT` | `2000` | Render wait before scrolling and before capture |
| `CONCURRENCY` | `3` | Maximum simultaneous browser contexts/pages |
| `MAX_JS_ERRORS` | `20` | Maximum stored page errors per site |
| `MAX_CONSOLE_ERRORS` | `20` | Maximum stored console errors per site |
| `MAX_FAILED_REQUESTS` | `30` | Maximum stored failed/HTTP-error requests per site |
| `SCROLL_DELAY` | `250` | Delay between lazy-loading scroll steps in milliseconds |
| `SCROLL_MAX_STEPS` | `100` | Safety limit for lazy-loading scroll steps |
| `TEAMS_TIMEOUT` | `10000` | Teams webhook request timeout in milliseconds |

For PowerShell, a one-run override looks like:

```powershell
$env:CONCURRENCY = '2'
npm run check
```

## Microsoft Teams setup

The existing Power Automate webhook must be saved as a GitHub Actions repository secret. The URL is read only from `process.env.TEAMS_WEBHOOK_URL`; it is never hardcoded or logged.

In GitHub, open:

```text
Repository
→ Settings
→ Secrets and variables
→ Actions
→ New repository secret
```

Create a secret named `TEAMS_WEBHOOK_URL` and paste the existing Power Automate webhook URL as its value. Do not add the URL to source files or workflow YAML.

Only `REVIEW` and `BROKEN` sites receive individual issue payloads. One aggregate summary is sent after all sites finish. Teams delivery failures are logged without exposing the webhook and do not stop the audit.

Each issue payload contains a human-readable `websiteName`, status and URL fields, HTTP/load information, issue text and counts, a preformatted `detailsText`, and the screenshot as `screenshotContentBase64`. The original `screenshotPath` is retained only as an artifact-relative reference; it is not a public URL.

### Display screenshots in the Teams card

An Adaptive Card image requires an accessible image URL. The GitHub runner path cannot be used directly. In the Power Automate `type = issue` branch:

1. Add **Create file** using OneDrive for Business or SharePoint.
2. Set **File Name** to `triggerBody()?['screenshotFileName']`.
3. Set **File Content** with the expression `base64ToBinary(triggerBody()?['screenshotContentBase64'])`.
4. Create an organization-accessible sharing link for that file.
5. Add an `Action.OpenUrl` button such as **Open full screenshot** using that sharing link.

For an inline Adaptive Card `Image`, use a direct HTTPS URL that returns the image bytes and is accessible to the Teams client. Do not use a normal sharing link if it redirects: Teams does not support redirects for card image URLs. An access-controlled SharePoint direct image URL can work if it is resolvable by every intended Teams viewer; otherwise publish the image to an approved image host. The audit deliberately does not make screenshots public automatically.

The issue-card title can use `triggerBody()?['title']`, which produces values such as `REVIEW: digitalfeet.com`. Use `triggerBody()?['detailsText']` for all core diagnostics in one text block. The summary card can use `triggerBody()?['summaryText']` and `triggerBody()?['websiteStatusText']`; the payload also includes a structured `websites` array with the name, status, URL, HTTP status, load time, and issues for every audited site.

## GitHub Actions

The workflow is defined in [`.github/workflows/health-check.yml`](.github/workflows/health-check.yml). It uses `ubuntu-latest`, Node.js 24 LTS, dependency caching, and Playwright's Chromium plus required Linux dependencies.

### Manual run

In GitHub, open:

```text
GitHub
→ Actions
→ Website Homepage Audit
→ Run workflow
```

### Scheduled run

The default schedule is daily at `00:00 UTC`, which is `08:00` in the Philippines (`UTC+8`). GitHub Actions cron expressions always use UTC. To change the time, edit the `cron` value in `.github/workflows/health-check.yml`; for example, `0 1 * * *` means 01:00 UTC / 09:00 Philippines time.

GitHub may delay scheduled jobs during periods of high load, so the start time is approximate.

## Results

Every completed audit writes:

```text
artifacts/results.json
artifacts/results.csv
artifacts/screenshots/
```

The reports are written even when one or more monitored websites are `REVIEW` or `BROKEN`. These classifications are monitoring outcomes and do not fail the workflow. Only a genuine execution failure—such as Chromium failing to launch or reports being impossible to write—fails the job.

The workflow's artifact upload uses `if: always()` and retains results for 14 days. To download them, open the completed workflow run in GitHub Actions and select the `website-audit-results-<run number>` artifact near the bottom of the run summary.

Generated local screenshots and reports are ignored by Git, while the artifact directories remain tracked.

## Project structure

```text
.github/workflows/health-check.yml  GitHub Actions schedule and manual run
src/index.js                        Orchestration, concurrency, reports
src/checker.js                      Playwright navigation and page inspection
src/classifier.js                   PASS/REVIEW/BROKEN rules and noise filters
src/teams.js                        Power Automate webhook delivery
src/csv.js                          Site input and CSV report generation
src/config.js                       Environment configuration
src/utils.js                        Shared utilities
test/classifier.test.js             Classification regression tests
sites.csv                           Monitored homepage URLs
artifacts/                          Generated reports and screenshots
```
