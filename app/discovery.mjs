import { isChatModel, normalizeModelSlug } from './providers.mjs';

// A catalog price of 0 is a claim about the listing, not proof the id will
// answer for free. Some OpenAI-compatible gateways serve a request and then
// report a positive bill on the response; that response is the authoritative
// answer, so a probe that sees one must not enter the route.
export function responseLooksBilled(payload) {
  if (!payload || typeof payload !== 'object') return false;
  const usage = payload.usage;
  if (!usage || typeof usage !== 'object') return false;
  for (const key of ['cost', 'total_cost', 'credits', 'credit', 'total_credits']) {
    const value = Number(usage[key]);
    if (Number.isFinite(value) && value > 0) return true;
  }
  return false;
}

// Discovery writes both the route entry and a cached verdict. If the state
// file loses the entry but keeps the verdict (migration, manual edit, older
// layout), the model would never be probed again and never routed. Promote
// cached free verdicts back into the discovered set without spending a request.
//
// Callers own the exclusions and the known slugs (configured route entries and
// already-discovered models): a catalog spelling that differs only by prefix
// or case must not become a duplicate route row.
// Which catalog models are still worth a probe request. A probe is the only
// way a price-free provider can prove a model is free, so anything already
// known — allowlisted, explicitly selected, or carrying an unexpired verdict —
// is skipped. Exclusions apply only to models discovery would add on its own.
export function probeCandidates({
  provider,
  verdictFor = () => null,
  isExcluded = () => '',
  limit = 8,
} = {}) {
  if (!provider?.probeFreeTier || !provider.catalog?.size) return [];
  const knownSlugs = new Set();
  for (const id of provider.freeModels || []) knownSlugs.add(normalizeModelSlug(id));
  for (const id of provider.selectedModels || []) knownSlugs.add(normalizeModelSlug(id));
  const remaining = [];
  for (const model of provider.catalog.values()) {
    if (!model || typeof model.id !== 'string' || !model.id) continue;
    if (!isChatModel(model)) continue;
    if (knownSlugs.has(normalizeModelSlug(model.id))) continue;
    if (verdictFor(`${provider.name}:${model.id}`)) continue;
    if (isExcluded(`${provider.name}:${model.id}`)) continue;
    remaining.push(model.id);
  }
  return remaining.slice(0, Math.max(0, Number(limit) || 0));
}

// A probe run is budget-limited on purpose: one real request per candidate,
// so a large catalog must drain over several batches instead of hammering the
// provider. `remaining` tells the drain loop whether to schedule another one.
export function probeBatchPlan(options = {}) {
  const candidates = probeCandidates(options);
  if (!options.provider?.probeFreeTier || !options.provider?.catalog?.size) {
    return { candidates: [], remaining: 0 };
  }
  const everything = probeCandidates({ ...options, limit: Number.MAX_SAFE_INTEGER });
  return { candidates, remaining: Math.max(0, everything.length - candidates.length) };
}

