// Provider-verdict cache, kept pure so the expiry rules can be unit tested
// (server.mjs boots on import). A verdict is a cached observation, not a
// permanent fact: "free" can turn into "billed", and "gone" can come back.
// Both directions expire, and every observation refreshes the timestamp so a
// repeatedly failing model is not re-probed forever.

export function verdictFor(verdicts, key, now, ttlMs) {
  const verdict = verdicts?.[key];
  if (!verdict) return null;
  const observedAt = Date.parse(verdict.observedAt || 0);
  const age = now - observedAt;
  if (!Number.isFinite(age) || age > ttlMs) return null;
  return verdict;
}

export function mergeVerdict(previous, verdict, observedAt) {
  return {
    ...(previous && typeof previous === 'object' ? previous : {}),
    ...(verdict && typeof verdict === 'object' ? verdict : {}),
    observedAt,
  };
}
