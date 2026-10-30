import { providerKeysFromConfig } from './config.mjs';

const PROVIDER_ID = /^[a-z][a-z0-9_-]*$/;

export function isZeroCost(model) {
  const prompt = Number(model?.pricing?.prompt);
  const completion = Number(model?.pricing?.completion);
  return Number.isFinite(prompt) && Number.isFinite(completion) && prompt === 0 && completion === 0;
}

// Does this catalog row actually publish per-token prices? A `pricing: true`
// flag only describes the operator's expectation; a provider that answers with
// no price fields (Google's native listing, for one) cannot have its freeness
// decided by price, so it must fall back to probing.
export function hasPricingFields(model) {
  const pricing = model?.pricing;
  if (!pricing || typeof pricing !== 'object') return false;
  return (
    Number.isFinite(Number(pricing.prompt)) && Number.isFinite(Number(pricing.completion))
  );
}

export function isChatModel(model) {
  // A catalog that states which generation methods a model supports is
  // authoritative; guessing from modalities is only for catalogs that do not.
  if (typeof model?.chatCapable === 'boolean') return model.chatCapable;
  const outputs = model?.architecture?.output_modalities || ['text'];
  if (!outputs.includes('text') || outputs.some((modality) => modality !== 'text')) return false;
  if (model?.architecture?.tokenizer === 'Router') return false;
  return !/(?:content[-_ ]?safety|moderation|guard)(?:[:/_-]|$)/i.test(model?.id || '');
}

// A catalog that lists parameters can rule a model out. Missing or empty means
// the listing did not say, which is not the same as "cannot use tools".
export function supportsRequest(model, needs) {
  if (!model) return true;
  const listed = model.supported_parameters;
  if (Array.isArray(listed) && listed.length) {
    const supported = new Set(listed);
    if (needs.tools && !supported.has('tools')) return false;
    if (
      needs.responseFormat &&
      !supported.has('response_format') &&
      !supported.has('structured_outputs')
    ) {
      return false;
    }
  }
  const inputs = model.architecture?.input_modalities;
  if (Array.isArray(inputs) && inputs.length) {
    const allowed = new Set(inputs);
    for (const modality of needs.modalities || []) {
      if (!allowed.has(modality)) return false;
    }
  }
  return true;
}

