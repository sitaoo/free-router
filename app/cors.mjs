// Cross-origin rules for the gateway API. Pure so the decision is testable:
// the server only maps the result onto response headers.
//
// `gateway.cors` accepts:
//   false / undefined  no CORS headers at all (the default)
//   true               any origin (`*`)
//   ["https://a", …]   only those exact origins
//
// A request without an Origin header (curl, server-to-server) is not a CORS
// request and gets no headers either way.

export function corsEnabled(setting) {
  if (setting === true) return true;
  return Array.isArray(setting) && setting.some((origin) => typeof origin === 'string' && origin.trim());
}

export function corsOrigin(setting, origin) {
  const requested = String(origin || '').trim();
  if (!requested || !corsEnabled(setting)) return '';
  if (setting === true) return '*';
  const match = setting.find((entry) => typeof entry === 'string' && entry.trim() === requested);
  return match ? requested : '';
}

export function corsHeaders(setting, origin) {
  const allowed = corsOrigin(setting, origin);
  if (!allowed) return null;
  const headers = {
    'Access-Control-Allow-Origin': allowed,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    // So a browser client can read the id it can quote in a bug report.
    'Access-Control-Expose-Headers': 'X-Free-Router-Request-Id',
    'Access-Control-Max-Age': '600',
  };
  // `*` must not be combined with Vary: Origin; a reflected origin must.
  if (allowed !== '*') headers.Vary = 'Origin';
  return headers;
}
