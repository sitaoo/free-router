// Pure helpers for external score sync (script/sync-scores.mjs).
// Side-effect free so unit tests import this directly. Conventions:
// - External priors land in the 40-80 band: below config anchors (an
//   explicit operator order always wins) and above unevaluated models.
// - Name mapping never guesses: alias table hit or skip-with-report.
// - Merge refreshes fetched keys and never deletes manual-only keys.

export const SCORE_BAND_LO = 40;
export const SCORE_BAND_HI = 80;

export function normalizeBand(value, min, max, lo = SCORE_BAND_LO, hi = SCORE_BAND_HI) {
  if (!Number.isFinite(min) || !Number.isFinite(max) || min >= max) {
    return Math.round(((lo + hi) / 2) * 10) / 10;
  }
  const ratio = (Number(value) - min) / (max - min);
  const clamped = Math.max(0, Math.min(1, ratio));
  return Math.round((lo + clamped * (hi - lo)) * 10) / 10;
}

export function normalizeModelName(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

// Curated alias table (normalized source name -> baselineScores key).
// Sources use display names or foreign ids; we only map what we know.
export function mapModelKey(name, aliases = {}) {
  if (!name || !String(name).trim()) return null;
  const slug = normalizeModelName(name);
  if (!slug || !aliases || typeof aliases !== 'object') return null;
  const hit = aliases[slug];
  return typeof hit === 'string' && hit ? hit : null;
}

export function mergeBaselineScores(existing, fetched) {
  const base = existing && typeof existing === 'object' ? existing : {};
  const incoming = fetched && typeof fetched === 'object' ? fetched : {};
  const merged = { ...base };
  const added = [];
  const updated = [];
  for (const [key, value] of Object.entries(incoming)) {
    if (Object.prototype.hasOwnProperty.call(merged, key)) updated.push(key);
    else added.push(key);
    merged[key] = value;
  }
  const kept = Object.keys(base).filter((key) => !Object.prototype.hasOwnProperty.call(incoming, key));
  return { merged, added, updated, kept };
}

function isZeroPrice(value) {
  return value === 0 || value === '0' || value === '0.0';
}

// OpenRouter-style catalog summary: zero-price or :free suffix counts as
// free; priced-but-known vs no-pricing-info stay separate buckets.
export function summarizeCatalog(models) {
  const free = [];
  const priced = [];
  const unknown = [];
  for (const model of Array.isArray(models) ? models : []) {
    const id = model && typeof model.id === 'string' ? model.id : '';
    if (!id) continue;
    const pricing = model.pricing && typeof model.pricing === 'object' ? model.pricing : null;
    if (id.endsWith(':free') || (pricing && isZeroPrice(pricing.prompt) && isZeroPrice(pricing.completion))) {
      free.push(id);
    } else if (pricing) {
      priced.push(id);
    } else {
      unknown.push(id);
    }
  }
  return { total: free.length + priced.length + unknown.length, free, priced, unknown };
}