// Google's native /v1beta/models speaks a different dialect than the
// OpenAI-compatible listing: models[] keyed by `name`, capabilities in
// `supportedGenerationMethods`, and no pricing at all. Normalizing here keeps
// the rest of the router on one model shape.
export function normalizeCatalogPayload(payload) {
  if (Array.isArray(payload?.data)) {
    return {
      shape: 'openai',
      models: payload.data.filter((model) => model && typeof model.id === 'string'),
      nextPageToken: '',
    };
  }
  if (!Array.isArray(payload?.models)) return { shape: 'unknown', models: [], nextPageToken: '' };
  const models = [];
  for (const raw of payload.models) {
    if (!raw || typeof raw.name !== 'string') continue;
    const methods = Array.isArray(raw.supportedGenerationMethods)
      ? raw.supportedGenerationMethods
      : [];
    models.push({
      id: raw.name.replace(/^models\//, ''),
      name: raw.displayName || '',
      description: raw.description || '',
      context_length: Number(raw.inputTokenLimit || 0),
      max_output_tokens: Number(raw.outputTokenLimit || 0),
      // Text chat is exactly `generateContent`. Embeddings expose
      // `embedContent`, video `predictLongRunning`, live audio
      // `bidiGenerateContent`, and none of those belong in a chat route.
      chatCapable: methods.includes('generateContent'),
      supportedGenerationMethods: methods,
      // supported_parameters is omitted on purpose: this listing does not
      // describe OpenAI-style tools, and an empty list would skip the model.
    });
  }
  return { shape: 'google', models, nextPageToken: String(payload.nextPageToken || '') };
}

function envName(providerName, suffix) {
  return `${String(providerName).replace(/-/g, '_').toUpperCase()}_${suffix}`;
}

export function normalizeModelSlug(id) {
  let slug = String(id || '').toLowerCase().trim();
  slug = slug.replace(/:free$/, '');
  const slash = slug.lastIndexOf('/');
  if (slash >= 0) slug = slug.slice(slash + 1);
  return slug;
}

function resolveHeaderValue(spec, { host, port }) {
  const origin = `http://${host}:${port}`;
  const expand = (value) => (value === '${origin}' ? origin : value);
  if (typeof spec === 'string') return expand(spec);
  if (!spec || typeof spec !== 'object') return '';
  const fromEnv = spec.env ? process.env[spec.env] : '';
  if (fromEnv) return fromEnv;
  return expand(spec.default || '');
}

function joinUrl(baseUrl, path) {
  const prefix = String(baseUrl || '').replace(/\/+$/, '');
  const suffix = String(path || '').startsWith('/') ? path : `/${path || ''}`;
  return `${prefix}${suffix}`;
}

export function createProviderRegistry(config, { host, port }) {
  const providers = new Map();

  function makeProviderEntry(name, raw) {
    if (!PROVIDER_ID.test(name)) {
      throw new Error(`invalid provider id "${name}"; use lowercase letters, digits, _ or -`);
    }
    const cfg = raw && typeof raw === 'object' ? raw : {};
    const keyEnv = cfg.keyEnv || envName(name, 'API_KEY');
    const baseUrlEnv = cfg.baseUrlEnv || envName(name, 'BASE_URL');
    const usesCatalog = cfg.catalog === true;
    // Fetching /models and deciding what is free are separate powers. Only a
    // catalog that actually publishes per-token prices can decide freeness by
    // itself; for the rest `freeModels` stays the allowlist (or polling proves
    // models free one by one). The flags below start from config and are
    // re-derived from the fetched rows once a catalog loads.
    const catalogHasPricing = usesCatalog && cfg.pricing !== false;
    const baseUrl = String(process.env[baseUrlEnv] || cfg.baseUrl || '').replace(/\/+$/, '');
    if (!baseUrl) throw new Error(`provider ${name} is missing baseUrl`);
    // Multi-account: keys live in config file (`[[providers.<name>.keys]]`
    // with `{name, key}`) plus env fallback (`<KEYENV>`, `<KEYENV>S`,
    // `<KEYENV>_KEYS`). `apiKey` stays as the first key for compatibility.
    const resolved = providerKeysFromConfig(name, { ...cfg, keyEnv });
    return {
      name,
      keyEnv,
      baseUrlEnv,
      usesCatalog,
      catalogHasPricing,
      cfgPricing: cfg.pricing !== false,
      cfgDiscover: cfg.discover !== false,
      cfgProbeFreeTier: cfg.probeFreeTier === true,
      // Adding unknown models from a catalog is only safe where prices are
      // published, so a priced catalog is a precondition for that route in.
      discover: catalogHasPricing && cfg.discover !== false,
      // The other way in: no prices, so ask the provider directly whether it
      // will serve the model for free. Opt-in, since it spends a request per
      // candidate and is only sound on a key with no billing attached.
      probeFreeTier: usesCatalog && !catalogHasPricing && cfg.probeFreeTier === true,
      chatPath: cfg.chatPath || '/chat/completions',
      // Some OpenAI-compatible layers (Gemini's) reject `stream_options`
      // outright; providers that understand it keep returning usage.
      streamOptions: cfg.streamOptions !== false,
      modelsPath: cfg.modelsPath || '/models',
      // Some providers serve a richer catalog outside the OpenAI-compatible
      // prefix used for chat, on its own auth scheme.
      modelsUrl: String(cfg.modelsUrl || ''),
      modelsKeyHeader: String(cfg.modelsKeyHeader || ''),
      extraHeaders: cfg.headers && typeof cfg.headers === 'object' ? cfg.headers : {},
      baseUrl,
      configRef: cfg,
      apiKeys: resolved.keys,
      apiKey: resolved.keys[0]?.key || '',
      keyCursor: 0,
      invalidKeys: new Set(),
      freeModels: new Set(cfg.freeModels || []),
      selectedModels: new Set(cfg.selectedModels || []),
      catalog: usesCatalog ? new Map() : null,
      catalogSlugs: usesCatalog ? new Map() : null,
      catalogFetchedAt: 0,
      catalogAttemptedAt: 0,
      catalogError: '',
    };
  }

  const entries = Object.entries(config.providers || {});
  if (!entries.length) throw new Error('config.providers is empty');

  for (const [name, raw] of entries) {
    providers.set(name, makeProviderEntry(name, raw));
  }

  const configuredDefault = config.defaultProvider;
  if (configuredDefault && !providers.has(configuredDefault)) {
    throw new Error(`defaultProvider "${configuredDefault}" is not in providers`);
  }
  let defaultProvider =
    configuredDefault ||
    [...providers.values()].find((provider) => provider.catalogHasPricing)?.name ||
    [...providers.keys()][0];

  function get(name) {
    return providers.get(name);
  }

  // Runtime provider management for the web UI. Config persistence is the
  // caller's job; the registry only mirrors it into live state.
  function addProvider(name, rawCfg) {
    if (providers.has(name)) throw new Error(`provider already exists: ${name}`);
    const entry = makeProviderEntry(name, rawCfg);
    providers.set(name, entry);
    return entry;
  }

  function removeProvider(name) {
    if (!providers.has(name)) return false;
    if (name === defaultProvider) throw new Error(`cannot remove the default provider: ${name}`);
    providers.delete(name);
    return true;
  }

  function setDefaultProvider(name) {
    if (!providers.has(name)) throw new Error(`unknown provider: ${name}`);
    defaultProvider = name;
  }

  function headers(name, keyOverride) {
    const provider = get(name);
    const resolved = {
      Authorization: `Bearer ${keyOverride ?? provider?.apiKey ?? ''}`,
      'Content-Type': 'application/json',
    };
    for (const [header, spec] of Object.entries(provider?.extraHeaders || {})) {
      const value = resolveHeaderValue(spec, { host, port });
      if (value) resolved[header] = value;
    }
    return resolved;
  }

  // Providers disagree on how to spell the same model: Gemini's OpenAI-compat
  // catalog returns "models/gemini-3.8-flash" where config.json says
  // "gemini-3.8-flash". Fall back to the slug so a naming difference does not
  // read as a model that vanished upstream.
  function catalogEntry(provider, modelId) {
    if (!provider?.catalog) return null;
    const exact = provider.catalog.get(modelId);
    if (exact) return exact;
    const slug = normalizeModelSlug(modelId);
    return (slug && provider.catalogSlugs?.get(slug)) || null;
  }

  function metadata(candidate) {
    const provider = get(candidate.provider);
    return provider?.usesCatalog ? catalogEntry(provider, candidate.model) : null;
  }

  function hasUsableKey(provider) {
    return Boolean(provider && provider.apiKeys && provider.apiKeys.length);
  }


  // Allowlisted models the provider no longer offers. Attempting these wastes
  // an upstream round trip and a cooldown slot on a guaranteed 404.
  function unavailableFreeModels() {
    const missing = [];
    for (const provider of providers.values()) {
      if (!provider.usesCatalog || provider.catalogHasPricing) continue;
      if (!hasUsableKey(provider) || !provider.catalog.size) continue;
      for (const id of provider.freeModels) {
        if (!catalogEntry(provider, id)) missing.push(`${provider.name}:${id}`);
      }
    }
    return missing.sort();
  }

  // Round-robin over usable keys. Invalid (401) keys are skipped until the
  // provider is reconfigured. Returns [{index, name, key}] in try-order, and
  // an empty list once every configured key has been retired: falling back to
  // the invalid keys made every request retry a credential the provider had
  // already refused. Pure read: rotation advances only via rotateKeyCursor
  // (called when a request actually goes out), so status pages and filters
  // never skew it.
  function keySlots(providerName) {
    const provider = get(providerName);
    if (!provider || !provider.apiKeys?.length) return [];
    const usable = provider.apiKeys
      .map((entry, index) => ({ ...entry, index }))
      .filter((entry) => entry.key && !provider.invalidKeys.has(entry.key));
    if (!usable.length) return [];
    const start = provider.keyCursor % usable.length;
    return [...usable.slice(start), ...usable.slice(0, start)];
  }

  // How many keys the operator configured, retired or not. Lets callers tell
  // "this provider needs no key" (local endpoints) from "every key is dead".
  function keyCount(providerName) {
    return get(providerName)?.apiKeys?.length || 0;
  }

  function rotateKeyCursor(providerName) {
    const provider = get(providerName);
    if (provider) provider.keyCursor += 1;
  }

  function markKeyInvalid(providerName, key) {
    get(providerName)?.invalidKeys.add(key);
  }

  function refreshKeysFromEnv(providerName) {
    const provider = get(providerName);
    if (!provider) return false;
    const raw = provider.configRef && typeof provider.configRef === 'object' ? provider.configRef : {};
    const resolved = providerKeysFromConfig(providerName, { ...raw, keyEnv: provider.keyEnv });
    provider.apiKeys = resolved.keys;
    provider.apiKey = resolved.keys[0]?.key || '';
    provider.invalidKeys.clear();
    return true;
  }

  function parsePrefixed(requestedModel) {
    const separator = requestedModel.indexOf(':');
    if (separator <= 0) return null;
    const providerName = requestedModel.slice(0, separator);
    const model = requestedModel.slice(separator + 1);
    if (!providers.has(providerName) || !model) return null;
    return { provider: providerName, model };
  }

  function catalogUrl(provider) {
    return provider.modelsUrl || joinUrl(provider.baseUrl, provider.modelsPath);
  }

  function firstKey(provider) {
    return provider?.apiKeys?.[0]?.key || '';
  }

  function catalogHeaders(provider, keyOverride) {
    const key = keyOverride ?? firstKey(provider);
    if (!key) return undefined;
    // Google's native endpoint rejects a Bearer token with 401 and wants its
    // own header. Keeping the key out of the query string keeps it out of logs.
    if (provider.modelsKeyHeader) return { [provider.modelsKeyHeader]: key };
    return { Authorization: `Bearer ${key}` };
  }

  async function fetchCatalogPage(provider, pageToken, keyOverride) {
    const url = new URL(catalogUrl(provider));
    if (provider.modelsUrl) url.searchParams.set('pageSize', '1000');
    if (pageToken) url.searchParams.set('pageToken', pageToken);
    const response = await fetch(url, {
      headers: catalogHeaders(provider, keyOverride),
      signal: AbortSignal.timeout(30000),
    });
    if (!response.ok) {
      const error = new Error(`HTTP ${response.status}`);
      error.status = response.status;
      throw error;
    }
    return normalizeCatalogPayload(await response.json());
  }

  // Freeness semantics are decided by the rows, not only by the config flag.
  // Only a successful, non-empty fetch may change them: an outage must not
  // turn a priced provider into a probeable one (or spend probes on a key
  // that is actually billed).
  function applyCatalogSemantics(provider, models) {
    if (!provider?.usesCatalog || !Array.isArray(models) || !models.length) return;
    const priced = models.some(hasPricingFields);
    provider.catalogHasPricing = Boolean(provider.cfgPricing && priced);
    provider.probeFreeTier = Boolean(
      provider.usesCatalog && !provider.catalogHasPricing && provider.cfgProbeFreeTier,
    );
    provider.discover = Boolean(provider.catalogHasPricing && provider.cfgDiscover);
  }

  async function refreshProviderCatalog(provider, force, catalogRefreshMs) {
    if (!provider.usesCatalog) return;
    if (
      !force &&
      Date.now() - provider.catalogAttemptedAt < catalogRefreshMs &&
      (provider.catalog.size || provider.catalogError)
    ) {
      return;
    }
    provider.catalogAttemptedAt = Date.now();
    const keyCandidates = provider.apiKeys?.map((entry) => entry.key).filter(Boolean) || [];
    if (!keyCandidates.length) keyCandidates.push('');
    let lastError = null;
    for (const keyCandidate of keyCandidates) {
      try {
        const listed = [];
        let pageToken = '';
        // A truncated listing is indistinguishable from models withdrawn
        // upstream, so follow pagination rather than trusting the first page.
        for (let page = 0; page < 10; page += 1) {
          const result = await fetchCatalogPage(provider, pageToken, keyCandidate);
          if (result.shape === 'unknown') throw new Error('unrecognised catalog response shape');
          listed.push(...result.models);
          pageToken = result.nextPageToken;
          if (!pageToken) break;
        }
        if (!listed.length) throw new Error('catalog response listed no models');
        provider.catalog = new Map(listed.map((model) => [model.id, model]));
        provider.catalogSlugs = new Map();
        for (const model of listed) {
          const slug = normalizeModelSlug(model.id);
          if (slug && !provider.catalogSlugs.has(slug)) provider.catalogSlugs.set(slug, model);
        }
        provider.catalogFetchedAt = Date.now();
        provider.catalogError = '';
        applyCatalogSemantics(provider, listed);
        const freeCount = provider.catalogHasPricing
          ? [...provider.catalog.values()].filter(isZeroCost).length
          : null;
        const chatCount = [...provider.catalog.values()].filter(isChatModel).length;
        return { name: provider.name, size: provider.catalog.size, freeCount, chatCount };
      } catch (error) {
        lastError = error;
        // A wrong key must not poison other keys: try the next one.
        if (error?.status === 401 && keyCandidate !== keyCandidates[keyCandidates.length - 1]) continue;
        break;
      }
    }
    provider.catalogError = lastError instanceof Error ? lastError.message : String(lastError);
    throw new Error(`${provider.name}: ${provider.catalogError}`);
  }

  // Refresh a single provider's catalog. Adding or saving a key should not
  // pay for every other provider's listing.
  async function refreshCatalogFor(name, force = false, catalogRefreshMs = 0) {
    const provider = get(name);
    if (!provider || !provider.usesCatalog) return null;
    try {
      const result = await refreshProviderCatalog(provider, force, catalogRefreshMs);
      return result || null;
    } catch (error) {
      throw error;
    }
  }

  async function refreshCatalogs(force, catalogRefreshMs, log) {
    for (const provider of providers.values()) {
      if (!provider.usesCatalog) continue;
      try {
        const result = await refreshProviderCatalog(provider, force, catalogRefreshMs);
        if (result) {
          const detail =
            result.freeCount === null
              ? `${result.chatCount} chat-capable, no prices published`
              : `${result.freeCount} zero-cost`;
          log(`catalog refreshed (${result.name}): ${result.size} models, ${detail}`);
        }
      } catch (error) {
        log(
          `catalog refresh failed for ${provider.name}; retaining previous catalog: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
  }

  // A listing entry carries everything the catalogs actually publish about a
  // model. Providers speak different dialects: Google reports sizes but no
  // release time, OpenRouter reports a `created` timestamp, and either may be
  // the only place a given model appears. Fields are therefore filled per
  // model and topped up across providers rather than zero-filled.
  function catalogFacts(model) {
    if (!model) return {};
    const facts = {};
    const contextLength = Number(model.context_length || model.top_provider?.context_length || 0);
    if (contextLength > 0) facts.context_length = contextLength;
    const maxOutput = Number(model.max_output_tokens || model.top_provider?.max_completion_tokens || 0);
    if (maxOutput > 0) facts.max_output_tokens = maxOutput;
    const created = Number(model.created || 0);
    if (created > 0) facts.created = created;
    if (model.name) facts.name = String(model.name);
    if (model.description) facts.description = String(model.description);
    if (Array.isArray(model.supported_parameters) && model.supported_parameters.length) {
      facts.supported_parameters = [...model.supported_parameters];
    }
    const inputs = model.architecture?.input_modalities;
    if (Array.isArray(inputs) && inputs.length) facts.input_modalities = [...inputs];
    const outputs = model.architecture?.output_modalities;
    if (Array.isArray(outputs) && outputs.length) facts.output_modalities = [...outputs];
    if (model.pricing && typeof model.pricing === 'object') facts.pricing = { ...model.pricing };
    // Free models get retired, and a listing that says so is worth passing on.
    if (model.expiration_date) facts.expiration_date = String(model.expiration_date);
    return facts;
  }

  // What every other provider says about the same model, keyed by slug. Google
  // never publishes a release date, so the OpenRouter entry for `gemini-x` is
  // the only honest source for it.
  function borrowedFacts(modelId) {
    const slug = normalizeModelSlug(modelId);
    if (!slug) return {};
    const facts = {};
    for (const provider of providers.values()) {
      if (!provider.catalog?.size) continue;
      const model = provider.catalogSlugs?.get(slug);
      if (!model) continue;
      const found = catalogFacts(model);
      for (const [key, value] of Object.entries(found)) {
        if (facts[key] === undefined) facts[key] = value;
      }
    }
    return facts;
  }

  function modelEntry({ provider, id, catalogModel, ownedBy }) {
    const entry = {
      id,
      object: 'model',
      created: 0,
      // An allowlisted model is the provider's offering, so the provider owns
      // it; a catalog model keeps the vendor prefix it publishes ("google/…").
      owned_by: ownedBy || provider.name,
      context_length: 0,
      provider: provider.name,
      free: true,
    };
    const facts = provider?.usesCatalog ? catalogFacts(catalogModel || catalogEntry(provider, id)) : {};
    const borrowed = borrowedFacts(id);
    // This provider's own numbers win; anything it does not publish is filled
    // from a sibling provider that does. Pricing is the exception: it is per
    // provider, so another provider's price says nothing about this one.
    const borrowedForThisModel = { ...borrowed };
    delete borrowedForThisModel.pricing;
    const merged = { ...borrowedForThisModel, ...facts };
    for (const key of [
      'created',
      'context_length',
      'max_output_tokens',
      'name',
      'description',
      'supported_parameters',
      'input_modalities',
      'output_modalities',
      'pricing',
      'expiration_date',
    ]) {
      if (merged[key] !== undefined) entry[key] = merged[key];
    }
    return entry;
  }

  // Every chat-capable zero-cost model a priced catalog publishes. The pool
  // uses this to build automatic membership; the UI uses it for pickers.
  function catalogFreeChatModels(provider) {
    if (!provider?.catalog?.size || !provider.catalogHasPricing) return [];
    return [...provider.catalog.values()].filter((model) => isZeroCost(model) && isChatModel(model));
  }

  // One payload for GET /v1/models: the default alias first, then the pool's
  // free entries (deduplicated by bare id), then explicitly selected paid
  // entries. Only callable entries appear: a provider without a usable key is
  // shown in the UI, never advertised to clients.
  function buildModelList({ aliases = [], entries = [] } = {}) {
    const models = [];
    const used = new Set();
    for (const alias of aliases) {
      models.push({
        id: alias.id,
        object: 'model',
        created: 0,
        owned_by: alias.owned_by || 'free-router',
      });
      used.add(alias.id);
    }
    const freeEntries = entries.filter((entry) => entry.free);
    const paidEntries = entries.filter((entry) => !entry.free);
    for (const entry of freeEntries) {
      const provider = get(entry.provider);
      if (!provider || !hasUsableKey(provider)) continue;
      if (used.has(entry.model)) continue;
      used.add(entry.model);
      const vendor = entry.catalogModel?.id?.includes('/')
        ? entry.catalogModel.id.split('/')[0]
        : provider.name;
      models.push(
        modelEntry({ provider, id: entry.model, catalogModel: entry.catalogModel, ownedBy: vendor }),
      );
    }
    for (const entry of paidEntries) {
      const provider = get(entry.provider);
      if (!provider || !hasUsableKey(provider)) continue;
      // Two providers can offer the same bare id; a selected paid model then
      // needs the qualified form so it does not shadow the free offering.
      const id = used.has(entry.model) ? `${entry.provider}:${entry.model}` : entry.model;
      used.add(id);
      const vendor = entry.catalogModel?.id?.includes('/')
        ? entry.catalogModel.id.split('/')[0]
        : provider.name;
      const listed = modelEntry({ provider, id: entry.model, catalogModel: entry.catalogModel, ownedBy: vendor });
      listed.id = id;
      listed.provider = entry.provider;
      listed.free = false;
      listed.paid = true;
      if (entry.unknown) listed.unknown = true;
      models.push(listed);
    }
    return { models };
  }

  // 'catalog' lets prices decide what is free; 'static' trusts the freeModels
  // allowlist; 'static+catalog' trusts the allowlist but still consults the
  // catalog to drop models the provider stopped offering.
  function providerKind(provider) {
    if (provider.catalogHasPricing) return 'catalog';
    return provider.usesCatalog ? 'static+catalog' : 'static';
  }

  function health() {
    const unavailable = new Set(unavailableFreeModels());
    return Object.fromEntries(
      [...providers.entries()].map(([name, provider]) => [
        name,
        {
          configured: hasUsableKey(provider),
          keyCount: provider.apiKeys?.length || 0,
          keys: (provider.apiKeys || []).map((entry) => ({
            name: entry.name,
            source: entry.source,
            masked: entry.key ? `${entry.key.slice(0, 5)}${'*'.repeat(8)}${entry.key.slice(-4)} (${entry.key.length})` : '',
            invalid: provider.invalidKeys.has(entry.key),
          })),
          kind: providerKind(provider),
          baseUrl: provider.baseUrl,
          freeModels: provider.catalogHasPricing ? undefined : [...provider.freeModels],
          unavailableModels: provider.catalogHasPricing
            ? undefined
            : [...provider.freeModels].filter((id) => unavailable.has(`${name}:${id}`)),
          catalogModels: provider.usesCatalog ? provider.catalog.size : undefined,
          catalogFetchedAt:
            provider.usesCatalog && provider.catalogFetchedAt
              ? new Date(provider.catalogFetchedAt).toISOString()
              : undefined,
          catalogError: provider.usesCatalog ? provider.catalogError || null : undefined,
        },
      ]),
    );
  }

  // Applied to the live provider and to process.env, so a key set at runtime
  // works on the next request without a restart. Legacy single-key path:
  // replaces the `env` entry, keeps file keys intact.
  function setApiKey(name, key) {
    const provider = get(name);
    if (!provider) return false;
    const value = String(key || '');
    const fileKeys = (provider.apiKeys || []).filter((entry) => entry.source === 'file');
    const next = [...fileKeys];
    if (value) {
      process.env[provider.keyEnv] = value;
      next.push({ name: 'env', key: value, source: 'env', keyEnv: provider.keyEnv });
    } else {
      delete process.env[provider.keyEnv];
    }
    provider.apiKeys = next;
    provider.apiKey = next[0]?.key || '';
    provider.invalidKeys.clear();
    if (provider.usesCatalog && !next.length) {
      provider.catalog = new Map();
      provider.catalogSlugs = new Map();
      provider.catalogFetchedAt = 0;
      provider.catalogAttemptedAt = 0;
      provider.catalogError = '';
    }
    return true;
  }

  // Explicit model selection for one provider. Config persistence is the
  // caller's job; this mirrors the list into live state so routing sees it on
  // the next request. Selection enables a model, never marks it free.
  function setSelectedModels(name, list) {
    const provider = get(name);
    if (!provider) return false;
    const cleaned = [...new Set((list || []).map((id) => String(id || '').trim()).filter(Boolean))];
    provider.selectedModels = new Set(cleaned);
    provider.configRef.selectedModels = cleaned;
    return true;
  }

  // Named multi-key write path used by the web UI (persisted to TOML by the
  // caller via configRef). Entries: [{name, key}].
  function setProviderKeys(name, entries) {
    const provider = get(name);
    if (!provider) return false;
    const cleaned = (entries || [])
      .map((entry, index) => ({
        name: String(entry?.name || `key-${index + 1}`),
        key: String(entry?.key || ''),
        source: 'file',
      }))
      .filter((entry) => entry.key);
    const seen = new Set();
    const deduped = [];
    for (const entry of cleaned) {
      if (seen.has(entry.key)) continue;
      seen.add(entry.key);
      deduped.push(entry);
    }
    provider.configRef.keys = deduped.map(({ name: keyName, key }) => ({ name: keyName, key }));
    refreshKeysFromEnv(name);
    return true;
  }

  return {
    providers,
    get defaultProvider() {
      return defaultProvider;
    },
    get,
    headers,
    metadata,
    parsePrefixed,
    refreshCatalogs,
    refreshCatalogFor,
    catalogFreeChatModels,
    buildModelList,
    setSelectedModels,
    health,
    catalogEntry,
    unavailableFreeModels,
    providerKind,
    setApiKey,
    setProviderKeys,
    addProvider,
    removeProvider,
    setDefaultProvider,
    keySlots,
    keyCount,
    rotateKeyCursor,
    markKeyInvalid,
    refreshKeysFromEnv,
    hasUsableKey,
    chatUrl(name) {
      const provider = get(name);
      return provider ? joinUrl(provider.baseUrl, provider.chatPath) : '';
    },
  };
}
