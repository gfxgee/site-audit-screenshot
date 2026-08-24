/**
 * Low-value third-party noise.
 *
 * Everything in here is deliberately NOT allowed to influence a site's
 * classification: analytics, tag managers, ad networks, tracking pixels,
 * session recording, consent tooling, telemetry and favicons fail all the
 * time (ad blockers, cookie choices, regional blocking) without a homepage
 * being broken in any way a visitor would notice.
 *
 * ---------------------------------------------------------------------------
 * HOW TO EDIT
 *   IGNORED_REQUEST_HOSTS    - substrings matched against hostname + path.
 *   IGNORED_URL_PATTERNS     - regexes matched against the full request URL.
 *   IGNORED_CONSOLE_PATTERNS - regexes matched against console error text.
 *   IGNORED_FAILURE_REASONS  - Playwright request failure strings to skip.
 * Add a line and a short comment if the entry is not self-explanatory.
 * ---------------------------------------------------------------------------
 */

export const IGNORED_REQUEST_HOSTS = [
  // --- Google analytics / tags / ads ---
  'google-analytics.com',
  'googletagmanager.com',
  'googletagservices.com',
  'googlesyndication.com',
  'googleadservices.com',
  'doubleclick.net',
  'gstatic.com/recaptcha',
  'google.com/recaptcha',
  'analytics.google.com',
  'region1.google-analytics.com',
  'region1.analytics.google.com',

  // --- Meta / Facebook ---
  'facebook.com/tr',
  'facebook.net',
  'connect.facebook.net',
  'fbcdn.net/signals',

  // --- other social / marketing pixels ---
  'ads.linkedin.com',
  'px.ads.linkedin.com',
  'snap.licdn.com',
  'analytics.twitter.com',
  'ads-twitter.com',
  'static.ads-twitter.com',
  'bat.bing.com',
  'clarity.ms',
  'ct.pinterest.com',
  'analytics.tiktok.com',
  'redditstatic.com/ads',

  // --- session recording / product analytics / heatmaps ---
  'hotjar.com',
  'hotjar.io',
  'mouseflow.com',
  'fullstory.com',
  'luckyorange.com',
  'crazyegg.com',
  'inspectlet.com',
  'smartlook.com',
  'logrocket.com',
  'mixpanel.com',
  'segment.com',
  'segment.io',
  'amplitude.com',
  'heapanalytics.com',
  'matomo.cloud',
  'plausible.io',
  'posthog.com',
  'statcounter.com',

  // --- marketing automation / chat / CRM widgets ---
  'hubspot.com',
  'hs-scripts.com',
  'hs-analytics.net',
  'hsforms.net',
  'hsforms.com',
  'hubapi.com',
  'marketo.net',
  'mktoresp.com',
  'pardot.com',
  'intercom.io',
  'intercomcdn.com',
  'drift.com',
  'driftt.com',
  'zdassets.com',
  'zopim.com',
  'tawk.to',
  'livechatinc.com',
  'crisp.chat',
  'leadinfo.com',
  'leadfeeder.com',
  'albacross.com',
  'list-manage.com',
  'klaviyo.com',
  'sleeknote.com',
  'getsitecontrol.com',

  // --- consent / cookie management ---
  'cookiebot.com',
  'cookielaw.org',
  'onetrust.com',
  'consensu.org',
  'iubenda.com',
  'cookieyes.com',
  'termly.io',
  'usercentrics.eu',
  'privacy-mgmt.com',
  'cookieinformation.com',

  // --- error telemetry / RUM ---
  'sentry.io',
  'bugsnag.com',
  'newrelic.com',
  'nr-data.net',
  'datadoghq.com',
  'browser-intake-datadoghq.com',
  'rollbar.com',
  'trackjs.com',
  'cloudflareinsights.com',
  'vitals.vercel-insights.com',

  // --- ad exchanges / DSPs ---
  'adnxs.com',
  'adform.net',
  'adroll.com',
  'criteo.com',
  'criteo.net',
  'taboola.com',
  'outbrain.com',
  'rubiconproject.com',
  'pubmatic.com',
  'openx.net',
  'casalemedia.com',
  'sharethrough.com',
  'teads.tv',
  'yieldlab.net',
  'quantserve.com',
  'scorecardresearch.com',
  'moatads.com',
  'everesttech.net',
  'demdex.net',
  'omtrdc.net',
  '2o7.net',
];

