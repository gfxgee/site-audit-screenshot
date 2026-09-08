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

Local audits work without email configured: screenshots and reports are saved and a warning explains that email was skipped. GitHub Actions requires email configuration, so missing settings or delivery failures fail the job after saving the artifacts.

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
| `EMAIL_MAX_ATTACHMENT_BYTES` | `12582912` | Maximum raw attachment bytes per email; larger runs are split into numbered parts |

For PowerShell, a one-run override looks like:

```powershell
$env:CONCURRENCY = '2'
npm run check
```

## Email setup

Each audit emails **gee@digitalfeet.com**, **romeo@digitalfeet.com**, **jason@digitalfeet.com**, and **levi@digitalfeet.com** from **gee@digitalfeet.com**. Teams notifications have been removed.

The email body lists every website's status, URL, HTTP status, load time, issues, and check timestamp. Attachments include `results.csv`, `results.json`, and every available screenshot, including PASS sites. Missing or failed screenshots are explicitly listed in the body. A failed capture never attaches a stale screenshot from an earlier local run.

In GitHub, open **Settings → Secrets and variables → Actions** and add these repository secrets:

| Secret | Value |
| --- | --- |
| `SMTP_HOST` | SMTP hostname supplied by the sender's mail provider |
| `SMTP_USER` | SMTP username for the authorized sending account |
| `SMTP_PASS` | Provider-issued SMTP password or app password |

Set the repository **variable** `SMTP_PORT` to the provider's port (default `587`; `465` is also supported). Port 465 uses TLS immediately; other ports require STARTTLS. Certificate verification remains enabled. The sender is set to `gee@digitalfeet.com` in the workflow. Your provider must authorize sending as this address and support SMTP password/app-password authentication. If the account requires OAuth or SMTP is disabled, the sending integration must be adapted to the provider before enabling delivery. Transport behavior follows the [Nodemailer SMTP documentation](https://nodemailer.com/smtp).

For local runs, supply the same SMTP settings as environment variables. `EMAIL_FROM` defaults to `gee@digitalfeet.com`; `EMAIL_REQUIRED=true` makes missing configuration an error. Never commit credentials. The old `TEAMS_WEBHOOK_URL` secret is no longer used.

The default attachment budget is 12 MiB of raw files per message, allowing room for Base64 encoding overhead. Larger runs are split across numbered emails; the summary appears in each part and each file is attached once across the parts. Provider limits vary. Set `EMAIL_MAX_ATTACHMENT_BYTES` below your provider's message-size limit with room for encoding and body text. If a single file exceeds the budget, sending fails before any part is sent; the full files remain available in GitHub artifacts. Increase the budget only if the provider permits it.

Missing required settings, transport failures, and partial recipient rejection fail the workflow while preserving artifacts. Earlier parts may already have been accepted if a later part fails, so rerunning can produce duplicates. SMTP acceptance means the provider accepted the message; it does not confirm inbox delivery.

After configuring the sender and deploying the changes, use **Actions → Website Homepage Audit → Run workflow** and confirm all four inboxes receive the attachments.

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

The reports are written even when one or more monitored websites are `REVIEW` or `BROKEN`. These classifications are monitoring outcomes and do not fail the workflow. Execution failures—such as Chromium failing to launch, reports being impossible to write, or required email delivery failing—fail the job.

The workflow's artifact upload uses `if: always()` and retains results for 14 days. To download them, open the completed workflow run in GitHub Actions and select the `website-audit-results-<run number>` artifact near the bottom of the run summary.

Generated local screenshots and reports are ignored by Git, while the artifact directories remain tracked.

## Project structure

```text
.github/workflows/health-check.yml  GitHub Actions schedule and manual run
src/index.js                        Orchestration, concurrency, reports
src/checker.js                      Playwright navigation and page inspection
src/classifier.js                   PASS/REVIEW/BROKEN rules and noise filters
src/email.js                        SMTP summary and attachment delivery
src/csv.js                          Site input and CSV report generation
src/config.js                       Environment configuration
src/utils.js                        Shared utilities
test/classifier.test.js             Classification regression tests
sites.csv                           Monitored homepage URLs
artifacts/                          Generated reports and screenshots
```
