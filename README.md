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

- `PASS`: the homepage loaded and rendered without a visitor-visible problem.
- `REVIEW`: it loaded, but something a visitor could notice looks wrong.
- `BROKEN`: a visitor cannot use this homepage.

### BROKEN

- navigation failed, timed out, or hit a DNS/TLS error
- the main document returned `404` or `5xx`
- a server or application error page was detected
- **the homepage is blank or barely rendered** (weighted scoring, below)
- **a redirect loop** — `ERR_TOO_MANY_REDIRECTS`, the homepage never resolves
- **the homepage redirects off-domain** — an expired domain or parking page,
  which is broken even though the final response is `200`

### REVIEW

- a meaningful broken image, or a failed first-party script/stylesheet/image
- an unusually long redirect chain (more than 3 hops)
- major horizontal overflow, or a suspiciously collapsed layout
- the screenshot could not be captured
- a `4xx` other than `404`

### Recorded but never classified

These are written to `results.json` and shown in the email as context, but they
do **not** change the status:

| Signal | Why |
| --- | --- |
| JavaScript errors | Near-universal on real marketing sites and poorly correlated with what a visitor sees. `infosoft.no` throws `jQuery is not defined` and renders perfectly. |
| Console errors | Same, plus browser privacy and policy noise. |
| Failed font requests | A font that fails falls back to a system font. `marstrand.no` references nine Segoe UI files its theme never shipped; the page looks fine. |
| Failed `fetch`/`xhr` | Background calls with no rendered output. |
| Any third-party failure | Analytics, ads, consent tooling, embedded widgets, telemetry, favicons. |

Together these accounted for **every** flag across a 13-site run of healthy
sites: 9 REVIEW alerts, none of which a visitor would have noticed. The
full-page screenshot is the evidence that matters, and it is attached to every
report.

### Blank and partial-render scoring

A single hard threshold is too blunt — requiring almost no text *and* almost no
elements *and* no images *and* a short page means a homepage rendering only its
header slips through. Weak signals are weighted instead (see `scoreBlankPage`
in [`src/classifier.js`](src/classifier.js)):

| Signal | Points |
| --- | ---: |
| body not visible | 3 |
| under 40 characters of visible text | 2 |
| under 250 characters of visible text | 1 |
| fewer than 3 content elements | 2 |
| fewer than 10 content elements | 1 |
| page shorter than 60% of the viewport | 1 |
| no images | 1 |
| no `main`/`header`/`footer` container | 1 |
| no page title | 1 |

A score of 5 or more, an invisible body, or almost no text *and* almost no
elements is `BROKEN`. A score of exactly 4 is `REVIEW`. A deliberately minimal
landing page scores 2 and stays `PASS`.

Ambiguous partial failures are intentionally `REVIEW`, not `BROKEN`.

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
| `SITE_TIMEOUT` | `90000` | Hard per-site ceiling; a site exceeding it is recorded `BROKEN` |
| `EVALUATE_TIMEOUT` | `20000` | Timeout for in-page inspection scripts |
| `SCREENSHOT_TIMEOUT` | `45000` | Timeout per full-page screenshot |
| `MAX_INSPECTED_ELEMENTS` | `4000` | Cap on elements examined for layout overflow |
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

Add one **secret** — the API key is the only real secret here:

```text
Settings → Secrets and variables → Actions → Secrets tab
```

| Name | Value |
| --- | --- |
| `RESEND_API_KEY` | Your Resend API key (`re_...`) |

Then add the addresses as **variables**, on the Variables tab of the same page:

```text
Settings → Secrets and variables → Actions → Variables tab
```

| Name | Value |
| --- | --- |
| `EMAIL_TO` | Recipients, comma separated |
| `EMAIL_FROM` | Sender on a Resend-verified domain, e.g. `audit@digitalfeet.com` |

Recipients and sender are configuration, not credentials, so variables suit them
better: a variable stays readable and editable, whereas a secret is write-only —
you can overwrite it but never read it back, which makes adding one forgotten
recipient mean retyping the whole list. Actions variables are not published with
the repository, and the audit logs only the recipient *count*, never the
addresses. A secret named `EMAIL_TO` still works as a fallback if one exists.

`EMAIL_FROM` must be on a domain verified under Domains in the Resend dashboard.
Until one is, leave it unset: it falls back to Resend's `onboarding@resend.dev`
test sender, which can only deliver to the address that owns the Resend account.
The local part does not need to be a real mailbox, though replies to it will
bounce — use a real address or `noreply@` if that matters.

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

The audit is scheduled so the report lands around **10:00 Philippine time**:

```yaml
schedule:
  - cron: '17 21 * * *'
```

That is **not** 10:00 PHT converted to UTC. GitHub queues scheduled workflows
and starts them late, and on this repository the delay is large and consistent:

| Cron (UTC) | Actual start (UTC) | Delay |
| --- | --- | ---: |
| `00:00` | 03:58 – 04:05 | ~4h |
| `02:17` | 07:23 | 5h06m |

So the nominal time is set about five hours earlier than the time we actually
want, to absorb the queue delay:

```
21:17 UTC nominal (05:17 PHT) + ~4-5h observed delay = ~09:15-10:30 PHT
```

This fires on the previous UTC day, which is fine for a daily run. The minute is
kept off `:00`, the most contended slot in GitHub's queue.

**This is compensation, not precision.** GitHub guarantees no start time for
scheduled workflows. If the delay shrinks, the report arrives earlier (as early
as 05:17 PHT); if it grows, later. To re-measure and re-tune:

```bash
gh run list --workflow=health-check.yml --json event,createdAt,conclusion
```

Then shift the cron hour by the difference. To move the target time itself,
work backwards: desired PHT − 8h = UTC, then subtract the observed delay.

For a genuinely punctual 10:00, don't use cron — have an external scheduler
that does honour its schedule (Azure Scheduler, or a Power Automate recurrence)
call the `workflow_dispatch` API instead.

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
