// The implicit model pool: one place that decides which models are callable,
// whether each one is free, paid, or unknown, and how a request resolves
// against it. Side-effect free by design so unit tests can import it directly
// (unlike server.mjs, which boots on import).
//
// The pool replaces the old hand-maintained route lists. Membership comes from
// two sources per provider: models the rules prove free (catalog prices,
// allowlist, probe verdicts) and models the operator explicitly selected,
// which may be paid. A paid model never enters an automatic fallback; it is
// only offered when the request names it.
import { isChatModel, normalizeModelSlug } from './providers.mjs';
import { compareByScarcity } from './ranking.mjs';

export const DEFAULT_MODEL_ALIAS = 'free-best';

export function candidateKey(candidate) {
  return `${candidate.provider}:${candidate.model}`;
}

// A catalog entry's own price claim: 'free' (both sides exactly zero), 'paid'
// (both sides numeric, not all zero), or 'unknown' (missing or partial).
export function priceClass(model) {
  const pricing = model?.pricing;
  if (!pricing || typeof pricing !== 'object') return 'unknown';
  const prompt = Number(pricing.prompt);
  const completion = Number(pricing.completion);
  if (!Number.isFinite(prompt) || !Number.isFinite(completion)) return 'unknown';
  return prompt === 0 && completion === 0 ? 'free' : 'paid';
}

// Position in an explicit list is the only hand-authored ranking signal left.
// Same ladder the route editor used: 94 down to 30, then flat.
export function seedScore(index) {
  return Math.max(30, 94 - Math.max(0, index - 1) * 4);
}

function providerHasKey(provider) {
  if (typeof provider?.hasKey === 'boolean') return provider.hasKey;
  return Boolean(provider?.apiKeys?.length);
}

function catalogModelsOf(provider) {
  if (!provider?.catalog?.size) return [];
  return [...provider.catalog.values()].filter((model) => model && typeof model.id === 'string');
}

