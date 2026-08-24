# Website Homepage Audit

Automated homepage monitoring. For every site in [`sites.csv`](sites.csv) this project opens **only the homepage** in headless Chromium (Playwright), waits for it to render, scrolls once to trigger lazy-loaded content, captures a **true full-page screenshot**, runs technical checks, and classifies the page as **PASS**, **REVIEW** or **BROKEN**.

Results are written to `artifacts/` and uploaded as a GitHub Actions artifact. `REVIEW` and `BROKEN` pages are posted to Microsoft Teams through an existing Power Automate webhook, followed by one summary message per run.

Everything runs on GitHub-hosted runners. No Browserbase, no paid browser service.

## What gets checked

| Check | Detail |
| --- | --- |
| Navigation | requested URL, final URL, redirect chain, HTTP status, timeouts, DNS and TLS failures, load duration |
| HTTP status | `500+` and a real homepage `404` are treated as broken |
| Broken images | every rendered `<img>` inspected via `complete && naturalWidth === 0`, plus images that failed at the network level |
| JavaScript errors | `pageerror` events, attributed to the script that threw them |
| Console errors | `console` events of type `error`, with third-party noise filtered out |
| Failed requests | `requestfailed` events and any response with `status >= 400`, split into first-party and third-party |
| Blank page | weighted signals: visible text length, meaningful element count, document height, image count, major containers, page title, body visibility |
| Error pages | contextual phrase matching for server/application error and crash pages |
| Layout | `documentElement.scrollWidth` vs `window.innerWidth`, body overflow hidden by `overflow-x`, oversized elements extending past the viewport, collapsed layout |

Cookie banners, privacy popups, newsletter modals and normal promotional overlays are **not** treated as faults. Nothing is clicked, so screenshots show roughly what a first-time visitor sees.

## Websites

Monitored sites live in [`sites.csv`](sites.csv):

```csv
url
https://digitalfeet.com/
https://cloudway.com/
```

### Adding a website

Add one row with the full homepage URL and commit the change:

```csv
https://newsite.com/
```

Blank lines and `#` comments are ignored, duplicates are skipped, and a URL without a scheme gets `https://` prepended. Only the homepage URL given here is visited — the audit never follows links into internal pages.

## Local setup

```bash
npm install
```

```bash
npx playwright install chromium
```

```bash
npm run check
```

Requires Node.js 20 or newer. Output lands in `artifacts/` (git-ignored).

Terminal output looks like:

```
[1/8] Checking https://digitalfeet.com/
   [PASS] digitalfeet.com - HTTP 200 - 2.8s

[2/8] Checking https://cloudway.com/
   [REVIEW] cloudway.com - HTTP 200 - 0.9s - 1 console error: ...
```

## Configuration

Every setting is an environment variable with a sensible default — no code edits needed.

| Variable | Default | Purpose |
| --- | --- | --- |
| `VIEWPORT_WIDTH` | `1440` | Browser viewport width |
| `VIEWPORT_HEIGHT` | `900` | Browser viewport height |
| `NAVIGATION_TIMEOUT` | `30000` | Navigation timeout in ms |
| `POST_LOAD_WAIT` | `2000` | Settle time after `domcontentloaded`, before scrolling |
| `FINAL_RENDER_WAIT` | `1200` | Render delay after scrolling back to the top, before the screenshot |
| `CONCURRENCY` | `3` | Sites audited in parallel (one browser, one context each) |
| `MAX_JS_ERRORS` | `20` | Cap on stored JavaScript errors |
| `MAX_CONSOLE_ERRORS` | `20` | Cap on stored console errors |
| `MAX_FAILED_REQUESTS` | `30` | Cap on stored failed requests |
| `MAX_BROKEN_IMAGES` | `25` | Cap on stored broken images |
| `LAZY_SCROLL` | `true` | Enable the lazy-load scroll pass |
| `LAZY_SCROLL_DELAY` | `350` | Pause between scroll steps in ms |
| `LAZY_SCROLL_STEP_RATIO` | `0.85` | Fraction of a viewport scrolled per step |
| `LAZY_SCROLL_MAX_STEPS` | `40` | Safety cap on scroll steps |
| `SCREENSHOT_TIMEOUT` | `45000` | Full-page screenshot timeout in ms |
| `OVERFLOW_TOLERANCE_PX` | `32` | Horizontal overflow ignored below this |
| `MAJOR_OVERFLOW_RATIO` | `0.05` | Overflow beyond this share of the viewport becomes an issue |
| `OVERSIZED_ELEMENT_OVERSHOOT_PX` | `200` | How far a large element must stick out to be flagged |
| `BLANK_TEXT_LENGTH` | `40` | Visible text below this counts as blank |
| `LOW_TEXT_LENGTH` | `250` | Visible text below this counts as thin |
| `BLANK_ELEMENT_COUNT` | `5` | Content elements below this counts as blank |
| `LOW_ELEMENT_COUNT` | `15` | Content elements below this counts as thin |
| `SHORT_PAGE_RATIO` | `0.6` | Page shorter than this share of the viewport is "very short" |
| `BLANK_SCORE` | `5` | Weighted blank score that classifies a page as blank |
| `FIRST_PARTY_FAILURE_LIMIT` | `1` | First-party request failures needed for REVIEW |
| `SITES_FILE` | `sites.csv` | Path to the site list |
| `ARTIFACTS_DIR` | `artifacts` | Report output directory |
| `SCREENSHOTS_DIR` | `artifacts/screenshots` | Screenshot output directory |
| `USER_AGENT` | desktop Chrome UA | Override the user agent |
| `TIMEZONE_ID` | `Europe/Oslo` | Browser timezone |
| `TEAMS_WEBHOOK_URL` | _(unset)_ | Power Automate webhook. **Secret — never commit this.** |
| `TEAMS_TIMEOUT` | `15000` | Teams request timeout in ms |
| `TEAMS_RETRIES` | `2` | Retries per Teams message |

