// Cooldown policy, kept pure so it can be unit tested (server.mjs boots on
// import). A repeated timeout is a stronger signal than a single one: the
// model is not merely slow, it is stuck, and retrying it every base interval
// keeps stepping on the same hole. Each consecutive timeout doubles the wait
// up to a cap, so a recovered model is still probed eventually.

export const TIMEOUT_BACKOFF_CAP_MS = 60 * 60 * 1000;

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
