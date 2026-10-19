// The dashboard is served from the same origin as the API, so the API sends no
// CORS headers. That stops other sites from reading responses, but not from
// sending "simple" cross-origin POSTs (text/plain bodies, HTML form posts),
// which skip the CORS preflight and still reach the handler. These checks
// reject those before any state changes.

const SAFE_METHODS = new Set(['GET', 'HEAD']);
const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]']);

function firstHeader(headers, name) {
  const value = headers?.[name];
  const single = Array.isArray(value) ? value[0] : value;
  return typeof single === 'string' ? single.split(',')[0].trim() : undefined;
}

function normalizeHost(hostHeader, protocol) {
  try {
    return new URL(`${protocol}//${hostHeader}`).host;
  } catch {
    return null;
  }
}

// Browsers send Origin on every cross-origin POST. A request without one comes
// from a non-browser client, which can't be used for cross-site request forgery.
// Origin "null" (sandboxed iframes, file: pages) doesn't parse and is rejected.
export function isCrossOriginWrite(req) {
  if (SAFE_METHODS.has(String(req.method).toUpperCase())) return false;

  const fetchSite = firstHeader(req.headers, 'sec-fetch-site');
  if (fetchSite && fetchSite !== 'same-origin' && fetchSite !== 'none') return true;

  const origin = firstHeader(req.headers, 'origin');
  if (origin === undefined) return false;

  let originUrl;
  try {
    originUrl = new URL(origin);
  } catch {
    return true;
  }

  const requestHosts = ['host', 'x-forwarded-host']
    .map((name) => firstHeader(req.headers, name))
    .filter(Boolean)
    .map((value) => normalizeHost(value, originUrl.protocol));
  return !requestHosts.includes(originUrl.host);
}

// A DNS-rebinding page (attacker.example re-pointed at 127.0.0.1) is
// same-origin with itself, so it passes the Origin check and can read GET
// responses. The local server therefore only answers requests addressed to a
// loopback name.
export function isLoopbackHost(hostHeader) {
  if (typeof hostHeader !== 'string' || !hostHeader) return false;
  try {
    return LOOPBACK_HOSTNAMES.has(new URL(`http://${hostHeader}`).hostname);
  } catch {
    return false;
  }
}
