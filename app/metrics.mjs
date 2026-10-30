// Prometheus text exposition for the gateway. Pure rendering: the caller
// gathers the snapshot, this module only formats it, so the output is unit
// testable without a server. Series with a zero value are omitted (a fresh
// process should not claim 0 failures), and every label value is escaped.
//
// The token and request totals are process lifetime counters kept in
// server.mjs; pool, cooldown, and gateway-key gauges are read at scrape time.

function escapeLabel(value) {
  return String(value ?? '')
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"');
}

function number(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '0';
  // Six decimals keeps sub-second sums exact enough for rate() without
  // printing float noise (0.6000000000000001).
  return String(Number(n.toFixed(6)));
}

function family(lines, name, type, help, samples) {
  if (!samples.length) return;
  lines.push(`# HELP ${name} ${help}`);
  lines.push(`# TYPE ${name} ${type}`);
  for (const sample of samples) lines.push(sample);
}

function gauge(name, help, samples, lines) {
  family(lines, name, 'gauge', help, samples);
}

function counter(name, help, samples, lines) {
  family(lines, name, 'counter', help, samples);
}

export function formatMetrics(snapshot = {}) {
  const lines = [];
  const totals = snapshot.totals || {};
  const pool = snapshot.pool || {};
  const uptime = Math.max(0, (Number(snapshot.now) - Number(snapshot.startedAt)) / 1000);

  gauge('free_router_up', 'Whether the gateway is running.', ['free_router_up 1'], lines);
  gauge(
    'free_router_info',
    'Build information; the version label is the only value.',
    [`free_router_info{version="${escapeLabel(snapshot.version)}"} 1`],
    lines,
  );
  gauge(
    'free_router_uptime_seconds',
    'Seconds since this process started.',
    [`free_router_uptime_seconds ${number(uptime)}`],
    lines,
  );

  const free = Array.isArray(pool.free) ? pool.free.length : 0;
  const paid = Array.isArray(pool.paid) ? pool.paid.length : 0;
  gauge(
    'free_router_pool_models',
    'Models currently in the routing pool, by kind.',
    [
      `free_router_pool_models{kind="free"} ${number(free)}`,
      `free_router_pool_models{kind="paid"} ${number(paid)}`,
    ],
    lines,
  );

  const outcomes = totals.outcomes || {};
  const outcomeSamples = Object.entries(outcomes)
    .filter(([, count]) => Number(count) > 0)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([outcome, count]) => `free_router_requests_total{outcome="${escapeLabel(outcome)}"} ${number(count)}`);
  counter('free_router_requests_total', 'Client requests by outcome since process start.', outcomeSamples, lines);

  const requests = Number(totals.requests) || 0;
  counter(
    'free_router_request_duration_seconds',
    'Total time spent answering client requests.',
    requests > 0
      ? [
        `free_router_request_duration_seconds_sum ${number((Number(totals.durationMs) || 0) / 1000)}`,
        `free_router_request_duration_seconds_count ${number(requests)}`,
      ]
      : [],
    lines,
  );
  const firstSamples = Number(totals.firstTokenSamples) || 0;
  counter(
    'free_router_first_token_seconds',
    'Time from request start to the first streamed token.',
    firstSamples > 0
      ? [
        `free_router_first_token_seconds_sum ${number((Number(totals.firstTokenMs) || 0) / 1000)}`,
        `free_router_first_token_seconds_count ${number(firstSamples)}`,
      ]
      : [],
    lines,
  );

  const input = Number(totals.inputTokens) || 0;
  const output = Number(totals.outputTokens) || 0;
  counter(
    'free_router_tokens_total',
    'Tokens reported by upstreams, by direction.',
    [
      input > 0 ? `free_router_tokens_total{direction="input"} ${number(input)}` : '',
      output > 0 ? `free_router_tokens_total{direction="output"} ${number(output)}` : '',
    ].filter(Boolean),
    lines,
  );

  const cooldowns = Array.isArray(snapshot.cooldowns) ? snapshot.cooldowns.length : 0;
  gauge(
    'free_router_cooldown_models',
    'Models currently cooling down after a failure.',
    [`free_router_cooldown_models ${number(cooldowns)}`],
    lines,
  );

  const keys = Array.isArray(snapshot.gatewayKeys) ? snapshot.gatewayKeys : [];
  const usedSamples = keys.map(
    (entry) => `free_router_gateway_key_requests_today{name="${escapeLabel(entry.name)}"} ${number(entry.usedToday)}`,
  );
  gauge('free_router_gateway_key_requests_today', "Authenticated /v1 calls per key today.", usedSamples, lines);
  const limitSamples = keys
    .filter((entry) => entry.dailyLimit !== null && entry.dailyLimit !== undefined)
    .map((entry) => `free_router_gateway_key_limit{name="${escapeLabel(entry.name)}"} ${number(entry.dailyLimit)}`);
  gauge('free_router_gateway_key_limit', 'Daily request limit per gateway key (absent when unlimited).', limitSamples, lines);

  return lines.length ? `${lines.join('\n')}\n` : '';
}
