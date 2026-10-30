// Cooldown policy, kept pure so it can be unit tested (server.mjs boots on
// import). A repeated timeout is a stronger signal than a single one: the
// model is not merely slow, it is stuck, and retrying it every base interval
// keeps stepping on the same hole. Each consecutive timeout doubles the wait
// up to a cap, so a recovered model is still probed eventually.

export const TIMEOUT_BACKOFF_CAP_MS = 60 * 60 * 1000;
export const MAX_RETRY_AFTER_MS = 24 * 60 * 60 * 1000;

export function timeoutBackoffMs(consecutive, baseMs, capMs = TIMEOUT_BACKOFF_CAP_MS) {
  const base = Number(baseMs);
  // No configured timeout cooldown means timeouts are not cooled at all.
  if (!Number.isFinite(base) || base <= 0) return 0;
  const count = Math.max(1, Math.floor(Number(consecutive)) || 1);
  const cap = Number(capMs);
  const limit = Number.isFinite(cap) && cap > 0 ? cap : TIMEOUT_BACKOFF_CAP_MS;
  // 1x, 2x, 4x, ... The exponent stops growing long before it overflows.
  const factor = 2 ** Math.min(count - 1, 20);
  return Math.min(limit, base * factor);
}

// Upstream `Retry-After` in either documented form: delta-seconds or an HTTP
// date. Returns 0 for a missing/unparseable header and caps absurd values so
// a bad header cannot park a model for days.
export function parseRetryAfterMs(value, now = Date.now()) {
  const raw = String(value ?? '').trim();
  if (!raw) return 0;
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) {
    if (seconds <= 0) return 0;
    return Math.min(MAX_RETRY_AFTER_MS, Math.round(seconds * 1000));
  }
  const at = Date.parse(raw);
  if (!Number.isFinite(at)) return 0;
  const wait = at - now;
  if (wait <= 0) return 0;
  return Math.min(MAX_RETRY_AFTER_MS, wait);
}

// A candidate is cooling only when it has no usable key left: a model-level
// cooldown covers every key, and a per-key cooldown hides just that key.
// Taking the worst key (the previous behaviour) parked the whole model while
// its other accounts were idle.
export function candidateCooldown({ now, modelEntry, keyEntries = [] }) {
  if (modelEntry && modelEntry.until > now) return modelEntry;
  if (!keyEntries.length) return null;
  let worst = null;
  let free = false;
  for (const entry of keyEntries) {
    if (!entry || entry.until <= now) {
      free = true;
      continue;
    }
    if (!worst || entry.until > worst.until) worst = entry;
  }
  return free ? null : worst;
}