export const IGNORED_URL_PATTERNS = [
  // favicons / touch icons are cosmetic and 404 constantly without harm
  /\/favicon\.(ico|png|svg)(\?|$)/i,
  /apple-touch-icon[^/]*\.png(\?|$)/i,
  /\/browserconfig\.xml(\?|$)/i,
  /\/site\.webmanifest(\?|$)/i,
  /\/manifest\.json(\?|$)/i,
  // generic tracking / beacon endpoints on any host
  /[/.](collect|beacon|pixel|tracker|tracking|telemetry)([/?.]|$)/i,
  // e.g. /webtracking/WebTracking/WebTracking.bundle.js
  /(^|[/.\-_])(web|user|visitor|site)?(tracking|telemetry|analytics)([/.\-_]|$)/i,
  /\/gtag\/js/i,
  /\/gtm\.js/i,
  /\/ga\.js/i,
  /\/fbevents\.js/i,
  /\/insight\.min\.js/i,
  /\/hotjar-\d+\.js/i,
  // ad slot fetches
  /\/ads?[/_-]/i,
];

export const IGNORED_CONSOLE_PATTERNS = [
  // browser-enforced privacy / policy notices — not site defects
  /third-?party cookie/i,
  /cookie .*(will be|has been) blocked/i,
  /\bsamesite\b/i,
  /was preloaded using link preload but not used/i,
  /\bdeprecat(ed|ion)\b/i,
  /quirks mode/i,
  /unrecognized feature/i,
  /error with permissions-policy header/i,
  /permissions policy violation/i,
  /allow attribute will take precedence/i,
  /requestStorageAccess/i, // Storage Access API prompt denied by the browser
  /storage access/i,
  // requests killed by the browser / extensions / privacy features
  /ERR_BLOCKED_BY_CLIENT/i,
  /ERR_BLOCKED_BY_RESPONSE/i,
  /net::ERR_ABORTED/i,
  /net::ERR_CACHE/i,
  // third-party CSP noise
  /Refused to (load|execute|connect|frame).*(google|facebook|doubleclick|hotjar|clarity|hubspot|sentry)/i,
  // "Failed to load resource: ..." messages carry no detail the failed-request
  // list does not already record (URL, status, resource type, failure reason),
  // so counting them again would double-report the same defect.
  /^Failed to load resource/i,
  // media autoplay policy
  /play\(\) failed because the user/i,
  /autoplay/i,
  // font loading fallbacks
  /downloadable font/i,
  /OTS parsing error/i,
];

export const IGNORED_FAILURE_REASONS = [
  'net::ERR_ABORTED', // navigation cancelled / fetch aborted — normal
  'net::ERR_BLOCKED_BY_CLIENT',
  'net::ERR_BLOCKED_BY_RESPONSE',
  'net::ERR_CACHE_MISS',
];

/** Resource types that never affect what a visitor sees. */
export const IGNORED_RESOURCE_TYPES = ['ping', 'csp_report', 'beacon', 'eventsource'];

/** True when a URL belongs to a known low-value third party. */
export function isIgnoredRequestUrl(url) {
  if (!url || typeof url !== 'string') return true;
  if (url.startsWith('data:') || url.startsWith('blob:') || url.startsWith('about:')) {
    return true;
  }

  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    // Unparsable URLs carry no useful signal.
    return true;
  }

  const haystack = `${parsed.hostname.toLowerCase()}${parsed.pathname.toLowerCase()}`;
  if (IGNORED_REQUEST_HOSTS.some((needle) => haystack.includes(needle))) return true;
  return IGNORED_URL_PATTERNS.some((pattern) => pattern.test(url));
}

/** True when a console error message is known third-party / policy noise. */
export function isIgnoredConsoleMessage(text, location = '') {
  const message = String(text || '');
  if (!message.trim()) return true;
  if (location && isIgnoredRequestUrl(location)) return true;
  return IGNORED_CONSOLE_PATTERNS.some((pattern) => pattern.test(message));
}

/** True when a Playwright request failure reason should be skipped. */
export function isIgnoredFailureReason(reason) {
  if (!reason) return false;
  return IGNORED_FAILURE_REASONS.some((skip) => String(reason).includes(skip));
}