// Builds both views of the pool from live provider entries (or plain doubles in
// tests). `free` is what automatic routing may use; `paid` is what an explicit
// request may name. Entries carry the catalog row so callers can report
// metadata without looking the model up again.
export function buildPool({
  providers = [],
  verdictFor = () => null,
  excludeReason = () => '',
  paymentBlocks = {},
  now = Date.now(),
} = {}) {
  const free = [];
  const paid = [];
  const byKey = new Map();

  for (const provider of providers) {
    const name = String(provider?.name || '');
    if (!name || !providerHasKey(provider)) continue;
    const catalogModels = catalogModelsOf(provider);
    const hasCatalog = Boolean(provider.catalog?.size);
    const byId = new Map(catalogModels.map((model) => [model.id, model]));
    const bySlug = new Map();
    for (const model of catalogModels) {
      const slug = normalizeModelSlug(model.id);
      if (slug && !bySlug.has(slug)) bySlug.set(slug, model);
    }
    const lookup = (id) => {
      if (!hasCatalog) return null;
      return byId.get(id) || bySlug.get(normalizeModelSlug(id)) || null;
    };
    const allowlist = !provider.catalogHasPricing ? [...(provider.freeModels || [])] : [];
    const selectedModels = [...(provider.selectedModels || [])];

    const emit = (modelId, details) => {
      const key = `${name}:${modelId}`;
      if (byKey.has(key)) return;
      const entry = {
        provider: name,
        model: modelId,
        key,
        free: Boolean(details.free),
        paid: Boolean(details.paid),
        unknown: Boolean(details.unknown),
        source: details.source,
        seedIndex: details.seedIndex ?? null,
        catalogModel: details.catalogModel || null,
        blockedUntil: null,
      };
      if (!entry.free) {
        const block = paymentBlockFor(paymentBlocks, key, now);
        if (block) entry.blockedUntil = new Date(block.until).toISOString();
      }
      byKey.set(key, entry);
      (entry.free ? free : paid).push(entry);
    };

    // Rules pick the free models. On a priced catalog the published price is
    // the claim; on a price-free provider the allowlist is. A positive verdict
    // from the provider overrides both (withdrawn models excepted).
    const autoFree = [];
    if (provider.catalogHasPricing) {
      if (hasCatalog) {
        for (const model of catalogModels) {
          if (!isChatModel(model) || priceClass(model) !== 'free') continue;
          if (excludeReason(`${name}:${model.id}`)) continue;
          autoFree.push({ id: model.id, catalogModel: model, source: 'auto', seedIndex: null });
        }
      }
    } else {
      allowlist.forEach((id, index) => {
        const catalogModel = lookup(id);
        if (hasCatalog && !catalogModel) return;
        autoFree.push({ id, catalogModel, source: 'allowlist', seedIndex: index });
      });
    }
    // Probed models: only a catalog listing can be probed, so presence already
    // guards against a stale verdict pointing at a withdrawn model.
    if (hasCatalog) {
      for (const model of catalogModels) {
        if (!isChatModel(model)) continue;
        if (verdictFor(`${name}:${model.id}`)?.free !== true) continue;
        if (autoFree.some((entry) => normalizeModelSlug(entry.id) === normalizeModelSlug(model.id))) continue;
        if (excludeReason(`${name}:${model.id}`)) continue;
        autoFree.push({ id: model.id, catalogModel: model, source: 'auto', seedIndex: null });
      }
    }

    for (const item of autoFree) {
      const key = `${name}:${item.id}`;
      const model = item.catalogModel || null;
      if (!model && provider.catalogHasPricing) continue;
      // A refusal outranks every automatic signal; the selection loop below
      // still admits the model (as paid) when the operator asked for it.
      if (verdictFor(key)?.free === false) continue;
      if (model && !isChatModel(model)) continue;
      emit(item.id, { free: true, source: item.source, seedIndex: item.seedIndex, catalogModel: model });
    }

    // Explicit selection: always admitted (even when a verdict calls it paid),
    // labelled by the best evidence available. Selection never turns a paid
    // model into a free one.
    selectedModels.forEach((id, index) => {
      const key = `${name}:${id}`;
      if (byKey.has(key)) return;
      const model = lookup(id);
      if (hasCatalog && !model && !allowlist.some((entry) => entry === id)) return;
      if (model && !isChatModel(model)) return;
      const verdict = verdictFor(key);
      if (verdict?.free === true) {
        emit(id, { free: true, source: 'selected', seedIndex: index, catalogModel: model });
        return;
      }
      if (verdict?.free === false) {
        emit(id, { free: false, paid: true, source: 'selected', seedIndex: index, catalogModel: model });
        return;
      }
      if (provider.catalogHasPricing && model) {
        const price = priceClass(model);
        if (price === 'free') {
          emit(id, { free: true, source: 'selected', seedIndex: index, catalogModel: model });
        } else if (price === 'paid') {
          emit(id, { free: false, paid: true, source: 'selected', seedIndex: index, catalogModel: model });
        } else {
          emit(id, { free: false, paid: true, unknown: true, source: 'selected', seedIndex: index, catalogModel: model });
        }
        return;
      }
      // Price-free provider, not on the allowlist: the catalog says nothing
      // about cost, so treat it as billable until a probe proves otherwise.
      emit(id, { free: false, paid: true, unknown: true, source: 'selected', seedIndex: index, catalogModel: model });
    });
  }

  return { free, paid };
}

// Resolves a request's `model` against the pool. `alias` (free-best) and an
// omitted model mean "automatic": free models only. A `provider:model` names
// exactly one enabled model. A bare id matches free offerings first, then
// explicitly selected paid ones — never any other paid model.
export function resolvePoolRequest(
  requested,
  pool,
  { alias = DEFAULT_MODEL_ALIAS, parsePrefixed = () => null } = {},
) {
  const text = String(requested || '');
  const free = pool?.free || [];
  const paid = pool?.paid || [];
  if (!text || text === alias) {
    return { kind: 'alias', requested: text, candidates: free, allowPaid: false };
  }
  const prefixed = parsePrefixed(text);
  if (prefixed) {
    const match = [...free, ...paid].find(
      (entry) => entry.provider === prefixed.provider && entry.model === prefixed.model,
    );
    if (!match) return { kind: 'not_enabled', requested: text, candidates: [], allowPaid: false };
    return { kind: 'named', requested: text, candidates: [match], allowPaid: Boolean(match.paid) };
  }
  const slug = normalizeModelSlug(text);
  const matches = (entries) => {
    const exact = [];
    const sameModel = [];
    for (const entry of entries) {
      if (entry.model === text) exact.push(entry);
      else if (slug && normalizeModelSlug(entry.model) === slug) sameModel.push(entry);
    }
    return [...exact, ...sameModel];
  };
  const freeMatches = matches(free);
  const paidMatches = matches(paid);
  if (!freeMatches.length && !paidMatches.length) {
    return { kind: 'unknown', requested: text, candidates: [], allowPaid: false };
  }
  return {
    kind: 'named',
    requested: text,
    candidates: [...freeMatches, ...paidMatches],
    allowPaid: paidMatches.length > 0,
  };
}

