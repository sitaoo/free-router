// Pure ranking-signal helpers. Side-effect free by design so unit tests can
// import this module directly (unlike server.mjs, which boots on import).
//
// Failure kinds fall into three buckets:
// - quality: the model's own record (empty/broken responses, upstream
//   errors, unknowns). Only these move the quality score.
// - capacity: serving conditions (rateLimit, timeout, aborted). These drive
//   cooldowns and failover, never the quality score.
// - unattributed: routing/config faults (notFound, forbidden) plus
//   credential faults (401, which never even reaches a kind bucket).
//   Recorded for observability, never scored as model quality.

export const QUALITY_FAIL_KINDS = new Set(['empty', 'serverError', 'other']);

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
