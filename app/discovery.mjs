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
export function adoptableFreeModels({
  providers = [],
  discoveredIds = [],
  knownSlugs = new Set(),
  verdictFor = () => null,
  isExcluded = () => '',
} = {}) {
  const discovered = new Set(discoveredIds);
  const known = new Set(knownSlugs);
  const adopted = [];
  for (const provider of providers) {
    if (!provider?.probeFreeTier || !provider.name || !provider.catalog?.size) continue;
    for (const model of provider.catalog.values()) {
      if (!model || typeof model.id !== 'string' || !model.id) continue;
      if (!isChatModel(model)) continue;
      const key = `${provider.name}:${model.id}`;
      if (discovered.has(key)) continue;
      const slug = normalizeModelSlug(model.id);
      if (slug && known.has(slug)) continue;
      if (isExcluded(key)) continue;
      if (verdictFor(key)?.free !== true) continue;
      discovered.add(key);
      if (slug) known.add(slug);
      adopted.push(key);
    }
  }
  return adopted;
}