Third-party noise filtering lives in [`src/ignore-list.js`](src/ignore-list.js) and is meant to be edited — hosts, URL patterns, console patterns and failure reasons are separate, commented lists.

## Microsoft Teams setup

The Power Automate webhook already exists. It is read **only** from the `TEAMS_WEBHOOK_URL` environment variable — it is never hardcoded, never written to a report, and never printed to the logs.

Save it as a repository secret:

```
Repository
→ Settings
→ Secrets and variables
→ Actions
→ New repository secret
```

Name it exactly:

```
TEAMS_WEBHOOK_URL
```

Paste the Power Automate URL as the value. This is the only manual configuration the project needs.

If the secret is missing the audit still runs, screenshots and reports are still saved, a warning is logged, and Teams posting is skipped. Teams failures never fail the audit.

### Payloads

One message per `REVIEW` / `BROKEN` site (`PASS` sites are never posted individually):

```json
{
  "type": "issue",
  "status": "BROKEN",
  "url": "https://example.com/",
  "finalUrl": "https://example.com/",
  "httpStatus": 500,
  "loadTimeMs": 3200,
  "issues": ["Server error page detected", "2 failed first-party requests"],
  "screenshotPath": "artifacts/screenshots/example-com.png",
  "checkedAt": "2026-01-01T00:00:00.000Z"
}
```

One summary message after all sites are processed:

```json
{
  "type": "summary",
  "total": 8,
  "passed": 6,
  "review": 1,
  "broken": 1,
  "durationMs": 123456,
  "checkedAt": "2026-01-01T00:00:00.000Z"
}
```

