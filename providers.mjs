const PROVIDER_ID = /^[a-z][a-z0-9_-]*$/;

export function isZeroCost(model) {
  const prompt = Number(model?.pricing?.prompt);
  const completion = Number(model?.pricing?.completion);
  return Number.isFinite(prompt) && Number.isFinite(completion) && prompt === 0 && completion === 0;
}

export function isChatModel(model) {
  const outputs = model?.architecture?.output_modalities || ['text'];
  if (!outputs.includes('text') || outputs.some((modality) => modality !== 'text')) return false;
  if (model?.architecture?.tokenizer === 'Router') return false;
  return !/(?:content[-_ ]?safety|moderation|guard)(?:[:/_-]|$)/i.test(model?.id || '');
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
  const entries = Object.entries(config.providers || {});
  if (!entries.length) throw new Error('config.providers is empty');

  const providers = new Map();
  for (const [name, raw] of entries) {
    if (!PROVIDER_ID.test(name)) {
      throw new Error(`invalid provider id "${name}"; use lowercase letters, digits, _ or -`);
    }
    const cfg = raw && typeof raw === 'object' ? raw : {};
    const keyEnv = cfg.keyEnv || envName(name, 'API_KEY');
    const baseUrlEnv = cfg.baseUrlEnv || envName(name, 'BASE_URL');
    const usesCatalog = cfg.catalog === true;
    const baseUrl = String(process.env[baseUrlEnv] || cfg.baseUrl || '').replace(/\/+$/, '');
    if (!baseUrl) throw new Error(`provider ${name} is missing baseUrl`);
    providers.set(name, {
      name,
      keyEnv,
      baseUrlEnv,
      usesCatalog,
      discover: usesCatalog && cfg.discover !== false,
      chatPath: cfg.chatPath || '/chat/completions',
      modelsPath: cfg.modelsPath || '/models',
      extraHeaders: cfg.headers && typeof cfg.headers === 'object' ? cfg.headers : {},
      baseUrl,
      apiKey: process.env[keyEnv] || '',
      freeModels: new Set(cfg.freeModels || []),
      catalog: usesCatalog ? new Map() : null,
      catalogFetchedAt: 0,
      catalogError: '',
    });
  }

  const configuredDefault = config.defaultProvider;
  if (configuredDefault && !providers.has(configuredDefault)) {
    throw new Error(`defaultProvider "${configuredDefault}" is not in providers`);
  }
  const defaultProvider =
    configuredDefault ||
    [...providers.values()].find((provider) => provider.usesCatalog)?.name ||
    [...providers.keys()][0];

  const configuredDiscovery = config.discovery?.provider;
  if (configuredDiscovery && !providers.has(configuredDiscovery)) {
    throw new Error(`discovery.provider "${configuredDiscovery}" is not in providers`);
  }
  const discoveryProvider =
    configuredDiscovery ||
    [...providers.values()].find((provider) => provider.discover)?.name ||
    defaultProvider;

  function get(name) {
    return providers.get(name);
  }

  function headers(name) {
    const provider = get(name);
    const resolved = {
      Authorization: `Bearer ${provider?.apiKey || ''}`,
      'Content-Type': 'application/json',
    };
    for (const [header, spec] of Object.entries(provider?.extraHeaders || {})) {
      const value = resolveHeaderValue(spec, { host, port });
      if (value) resolved[header] = value;
    }
    return resolved;
  }

  function metadata(candidate) {
    const provider = get(candidate.provider);
    return provider?.usesCatalog ? provider.catalog.get(candidate.model) : null;
  }

  function isFree(candidate) {
    const provider = get(candidate.provider);
    if (!provider || !provider.apiKey) return false;
    if (provider.usesCatalog) {
      const model = provider.catalog.get(candidate.model);
      return !provider.catalog.size || Boolean(model && isZeroCost(model) && isChatModel(model));
    }
    return provider.freeModels.has(candidate.model);
  }

  function parsePrefixed(requestedModel) {
    const separator = requestedModel.indexOf(':');
    if (separator <= 0) return null;
    const providerName = requestedModel.slice(0, separator);
    const model = requestedModel.slice(separator + 1);
    if (!providers.has(providerName) || !model) return null;
    return { provider: providerName, model };
  }

  function offeringsForSlug(slug) {
    const normalized = String(slug || '');
    if (!normalized) return [];
    const offerings = [];
    const seen = new Set();
    for (const provider of providers.values()) {
      if (!provider.apiKey) continue;
      if (provider.usesCatalog) {
        if (!provider.catalog) continue;
        for (const model of provider.catalog.values()) {
          if (normalizeModelSlug(model.id) !== normalized) continue;
          if (!isZeroCost(model) || !isChatModel(model)) continue;
          const key = `${provider.name}:${model.id}`;
          if (seen.has(key)) continue;
          seen.add(key);
          offerings.push({ provider: provider.name, model: model.id });
        }
        continue;
      }
      for (const id of provider.freeModels) {
        if (normalizeModelSlug(id) !== normalized) continue;
        const key = `${provider.name}:${id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        offerings.push({ provider: provider.name, model: id });
      }
    }
    return offerings;
  }

  function directCandidates(requestedModel) {
    const prefixed = parsePrefixed(requestedModel);
    if (prefixed) return [prefixed];
    const slug = normalizeModelSlug(requestedModel);
    const offerings = offeringsForSlug(slug);
    if (!offerings.length) {
      return [{ provider: defaultProvider, model: requestedModel }];
    }
    const exact = [];
    const rest = [];
    for (const offering of offerings) {
      if (offering.model === requestedModel) exact.push(offering);
      else rest.push(offering);
    }
    return [...exact, ...rest];
  }

  async function refreshProviderCatalog(provider, force, catalogRefreshMs) {
    if (!provider.usesCatalog) return;
    if (
      !force &&
      Date.now() - provider.catalogFetchedAt < catalogRefreshMs &&
      provider.catalog.size
    ) {
      return;
    }
    try {
      const response = await fetch(joinUrl(provider.baseUrl, provider.modelsPath), {
        headers: provider.apiKey ? { Authorization: `Bearer ${provider.apiKey}` } : undefined,
        signal: AbortSignal.timeout(30000),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const payload = await response.json();
      provider.catalog = new Map((payload.data || []).map((model) => [model.id, model]));
      provider.catalogFetchedAt = Date.now();
      provider.catalogError = '';
      const freeCount = [...provider.catalog.values()].filter(isZeroCost).length;
      return { name: provider.name, size: provider.catalog.size, freeCount };
    } catch (error) {
      provider.catalogError = error instanceof Error ? error.message : String(error);
      throw new Error(`${provider.name}: ${provider.catalogError}`);
    }
  }

  async function refreshCatalogs(force, catalogRefreshMs, log) {
    for (const provider of providers.values()) {
      if (!provider.usesCatalog) continue;
      try {
        const result = await refreshProviderCatalog(provider, force, catalogRefreshMs);
        if (result) {
          log(`catalog refreshed (${result.name}): ${result.size} models, ${result.freeCount} zero-cost`);
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

  function listListedModels() {
    const models = [];
    const ids = new Set();
    for (const provider of providers.values()) {
      if (!provider.apiKey || provider.usesCatalog) continue;
      for (const id of provider.freeModels) {
        if (ids.has(id)) continue;
        ids.add(id);
        models.push({
          id,
          object: 'model',
          created: 0,
          owned_by: provider.name,
          context_length: 0,
        });
      }
    }
    return { models, ids };
  }

  function listCatalogModels(excludeIds = new Set()) {
    const models = [];
    const seen = new Set(excludeIds);
    for (const provider of providers.values()) {
      if (!provider.usesCatalog || !provider.catalog) continue;
      for (const model of provider.catalog.values()) {
        if (!isZeroCost(model) || !isChatModel(model) || seen.has(model.id)) continue;
        seen.add(model.id);
        models.push({
          id: model.id,
          object: 'model',
          created: Number(model.created || 0),
          owned_by: model.id.split('/')[0] || provider.name,
          context_length: Number(model.context_length || 0),
          provider: provider.name,
        });
      }
    }
    models.sort((a, b) => String(a.id).localeCompare(String(b.id)));
    return models;
  }

  function health() {
    return Object.fromEntries(
      [...providers.entries()].map(([name, provider]) => [
        name,
        {
          configured: Boolean(provider.apiKey),
          kind: provider.usesCatalog ? 'catalog' : 'static',
          baseUrl: provider.baseUrl,
          freeModels: provider.usesCatalog ? undefined : [...provider.freeModels],
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

  function discoveryCatalog() {
    return get(discoveryProvider);
  }

  return {
    providers,
    defaultProvider,
    discoveryProvider,
    get,
    headers,
    metadata,
    isFree,
    parsePrefixed,
    offeringsForSlug,
    directCandidates,
    refreshCatalogs,
    listListedModels,
    listCatalogModels,
    health,
    discoveryCatalog,
    chatUrl(name) {
      const provider = get(name);
      return provider ? joinUrl(provider.baseUrl, provider.chatPath) : '';
    },
  };
}
