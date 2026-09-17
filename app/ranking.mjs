// Pure ranking-signal helpers. Side-effect free by design so unit tests can
// import this module directly (unlike server.mjs, which boots on import).
//
// Failure kinds fall into three buckets:
// - quality: the model's own record (empty/broken responses, upstream
//   errors, unknowns). Only these move the quality score.
// - capacity: serving conditions (rateLimit, timeout, overloaded, aborted).
//   These drive cooldowns and failover, never the quality score.
// - unattributed: routing/config/billing faults (notFound, forbidden,
//   payment) plus credential faults (401, which never even reaches a kind
//   bucket). Recorded for observability, never scored as model quality.
export const USAGE_KINDS = [
  'ok',
  'rateLimit',
  'timeout',
  'serverError',
  'empty',
  'notFound',
  'forbidden',
  'aborted',
  'payment',
  'overloaded',
  'other',
];

export const QUALITY_FAIL_KINDS = new Set(['empty', 'serverError', 'other']);
export const CAPACITY_FAIL_KINDS = new Set(['rateLimit', 'timeout', 'overloaded', 'aborted']);
export const UNATTRIBUTED_FAIL_KINDS = new Set(['notFound', 'forbidden', 'payment']);

// Maps an upstream outcome to a usage kind. Payment and overload get their
// own kinds instead of hiding in 'other'/'serverError': a billing refusal
// says nothing about the model, and an overloaded endpoint recovers in
// seconds rather than failing mysterious server errors.
export function classifyFailure(status, message, timedOut = false) {
  if (timedOut) return 'timeout';
  if (status === 429) return 'rateLimit';
  if (status === 404) return 'notFound';
  if (status === 403) return 'forbidden';
  if (status === 402) return 'payment';
  if (status === 529) return 'overloaded';
  if (status >= 500) {
    if (/overload/i.test(message || '')) return 'overloaded';
    return 'serverError';
  }
  if (/empty|reasoning only|no useful/i.test(message)) return 'empty';
  return '';
}

// A 401 means the credential is wrong, not the model. Callers must skip
// recordUsage for it: classifyFailure leaves 401 unmapped, so it would
// otherwise land in the 'other' bucket and count as a quality failure.
export function isCredentialFault(status) {
  return Number(status) === 401;
}

export function qualityTotals(counts) {
  let ok = 0;
  let fail = 0;
  for (const [kind, raw] of Object.entries(counts || {})) {
    const amount = Number(raw) || 0;
    if (amount <= 0) continue;
    if (kind === 'ok') ok += amount;
    else if (QUALITY_FAIL_KINDS.has(kind)) fail += amount;
  }
  return { ok, fail };
}