> **`screenshotPath` is a path inside the run artifact, not a public URL.** GitHub Actions artifact files are not publicly addressable. The field is a reference for locating the image after downloading the artifact — see [GitHub artifacts](#github-artifacts).

## Manual run

```
GitHub
→ Actions
→ Website Homepage Audit
→ Run workflow
```

## Scheduled run

The workflow runs once daily. **GitHub Actions cron is always UTC**, and the Philippines is **UTC+8**:

```
00:00 UTC = 08:00 Philippine time
```

The default schedule in [`.github/workflows/health-check.yml`](.github/workflows/health-check.yml) is:

```yaml
schedule:
  - cron: '0 0 * * *'   # 08:00 Philippine time
```

To change it, subtract 8 hours from the Philippine time you want:

| Philippine time | cron (UTC) |
| --- | --- |
| 06:00 PHT | `'0 22 * * *'` |
| 08:00 PHT | `'0 0 * * *'` (default) |
| 12:00 PHT | `'0 4 * * *'` |
| 18:00 PHT | `'0 10 * * *'` |
| 22:00 PHT | `'0 14 * * *'` |

Note that GitHub may delay scheduled runs during periods of high load, so the run can start a little after the configured time.

## Results

| File | Contents |
| --- | --- |
| `artifacts/results.json` | Full result per site plus a run summary |
| `artifacts/results.csv` | One summary row per site, for spreadsheets |
| `artifacts/screenshots/` | Full-page PNGs named after the hostname, e.g. `digitalfeet-com.png` |

Both reports are always written, even when sites fail or the run is partial.

`results.csv` columns: `url`, `finalUrl`, `status`, `httpStatus`, `loadTimeMs`, `brokenImageCount`, `jsErrorCount`, `consoleErrorCount`, `failedRequestCount`, `horizontalOverflow`, `issues`, `screenshotPath`, `checkedAt`.

One entry in `results.json`:

```json
{
  "url": "https://digitalfeet.com/",
  "finalUrl": "https://digitalfeet.com/",
  "status": "PASS",
  "httpStatus": 200,
  "loadTimeMs": 2350,
  "navigationError": null,
  "brokenImages": [],
  "jsErrors": [],
  "consoleErrors": [],
  "failedRequests": [],
  "horizontalOverflow": false,
  "suspiciousText": [],
  "issues": [],
  "screenshotPath": "artifacts/screenshots/digitalfeet-com.png",
  "checkedAt": "2026-01-01T00:00:00.000Z"
}
```

Each record also carries `redirectedTo`, `redirectChain`, `navigationErrorType`, `metrics` (the raw page measurements), `signals` (why the classifier decided what it did), `ignoredCounts` (how much third-party noise was filtered) and `truncated` (how many entries were dropped by the caps).

## GitHub artifacts

Screenshots and reports are uploaded on every run, including runs where sites are `BROKEN`:

```
GitHub
→ Actions
→ pick the run
→ Artifacts
→ website-audit-results
```

Retention is **14 days**. The run page also shows a summary table of every site and its issues.

## Classifications

### BROKEN — a visitor cannot use the homepage

- navigation failed, or timed out
- DNS lookup failure
- TLS/certificate failure preventing load
- main document returned `500+`
- homepage returned a real `404` / `410`, or `401` / `403`
- server error, application crash or "something went wrong" page detected
- homepage is effectively blank, or the body is hidden
- major render failure

### REVIEW — it loads, but something looks wrong

- one or more meaningful broken images
- significant first-party request failures
- meaningful JavaScript errors
- suspicious console errors
- major horizontal overflow, or overflow hidden by `overflow-x`
- oversized elements outside the viewport, or a collapsed layout
- very thin content, or a screenshot that could not be captured
- homepage loads but appears partially broken

### PASS

- homepage loads correctly
- no significant issues detected
- only harmless third-party errors occurred

### Avoiding false positives

False positives are treated as expensive. A site is **never** downgraded because of analytics errors, blocked trackers, third-party ads, cookie/consent scripts, third-party CSP warnings, favicon errors, normal redirects, missing optional tracking resources, or console warnings that do not affect rendering. Third-party scripts that throw inside their own files are attributed to that vendor and ignored. Small decorative overflow is tolerated, deliberately minimalist landing pages are not called broken, and bare numbers like `404` or `500` in body copy do not match error-page detection — a homepage advertising "500 customers" stays `PASS`.

When the evidence is ambiguous, the classifier prefers `REVIEW` over `BROKEN`.

## Workflow failure behaviour

`REVIEW` and `BROKEN` are monitoring results, not execution failures, so the workflow still completes successfully when sites are unhealthy. Every site is processed before the run exits — one failing site never stops the others. The job fails only on genuine execution problems: the project cannot start, Chromium cannot initialize, or report generation fails catastrophically. Artifacts upload with `if: always()`.

## Project layout

```
site-audit-screenshot/
├── .github/workflows/health-check.yml   GitHub Actions workflow (manual + daily)
├── src/
│   ├── index.js         orchestration, concurrency, logging, reports
│   ├── checker.js       Playwright navigation, instrumentation, screenshot
│   ├── classifier.js    PASS / REVIEW / BROKEN rules
│   ├── ignore-list.js   editable third-party noise filters
│   ├── teams.js         Power Automate webhook delivery
│   ├── csv.js           site list parsing, results.json / results.csv
│   ├── config.js        environment-variable configuration
│   └── utils.js         filenames, domains, concurrency helper
├── artifacts/screenshots/   generated output (git-ignored)
├── sites.csv
└── package.json
```