// Groups same-provider duplicates, ranks whole `provider:model` groups, then
// expands same-slug offerings from other providers at their best position.
// `rankGroup(group)` returns {pinned, score, tie}; `siblingsFor(slug)` returns
// extra candidates to offer once per model slug.
export function orderCandidates(
  candidates,
  { rankGroup, scarcityFor = () => null, siblingsFor = () => [], expandSiblings = true } = {},
) {
  const groups = new Map();
  candidates.forEach((candidate, originalIndex) => {
    const key = candidateKey(candidate);
    let group = groups.get(key);
    if (!group) {
      group = {
        key,
        slug: normalizeModelSlug(candidate.model) || key,
        members: [],
        firstIndex: originalIndex,
      };
      groups.set(key, group);
    }
    group.members.push({ candidate, originalIndex });
  });
  const ranked = [...groups.values()].map((group) => ({ group, rank: rankGroup(group) }));
  ranked.sort((left, right) => {
    const a = left.rank;
    const b = right.rank;
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    if (a.pinned) return a.tie - b.tie;
    // Within the tie band, higher remaining quota wins so scarce-but-smart
    // models are saved for when they matter. Unlimited (null) wins.
    const scarcity = compareByScarcity(
      a.score,
      b.score,
      scarcityFor(left.group),
      scarcityFor(right.group),
    );
    if (scarcity) return scarcity;
    return b.score - a.score || a.tie - b.tie;
  });

  const expanded = [];
  const present = new Set();
  const expandedSlugs = new Set();
  const candidateKeys = new Set(candidates.map(candidateKey));
  const emit = (candidate) => {
    const key = candidateKey(candidate);
    if (present.has(key)) return;
    present.add(key);
    expanded.push(candidate);
  };
  for (const { group } of ranked) {
    for (const { candidate } of [...group.members].sort((a, b) => a.originalIndex - b.originalIndex)) {
      emit(candidate);
    }
    if (!expandSiblings || expandedSlugs.has(group.slug)) continue;
    expandedSlugs.add(group.slug);
    // Same-model offerings from other providers are offered once per model
    // slug, at the position of the highest-ranked variant of that model.
    for (const offering of siblingsFor(group.slug)) {
      if (candidateKeys.has(candidateKey(offering))) continue;
      emit(offering);
    }
  }
  return expanded;
}

// A paid model that reported insufficient funds is parked for a fixed window.
// The block is keyed by `provider:model`, never by provider or key, and it
// lives outside the in-memory cooldown map so a restart cannot forget it.
export function paymentBlockFor(blocks, key, now = Date.now()) {
  const entry = blocks?.[key];
  if (!entry) return null;
  const until = Date.parse(entry.until || 0);
  if (!Number.isFinite(until) || until <= now) return null;
  return { until, reason: entry.reason || '', observedAt: entry.observedAt || '' };
}

// Drops expired blocks; returns a new object plus whether anything changed so
// callers can decide whether to persist.
export function prunePaymentBlocks(blocks, now = Date.now()) {
  const next = {};
  let changed = false;
  for (const [key, entry] of Object.entries(blocks || {})) {
    const until = Date.parse(entry?.until || 0);
    if (!Number.isFinite(until) || until <= now) {
      changed = true;
      continue;
    }
    next[key] = entry;
  }
  return { blocks: next, changed };
}

export function sanitizePaymentBlocks(raw) {
  const clean = {};
  if (!raw || typeof raw !== 'object') return clean;
  for (const [key, entry] of Object.entries(raw)) {
    if (typeof key !== 'string' || !key.includes(':') || !entry || typeof entry !== 'object') continue;
    const until = Date.parse(entry.until || 0);
    if (!Number.isFinite(until)) continue;
    clean[key] = {
      until: new Date(until).toISOString(),
      reason: String(entry.reason || '').slice(0, 300),
      observedAt: entry.observedAt ? String(entry.observedAt) : new Date().toISOString(),
    };
  }
  return clean;
}

// Only capacity faults are worth retrying when every candidate is cooling
// down. A payment/notFound/forbidden refusal will answer the same way, and a
// 24h insufficient-funds block must never be bypassed by the fallback path.
const RETRYABLE_COOLDOWNS = new Set(['rateLimit', 'timeout', 'serverError', 'empty', 'overloaded']);

export function isRetryableCooldown(kind) {
  return RETRYABLE_COOLDOWNS.has(kind);
}
