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

The audit works without email configured. In that case it still creates every screenshot and report, logs one warning, and skips sending.

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
| `RESEND_API_KEY` | _(unset)_ | Resend API key. **Secret** — without it the email is skipped |
| `EMAIL_TO` | _(unset)_ | Recipients, comma separated. Without it the email is skipped |
| `EMAIL_FROM` | `onboarding@resend.dev` | Sender. Needs a Resend-verified domain to send anywhere else |
| `EMAIL_SUBJECT_PREFIX` | `Homepage audit` | Leading text of the subject line |
| `EMAIL_TIMEOUT` | `60000` | Resend request timeout in milliseconds |
| `EMAIL_JPEG_QUALITY` | `70` | Quality of the JPEG screenshot copies sent by email (1-100) |
| `EMAIL_ATTACHMENT_BUDGET_MB` | `12` | Attachment cap before base64 overhead; healthy sites are dropped first |
| `EMAIL_INLINE_SCREENSHOTS` | `all` | Inline embedding: `all`, `issues` or `none`. Everything is attached regardless |

For PowerShell, a one-run override looks like:

```powershell
$env:CONCURRENCY = '2'
npm run check
```

## Email report (Resend)

After every run the audit sends **one digest email** through the Resend API containing:

- a summary line (`N sites checked in Xs — P PASS, R REVIEW, B BROKEN`)
- a report of every `REVIEW`/`BROKEN` site with each detected issue
- a table of all monitored sites
- the **full-page screenshot of every site**, attached as JPEG and embedded inline

Screenshots are attached as JPEG rather than PNG purely for size: the PNG set is
~14MB for 8 sites, which most mailboxes reject once base64-encoded, while the
JPEG set is ~4MB. Full-resolution PNGs remain in the workflow artifact.

If the total would still exceed `EMAIL_ATTACHMENT_BUDGET_MB`, screenshots are
dropped in `PASS` → `REVIEW` → `BROKEN` priority order, so a size cap can never
hide the sites that matter. Anything omitted is listed at the bottom of the email.

Note that a full-page screenshot renders roughly 2,700px tall, so a 13-site email
is very long to scroll. Set `EMAIL_INLINE_SCREENSHOTS=issues` to embed only the
problem sites (everything stays attached either way).

### Setup

`RESEND_API_KEY` is read only from the environment — never hardcoded, never
logged, never written to a report.

In GitHub, open:

```text
Repository
→ Settings
→ Secrets and variables
→ Actions
```

Add two **secrets**:

| Name | Value |
| --- | --- |
| `RESEND_API_KEY` | Your Resend API key (`re_...`) |
| `EMAIL_TO` | Recipient address, or several separated by commas |

Sender addresses work in two stages:

- **Without a verified domain**, leave `EMAIL_FROM` unset. It defaults to
  Resend's `onboarding@resend.dev` test sender, which can only deliver to the
  email address that owns the Resend account.
- **With a verified domain**, add a repository **variable** named `EMAIL_FROM`
  (e.g. `audit@yourdomain.com`) to send to any recipient. Verify the domain
  under Domains in the Resend dashboard and add the DNS records it lists.

Delivery failures are logged without exposing the API key and never stop the
audit. `screenshotPath` in the reports is an artifact-relative reference, not a
public URL.

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

`artifacts/screenshots/` holds a full-resolution `.png` per site plus the
smaller `.jpg` copy used for email delivery.

The reports are written even when one or more monitored websites are `REVIEW` or `BROKEN`. These classifications are monitoring outcomes and do not fail the workflow. Only a genuine execution failure—such as Chromium failing to launch or reports being impossible to write—fails the job.

The workflow's artifact upload uses `if: always()` and retains results for 14 days. To download them, open the completed workflow run in GitHub Actions and select the `website-audit-results-<run number>` artifact near the bottom of the run summary.

Generated local screenshots and reports are ignored by Git, while the artifact directories remain tracked.

## Project structure

```text
.github/workflows/health-check.yml  GitHub Actions schedule and manual run
src/index.js                        Orchestration, concurrency, reports
src/checker.js                      Playwright navigation and page inspection
src/classifier.js                   PASS/REVIEW/BROKEN rules and noise filters
src/email.js                        Resend email report delivery
src/csv.js                          Site input and CSV report generation
src/config.js                       Environment configuration
src/utils.js                        Shared utilities
test/classifier.test.js             Classification regression tests
test/email.test.js                  Email report and attachment budget tests
sites.csv                           Monitored homepage URLs
artifacts/                          Generated reports and screenshots
```
