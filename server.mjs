#!/usr/bin/env node

import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildLiveConfig,
  defaultConfigPath,
  ensureConfigFile,
  isPlainObject,
  loadConfigFile,
  loadOverlayFile,
  OVERLAY_FILENAME,
  resolveConfigPaths,
  runOverlayMigrations,
  saveOverlayFile,
} from './config.mjs';
import { hashPassword, isPasswordHash, verifyPassword } from './auth.mjs';
import {
  createProviderRegistry,
  isChatModel,
  isZeroCost,
  normalizeModelSlug,
  supportsRequest,
} from './providers.mjs';
import { installUpstreamProxy } from './proxy.mjs';
import { msUntilQuotaReset, parseQuotaFailure, permanentRejection } from './quota.mjs';
import { createSecretRedactor } from './redact.mjs';
import {
  createStreamSignatureExtractor,
  createThoughtSignatureCache,
  injectThoughtSignatures,
  isMissingThoughtSignatureError,
  providerNeedsThoughtSignatures,
  rememberSignaturesFromPayload,
} from './thought-signature.mjs';
import { displayPath, maskSecret, renderPage, updateEnvFile, validateSecret } from './ui.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const VERSION = JSON.parse(fs.readFileSync(path.join(HERE, 'package.json'), 'utf8')).version;

function loadEnvFile(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!match) continue;
    let value = match[2];
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!value || process.env[match[1]]) continue;
    process.env[match[1]] = value;
  }
}

const envCandidates = [
  path.join(HERE, '.env'),
  path.join(os.homedir(), '.hermes', '.env'),
];
for (const file of envCandidates) {
  if (file) loadEnvFile(file);
}

const CONFIG_PATH = process.env.FREE_ROUTER_CONFIG || defaultConfigPath(HERE);
const { overlayPath: OVERLAY_PATH } = resolveConfigPaths(HERE, process.env.FREE_ROUTER_CONFIG);
try {
  // Docker creates a directory for a volume-mounted file that does not exist
  // on the host yet; replace it with a real default config instead of
  // crashing on read.
  if (fs.existsSync(CONFIG_PATH) && fs.statSync(CONFIG_PATH).isDirectory()) {
    fs.rmSync(CONFIG_PATH, { recursive: true, force: true });
  }
} catch {
  // Fall through to the normal load path, which reports the problem.
}
if (ensureConfigFile(CONFIG_PATH)) {
  console.log(`[${new Date().toISOString()}] wrote default config to ${CONFIG_PATH}; set keys in the web UI`);
}
// Layered config: config.json (tracked defaults) + config.local.json
// (gitignored operator overlay). The live view merges both; only the
// overlay file is ever written back, so the base stays merge-clean.
const { config: baseConfig, format: CONFIG_FORMAT } = loadConfigFile(CONFIG_PATH);
const overlayLoaded = loadOverlayFile(OVERLAY_PATH);
let overlay = overlayLoaded.overlay;
if (overlayLoaded.error) {
  log(`ignoring unreadable overlay ${displayPath(OVERLAY_PATH)}: ${overlayLoaded.error}`);
}
if (runOverlayMigrations(overlay)) persistOverlayFile();
const config = buildLiveConfig(baseConfig, overlay);
// Live-view-only normalization (memory, never persisted): the overlay file
// stays sparse until a real mutation lands through the helpers below.
if (!isPlainObject(config.webui)) config.webui = {};
if (!isPlainObject(config.gateway)) config.gateway = {};
if (!Array.isArray(config.gateway.keys)) config.gateway = { ...config.gateway, keys: [] };
// Write helpers below always target the overlay object, so a base-owned
// subtree is materialized there on first write (copy-on-write) and the base
// file is never touched at runtime.
function overlayParent(path) {
  let overlayNode = overlay;
  let liveNode = config;
  for (const key of path.slice(0, -1)) {
    if (!isPlainObject(overlayNode[key])) overlayNode[key] = {};
    if (!isPlainObject(liveNode[key])) liveNode[key] = {};
    overlayNode = overlayNode[key];
    liveNode = liveNode[key];
  }
  return [overlayNode, liveNode];
}
function setOverlayValue(path, value) {
  const [overlayNode, liveNode] = overlayParent(path);
  const leaf = path[path.length - 1];
  overlayNode[leaf] = value;
  liveNode[leaf] = value;
}
function deleteOverlayValue(path) {
  const [overlayNode, liveNode] = overlayParent(path);
  const leaf = path[path.length - 1];
  delete overlayNode[leaf];
  delete liveNode[leaf];
}
// Provider raw blocks need whole-object ownership (nested partial updates
// like freeModels/baseUrl must not orphan sibling keys from the live view).
function editableProviderRaw(name) {
  overlay.providers ||= {};
  if (!isPlainObject(overlay.providers[name])) {
    overlay.providers[name] = structuredClone(config.providers?.[name] || {});
  }
  const raw = overlay.providers[name];
  const provider = PROVIDERS.get(name);
  if (provider) provider.configRef = raw;
  config.providers ||= {};
  config.providers[name] = raw;
  return raw;
}
function persistOverlayFile() {
  saveOverlayFile(OVERLAY_PATH, overlay);
}
function tombstone(listKey, name, present) {
  if (!Array.isArray(overlay[listKey])) overlay[listKey] = [];
  const key = String(name);
  const index = overlay[listKey].indexOf(key);
  if (present && index < 0) overlay[listKey].push(key);
  if (!present && index >= 0) overlay[listKey].splice(index, 1);
}
installUpstreamProxy(
  (message) => {
    console.log(`[${new Date().toISOString()}]`, message);
  },
  { socksFirstHosts: config.socksFirstHosts || [] },
);
const HOST = process.env.FREE_ROUTER_HOST || config.host || '127.0.0.1';
const PORT = Number(process.env.FREE_ROUTER_PORT || config.port || 8787);
let attemptTimeoutMs = Number(
  process.env.FREE_ROUTER_ATTEMPT_TIMEOUT_MS || config.attemptTimeoutMs || 180000,
);
let catalogRefreshMs = Number(config.catalogRefreshMs || 900000);
const registry = createProviderRegistry(config, { host: HOST, port: PORT });
const PROVIDERS = registry.providers;
const discoveryConfig = config.discovery || {};
let discoveryEnabled = discoveryConfig.enabled !== false;
const DISCOVERY_INTERVAL_MS = Number(discoveryConfig.intervalMs || 7 * 24 * 60 * 60 * 1000);
const DISCOVERY_ROUTE = String(discoveryConfig.route || 'free-best');
// How long a "not free" verdict stands before the model is worth asking again.
const VERDICT_RETRY_MS = Number(discoveryConfig.verdictRetryMs || DISCOVERY_INTERVAL_MS);
const DISCOVERY_STATE_PATH = path.resolve(
  path.dirname(CONFIG_PATH),
  discoveryConfig.stateFile || 'discovered-free-models.json',
);
function compilePatterns(patterns, label) {
  const compiled = [];
  for (const pattern of patterns || []) {
    try {
      compiled.push(new RegExp(String(pattern), 'i'));
    } catch (error) {
      log(`ignoring invalid ${label} pattern ${pattern}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return compiled;
}

const excludeConfig = discoveryConfig.exclude || {};
const EXCLUDE_MODEL_PATTERNS = compilePatterns(excludeConfig.modelPatterns, 'exclude.modelPatterns');
const EXCLUDE_TEXT_PATTERNS = compilePatterns(excludeConfig.textPatterns, 'exclude.textPatterns');
const evaluationConfig = discoveryConfig.evaluation || {};
let evaluationEnabled = evaluationConfig.enabled !== false;
const EVALUATION_MAX_TOKENS = Number(evaluationConfig.maxTokens || 4000);
// Bumped whenever the benchmark or its weights change, so stored scores from an
// older scale get recomputed instead of being compared against new ones.
const EVALUATION_VERSION = 2;
const EVALUATION_MAX_PER_RUN = Math.max(1, Number(evaluationConfig.maxPerRun || 8));
const RANK_USAGE_WEIGHT = Math.max(0, Number(evaluationConfig.usageWeight ?? 12));
const RANK_USAGE_MIN_REQUESTS = Math.max(1, Number(evaluationConfig.usageMinRequests || 20));
const PINNED_MODELS = new Set(evaluationConfig.pinnedModels || []);
const usageConfig = config.usage || {};
const USAGE_RETENTION_DAYS = Math.max(1, Number(usageConfig.retentionDays || 7));
const USAGE_TIMEZONE = String(usageConfig.timezone || '');
const USAGE_DAILY_LIMITS = usageConfig.dailyLimits || {};
const USAGE_KINDS = [
  'ok',
  'rateLimit',
  'timeout',
  'serverError',
  'empty',
  'notFound',
  'forbidden',
  'aborted',
  'other',
];
// A rejected request never reaches the model, so it does not burn daily quota.
const USAGE_NON_CONSUMING = new Set(['rateLimit', 'notFound', 'forbidden']);
const USAGE_DAY_FORMATTER = (() => {
  if (!USAGE_TIMEZONE) return null;
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: USAGE_TIMEZONE,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
  } catch {
    log(`invalid usage.timezone ${USAGE_TIMEZONE}; falling back to local dates`);
    return null;
  }
})();
const uiConfig = config.webui || config.ui || {};
const UI_ENABLED = uiConfig.enabled !== false;
const UI_ENV_PATH = path.resolve(path.dirname(CONFIG_PATH), uiConfig.envFile || '.env');
// Web UI single admin password (default "admin123"). Stored as a salted
// scrypt hash; legacy plaintext values are upgraded on boot and on login.
// Env override wins so a locked-out operator can recover without editing
// the config file.
const storedWebuiPassword = () => String(uiConfig.password || config.ui?.password || 'admin123');

// Whether the effective password is still the default. Memoized per stored
// value so the scrypt check runs at most once per password change.
let defaultPwCache = { key: null, result: false };
function isDefaultPassword() {
  if (process.env.FREE_ROUTER_WEBUI_PASSWORD) {
    return process.env.FREE_ROUTER_WEBUI_PASSWORD === 'admin123';
  }
  const stored = storedWebuiPassword();
  if (stored === 'admin123') return true;
  if (defaultPwCache.key === stored) return defaultPwCache.result;
  const result = verifyPassword('admin123', stored);
  defaultPwCache = { key: stored, result };
  return result;
}

function setStoredWebuiPassword(value, { persist = true } = {}) {
  // Readers prefer config.webui over the legacy config.ui mirror, so the
  // overlay copy alone is authoritative; the tracked base file is untouched.
  setOverlayValue(['webui', 'password'], value);
  defaultPwCache.key = null;
  if (!persist) return true;
  try {
    persistOverlayFile();
  } catch (error) {
    log(`could not persist web UI password: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
  return true;
}

function checkWebuiPassword(input) {
  const password = String(input || '');
  if (!password) return false;
  if (process.env.FREE_ROUTER_WEBUI_PASSWORD) {
    return verifyPassword(password, process.env.FREE_ROUTER_WEBUI_PASSWORD);
  }
  return verifyPassword(password, storedWebuiPassword());
}

// One-time upgrade: replace a plaintext stored password with a salted hash.
// Runs at boot and after successful legacy logins (operators hand-editing
// the file between restarts converge on the next login either way).
function upgradePasswordStorage(reason) {
  if (process.env.FREE_ROUTER_WEBUI_PASSWORD) return;
  const stored = storedWebuiPassword();
  if (isPasswordHash(stored)) return;
  setStoredWebuiPassword(hashPassword(stored));
  log(`upgraded web UI password storage to salted scrypt hash (${reason})`);
}
// Login session TTL in hours (default 24, 0 = never expires).
const sessionTtlHours = () => {
  const raw = Number(config.webui?.sessionTtlHours ?? 24);
  return Number.isFinite(raw) && raw >= 0 ? raw : 24;
};
const webuiSessions = new Map();
function webuiSessionToken(req) {
  const cookie = String(req.headers.cookie || '');
  const match = cookie.match(/(?:^|;\s*)fr_session=([^;]+)/);
  return match ? decodeURIComponent(match[1]) : '';
}
function pruneWebuiSessions() {
  const now = Date.now();
  for (const [token, expiresAt] of webuiSessions) {
    if (expiresAt <= now) webuiSessions.delete(token);
  }
}
let secretRedactor = config.redactSecrets === false ? null : createSecretRedactor(redactorEnv());

// The redactor snapshots secrets at build time, so keys added through the
// UI would otherwise never be stripped from upstream payloads. Overlay-
// stored provider keys and gateway keys are not in process.env, so they are
// merged in under synthetic names the redactor recognises as secrets.
function redactorEnv() {
  const merged = { ...process.env };
  let index = 0;
  for (const provider of PROVIDERS.values()) {
    for (const entry of provider.apiKeys || []) {
      if (entry.key) merged[`FREE_ROUTER_TOML_${index}_API_KEY`] = entry.key;
      index += 1;
    }
  }
  for (const entry of gatewayKeys()) {
    if (entry.key) merged[`FREE_ROUTER_GATEWAY_${index}_TOKEN`] = entry.key;
    index += 1;
  }
  const admin = storedWebuiPassword();
  if (admin) merged.FREE_ROUTER_WEBUI_PASSWORD = admin;
  if (process.env.FREE_ROUTER_WEBUI_PASSWORD) {
    merged.FREE_ROUTER_WEBUI_PASSWORD = process.env.FREE_ROUTER_WEBUI_PASSWORD;
  }
  return merged;
}

function refreshSecretRedactor() {
  if (config.redactSecrets === false) return;
  secretRedactor = createSecretRedactor(redactorEnv());
}

// One-time legacy migration: on the first boot with no migration record,
// import provider keys found in the .env file into the overlay so
// config.local.json becomes the single place user data lives afterwards.
// Imported vars are removed from .env (their values already live in the
// overlay); the web UI shows a notice with what was moved.
function parseEnvAssignments(text) {
  const vars = new Map();
  for (const line of String(text || '').split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!match) continue;
    let value = match[2];
    if (value.length > 1 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
      value = value.slice(1, -1);
    }
    if (value) vars.set(match[1], value);
  }
  return vars;
}

function migrateEnvFileOnce() {
  if (config.migratedFromEnv) return;
  let envFileExisted = false;
  let fileVars = new Map();
  try {
    envFileExisted = fs.existsSync(UI_ENV_PATH);
    if (envFileExisted) fileVars = parseEnvAssignments(fs.readFileSync(UI_ENV_PATH, 'utf8'));
  } catch {
    fileVars = new Map();
  }
  const summary = { at: new Date().toISOString(), providers: {}, gateway: 0 };
  if (fileVars.size) {
    const clearVars = {};
    for (const provider of PROVIDERS.values()) {
      const fileKeys = (provider.apiKeys || []).filter((e) => e.source === 'file').map((e) => ({ name: e.name, key: e.key }));
      const have = new Set(fileKeys.map((e) => e.key));
      const fresh = [];
      const candidates = [
        { varName: provider.keyEnv, plural: false },
        { varName: `${provider.keyEnv}S`, plural: true },
        { varName: `${provider.keyEnv}_KEYS`, plural: true },
      ];
      for (const { varName, plural } of candidates) {
        const fileValue = fileVars.get(varName);
        if (!fileValue) continue;
        // The file wins when nothing else provides the var; otherwise only
        // migrate values the file actually contributed (a real environment
        // variable wins over the file and stays untouched).
        const effective = String(process.env[varName] || '');
        const fileValues = plural
          ? fileValue.split(',').map((s) => s.trim()).filter(Boolean)
          : [fileValue.trim()];
        const effectiveValues = plural
          ? effective.split(',').map((s) => s.trim()).filter(Boolean)
          : [effective.trim()].filter(Boolean);
        const values = effectiveValues.length
          ? effectiveValues.filter((v) => fileValues.includes(v))
          : [...fileValues];
        const usable = values.filter((v) => !have.has(v));
        for (const v of usable) {
          have.add(v);
          fresh.push(v);
        }
        if (usable.length) clearVars[varName] = '';
      }
      if (fresh.length) {
        const named = fresh.map((key, i) => ({ name: `migrated-${i + 1}`, key }));
        editableProviderRaw(provider.name);
        registry.setProviderKeys(provider.name, [...fileKeys, ...named]);
        summary.providers[provider.name] = fresh.length;
      }
    }
    // A personal gateway client key kept in .env becomes a named gateway key
    // (it stays in .env too, since local scripts like models.sh need it).
    const clientFileKey = fileVars.get('FREE_ROUTER_API_KEY') || '';
    const clientEffective = String(process.env.FREE_ROUTER_API_KEY || '');
    const clientKey = clientEffective || clientFileKey;
    if (clientKey && !gatewayKeys().length) {
      setOverlayValue(['gateway', 'keys'], [
        { name: 'migrated', key: clientKey, createdAt: new Date().toISOString() },
      ]);
      setOverlayValue(['gateway', 'requireAuth'], true);
      summary.gateway = 1;
    }
    if (Object.keys(clearVars).length && envFileExisted) {
      try {
        updateEnvFile(UI_ENV_PATH, clearVars);
        for (const name of Object.keys(clearVars)) delete process.env[name];
        for (const provider of PROVIDERS.values()) registry.refreshKeysFromEnv(provider.name);
      } catch (error) {
        log(`env migration: could not clean ${displayPath(UI_ENV_PATH)}: ${error instanceof Error ? error.message : String(error)}`);
      }
    } else if (Object.keys(clearVars).length) {
      // No .env file (e.g. docker env_file injects variables without one):
      // drop the migrated values from this process so TOML stays canonical.
      for (const name of Object.keys(clearVars)) delete process.env[name];
      for (const provider of PROVIDERS.values()) registry.refreshKeysFromEnv(provider.name);
    }
  }
  setOverlayValue(['migratedFromEnv'], summary);
  try {
    persistOverlayFile();
  } catch (error) {
    log(`env migration: could not persist config: ${error instanceof Error ? error.message : String(error)}`);
  }
  refreshSecretRedactor();
  const imported = Object.values(summary.providers).reduce((a, b) => a + b, 0);
  if (imported || summary.gateway) {
    log(`migrated ${imported} provider key(s) and ${summary.gateway} gateway key(s) from ${displayPath(UI_ENV_PATH)} into ${OVERLAY_FILENAME}; the overlay file is now where user data lives`);
  }
}

migrateEnvFileOnce();
upgradePasswordStorage('boot');

// Gateway (downstream) API keys: named client credentials for LAN access.
// Auth is required once at least one key exists (unless explicitly disabled).
function gatewayKeys() {
  const keys = config.gateway?.keys;
  return Array.isArray(keys) ? keys.filter((entry) => entry && entry.key) : [];
}

function gatewayAuthRequired() {
  if (config.gateway?.requireAuth === false && !gatewayKeys().length) return false;
  if (config.gateway?.requireAuth === true) return true;
  return gatewayKeys().length > 0;
}

function bearerKey(req) {
  const header = String(req.headers.authorization || '');
  const match = header.match(/^\s*Bearer\s+(.+?)\s*$/i);
  return match ? match[1] : '';
}

function gatewayClientName(req) {
  const key = bearerKey(req);
  if (!key) return '';
  return gatewayKeys().find((entry) => entry.key === key)?.name || '';
}

function gatewayGuardFailure(req) {
  if (!gatewayAuthRequired()) return '';
  if (gatewayClientName(req)) return '';
  return bearerKey(req) ? 'invalid API key' : 'missing API key (Authorization: Bearer <key>)';
}

const cooldowns = new Map();
const thoughtSignatures = createThoughtSignatureCache();
let discoveredModelIds = [];
let discoverySeenIds = [];
let discoveryRemovedIds = [];
let discoveryLastCheckedAt = 0;
let discoveryError = '';
let discoveryInFlight = null;
let modelEvaluations = {};
let discoveryExcludedIds = [];
let discoveryUnavailableIds = [];
// What providers told us about their own free tier, keyed by `provider:model`.
let modelVerdicts = {};
let lastSelection = null;
let usageByDay = {};
let stateSaveTimer = null;

function log(message, detail = undefined) {
  const prefix = `[${new Date().toISOString()}]`;
  if (detail === undefined) console.log(prefix, message);
  else console.log(prefix, message, detail);
}

function normalizeCandidate(entry) {
  if (typeof entry === 'string') return { provider: registry.defaultProvider, model: entry };
  if (entry && typeof entry === 'object') {
    return {
      provider: String(entry.provider || registry.defaultProvider),
      model: String(entry.model || entry.id || ''),
    };
  }
  return { provider: registry.defaultProvider, model: '' };
}

function candidateKey(candidate) {
  return `${candidate.provider}:${candidate.model}`;
}

function keySlug(key) {
  const separator = String(key).indexOf(':');
  return normalizeModelSlug(separator >= 0 ? key.slice(separator + 1) : key);
}

function candidateMetadata(candidate) {
  return registry.metadata(candidate);
}

// A negative verdict is worth acting on but not worth trusting forever: a
// provider blip would otherwise retire a model permanently with no way back.
// Positive verdicts need no expiry, since ordinary traffic revisits them and a
// later refusal overwrites them.
function verdictFor(key) {
  const verdict = modelVerdicts[key];
  if (!verdict) return null;
  if (verdict.free !== false) return verdict;
  const age = Date.now() - Date.parse(verdict.observedAt || 0);
  return Number.isFinite(age) && age > VERDICT_RETRY_MS ? null : verdict;
}

// What the provider itself told us outranks any local allowlist, in both
// directions: a list in config.json is only ever a guess about someone else's
// pricing, while a served request or a quota figure is a direct answer.
function candidateIsFree(candidate) {
  const verdict = verdictFor(candidateKey(candidate));
  if (verdict?.free === false) return false;
  if (verdict?.free === true) return Boolean(PROVIDERS.get(candidate.provider)?.apiKey);
  return registry.isFree(candidate);
}

function setModelVerdict(key, verdict) {
  const previous = modelVerdicts[key];
  const merged = {
    ...previous,
    ...verdict,
    observedAt: new Date().toISOString(),
  };
  if (previous?.free === merged.free && previous?.dailyRequestLimit === merged.dailyRequestLimit) {
    return;
  }
  modelVerdicts[key] = merged;
  scheduleStateSave();
}

// Models named in config.json, either in a route or a provider allowlist.
function configuredCandidateKeys() {
  const keys = new Set();
  for (const entries of Object.values(config.routes || {})) {
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) keys.add(candidateKey(normalizeCandidate(entry)));
  }
  for (const provider of PROVIDERS.values()) {
    for (const model of provider.freeModels) keys.add(`${provider.name}:${model}`);
  }
  return keys;
}

// Only the verdicts that contradict something asked for. A probe finding that
// some catalog model has no free tier is discovery working, not news: reporting
// every one of those buries the single case that needs attention, a model
// written into config.json that the provider will not serve for free.
function rejectedConfiguredModels() {
  const configured = configuredCandidateKeys();
  return Object.keys(modelVerdicts)
    .filter((key) => configured.has(key) && verdictFor(key)?.free === false)
    .sort()
    .map((key) => ({ key, reason: modelVerdicts[key].reason || '' }));
}

// The provider's own number beats the hand-written one in config.json.
function learnedDailyLimit(key) {
  const learned = Number(modelVerdicts[key]?.dailyRequestLimit);
  return Number.isFinite(learned) && learned > 0 ? learned : null;
}

function discoveredCandidate(id) {
  return registry.parsePrefixed(id) || { provider: registry.discoveryProvider, model: id };
}

// Narrow, domain-tuned models score well on a generic benchmark but are a poor
// default for general traffic. Returns a reason string, or '' to keep the model.
// Only applies to auto-discovered models; anything listed in config.json stays.
function discoveryExclusionReason(id) {
  for (const pattern of EXCLUDE_MODEL_PATTERNS) {
    if (pattern.test(id)) return `model id matches /${pattern.source}/`;
  }
  if (!EXCLUDE_TEXT_PATTERNS.length) return '';
  const model = candidateMetadata(discoveredCandidate(id));
  if (!model) return '';
  const text = `${model.name || ''} ${model.description || ''}`;
  for (const pattern of EXCLUDE_TEXT_PATTERNS) {
    if (pattern.test(text)) return `description matches /${pattern.source}/`;
  }
  return '';
}

// Combines what the last discovery run filtered out with anything currently
// tracked that the filter now rejects, so a pattern added between runs is
// visible immediately instead of only after the next collection.
function excludedModelIds() {
  const ids = new Set(discoveryExcludedIds);
  for (const id of discoveredModelIds) {
    if (discoveryExclusionReason(id)) ids.add(id);
  }
  return [...ids].sort();
}

function usageDay(at = Date.now()) {
  const date = new Date(at);
  if (USAGE_DAY_FORMATTER) return USAGE_DAY_FORMATTER.format(date);
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function usageDays() {
  const days = [];
  for (let offset = 0; offset < USAGE_RETENTION_DAYS; offset += 1) {
    days.push(usageDay(Date.now() - offset * 86400000));
  }
  return days;
}

function sanitizeUsage(raw) {
  const clean = {};
  if (!raw || typeof raw !== 'object') return clean;
  for (const [day, models] of Object.entries(raw)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !models || typeof models !== 'object') continue;
    const perModel = {};
    for (const [key, counts] of Object.entries(models)) {
      if (!counts || typeof counts !== 'object') continue;
      const bucket = {};
      for (const kind of USAGE_KINDS) {
        const value = Math.floor(Number(counts[kind]));
        if (Number.isFinite(value) && value > 0) bucket[kind] = value;
      }
      if (Object.keys(bucket).length) perModel[key] = bucket;
    }
    if (Object.keys(perModel).length) clean[day] = perModel;
  }
  return clean;
}

function pruneUsage() {
  const keep = new Set(usageDays());
  for (const day of Object.keys(usageByDay)) {
    if (!keep.has(day)) delete usageByDay[day];
  }
}

function recordUsage(candidate, kind) {
  const bucket = USAGE_KINDS.includes(kind) ? kind : 'other';
  const day = usageDay();
  const perDay = (usageByDay[day] ||= {});
  const counts = (perDay[candidateKey(candidate)] ||= {});
  counts[bucket] = (counts[bucket] || 0) + 1;
  pruneUsage();
  scheduleStateSave();
}

function dailyLimitFor(key) {
  // A limit the provider reported for itself is authoritative; the config
  // value is only a stand-in until the provider tells us the real one.
  const learned = learnedDailyLimit(key);
  if (learned) return learned;
  // Read live from config (not a startup snapshot) so UI edits apply at once.
  const limits = config.usage?.dailyLimits || {};
  const separator = String(key).indexOf(':');
  const provider = separator >= 0 ? key.slice(0, separator) : '';
  const model = separator >= 0 ? key.slice(separator + 1) : key;
  for (const lookup of [key, model, `${provider}:*`]) {
    const value = Number(limits[lookup]);
    if (Number.isFinite(value) && value > 0) return value;
  }
  return null;
}

function dailyLimitSource(key) {
  if (learnedDailyLimit(key)) return 'provider';
  return dailyLimitFor(key) ? 'config' : '';
}

function usageTotals(counts) {
  let ok = 0;
  let fail = 0;
  let aborted = 0;
  let consumed = 0;
  for (const [kind, raw] of Object.entries(counts || {})) {
    const amount = Number(raw) || 0;
    if (amount <= 0) continue;
    if (kind === 'ok') ok += amount;
    else if (kind === 'aborted') aborted += amount;
    else fail += amount;
    if (!USAGE_NON_CONSUMING.has(kind)) consumed += amount;
  }
  return { ok, fail, aborted, consumed, total: ok + fail + aborted };
}

function mergeUsage(target, counts) {
  for (const [kind, raw] of Object.entries(counts || {})) {
    const amount = Number(raw) || 0;
    if (amount > 0) target[kind] = (target[kind] || 0) + amount;
  }
  return target;
}

function usageForKey(key) {
  const days = usageDays();
  const todayCounts = usageByDay[days[0]]?.[key] || {};
  const windowCounts = {};
  for (const day of days) mergeUsage(windowCounts, usageByDay[day]?.[key]);
  const limit = dailyLimitFor(key);
  const today = usageTotals(todayCounts);
  return {
    today,
    window: usageTotals(windowCounts),
    dailyLimit: limit,
    dailyLimitSource: dailyLimitSource(key),
    remainingToday: limit === null ? null : Math.max(0, limit - today.consumed),
  };
}

function usageSummary() {
  const days = usageDays();
  const byModel = {};
  const byDay = days.map((day) => {
    const dayCounts = {};
    let topModel = null;
    for (const [key, counts] of Object.entries(usageByDay[day] || {})) {
      mergeUsage(dayCounts, counts);
      mergeUsage((byModel[key] ||= {}), counts);
      const totals = usageTotals(counts);
      if (!topModel || totals.ok > topModel.ok) topModel = { key, ok: totals.ok };
    }
    return { day, ...usageTotals(dayCounts), counts: dayCounts, topModel };
  });
  const models = Object.entries(byModel)
    .map(([key, counts]) => {
      const separator = key.indexOf(':');
      const limit = dailyLimitFor(key);
      const today = usageTotals(usageByDay[days[0]]?.[key] || {});
      return {
        key,
        provider: separator >= 0 ? key.slice(0, separator) : '',
        model: separator >= 0 ? key.slice(separator + 1) : key,
        ...usageTotals(counts),
        counts,
        dailyLimit: limit,
        dailyLimitSource: dailyLimitSource(key),
        today,
        remainingToday: limit === null ? null : Math.max(0, limit - today.consumed),
      };
    })
    .sort((a, b) => b.total - a.total || a.key.localeCompare(b.key));
  return {
    timezone: USAGE_TIMEZONE || Intl.DateTimeFormat().resolvedOptions().timeZone || 'local',
    retentionDays: USAGE_RETENTION_DAYS,
    today: days[0],
    days: byDay,
    models,
  };
}

function loadDiscoveryState() {
  if (!fs.existsSync(DISCOVERY_STATE_PATH)) return;
  try {
    const state = JSON.parse(fs.readFileSync(DISCOVERY_STATE_PATH, 'utf8'));
    usageByDay = sanitizeUsage(state.usage);
    pruneUsage();
    if (!discoveryEnabled) return;
    discoveredModelIds = Array.isArray(state.addedModels)
      ? state.addedModels.filter((id) => typeof id === 'string')
      : [];
    discoverySeenIds = Array.isArray(state.freeModels)
      ? state.freeModels.filter((id) => typeof id === 'string')
      : [];
    discoveryRemovedIds = Array.isArray(state.removedModels)
      ? state.removedModels.filter((id) => typeof id === 'string')
      : [];
    discoveryExcludedIds = Array.isArray(state.excludedModels)
      ? state.excludedModels.filter((id) => typeof id === 'string')
      : [];
    discoveryUnavailableIds = Array.isArray(state.unavailableModels)
      ? state.unavailableModels.filter((id) => typeof id === 'string')
      : [];
    modelVerdicts =
      state.modelVerdicts && typeof state.modelVerdicts === 'object' ? state.modelVerdicts : {};
    discoveryLastCheckedAt = Date.parse(state.lastCheckedAt || '') || 0;
    modelEvaluations =
      state.evaluations && typeof state.evaluations === 'object' ? state.evaluations : {};
    if (state.lastSelection && typeof state.lastSelection === 'object') {
      lastSelection = state.lastSelection;
    }
  } catch (error) {
    discoveryError = `state load failed: ${error instanceof Error ? error.message : String(error)}`;
    log(discoveryError);
  }
}

function saveDiscoveryState() {
  const payload = {
    lastCheckedAt: new Date(discoveryLastCheckedAt).toISOString(),
    route: DISCOVERY_ROUTE,
    freeModels: discoverySeenIds,
    addedModels: discoveredModelIds,
    removedModels: discoveryRemovedIds,
    excludedModels: discoveryExcludedIds,
    unavailableModels: discoveryUnavailableIds,
    modelVerdicts,
    evaluations: modelEvaluations,
    lastSelection,
    usage: usageByDay,
  };
  const temporaryPath = `${DISCOVERY_STATE_PATH}.${process.pid}.tmp`;
  fs.writeFileSync(temporaryPath, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o644 });
  fs.renameSync(temporaryPath, DISCOVERY_STATE_PATH);
}

function flushStateSave() {
  if (stateSaveTimer) {
    clearTimeout(stateSaveTimer);
    stateSaveTimer = null;
  }
  try {
    saveDiscoveryState();
  } catch (error) {
    log(`failed to persist router state: ${error instanceof Error ? error.message : String(error)}`);
  }
}

// Every request touches the counters, so batch writes instead of rewriting the
// state file once per attempt.
function scheduleStateSave(delayMs = 1500) {
  if (stateSaveTimer) return;
  stateSaveTimer = setTimeout(() => {
    stateSaveTimer = null;
    flushStateSave();
  }, delayMs);
  stateSaveTimer.unref?.();
}

function rememberSelection(selection) {
  lastSelection = selection;
  scheduleStateSave();
}

// A manual override in `baselineScores`, keyed by `provider:model` or by the
// bare model ID. Applies to discovered models too, not just configured ones.
function explicitScore(key) {
  const modelId = String(key).includes(':') ? key.slice(key.indexOf(':') + 1) : key;
  const explicit = Number(
    evaluationConfig.baselineScores?.[key] ?? evaluationConfig.baselineScores?.[modelId],
  );
  return Number.isFinite(explicit) ? explicit : null;
}

function configuredScore(id, configuredIndex) {
  const explicit = explicitScore(id);
  if (explicit !== null) return explicit;
  return Math.max(30, 94 - Math.max(0, configuredIndex - 1) * 4);
}

// Observed reliability nudges a model up or down once it has served enough
// traffic to be more trustworthy than a single one-shot evaluation.
function usageAdjustment(key) {
  if (!RANK_USAGE_WEIGHT) return 0;
  const counts = {};
  for (const day of usageDays()) mergeUsage(counts, usageByDay[day]?.[key]);
  const totals = usageTotals(counts);
  const attempts = totals.ok + totals.fail;
  if (attempts < RANK_USAGE_MIN_REQUESTS) return 0;
  const successRate = totals.ok / attempts;
  const scaled = ((successRate - 0.8) / 0.2) * RANK_USAGE_WEIGHT;
  const clamped = Math.max(-RANK_USAGE_WEIGHT, Math.min(RANK_USAGE_WEIGHT, scaled));
  return Math.round(clamped * 10) / 10;
}

function baseModelScore(key, configured, configuredIndex) {
  const slug = keySlug(key);
  const modelId = key.includes(':') ? key.slice(key.indexOf(':') + 1) : key;
  if (PINNED_MODELS.has(key) || PINNED_MODELS.has(modelId)) return Number.POSITIVE_INFINITY;
  if (configured.has(key)) return configuredScore(key, configuredIndex.get(key));
  for (const [configuredKey, index] of configuredIndex) {
    if (keySlug(configuredKey) === slug) return configuredScore(configuredKey, index);
  }
  const explicit = explicitScore(key);
  if (explicit !== null) return explicit;
  const evaluated = Number(modelEvaluations[modelId]?.score);
  return Number.isFinite(evaluated) ? evaluated : -1;
}

function rankedModelScore(key, configured, configuredIndex) {
  const base = baseModelScore(key, configured, configuredIndex);
  if (!Number.isFinite(base) || base < 0) return base;
  return Math.round((base + usageAdjustment(key)) * 10) / 10;
}

function scoreSourceFor(key, configured) {
  if (configured.has(key)) return 'baseline';
  const slug = keySlug(key);
  for (const configuredKey of configured) {
    if (keySlug(configuredKey) === slug) return 'baseline';
  }
  return 'evaluation';
}

function groupRank(group, configuredSet, configuredIndex) {
  let pinned = false;
  let pinIndex = Number.POSITIVE_INFINITY;
  let configuredIdx = Number.POSITIVE_INFINITY;
  let configuredKey = '';
  let evalScore = -1;
  let explicit = null;
  for (const { candidate, originalIndex } of group.members) {
    const key = candidateKey(candidate);
    if (PINNED_MODELS.has(key) || PINNED_MODELS.has(candidate.model)) {
      pinned = true;
      pinIndex = Math.min(pinIndex, originalIndex);
    }
    if (configuredSet.has(key) && configuredIndex.get(key) < configuredIdx) {
      configuredIdx = configuredIndex.get(key);
      configuredKey = key;
    }
    const override = explicitScore(key);
    if (override !== null && (explicit === null || override > explicit)) explicit = override;
    const evaluated = Number(modelEvaluations[candidate.model]?.score);
    if (Number.isFinite(evaluated)) evalScore = Math.max(evalScore, evaluated);
  }
  for (const [key, index] of configuredIndex) {
    if (keySlug(key) !== group.slug || index >= configuredIdx) continue;
    configuredIdx = index;
    configuredKey = key;
  }
  const base = pinned
    ? Number.POSITIVE_INFINITY
    : configuredIdx !== Number.POSITIVE_INFINITY
      ? configuredScore(configuredKey, configuredIdx)
      : explicit !== null
        ? explicit
        : evalScore;
  let score = base;
  if (!pinned && Number.isFinite(base) && base >= 0) {
    const adjustments = group.members.map(({ candidate }) =>
      usageAdjustment(candidateKey(candidate)),
    );
    score = base + (adjustments.length ? Math.max(...adjustments) : 0);
  }
  return { pinned, score, tie: pinned ? pinIndex : group.firstIndex };
}

function orderByModelThenProvider(candidates, configuredSet, configuredIndex) {
  // Rank each route entry on its own: group by `provider:model` so an
  // unpinned variant of a model does not inherit the pinned status or score
  // of a differently-cased or differently-provider variant.
  const groups = new Map();
  candidates.forEach((candidate, originalIndex) => {
    const key = candidateKey(candidate);
    let group = groups.get(key);
    if (!group) {
      group = { slug: normalizeModelSlug(candidate.model) || key, members: [], firstIndex: originalIndex };
      groups.set(key, group);
    }
    group.members.push({ candidate, originalIndex });
  });
  const ranked = [...groups.values()].sort((left, right) => {
    const a = groupRank(left, configuredSet, configuredIndex);
    const b = groupRank(right, configuredSet, configuredIndex);
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    if (a.pinned) return a.tie - b.tie;
    return b.score - a.score || a.tie - b.tie;
  });
  const expanded = [];
  const present = new Set();
  const expandedSlugs = new Set();
  // Variants that are already candidates rank on their own group, so the
  // expansion only adds genuinely new same-model offerings.
  const candidateKeys = new Set(candidates.map(candidateKey));
  const emit = (candidate) => {
    const key = candidateKey(candidate);
    if (present.has(key)) return;
    present.add(key);
    expanded.push(candidate);
  };
  for (const group of ranked) {
    for (const { candidate } of group.members.sort((a, b) => a.originalIndex - b.originalIndex)) {
      emit(candidate);
    }
    // Same-model offerings from other providers are offered once per model
    // slug, at the position of the highest-ranked variant of that model.
    if (expandedSlugs.has(group.slug)) continue;
    expandedSlugs.add(group.slug);
    for (const offering of registry.offeringsForSlug(group.slug)) {
      if (candidateKeys.has(candidateKey(offering))) continue;
      emit(offering);
    }
  }
  return expanded;
}

function routeCandidates(routeName) {
  const configured = config.routes?.[routeName];
  if (!configured) return null;
  const normalizedConfigured = configured.map(normalizeCandidate).filter((candidate) => candidate.model);
  const activeConfigured = normalizedConfigured.filter(candidateIsFree);
  const configuredKeys = normalizedConfigured.map(candidateKey);
  const configuredSet = new Set(configuredKeys);
  const configuredIndex = new Map(configuredKeys.map((key, index) => [key, index]));
  if (!discoveryEnabled || routeName !== DISCOVERY_ROUTE) {
    return orderByModelThenProvider(activeConfigured, configuredSet, configuredIndex);
  }

  const candidates = [...activeConfigured];
  const present = new Set(candidates.map(candidateKey));
  for (const id of discoveredModelIds) {
    if (discoveryExclusionReason(id)) continue;
    const candidate = discoveredCandidate(id);
    if (verdictFor(candidateKey(candidate))?.free === false) continue;
    if (present.has(candidateKey(candidate))) continue;
    const model = candidateMetadata(candidate);
    const provider = PROVIDERS.get(candidate.provider);
    if (provider?.catalogHasPricing && provider.catalog.size && (!model || !isZeroCost(model))) {
      continue;
    }
    candidates.push(candidate);
    present.add(candidateKey(candidate));
  }
  return orderByModelThenProvider(candidates, configuredSet, configuredIndex);
}

// Providers without published prices cannot offer new models safely, but their
// catalog still says what they stopped offering. Recomputed on every catalog
// refresh rather than once per discovery run, because routing already drops a
// missing model as soon as the catalog updates; recording it only every
// `discovery.intervalMs` would leave the log two days behind the behaviour.
function syncModelAvailability() {
  const current = registry.unavailableFreeModels();
  const gone = current.filter((id) => !discoveryUnavailableIds.includes(id));
  const restored = discoveryUnavailableIds.filter((id) => !current.includes(id));
  if (!gone.length && !restored.length) return;
  discoveryUnavailableIds = current;
  if (gone.length) log(`no longer offered upstream; skipped in routes`, gone);
  if (restored.length) log(`offered upstream again; restored to routes`, restored);
  scheduleStateSave();
}

async function refreshCatalog(force = false) {
  await registry.refreshCatalogs(force, catalogRefreshMs, log);
  syncModelAvailability();
}

function evaluationText(payload) {
  const content = payload?.choices?.[0]?.message?.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => (typeof part === 'string' ? part : part?.text || ''))
    .join('');
}

function parseEvaluationAnswers(text) {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

function metadataScore(model) {
  const supported = new Set(model?.supported_parameters || []);
  const contextLength = Number(model?.context_length || 0);
  const createdMs = Number(model?.created || 0) * 1000;
  let score = 0;
  if (supported.has('tools')) score += 6;
  if (supported.has('response_format') || supported.has('structured_outputs')) score += 4;
  score += Math.min(6, Math.max(0, Math.log2(Math.max(4096, contextLength) / 4096)));
  if ((model?.architecture?.input_modalities || ['text']).includes('text')) score += 2;
  if (createdMs && Date.now() - createdMs <= 180 * 24 * 60 * 60 * 1000) score += 2;
  return Math.round(score * 10) / 10;
}

async function evaluateModel(target) {
  const startedAt = Date.now();
  const candidate =
    typeof target === 'string'
      ? { provider: registry.discoveryProvider, model: target }
      : target;
  const model = candidateMetadata(candidate);
  const supported = new Set(model?.supported_parameters || []);
  const evaluationBody = {
    messages: [
      {
        role: 'user',
        content:
          'Return ONLY one JSON object with keys token, crt, trace, path, sequence, binary, ' +
          'derange, recur, modpow. ' +
          'No markdown and no explanation. token must be "OX-RANK-7". ' +
          'crt: smallest positive integer n where n%7=3, n%11=5, n%13=9. ' +
          'trace: output of JavaScript: let a=[1,2,3,4]; for(let i=0;i<a.length;i++){if(a[i]%2===0)a.splice(i,1)} console.log(a.join("-")). ' +
          'path: shortest distance A to E for undirected edges A-B:4,A-C:2,C-B:1,B-D:5,C-D:8,C-E:10,D-E:2. ' +
          'sequence: next number after 2,6,12,20,30. ' +
          'binary: number of binary strings of length 8 with no consecutive ones. ' +
          'derange: number of permutations of 1,2,3,4,5 where no value stays in its own position. ' +
          'recur: a(1)=1, and for n>1 a(n)=a(n-1)+n when n is even else a(n-1)*2; give a(6). ' +
          'modpow: 7^222 mod 100.',
      },
    ],
    temperature: 0,
    max_tokens: EVALUATION_MAX_TOKENS,
  };
  if (supported.has('reasoning') || supported.has('reasoning_effort')) {
    evaluationBody.reasoning = { effort: 'low' };
  }
  const result = await attemptJson(candidate, evaluationBody);
  const latencyMs = Date.now() - startedAt;
  recordUsage(candidate, result.ok ? 'ok' : result.kind || 'other');
  if (!result.ok) {
    // The refusal is the useful part when probing: it says whether the model is
    // offered for free at all, which no catalog on a price-free provider does.
    applyProviderVerdict(candidate, result);
    return {
      status: 'pending',
      version: EVALUATION_VERSION,
      attemptedAt: new Date().toISOString(),
      latencyMs,
      error: `${result.status} ${result.reason}`.slice(0, 300),
    };
  }
  // Serving the request is itself the proof, on a key with no billing.
  if (!PROVIDERS.get(candidate.provider)?.catalogHasPricing) {
    setModelVerdict(candidateKey(candidate), {
      free: true,
      reason: 'served a free-tier request',
    });
  }

  // Weights total 65 so scores stay on the same scale as the configured
  // baseline anchors. The last three items carry most of the discrimination;
  // the earlier ones are saturated by every competent model.
  const answers = parseEvaluationAnswers(evaluationText(result.payload));
  let benchmarkScore = 0;
  if (answers) benchmarkScore += 3;
  if (answers?.token === 'OX-RANK-7') benchmarkScore += 2;
  if (Number(answers?.crt) === 269) benchmarkScore += 8;
  if (String(answers?.trace) === '1-3') benchmarkScore += 8;
  if (Number(answers?.path) === 10) benchmarkScore += 6;
  if (Number(answers?.sequence) === 42) benchmarkScore += 4;
  if (Number(answers?.binary) === 55) benchmarkScore += 6;
  if (Number(answers?.derange) === 44) benchmarkScore += 10;
  if (Number(answers?.recur) === 26) benchmarkScore += 10;
  if (Number(answers?.modpow) === 49) benchmarkScore += 8;

  const modelMetadataScore = metadataScore(candidateMetadata(candidate));
  // Deliberately small: this is a single cold sample and used to swing the
  // ranking more than any capability signal did.
  const latencyScore = latencyMs <= 5000 ? 6 : latencyMs <= 15000 ? 4 : latencyMs <= 30000 ? 2 : 0;
  const score = Math.round((benchmarkScore + modelMetadataScore + latencyScore) * 10) / 10;
  return {
    status: 'scored',
    version: EVALUATION_VERSION,
    evaluatedAt: new Date().toISOString(),
    score,
    benchmarkScore,
    metadataScore: modelMetadataScore,
    latencyScore,
    latencyMs,
  };
}

// For a provider that publishes no prices, the only way to learn whether a
// model is free is to ask it. One request per candidate, verdict cached
// forever, so the cost is paid once per model rather than once per run.
async function probeFreeTierCandidates() {
  const configuredRoute = (config.routes?.[DISCOVERY_ROUTE] || []).map(normalizeCandidate);
  let budget = EVALUATION_MAX_PER_RUN;

  for (const provider of PROVIDERS.values()) {
    if (!provider.probeFreeTier || !provider.apiKey || !provider.catalog?.size) continue;

    const known = new Set(
      [
        ...provider.freeModels,
        ...configuredRoute
          .filter((candidate) => candidate.provider === provider.name)
          .map((candidate) => candidate.model),
        ...discoveredModelIds.map((id) => discoveredCandidate(id).model),
      ].map(normalizeModelSlug),
    );

    const candidates = [];
    for (const model of provider.catalog.values()) {
      if (budget <= 0) break;
      // Compared by slug, because a catalog id and the id used for chat need
      // not match character for character. Raw string comparison re-probes
      // models that are already routed and adds a duplicate entry for them.
      if (known.has(normalizeModelSlug(model.id))) continue;
      // Already answered: no second request until that answer goes stale.
      if (verdictFor(`${provider.name}:${model.id}`)) continue;
      if (!isChatModel(model)) continue;
      const reason = discoveryExclusionReason(`${provider.name}:${model.id}`);
      if (reason) continue;
      candidates.push(model.id);
      budget -= 1;
    }
    if (!candidates.length) continue;

    log(`probing ${candidates.length} ${provider.name} model(s) for free-tier access`, candidates);
    for (const model of candidates) {
      const candidate = { provider: provider.name, model };
      const key = candidateKey(candidate);
      const evaluation = await evaluateModel(candidate);
      if (modelVerdicts[key]?.free === false) continue;
      if (evaluation.status !== 'scored') {
        log(`probe inconclusive for ${key}: ${evaluation.error}`);
        continue;
      }
      modelEvaluations[model] = evaluation;
      if (!discoveredModelIds.includes(key)) discoveredModelIds.push(key);
      log(`${key} is free: score ${evaluation.score}`);
      saveDiscoveryState();
    }
  }
}

async function performFreeModelDiscovery(forceCatalogRefresh = false) {
  if (!discoveryEnabled) return;
  if (
    discoveryLastCheckedAt &&
    Date.now() - discoveryLastCheckedAt < DISCOVERY_INTERVAL_MS
  ) {
    return;
  }

  try {
    if (forceCatalogRefresh || !registry.discoveryCatalog()?.catalog.size) {
      await refreshCatalog(true);
    }
    const catalogProvider = registry.discoveryCatalog();
    const catalog = catalogProvider?.catalog || new Map();
    if (!catalog.size || catalogProvider?.catalogError) {
      throw new Error(catalogProvider?.catalogError || 'catalog is empty');
    }

    const configured = config.routes?.[DISCOVERY_ROUTE];
    if (!Array.isArray(configured)) {
      throw new Error(`discovery route does not exist: ${DISCOVERY_ROUTE}`);
    }
    const configuredCatalogIds = configured
      .map(normalizeCandidate)
      .filter((candidate) => candidate.provider === registry.discoveryProvider)
      .map((candidate) => candidate.model);

    const freeIds = [...catalog.values()]
      .filter((model) => isZeroCost(model) && isChatModel(model))
      .map((model) => model.id)
      .filter((id) => typeof id === 'string' && id)
      .sort();
    const eligible = new Set(freeIds);
    // Configured models are exempt: an explicit config entry beats the filter.
    const configuredCatalogSet = new Set(configuredCatalogIds);
    const excluded = new Map();
    for (const id of freeIds) {
      if (configuredCatalogSet.has(id)) continue;
      const reason = discoveryExclusionReason(id);
      if (reason) excluded.set(id, reason);
    }
    discoveryExcludedIds = [...excluded.keys()];
    if (excluded.size) {
      log(
        `excluding ${excluded.size} domain-specific model(s) from ${DISCOVERY_ROUTE}`,
        [...excluded].map(([id, reason]) => `${id} (${reason})`),
      );
    }

    // `eligible` is this one catalog's zero-cost list, so it can only judge
    // this catalog's models. Entries discovered by probing another provider are
    // governed by that provider's verdict and must survive this pass untouched.
    const fromCatalogProvider = (id) =>
      discoveredCandidate(id).provider === registry.discoveryProvider;
    const catalogDiscovered = discoveredModelIds.filter(fromCatalogProvider);
    const allRouted = [...new Set([...configuredCatalogIds, ...catalogDiscovered])];
    discoveryRemovedIds = allRouted.filter((id) => !eligible.has(id));
    discoveredModelIds = discoveredModelIds.filter(
      (id) => !fromCatalogProvider(id) || (eligible.has(id) && !excluded.has(id)),
    );
    if (discoveryRemovedIds.length) {
      log(
        `removed ${discoveryRemovedIds.length} non-free or unavailable model(s) from active routes`,
        discoveryRemovedIds,
      );
    }
    const routed = new Set([...configuredCatalogIds, ...catalogDiscovered]);
    const knownSlugs = new Set(
      [
        ...configured.map(normalizeCandidate).map((candidate) => normalizeModelSlug(candidate.model)),
        ...catalogDiscovered.map((id) => normalizeModelSlug(id)),
      ].filter(Boolean),
    );
    const additions = freeIds.filter(
      (id) => !routed.has(id) && !knownSlugs.has(normalizeModelSlug(id)) && !excluded.has(id),
    );
    if (additions.length) {
      discoveredModelIds.push(...additions);
      log(`discovered ${additions.length} free model(s); evaluating for ${DISCOVERY_ROUTE}`, additions);
    } else {
      log(`free-model discovery complete: no additions for ${DISCOVERY_ROUTE}`);
    }

    // A model whose one evaluation attempt failed used to keep score -1 forever,
    // because it was already in discoveredModelIds and so never reappeared in
    // `additions`. Retry those, plus anything scored on an older benchmark.
    const addedSet = new Set(additions);
    // Scores are keyed by bare model id, since a benchmark result describes the
    // model rather than the provider serving it, while route entries may carry
    // a `provider:` prefix once more than one provider contributes models.
    const stale = discoveredModelIds.filter((id) => {
      if (addedSet.has(id)) return false;
      const evaluation = modelEvaluations[discoveredCandidate(id).model];
      return evaluation?.status !== 'scored' || evaluation.version !== EVALUATION_VERSION;
    });
    const toEvaluate = [...additions, ...stale].slice(0, EVALUATION_MAX_PER_RUN);
    if (evaluationEnabled && toEvaluate.length) {
      if (stale.length) {
        log(`re-evaluating ${stale.length} model(s) with missing or outdated scores`, stale);
      }
      for (const id of toEvaluate) {
        const candidate = discoveredCandidate(id);
        log(`evaluating ${addedSet.has(id) ? 'newly discovered' : 'stale'} model ${id}`);
        const evaluation = await evaluateModel(candidate);
        modelEvaluations[candidate.model] = evaluation;
        if (evaluation.status === 'scored') {
          log(`evaluated ${id}: score ${evaluation.score}`);
        } else {
          log(`evaluation deferred for ${id}: ${evaluation.error}`);
        }
        saveDiscoveryState();
      }
    }

    discoverySeenIds = freeIds;
    discoveryError = '';
  } catch (error) {
    discoveryError = error instanceof Error ? error.message : String(error);
    log(`free-model discovery failed: ${discoveryError}`);
  }

  // Runs regardless of the priced catalog's outcome, since it depends on a
  // different provider and a failure there says nothing about this.
  if (evaluationEnabled) {
    try {
      await probeFreeTierCandidates();
    } catch (error) {
      log(`free-tier probing failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // Timestamped once the whole run is over, so the interval measures complete
  // runs and an observer waiting on it cannot see a half-finished one.
  discoveryLastCheckedAt = Date.now();
  saveDiscoveryState();
}

function discoverFreeModels(forceCatalogRefresh = false) {
  if (discoveryInFlight) return discoveryInFlight;
  discoveryInFlight = performFreeModelDiscovery(forceCatalogRefresh).finally(() => {
    discoveryInFlight = null;
  });
  return discoveryInFlight;
}

function scheduleNextDiscovery() {
  if (!discoveryEnabled) return;
  const elapsed = discoveryLastCheckedAt ? Date.now() - discoveryLastCheckedAt : 0;
  const delay = discoveryLastCheckedAt
    ? Math.max(1000, DISCOVERY_INTERVAL_MS - elapsed)
    : Math.min(DISCOVERY_INTERVAL_MS, 60 * 60 * 1000);
  const timer = setTimeout(async () => {
    await discoverFreeModels(true);
    scheduleNextDiscovery();
  }, delay);
  timer.unref();
}

loadDiscoveryState();

function requestNeeds(body) {
  const modalities = new Set();
  let hasImages = false;
  let hasVideo = false;
  for (const message of body.messages || []) {
    if (!Array.isArray(message?.content)) continue;
    for (const part of message.content) {
      if (part?.type === 'image_url' || part?.type === 'input_image') hasImages = true;
      if (part?.type === 'video_url' || part?.type === 'input_video') hasVideo = true;
    }
  }
  if (hasImages) modalities.add('image');
  if (hasVideo) modalities.add('video');
  return {
    tools: Array.isArray(body.tools) && body.tools.length > 0,
    responseFormat: Boolean(body.response_format),
    modalities,
  };
}

function cooldownKey(candidate, slot) {
  const base = candidateKey(candidate);
  if (slot === undefined || slot === null) return base;
  const suffix = typeof slot === 'object' ? (slot.index ?? slot.name ?? '') : slot;
  return `${base}#${suffix}`;
}

function cooldownRemaining(candidate, slot) {
  const entry = cooldowns.get(cooldownKey(candidate, slot));
  if (!entry) {
    // Legacy entries predate per-key cooldowns; still honour them.
    if (slot !== undefined && slot !== null) {
      const legacy = cooldowns.get(candidateKey(candidate));
      if (legacy && legacy.until > Date.now()) return legacy.until - Date.now();
    }
    return 0;
  }
  const remaining = entry.until - Date.now();
  if (remaining <= 0) {
    cooldowns.delete(cooldownKey(candidate, slot));
    return 0;
  }
  return remaining;
}

function setCooldown(candidate, kind, reason, overrideMs = 0, slot = null) {
  const durations = config.cooldownMs || {};
  const duration = overrideMs || Number(durations[kind] || 0);
  if (!duration) return;
  cooldowns.set(cooldownKey(candidate, slot), {
    until: Date.now() + duration,
    kind,
    reason: String(reason || '').slice(0, 300),
  });
}

// A provider that explains its own refusal is worth listening to. Turns one
// failed attempt into three separate decisions: how long to wait, whether the
// model is free at all, and what its real daily allowance is.
function applyProviderVerdict(candidate, result) {
  const key = candidateKey(candidate);
  const body = result.errorBody;
  if (!body) return 0;

  const permanent = permanentRejection(result.status, body);
  if (permanent) {
    setModelVerdict(key, { free: false, reason: permanent });
    log(`excluding ${key}: ${permanent}`);
    return 0;
  }

  const quota = parseQuotaFailure(body);
  if (!quota) return 0;

  if (quota.noFreeTier) {
    // Every free-tier allowance is zero, so no amount of waiting helps.
    setModelVerdict(key, { free: false, reason: 'no free-tier allowance (limit 0)' });
    log(`excluding ${key}: provider reports no free-tier quota`);
    return 0;
  }

  // The allowance exists, which is itself proof the model is free.
  const verdict = { free: true, reason: 'free-tier quota reported by provider' };
  if (quota.dailyRequestLimit) verdict.dailyRequestLimit = quota.dailyRequestLimit;
  setModelVerdict(key, verdict);

  if (quota.exhaustedWindow === 'day') {
    const wait = msUntilQuotaReset(Date.now(), USAGE_TIMEZONE || 'America/Los_Angeles');
    log(`${key} spent its daily free quota; waiting ${Math.round(wait / 60000)}m for reset`);
    return wait;
  }
  return quota.retryDelayMs;
}

function candidateModels(requestedModel, body) {
  const configured = routeCandidates(requestedModel);
  return filterCandidates(configured || registry.directCandidates(requestedModel), body, requestedModel);
}

function filterCandidates(configured, body, requestedModel) {
  const needs = requestNeeds(body);
  const active = [];
  const skipped = [];
  for (const candidate of configured) {
    const model = candidateMetadata(candidate);
    if (!candidateIsFree(candidate)) {
      skipped.push({ model: candidateKey(candidate), reason: 'not currently zero-cost or missing key' });
      continue;
    }
    if (!supportsRequest(model, needs)) {
      skipped.push({ model: candidateKey(candidate), reason: 'missing requested capability' });
      continue;
    }
    const slots = registry.keySlots(candidate.provider);
    const remaining = slots.length
      ? Math.min(...slots.map((slot) => cooldownRemaining(candidate, slot)))
      : cooldownRemaining(candidate);
    if (remaining > 0) {
      skipped.push({
        model: candidateKey(candidate),
        reason: `cooldown ${Math.ceil(remaining / 1000)}s`,
      });
      continue;
    }
    active.push(candidate);
  }

  // If every compatible model is cooling down, retry them in order instead of
  // turning a temporary cooldown into a hard outage.
  if (!active.length) {
    for (const candidate of configured) {
      if (
        candidateIsFree(candidate) &&
        supportsRequest(candidateMetadata(candidate), needs)
      ) {
        active.push(candidate);
      }
    }
  }

  if (skipped.length) log(`${requestedModel}: skipped ${skipped.length} candidate(s)`, skipped);
  return active;
}

function sanitizeUpstreamBody(body, candidate) {
  const upstream = JSON.parse(
    JSON.stringify({
      ...body,
      model: candidate.model,
    }),
  );
  delete upstream.models;
  delete upstream.route;
  if (providerNeedsThoughtSignatures(PROVIDERS.get(candidate.provider))) {
    injectThoughtSignatures(upstream, thoughtSignatures);
  }
  if (!secretRedactor) return upstream;
  const { value, count } = secretRedactor.redact(upstream);
  if (count) log(`redacted ${count} secret occurrence(s) before upstream`);
  return value;
}

function rememberGeminiSignatures(candidate, payload) {
  if (!providerNeedsThoughtSignatures(PROVIDERS.get(candidate.provider))) return;
  rememberSignaturesFromPayload(payload, thoughtSignatures);
}

function geminiStreamExtractor(candidate) {
  if (!providerNeedsThoughtSignatures(PROVIDERS.get(candidate.provider))) return null;
  return createStreamSignatureExtractor((id, signature) => {
    thoughtSignatures.remember(id, signature);
  });
}

function usefulMessage(payload) {
  const choice = payload?.choices?.[0];
  const message = choice?.message;
  if (!message) return false;
  if (Array.isArray(message.tool_calls) && message.tool_calls.length) return true;
  if (typeof message.content === 'string' && message.content.trim()) return true;
  if (Array.isArray(message.content) && message.content.length) {
    return message.content.some((part) => {
      if (typeof part === 'string') return part.trim();
      return typeof part?.text === 'string' && part.text.trim();
    });
  }
  return false;
}

function usefulDelta(payload) {
  const delta = payload?.choices?.[0]?.delta;
  if (!delta) return false;
  if (Array.isArray(delta.tool_calls) && delta.tool_calls.length) return true;
  if (typeof delta.content === 'string' && delta.content.length) return true;
  if (Array.isArray(delta.content) && delta.content.length) return true;
  return false;
}

function classifyFailure(status, message, timedOut = false) {
  if (timedOut) return 'timeout';
  if (status === 429) return 'rateLimit';
  if (status === 404) return 'notFound';
  if (status === 403) return 'forbidden';
  if (status >= 500) return 'serverError';
  if (/empty|reasoning only|no useful/i.test(message)) return 'empty';
  return '';
}

// Gemini's OpenAI-compatible layer returns errors wrapped in a single-element
// array, so an `error.message` lookup finds nothing and the real reason is lost.
function parseErrorPayload(raw) {
  try {
    const parsed = JSON.parse(raw);
    return (Array.isArray(parsed) ? parsed[0] : parsed) ?? null;
  } catch {
    return null;
  }
}

function errorSummary(status, raw) {
  const parsed = parseErrorPayload(raw);
  if (!parsed) return raw.trim().slice(0, 500) || `HTTP ${status}`;
  return (
    parsed?.error?.metadata?.raw ||
    parsed?.error?.message ||
    parsed?.message ||
    `HTTP ${status}`
  );
}

async function fetchModel(candidate, body, clientSignal, slot) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('attempt timeout')), attemptTimeoutMs);
  const abortFromClient = () => controller.abort(new Error('client disconnected'));
  clientSignal?.addEventListener('abort', abortFromClient, { once: true });
  const cleanup = () => {
    clearTimeout(timer);
    clientSignal?.removeEventListener('abort', abortFromClient);
  };
  try {
    const provider = PROVIDERS.get(candidate.provider);
    const key = slot?.key ?? provider?.apiKey;
    if (!provider?.baseUrl || !key) {
      throw new Error(`provider ${candidate.provider} is not configured`);
    }
    const response = await fetch(registry.chatUrl(candidate.provider), {
      method: 'POST',
      headers: registry.headers(candidate.provider, key),
      body: JSON.stringify(sanitizeUpstreamBody(body, candidate)),
      signal: controller.signal,
    });
    return { response, cleanup };
  } catch (error) {
    cleanup();
    throw error;
  }
}

async function attemptJson(candidate, body, clientSignal, slot) {
  let response;
  let cleanup = () => {};
  try {
    ({ response, cleanup } = await fetchModel(
      candidate,
      { ...body, stream: false },
      clientSignal,
      slot,
    ));
  } catch (error) {
    const timedOut = error?.name === 'AbortError' || /timeout/i.test(String(error));
    return {
      ok: false,
      status: timedOut ? 504 : 502,
      reason: timedOut ? 'attempt timeout' : String(error),
      kind: classifyFailure(0, String(error), timedOut),
    };
  }
  let raw;
  try {
    raw = await response.text();
  } catch (error) {
    const timedOut = error?.name === 'AbortError' || /timeout/i.test(String(error));
    cleanup();
    return {
      ok: false,
      status: timedOut ? 504 : 502,
      reason: timedOut ? 'attempt timeout' : String(error),
      kind: classifyFailure(0, String(error), timedOut),
    };
  }
  cleanup();
  if (!response.ok) {
    const reason = errorSummary(response.status, raw);
    return {
      ok: false,
      status: response.status,
      reason,
      kind: classifyFailure(response.status, reason),
      fatal: response.status === 401,
      // Kept so the caller can read what the provider said about its own
      // quotas instead of only seeing a status code.
      errorBody: parseErrorPayload(raw),
    };
  }
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    return { ok: false, status: 502, reason: 'invalid JSON response', kind: 'serverError' };
  }
  if (!usefulMessage(payload)) {
    const finish = payload?.choices?.[0]?.finish_reason || 'unknown';
    return {
      ok: false,
      status: 502,
      reason: `no useful content or tool call (finish_reason=${finish})`,
      kind: 'empty',
    };
  }
  rememberGeminiSignatures(candidate, payload);
  return {
    ok: true,
    payload,
    contentType: response.headers.get('content-type') || 'application/json',
  };
}

async function attemptStream(candidate, body, res, clientSignal, slot) {
  let response;
  let cleanup = () => {};
  try {
    ({ response, cleanup } = await fetchModel(
      candidate,
      { ...body, stream: true },
      clientSignal,
      slot,
    ));
  } catch (error) {
    const timedOut = error?.name === 'AbortError' || /timeout/i.test(String(error));
    return {
      ok: false,
      status: timedOut ? 504 : 502,
      reason: timedOut ? 'attempt timeout' : String(error),
      kind: classifyFailure(0, String(error), timedOut),
    };
  }

  if (!response.ok) {
    let raw;
    try {
      raw = await response.text();
    } finally {
      cleanup();
    }
    const reason = errorSummary(response.status, raw);
    return {
      ok: false,
      status: response.status,
      reason,
      kind: classifyFailure(response.status, reason),
      fatal: response.status === 401,
      errorBody: parseErrorPayload(raw),
    };
  }
  if (!response.body) {
    cleanup();
    return { ok: false, status: 502, reason: 'empty response body', kind: 'empty' };
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const extractor = geminiStreamExtractor(candidate);
  const bufferedChunks = [];
  let parserBuffer = '';
  let committed = false;
  let finishReason = '';

  while (true) {
    let read;
    try {
      read = await reader.read();
    } catch (error) {
      extractor?.flush();
      cleanup();
      if (committed) {
        res.end();
        return { ok: true, candidate, interrupted: true };
      }
      return { ok: false, status: 502, reason: String(error), kind: 'serverError' };
    }
    if (read.done) break;
    const bytes = Buffer.from(read.value);
    const text = decoder.decode(read.value, { stream: true });
    extractor?.push(text);
    if (committed) {
      res.write(bytes);
      continue;
    }

    bufferedChunks.push(bytes);
    parserBuffer += text;
    const lines = parserBuffer.split('\n');
    parserBuffer = lines.pop() || '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) continue;
      const data = trimmed.slice(5).trim();
      if (!data || data === '[DONE]') continue;
      try {
        const payload = JSON.parse(data);
        const finish = payload?.choices?.[0]?.finish_reason;
        if (finish) finishReason = finish;
        if (usefulDelta(payload)) {
          res.writeHead(200, {
            'Content-Type': 'text/event-stream; charset=utf-8',
            'Cache-Control': 'no-cache, no-transform',
            Connection: 'keep-alive',
            'X-Free-Router-Model': candidate.model,
            'X-Free-Router-Provider': candidate.provider,
          });
          for (const chunk of bufferedChunks) res.write(chunk);
          bufferedChunks.length = 0;
          committed = true;
          log(`selected ${candidateKey(candidate)} (stream)`);
          break;
        }
      } catch {
        // Ignore keepalives and malformed provider-specific event lines.
      }
    }
  }

  extractor?.flush();
  if (committed) {
    cleanup();
    res.end();
    return { ok: true, candidate };
  }
  cleanup();
  return {
    ok: false,
    status: 502,
    reason: `reasoning only or empty stream (finish_reason=${finishReason || 'unknown'})`,
    kind: 'empty',
  };
}

function sendJson(res, status, payload, headers = {}) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    ...headers,
  });
  res.end(body);
}

async function readJson(req, limit = 10 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error('request body too large');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

function routeStatus() {
  const now = Date.now();
  const routes = {};
  for (const name of Object.keys(config.routes || {})) {
    const candidates = routeCandidates(name) || [];
    const configured = (config.routes[name] || []).map(normalizeCandidate);
    const configuredKeys = configured.map(candidateKey);
    const configuredSet = new Set(configuredKeys);
    const configuredIndex = new Map(configuredKeys.map((key, index) => [key, index]));
    routes[name] = candidates.map((candidate, priority) => {
      const key = candidateKey(candidate);
      const model = candidateMetadata(candidate);
      // Per-key cooldowns share a `provider:model#slot` prefix; the status
      // shows the worst one so the UI reflects a spent quota even when only
      // one of several keys is cooling down.
      let cooldown = cooldowns.get(key);
      for (const [storedKey, entry] of cooldowns) {
        if (storedKey !== key && !storedKey.startsWith(`${key}#`)) continue;
        if (entry.until <= now) continue;
        if (!cooldown || entry.until > cooldown.until) cooldown = entry;
      }
      const pinned = PINNED_MODELS.has(key) || PINNED_MODELS.has(candidate.model);
      return {
        priority: priority + 1,
        provider: candidate.provider,
        id: candidate.model,
        pinned,
        score: pinned
          ? null
          : rankedModelScore(key, configuredSet, configuredIndex),
        baseScore: pinned ? null : baseModelScore(key, configuredSet, configuredIndex),
        scoreAdjustment: pinned ? 0 : usageAdjustment(key),
        scoreSource: scoreSourceFor(key, configuredSet),
        // Only meaningful where the catalog publishes prices; elsewhere the
        // freeModels allowlist is the guarantee, so report it as free.
        zeroCost: PROVIDERS.get(candidate.provider)?.catalogHasPricing
          ? model
            ? isZeroCost(model)
            : null
          : true,
        supportsTools: model ? (model.supported_parameters || []).includes('tools') : null,
        cooldownSeconds:
          cooldown && cooldown.until > now ? Math.ceil((cooldown.until - now) / 1000) : 0,
        cooldownReason: cooldown?.reason,
        usage: usageForKey(key),
      };
    });
  }
  return routes;
}

async function handleChat(req, res) {
  let body;
  try {
    body = await readJson(req);
  } catch (error) {
    return sendJson(res, 400, {
      error: { message: String(error), type: 'invalid_request_error' },
    });
  }

  const requestedModel = String(body.model || 'free-best');
  await refreshCatalog();
  const candidates = candidateModels(requestedModel, body);
  if (!candidates.length) {
    return sendJson(res, 503, {
      error: {
        message: `No currently free model supports this request for route ${requestedModel}`,
        type: 'no_compatible_free_model',
      },
    });
  }

  const failures = [];
  const failedProviders = new Set();
  const clientController = new AbortController();
  res.on('close', () => {
    if (!res.writableEnded) clientController.abort();
  });

  for (const candidate of candidates) {
    if (clientController.signal.aborted) return;
    if (failedProviders.has(candidate.provider)) continue;
    // Multi-account: each candidate is tried with every usable key in
    // round-robin order. A 401 retires just that key; rate limits cool down
    // just that key.
    const slots = registry.keySlots(candidate.provider);
    registry.rotateKeyCursor(candidate.provider);
    const attempts = slots.length ? slots : [null];
    let candidateOk = false;
    for (const slot of attempts) {
      if (clientController.signal.aborted) return;
      if (slot && cooldownRemaining(candidate, slot) > 0) continue;
      const slotLabel = slot ? ` [${slot.name}]` : '';
      log(`trying ${candidateKey(candidate)}${slotLabel} for ${requestedModel}`);
      const result = body.stream
        ? await attemptStream(candidate, body, res, clientController.signal, slot)
        : await attemptJson(candidate, body, clientController.signal, slot);

      if (result.ok) {
        recordUsage(candidate, 'ok');
        rememberSelection({
          route: requestedModel,
          provider: candidate.provider,
          model: candidate.model,
          selectedAt: new Date().toISOString(),
        });
        if (!body.stream) {
          log(`selected ${candidateKey(candidate)}${slotLabel}`);
          return sendJson(res, 200, result.payload, {
            'X-Free-Router-Model': candidate.model,
            'X-Free-Router-Provider': candidate.provider,
          });
        }
        return;
      }

      recordUsage(
        candidate,
        clientController.signal.aborted ? 'aborted' : result.kind || 'other',
      );
      failures.push({
        provider: candidate.provider,
        model: candidate.model,
        key: slot?.name || undefined,
        status: result.status,
        reason: result.reason,
      });
      const providerWaitMs = applyProviderVerdict(candidate, result);
      if (result.kind) setCooldown(candidate, result.kind, result.reason, providerWaitMs, slot);
      log(`failed ${candidateKey(candidate)}${slotLabel}: ${result.status} ${result.reason}`);
      if (result.fatal) {
        // Wrong key: retire it and try the next key on the same candidate.
        if (slot?.key && result.status === 401) {
          registry.markKeyInvalid(candidate.provider, slot.key);
          log(`retired key [${slot.name}] for ${candidate.provider}: 401`);
          continue;
        }
        break;
      }
      // The same history will 400 on every Gemini thinking model. Stop here so
      // 3.8-flash, 3.7-flash, and Flash-Lite are not each billed for a refusal.
      if (isMissingThoughtSignatureError(result.status, result.reason)) {
        log(`skipping remaining ${candidate.provider} candidates: missing thought_signature`);
        failedProviders.add(candidate.provider);
        break;
      }
      // Rate limit / timeout on this key: try the next key before moving on.
      if (attempts.length > 1 && (result.status === 429 || result.status === 504 || result.kind === 'timeout')) {
        continue;
      }
      break;
    }
    // All keys for this provider failed fatally: skip the rest of its models.
    if (failures.length && failures[failures.length - 1]?.status === 401) {
      const remainingSlots = registry.keySlots(candidate.provider);
      if (!remainingSlots.length) failedProviders.add(candidate.provider);
    }
  }

  if (!res.headersSent) {
    sendJson(res, 502, {
      error: {
        message: `All models failed for route ${requestedModel}`,
        type: 'free_router_exhausted',
        failures,
      },
    });
  }
}

function isLoopbackAddress(address) {
  const plain = String(address || '').replace(/^::ffff:/, '');
  return plain === '::1' || plain === '127.0.0.1' || plain.startsWith('127.');
}

// LAN-ready guard: the loopback-only restriction is gone. Protection now
// comes from authentication instead of the network:
//   - web UI + management APIs require the admin session (password login);
//   - /v1/* requires a gateway API key once one is configured.
// What remains here is CSRF/rebinding hygiene, now LAN-aware:
//   - cross-site browser requests are blocked (Sec-Fetch-Site);
//   - the Host header must be loopback, a private LAN IP, or a local
//     hostname (.local / single-label); a public domain (DNS rebinding)
//     is rejected;
//   - a forged Origin that does not match the request host is rejected,
//     while same-host LAN origins are allowed.
// A plain curl call sends neither Origin nor Sec-Fetch-Site and is allowed.
function isLocalHost(hostname) {
  const host = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (!host) return true;
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return true;
  if (host === '::1' || host === '127.0.0.1' || host.startsWith('127.') || host === '[::1]') return true;
  if (/^(10|172\.(1[6-9]|2\d|3[01])|192\.168)\./.test(host)) return true;
  if (/^(fc[0-9a-f]{2}|fd[0-9a-f]{2}|fe80):/i.test(host)) return true;
  if (!host.includes('.') && /^[a-z0-9-]+$/i.test(host)) return true;
  return false;
}

function uiGuardFailure(req) {
  const host = String(req.headers.host || '');
  const hostname = host.replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
  if (hostname && !isLocalHost(hostname)) {
    return `unexpected Host header: ${host}`;
  }

  const site = String(req.headers['sec-fetch-site'] || '');
  if (site && site !== 'same-origin' && site !== 'none') {
    return `cross-site request blocked (Sec-Fetch-Site: ${site})`;
  }

  const origin = String(req.headers.origin || '');
  if (origin) {
    let originHost = '';
    try {
      originHost = new URL(origin).hostname;
    } catch {
      return `invalid Origin header: ${origin}`;
    }
    const sameHost = originHost.toLowerCase() === hostname.toLowerCase();
    if (!sameHost && !isLocalHost(originHost)) {
      return `unexpected Origin header: ${origin}`;
    }
  }
  return '';
}

function webuiAuthFailure(req) {
  const token = webuiSessionToken(req);
  if (!token || !webuiSessions.has(token)) return 'web UI login required';
  const expiresAt = webuiSessions.get(token);
  if (expiresAt <= Date.now()) {
    webuiSessions.delete(token);
    return 'session expired, please log in again';
  }
  return '';
}

function uiProviderState() {
  const catalogHealth = registry.health();
  const providers = [...PROVIDERS.values()];
  providers.sort((left, right) => Number(right.name === 'gemini') - Number(left.name === 'gemini'));
  return providers.map((provider) => {
    const unavailable = catalogHealth[provider.name]?.unavailableModels || [];
    // Model totals next to the free-model availability: priced catalogs count
    // zero-cost chat models, allowlists count entries still offered upstream.
    let modelCount = null;
    let freeCount = null;
    if (provider.catalogHasPricing) {
      if (provider.catalog?.size) {
        modelCount = provider.catalog.size;
        freeCount = [...provider.catalog.values()].filter((m) => isZeroCost(m) && isChatModel(m)).length;
      }
    } else {
      modelCount = provider.freeModels.size;
      freeCount = [...provider.freeModels].filter((id) => !unavailable.includes(id)).length;
    }
    return {
      name: provider.name,
      keyEnv: provider.keyEnv,
      baseUrl: provider.baseUrl,
      kind: registry.providerKind(provider),
      configured: registry.hasUsableKey(provider),
      keyCount: provider.apiKeys?.length || 0,
      keys: (provider.apiKeys || []).map((entry) => ({
        name: entry.name,
        source: entry.source,
        maskedKey: maskSecret(entry.key),
        invalid: provider.invalidKeys.has(entry.key),
      })),
      maskedKey: maskSecret(provider.apiKey),
      catalogModels: provider.usesCatalog ? provider.catalog.size : null,
      modelCount,
      freeCount,
      catalogError: catalogHealth[provider.name]?.catalogError || null,
      unavailableModels: unavailable,
    };
  });
}

function uiRouteState() {
  const routes = routeStatus();
  const entries = routes[DISCOVERY_ROUTE] || Object.values(routes)[0] || [];
  return entries.map((entry) => ({
    priority: entry.priority,
    provider: entry.provider,
    model: entry.id,
    pinned: entry.pinned,
    zeroCost: entry.zeroCost,
    cooldownSeconds: entry.cooldownSeconds,
    scoreAdjustment: entry.scoreAdjustment,
    providerConfigured: registry.hasUsableKey(PROVIDERS.get(entry.provider)),
    usage: entry.usage,
  }));
}

function providerFileKeys(name) {
  const raw = config.providers?.[name];
  if (!raw || typeof raw !== 'object') return [];
  return Array.isArray(raw.keys) ? raw.keys : [];
}

// Named multi-key write path. Body variants:
//   {provider, key}                 legacy: replace the env-backed key
//   {provider, name, key}           add or replace the named file key
//   {provider, name, key: ''}       delete the named file key
// File keys persist to the TOML/JSON config; the legacy env path still
// updates the .env file so `start.sh` keeps working.
async function handleKeyUpdate(req, res) {
  let body;
  try {
    body = await readJson(req, 64 * 1024);
  } catch (error) {
    return sendJson(res, 400, {
      error: { message: String(error), type: 'invalid_request_error' },
    });
  }

  const name = String(body.provider || '');
  const provider = PROVIDERS.get(name);
  // Whitelisted by provider name, never by raw env name: start.sh sources the
  // env file with `set -a`, so writing an arbitrary variable such as
  // NODE_OPTIONS would be code execution on the next start.
  if (!provider) {
    return sendJson(res, 400, {
      error: {
        message: `unknown provider: ${name || '(missing)'}`,
        type: 'invalid_request_error',
      },
    });
  }

  const keyName = String(body.name || '').trim().slice(0, 64);
  const key = typeof body.key === 'string' ? body.key.trim() : '';
  const problem = validateSecret(key);
  if (problem) {
    return sendJson(res, 400, { error: { message: problem, type: 'invalid_request_error' } });
  }

  // Named path: file-backed multi-account keys -> overlay file.
  if (keyName) {
    const next = providerFileKeys(name)
      .filter((entry) => String(entry?.name || '') !== keyName)
      .map((entry) => ({ name: String(entry.name), key: String(entry.key || '') }));
    if (key) next.push({ name: keyName, key });
    editableProviderRaw(name);
    registry.setProviderKeys(name, next);
    try {
      persistOverlayFile();
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return sendJson(res, 500, {
        error: { message: `could not write ${OVERLAY_FILENAME}: ${reason}`, type: 'config_write_failed' },
      });
    }
    refreshSecretRedactor();
    log(`${key ? 'set' : 'cleared'} provider key [${keyName}] for ${name} via web interface`);
    if (key && provider.usesCatalog) {
      try {
        await refreshCatalog(true);
      } catch (error) {
        log(`catalog refresh after key change failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return sendJson(res, 200, { ok: true, provider: name, name: keyName, configured: Boolean(key) });
  }

  try {
    updateEnvFile(UI_ENV_PATH, { [provider.keyEnv]: key });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    log(`failed to write ${displayPath(UI_ENV_PATH)}: ${reason}`);
    return sendJson(res, 500, {
      error: { message: `could not write env file: ${reason}`, type: 'env_write_failed' },
    });
  }

  registry.setApiKey(name, key);
  refreshSecretRedactor();
  log(`${key ? 'set' : 'cleared'} ${provider.keyEnv} via web interface`);
  if (key && provider.usesCatalog) {
    try {
      await refreshCatalog(true);
    } catch (error) {
      log(`catalog refresh after key change failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return sendJson(res, 200, { ok: true, provider: name, configured: Boolean(key) });
}

function randomGatewayKey() {
  return `sk-fr-${crypto.randomBytes(24).toString('base64url')}`;
}

// Gateway client keys (downstream). Creating the first key enables auth;
// the full key value is returned only once at creation.
async function handleGatewayKeys(req, res) {
  let body;
  try {
    body = await readJson(req, 64 * 1024);
  } catch (error) {
    return sendJson(res, 400, { error: { message: String(error), type: 'invalid_request_error' } });
  }
  const action = String(body.action || 'create');
  if (action === 'setRequireAuth') {
    setOverlayValue(['gateway', 'requireAuth'], Boolean(body.requireAuth));
    if (gatewayAuthRequired() && !gatewayKeys().length) {
      setOverlayValue(['gateway', 'requireAuth'], false);
      return sendJson(res, 400, {
        error: { message: 'create at least one API key before enabling auth', type: 'invalid_request_error' },
      });
    }
    try {
      persistOverlayFile();
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return sendJson(res, 500, {
        error: { message: `could not write ${OVERLAY_FILENAME}: ${reason}`, type: 'config_write_failed' },
      });
    }
    refreshSecretRedactor();
    return sendJson(res, 200, { ok: true, requireAuth: gatewayAuthRequired() });
  }

  if (action === 'delete') {
    const keyName = String(body.name || '');
    const kept = gatewayKeys().filter((entry) => entry?.name !== keyName);
    if (kept.length === gatewayKeys().length) {
      return sendJson(res, 404, { error: { message: `unknown key: ${keyName}`, type: 'not_found' } });
    }
    setOverlayValue(['gateway', 'keys'], kept);
    if (!kept.length) setOverlayValue(['gateway', 'requireAuth'], false);
    try {
      persistOverlayFile();
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return sendJson(res, 500, {
        error: { message: `could not write ${OVERLAY_FILENAME}: ${reason}`, type: 'config_write_failed' },
      });
    }
    refreshSecretRedactor();
    log(`deleted gateway API key [${keyName}] via web interface`);
    return sendJson(res, 200, { ok: true });
  }

  if (action === 'create') {
    const keyName = String(body.name || '').trim().slice(0, 64);
    if (!keyName) {
      return sendJson(res, 400, { error: { message: 'name is required', type: 'invalid_request_error' } });
    }
    if (gatewayKeys().some((entry) => entry?.name === keyName)) {
      return sendJson(res, 400, { error: { message: `key already exists: ${keyName}`, type: 'invalid_request_error' } });
    }
    const value = typeof body.key === 'string' && body.key.trim() ? body.key.trim() : randomGatewayKey();
    const problem = validateSecret(value);
    if (problem) {
      return sendJson(res, 400, { error: { message: problem, type: 'invalid_request_error' } });
    }
    setOverlayValue(['gateway', 'keys'], [
      ...gatewayKeys(),
      { name: keyName, key: value, createdAt: new Date().toISOString() },
    ]);
    setOverlayValue(['gateway', 'requireAuth'], true);
    try {
      persistOverlayFile();
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return sendJson(res, 500, {
        error: { message: `could not write ${OVERLAY_FILENAME}: ${reason}`, type: 'config_write_failed' },
      });
    }
    refreshSecretRedactor();
    log(`created gateway API key [${keyName}] via web interface`);
    return sendJson(res, 200, { ok: true, name: keyName, key: value, requireAuth: true });
  }

  return sendJson(res, 400, { error: { message: `unknown action: ${action}`, type: 'invalid_request_error' } });
}

async function handleWebuiPassword(req, res) {
  let body;
  try {
    body = await readJson(req, 64 * 1024);
  } catch (error) {
    return sendJson(res, 400, { error: { message: String(error), type: 'invalid_request_error' } });
  }
  const password = typeof body.password === 'string' ? body.password : '';
  const problem = validateSecret(password);
  if (problem || !password) {
    return sendJson(res, 400, {
      error: { message: problem || 'password is required', type: 'invalid_request_error' },
    });
  }
  config.webui ||= {};
  if (!setStoredWebuiPassword(hashPassword(password))) {
    return sendJson(res, 500, {
      error: { message: `could not write ${OVERLAY_FILENAME}`, type: 'config_write_failed' },
    });
  }
  webuiSessions.clear();
  refreshSecretRedactor();
  log('web UI password changed via web interface; all sessions revoked');
  return sendJson(res, 200, { ok: true });
}

async function handleServerConfig(req, res) {
  let body;
  try {
    body = await readJson(req, 64 * 1024);
  } catch (error) {
    return sendJson(res, 400, { error: { message: String(error), type: 'invalid_request_error' } });
  }
  const notes = [];
  if (body.host !== undefined) {
    const host = String(body.host || '').trim();
    if (!host) {
      return sendJson(res, 400, { error: { message: 'host is required', type: 'invalid_request_error' } });
    }
    setOverlayValue(['host'], host);
    notes.push('host saved; restart to take effect');
  }
  if (body.port !== undefined) {
    const port = Number(body.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      return sendJson(res, 400, { error: { message: 'port must be 1-65535', type: 'invalid_request_error' } });
    }
    setOverlayValue(['port'], port);
    notes.push('port saved; restart to take effect');
  }
  try {
    persistOverlayFile();
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return sendJson(res, 500, {
      error: { message: `could not write ${OVERLAY_FILENAME}: ${reason}`, type: 'config_write_failed' },
    });
  }
  return sendJson(res, 200, { ok: true, host: config.host, port: config.port, notes });
}

// ---- Editable configuration (web UI settings tabs) ----

function routeEntryString(entry) {
  if (typeof entry === 'string') return entry;
  if (entry && typeof entry === 'object') {
    const provider = String(entry.provider || '');
    const model = String(entry.model || entry.id || '');
    if (provider && model) return `${provider}:${model}`;
    return model;
  }
  return '';
}

// "provider:model" -> {provider, model} when the prefix names a provider,
// otherwise kept as a plain string (e.g. "z-ai/glm-5.2:free").
function parseRouteEntryString(raw) {
  const text = String(raw || '').trim();
  if (!text) return null;
  const separator = text.indexOf(':');
  if (separator > 0 && PROVIDERS.has(text.slice(0, separator))) {
    const model = text.slice(separator + 1).trim();
    if (!model) return null;
    return { provider: text.slice(0, separator), model };
  }
  return text;
}

function editableConfigState() {
  const routes = {};
  for (const [name, entries] of Object.entries(config.routes || {})) {
    routes[name] = (Array.isArray(entries) ? entries : []).map(routeEntryString).filter(Boolean);
  }
  const limits = Object.entries(config.usage?.dailyLimits || {}).map(([key, limit]) => ({
    key,
    limit: Number(limit),
    source: dailyLimitSource(key),
  }));
  limits.sort((a, b) => a.key.localeCompare(b.key));
  return {
    providers: [...PROVIDERS.values()].map((provider) => ({
      name: provider.name,
      keyEnv: provider.keyEnv,
      baseUrl: provider.baseUrl,
      catalog: provider.usesCatalog,
      pricing: provider.catalogHasPricing,
      probeFreeTier: provider.probeFreeTier,
      freeModels: [...provider.freeModels],
      keyCount: provider.apiKeys?.length || 0,
    })),
    routes,
    discovery: {
      enabled: discoveryEnabled,
      provider: registry.discoveryProvider,
      intervalHours: Math.round(DISCOVERY_INTERVAL_MS / 3600000),
      route: DISCOVERY_ROUTE,
      evaluationEnabled,
      pinnedModels: [...PINNED_MODELS],
    },
    limits,
    general: {
      attemptTimeoutMs,
      catalogRefreshMs,
      redactSecrets: config.redactSecrets !== false,
      socksFirstHosts: config.socksFirstHosts || [],
      defaultProvider: registry.defaultProvider,
      retentionDays: USAGE_RETENTION_DAYS,
      timezone: USAGE_TIMEZONE || '',
    },
  };
}

function persistOrFail(res) {
  try {
    persistOverlayFile();
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    sendJson(res, 500, {
      error: { message: `could not write ${OVERLAY_FILENAME}: ${reason}`, type: 'config_write_failed' },
    });
    return false;
  }
  return true;
}

function validProviderId(name) {
  return /^[a-z][a-z0-9_-]*$/.test(String(name || ''));
}

function validHttpUrl(raw) {
  try {
    const url = new URL(String(raw || ''));
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

// Providers: create a new upstream, edit baseUrl/freeModels/flags, or delete.
// Deleting also purges the provider's entries from all routes.
async function handleProviders(req, res) {
  let body;
  try {
    body = await readJson(req, 128 * 1024);
  } catch (error) {
    return sendJson(res, 400, { error: { message: String(error), type: 'invalid_request_error' } });
  }
  const action = String(body.action || '');
  const name = String(body.name || '').trim();

  if (action === 'create') {
    if (!validProviderId(name)) {
      return sendJson(res, 400, { error: { message: 'name must match [a-z][a-z0-9_-]*', type: 'invalid_request_error' } });
    }
    if (PROVIDERS.has(name)) {
      return sendJson(res, 400, { error: { message: `provider already exists: ${name}`, type: 'invalid_request_error' } });
    }
    const baseUrl = String(body.baseUrl || '').trim().replace(/\/+$/, '');
    if (!validHttpUrl(baseUrl)) {
      return sendJson(res, 400, { error: { message: 'baseUrl must be an http(s) URL', type: 'invalid_request_error' } });
    }
    const freeModels = Array.isArray(body.freeModels)
      ? [...new Set(body.freeModels.map((m) => String(m || '').trim()).filter(Boolean))]
      : [];
    const cfg = {
      baseUrl,
      keyEnv: String(body.keyEnv || `${name.replace(/-/g, '_').toUpperCase()}_API_KEY`),
      catalog: body.catalog === true,
      pricing: body.pricing !== false,
      probeFreeTier: body.probeFreeTier === true,
      freeModels,
      keys: [],
    };
    setOverlayValue(['providers', name], cfg);
    try {
      registry.addProvider(name, cfg);
    } catch (error) {
      deleteOverlayValue(['providers', name]);
      return sendJson(res, 400, { error: { message: String(error.message || error), type: 'invalid_request_error' } });
    }
    tombstone('_removedProviders', name, false);
    if (!persistOrFail(res)) return undefined;
    refreshSecretRedactor();
    if (cfg.catalog) {
      try {
        await refreshCatalog(true);
      } catch (error) {
        log(`catalog refresh after provider add failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    log(`added provider ${name} via web interface`);
    return sendJson(res, 200, { ok: true, name });
  }

  const provider = PROVIDERS.get(name);
  if (!provider) {
    return sendJson(res, 404, { error: { message: `unknown provider: ${name || '(missing)'}`, type: 'not_found' } });
  }

  if (action === 'delete') {
    try {
      registry.removeProvider(name);
    } catch (error) {
      return sendJson(res, 400, { error: { message: String(error.message || error), type: 'invalid_request_error' } });
    }
    deleteOverlayValue(['providers', name]);
    tombstone('_removedProviders', name, true);
    let purged = 0;
    for (const [routeName, entries] of Object.entries(config.routes || {})) {
      if (!Array.isArray(entries)) continue;
      const kept = entries.filter((entry) => normalizeCandidate(entry).provider !== name);
      if (kept.length === entries.length) continue;
      purged += entries.length - kept.length;
      setOverlayValue(['routes', routeName], kept);
    }
    if (!persistOrFail(res)) return undefined;
    refreshSecretRedactor();
    log(`deleted provider ${name} via web interface (purged ${purged} route entr${purged === 1 ? 'y' : 'ies'})`);
    return sendJson(res, 200, { ok: true, purged });
  }

  if (action === 'update') {
    const notes = [];
    const cfg = editableProviderRaw(name);
    if (body.baseUrl !== undefined) {
      const baseUrl = String(body.baseUrl || '').trim().replace(/\/+$/, '');
      if (!validHttpUrl(baseUrl)) {
        return sendJson(res, 400, { error: { message: 'baseUrl must be an http(s) URL', type: 'invalid_request_error' } });
      }
      cfg.baseUrl = baseUrl;
      provider.baseUrl = baseUrl;
      notes.push('baseUrl updated');
    }
    if (body.freeModels !== undefined) {
      if (!Array.isArray(body.freeModels)) {
        return sendJson(res, 400, { error: { message: 'freeModels must be an array', type: 'invalid_request_error' } });
      }
      const list = [...new Set(body.freeModels.map((m) => String(m || '').trim()).filter(Boolean))];
      cfg.freeModels = list;
      provider.freeModels = new Set(list);
      notes.push('freeModels updated');
    }
    if (body.catalog !== undefined) {
      cfg.catalog = body.catalog === true;
      notes.push('catalog flag saved; restart to take effect');
    }
    if (body.pricing !== undefined) {
      cfg.pricing = body.pricing !== false;
      notes.push('pricing flag saved; restart to take effect');
    }
    if (body.probeFreeTier !== undefined) {
      cfg.probeFreeTier = body.probeFreeTier === true;
      notes.push('probeFreeTier saved; restart to take effect');
    }
    // cfg is already the overlay-owned raw (see editableProviderRaw above).
    if (!persistOrFail(res)) return undefined;
    if (body.baseUrl !== undefined && provider.usesCatalog) {
      try {
        await refreshCatalog(true);
      } catch (error) {
        log(`catalog refresh after provider update failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return sendJson(res, 200, { ok: true, name, notes });
  }

  return sendJson(res, 400, { error: { message: `unknown action: ${action}`, type: 'invalid_request_error' } });
}

// Routes: replace a whole route membership list, create a new route, or delete
// one. Models for price-free providers are auto-added to their freeModels
// allowlist so the new entry is actually routable.
async function handleRoutes(req, res) {
  let body;
  try {
    body = await readJson(req, 128 * 1024);
  } catch (error) {
    return sendJson(res, 400, { error: { message: String(error), type: 'invalid_request_error' } });
  }
  const action = String(body.action || 'save');
  const route = String(body.route || '').trim();
  if (!/^[A-Za-z0-9_-]+$/.test(route)) {
    return sendJson(res, 400, { error: { message: 'route must match [A-Za-z0-9_-]+', type: 'invalid_request_error' } });
  }

  if (action === 'delete') {
    if (route === DISCOVERY_ROUTE) {
      return sendJson(res, 400, { error: { message: `cannot delete the discovery route: ${route}`, type: 'invalid_request_error' } });
    }
    if (!config.routes?.[route]) {
      return sendJson(res, 404, { error: { message: `unknown route: ${route}`, type: 'not_found' } });
    }
    delete config.routes[route];
    tombstone('_removedRoutes', route, true);
    if (!persistOrFail(res)) return undefined;
    log(`deleted route ${route} via web interface`);
    return sendJson(res, 200, { ok: true });
  }

  if (action !== 'save') {
    return sendJson(res, 400, { error: { message: `unknown action: ${action}`, type: 'invalid_request_error' } });
  }
  if (!Array.isArray(body.models)) {
    return sendJson(res, 400, { error: { message: 'models must be an array of "provider:model" or model strings', type: 'invalid_request_error' } });
  }
  const parsed = [];
  const seen = new Set();
  const notes = [];
  for (const raw of body.models) {
    const entry = parseRouteEntryString(raw);
    if (!entry) {
      return sendJson(res, 400, { error: { message: `empty model entry`, type: 'invalid_request_error' } });
    }
    const key = typeof entry === 'string' ? `:${entry}` : `${entry.provider}:${entry.model}`;
    if (seen.has(key)) continue;
    seen.add(key);
    parsed.push(entry);
    if (typeof entry !== 'string') {
      const provider = PROVIDERS.get(entry.provider);
      if (!provider) {
        return sendJson(res, 400, { error: { message: `unknown provider in entry: ${routeEntryString(entry)}`, type: 'invalid_request_error' } });
      }
      if (!provider.catalogHasPricing && !provider.freeModels.has(entry.model)) {
        provider.freeModels.add(entry.model);
        const cfg = editableProviderRaw(entry.provider);
        cfg.freeModels = [...provider.freeModels];
        notes.push(`added ${entry.model} to ${entry.provider} freeModels`);
      }
    }
  }
  setOverlayValue(['routes', route], parsed);
  tombstone('_removedRoutes', route, false);
  if (!persistOrFail(res)) return undefined;
  log(`saved route ${route} via web interface (${parsed.length} entries)`);
  return sendJson(res, 200, { ok: true, route, count: parsed.length, notes });
}

// Daily quota limits: config values (provider-reported ones stay authoritative).
async function handleLimits(req, res) {
  let body;
  try {
    body = await readJson(req, 64 * 1024);
  } catch (error) {
    return sendJson(res, 400, { error: { message: String(error), type: 'invalid_request_error' } });
  }
  const action = String(body.action || 'set');
  const key = String(body.key || '').trim();
  if (!key) {
    return sendJson(res, 400, { error: { message: 'key is required, e.g. "gemini:gemini-3.8-flash"', type: 'invalid_request_error' } });
  }
  if (action === 'delete') {
    deleteOverlayValue(['usage', 'dailyLimits', key]);
    if (!persistOrFail(res)) return undefined;
    return sendJson(res, 200, { ok: true });
  }
  if (action !== 'set') {
    return sendJson(res, 400, { error: { message: `unknown action: ${action}`, type: 'invalid_request_error' } });
  }
  const limit = Number(body.limit);
  if (!Number.isFinite(limit) || limit <= 0) {
    return sendJson(res, 400, { error: { message: 'limit must be a positive number', type: 'invalid_request_error' } });
  }
  setOverlayValue(['usage', 'dailyLimits', key], limit);
  if (!persistOrFail(res)) return undefined;
  return sendJson(res, 200, { ok: true, key, limit });
}

// Discovery + evaluation toggles apply immediately; provider switch applies
// immediately too; the interval needs a restart (it arms the next timer).
async function handleDiscovery(req, res) {
  let body;
  try {
    body = await readJson(req, 64 * 1024);
  } catch (error) {
    return sendJson(res, 400, { error: { message: String(error), type: 'invalid_request_error' } });
  }
  const notes = [];
  if (body.enabled !== undefined) {
    discoveryEnabled = body.enabled !== false;
    setOverlayValue(['discovery', 'enabled'], discoveryEnabled);
  }
  if (body.evaluationEnabled !== undefined) {
    evaluationEnabled = body.evaluationEnabled !== false;
    setOverlayValue(['discovery', 'evaluation', 'enabled'], evaluationEnabled);
  }
  if (body.provider !== undefined) {
    const name = String(body.provider || '');
    try {
      registry.setDiscoveryProvider(name);
    } catch (error) {
      return sendJson(res, 400, { error: { message: String(error.message || error), type: 'invalid_request_error' } });
    }
    setOverlayValue(['discovery', 'provider'], name);
  }
  if (body.intervalHours !== undefined) {
    const hours = Number(body.intervalHours);
    if (!Number.isFinite(hours) || hours < 1 || hours > 720) {
      return sendJson(res, 400, { error: { message: 'intervalHours must be 1-720', type: 'invalid_request_error' } });
    }
    setOverlayValue(['discovery', 'intervalMs'], Math.round(hours * 3600000));
    notes.push('interval saved; restart to take effect');
  }
  if (body.pin !== undefined || body.unpin !== undefined) {
    const pinned = new Set(config.discovery?.evaluation?.pinnedModels || [...PINNED_MODELS]);
    if (body.pin) {
      const model = String(body.pin).trim();
      if (!model) {
        return sendJson(res, 400, { error: { message: 'pin must be a non-empty model id', type: 'invalid_request_error' } });
      }
      pinned.add(model);
      PINNED_MODELS.add(model);
    }
    if (body.unpin) {
      pinned.delete(String(body.unpin));
      PINNED_MODELS.delete(String(body.unpin));
    }
    setOverlayValue(['discovery', 'evaluation', 'pinnedModels'], [...pinned]);
  }
  if (!persistOrFail(res)) return undefined;
  return sendJson(res, 200, { ok: true, notes });
}

// General tuning knobs. Most apply immediately; host-like values and the
// usage timezone need a restart and are reported back as notes.
async function handleSettings(req, res) {
  let body;
  try {
    body = await readJson(req, 64 * 1024);
  } catch (error) {
    return sendJson(res, 400, { error: { message: String(error), type: 'invalid_request_error' } });
  }
  const notes = [];
  if (body.attemptTimeoutMs !== undefined) {
    const value = Number(body.attemptTimeoutMs);
    if (!Number.isFinite(value) || value < 5000 || value > 900000) {
      return sendJson(res, 400, { error: { message: 'attemptTimeoutMs must be 5000-900000', type: 'invalid_request_error' } });
    }
    attemptTimeoutMs = value;
    setOverlayValue(['attemptTimeoutMs'], value);
  }
  if (body.catalogRefreshMs !== undefined) {
    const value = Number(body.catalogRefreshMs);
    if (!Number.isFinite(value) || value < 60000 || value > 86400000) {
      return sendJson(res, 400, { error: { message: 'catalogRefreshMs must be 60000-86400000', type: 'invalid_request_error' } });
    }
    catalogRefreshMs = value;
    setOverlayValue(['catalogRefreshMs'], value);
  }
  if (body.redactSecrets !== undefined) {
    setOverlayValue(['redactSecrets'], body.redactSecrets !== false);
    refreshSecretRedactor();
  }
  if (body.socksFirstHosts !== undefined) {
    if (!Array.isArray(body.socksFirstHosts)) {
      return sendJson(res, 400, { error: { message: 'socksFirstHosts must be an array', type: 'invalid_request_error' } });
    }
    setOverlayValue(['socksFirstHosts'], body.socksFirstHosts.map((h) => String(h || '').trim()).filter(Boolean));
    notes.push('socksFirstHosts saved; restart to take effect');
  }
  if (body.defaultProvider !== undefined) {
    const name = String(body.defaultProvider || '');
    try {
      registry.setDefaultProvider(name);
    } catch (error) {
      return sendJson(res, 400, { error: { message: String(error.message || error), type: 'invalid_request_error' } });
    }
    setOverlayValue(['defaultProvider'], name);
  }
  if (body.retentionDays !== undefined) {
    const value = Number(body.retentionDays);
    if (!Number.isInteger(value) || value < 1 || value > 90) {
      return sendJson(res, 400, { error: { message: 'retentionDays must be 1-90', type: 'invalid_request_error' } });
    }
    setOverlayValue(['usage', 'retentionDays'], value);
    notes.push('retentionDays saved; restart to take effect');
  }
  if (body.timezone !== undefined) {
    setOverlayValue(['usage', 'timezone'], String(body.timezone || ''));
    notes.push('timezone saved; restart to take effect');
  }
  if (body.sessionTtlHours !== undefined) {
    const value = Number(body.sessionTtlHours);
    if (!Number.isFinite(value) || value < 0 || value > 8760) {
      return sendJson(res, 400, { error: { message: 'sessionTtlHours must be 0-8760 (0 = never expires)', type: 'invalid_request_error' } });
    }
    setOverlayValue(['webui', 'sessionTtlHours'], value);
    notes.push(value === 0 ? 'sessions never expire' : `sessions expire after ${value} hour(s); existing sessions keep their old expiry`);
  }
  if (body.dismissMigrationNotice === true) {
    deleteOverlayValue(['migratedFromEnv']);
  }
  if (!persistOrFail(res)) return undefined;
  return sendJson(res, 200, { ok: true, notes });
}

// Graceful restart for applying host/port changes from the web UI.
// Responds first, then flushes state and exits: process supervisors
// (docker restart policy, systemd) bring the server back up. Without a
// supervisor (plain ./start.sh) the process simply stops — the UI says so.
async function handleRestart(req, res) {
  sendJson(res, 200, { ok: true });
  setTimeout(() => {
    log('restart requested via web interface; exiting for supervisor restart');
    try {
      if (stateSaveTimer) flushStateSave();
    } catch {
      // Best effort; the process is exiting either way.
    }
    try {
      server.close(() => process.exit(0));
    } catch {
      process.exit(0);
    }
    setTimeout(() => process.exit(0), 3000).unref?.();
  }, 300).unref?.();
}

async function handleLogin(req, res) {
  let body;
  try {
    body = await readJson(req, 64 * 1024);
  } catch (error) {
    return sendJson(res, 400, { error: { message: String(error), type: 'invalid_request_error' } });
  }
  const password = typeof body.password === 'string' ? body.password : '';
  if (!checkWebuiPassword(password)) {
    return sendJson(res, 401, { error: { message: 'invalid password', type: 'unauthorized' } });
  }
  upgradePasswordStorage('login');
  const token = crypto.randomBytes(32).toString('hex');
  pruneWebuiSessions();
  const ttlHours = sessionTtlHours();
  const expiresAt = ttlHours > 0 ? Date.now() + Math.round(ttlHours * 3600000) : Number.POSITIVE_INFINITY;
  webuiSessions.set(token, expiresAt);
  // Cookie lifetime mirrors the server-side TTL; "never" becomes a browser
  // session cookie so it still dies with the browser.
  const maxAge = ttlHours > 0 ? `; Max-Age=${Math.round(ttlHours * 3600)}` : '';
  res.writeHead(200, {
    'Content-Type': 'application/json; charset=utf-8',
    'Set-Cookie': `fr_session=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax${maxAge}`,
    'Cache-Control': 'no-store',
  });
  return res.end(JSON.stringify({
    ok: true,
    expiresAt: Number.isFinite(expiresAt) ? new Date(expiresAt).toISOString() : null,
  }));
}

async function handler(req, res) {
  const url = new URL(req.url || '/', `http://${req.headers.host || `${HOST}:${PORT}`}`);
  const isUiPath = url.pathname === '/' || url.pathname.startsWith('/api/');
  if (isUiPath) {
    if (!UI_ENABLED) {
      return sendJson(res, 404, {
        error: { message: 'web interface is disabled', type: 'not_found' },
      });
    }
    const failure = uiGuardFailure(req);
    if (failure) {
      log(`blocked web interface request: ${failure}`);
      return sendJson(res, 403, { error: { message: failure, type: 'forbidden' } });
    }
  }

  if (req.method === 'GET' && url.pathname === '/') {
    const page = renderPage();
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Length': Buffer.byteLength(page),
      'Cache-Control': 'no-store',
      'Content-Security-Policy':
        "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; form-action 'none'; base-uri 'none'",
      'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
    });
    return res.end(page);
  }
  // Login is public (it is the gate itself); logout needs no session either.
  if (req.method === 'POST' && url.pathname === '/api/login') {
    return handleLogin(req, res);
  }
  if (req.method === 'POST' && url.pathname === '/api/logout') {
    webuiSessions.delete(webuiSessionToken(req));
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Set-Cookie': 'fr_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0',
      'Cache-Control': 'no-store',
    });
    return res.end(JSON.stringify({ ok: true }));
  }
  if (isUiPath && url.pathname.startsWith('/api/')) {
    const authFailure = webuiAuthFailure(req);
    if (authFailure) {
      return sendJson(res, 401, { error: { message: authFailure, type: 'unauthorized' } });
    }
  }
  if (req.method === 'GET' && url.pathname === '/api/state') {
    await refreshCatalog();
    return sendJson(
      res,
      200,
      {
        endpoint: `http://${HOST}:${PORT}/v1`,
        envFile: displayPath(UI_ENV_PATH),
        configFile: displayPath(CONFIG_PATH),
        configFormat: CONFIG_FORMAT,
        overlayFile: displayPath(OVERLAY_PATH),
        route: DISCOVERY_ROUTE,
        server: { host: config.host, port: config.port, runningHost: HOST, runningPort: PORT },
        gateway: {
          requireAuth: gatewayAuthRequired(),
          keys: gatewayKeys().map((entry) => ({
            name: entry.name,
            masked: maskSecret(entry.key),
            createdAt: entry.createdAt || null,
          })),
        },
        webui: {
          defaultPassword: isDefaultPassword(),
          sessionTtlHours: sessionTtlHours(),
          sessionExpiresAt: (() => {
            const expiresAt = webuiSessions.get(webuiSessionToken(req));
            return expiresAt === undefined
              ? null
              : Number.isFinite(expiresAt) ? new Date(expiresAt).toISOString() : null;
          })(),
        },
        providers: uiProviderState(),
        usage: usageSummary(),
        routes: uiRouteState(),
        migration: config.migratedFromEnv || null,
        editable: editableConfigState(),
        allRoutes: routeStatus(),
        unavailableModels: discoveryUnavailableIds,
        excludedByProvider: rejectedConfiguredModels(),
        lastSelection,
      },
      { 'Cache-Control': 'no-store' },
    );
  }
  if (req.method === 'POST' && url.pathname === '/api/keys') {
    return handleKeyUpdate(req, res);
  }
  if (req.method === 'POST' && url.pathname === '/api/gateway-keys') {
    return handleGatewayKeys(req, res);
  }
  if (req.method === 'POST' && url.pathname === '/api/webui-password') {
    return handleWebuiPassword(req, res);
  }
  if (req.method === 'POST' && url.pathname === '/api/server') {
    return handleServerConfig(req, res);
  }
  if (req.method === 'POST' && url.pathname === '/api/restart') {
    return handleRestart(req, res);
  }
  if (req.method === 'POST' && url.pathname === '/api/providers') {
    return handleProviders(req, res);
  }
  if (req.method === 'POST' && url.pathname === '/api/routes') {
    return handleRoutes(req, res);
  }
  if (req.method === 'POST' && url.pathname === '/api/limits') {
    return handleLimits(req, res);
  }
  if (req.method === 'POST' && url.pathname === '/api/discovery') {
    return handleDiscovery(req, res);
  }
  if (req.method === 'POST' && url.pathname === '/api/settings') {
    return handleSettings(req, res);
  }
  if (req.method === 'GET' && (url.pathname === '/health' || url.pathname === '/v1/health')) {
    return sendJson(res, 200, {
      ok: true,
      service: 'free-router',
      version: VERSION,
      defaultProvider: registry.defaultProvider,
      catalogModels: registry.discoveryCatalog()?.catalog?.size || 0,
      catalogFetchedAt: registry.discoveryCatalog()?.catalogFetchedAt
        ? new Date(registry.discoveryCatalog().catalogFetchedAt).toISOString()
        : null,
      catalogError: registry.discoveryCatalog()?.catalogError || null,
      providers: registry.health(),
      discovery: {
        enabled: discoveryEnabled,
        provider: registry.discoveryProvider,
        route: DISCOVERY_ROUTE,
        intervalMs: DISCOVERY_INTERVAL_MS,
        lastCheckedAt: discoveryLastCheckedAt
          ? new Date(discoveryLastCheckedAt).toISOString()
          : null,
        freeModelsSeen: discoverySeenIds.length,
        addedModels: discoveredModelIds,
        removedModels: discoveryRemovedIds,
        excludedModels: excludedModelIds(),
        unavailableModels: discoveryUnavailableIds,
        modelVerdicts,
        // Which providers can contribute new models, and which are only
        // checked for models that disappeared.
        addsFrom: [...PROVIDERS.values()].filter((p) => p.discover).map((p) => p.name),
        availabilityOnly: [...PROVIDERS.values()]
          .filter((p) => p.usesCatalog && !p.catalogHasPricing)
          .map((p) => p.name),
        evaluations: modelEvaluations,
        error: discoveryError || null,
      },
      lastSelection,
      usage: usageSummary(),
      routes: routeStatus(),
    });
  }
  if (req.method === 'GET' && url.pathname === '/v1/models') {
    const gatewayFailure = gatewayGuardFailure(req);
    if (gatewayFailure) {
      return sendJson(res, 401, { error: { message: gatewayFailure, type: 'unauthorized' } });
    }
    await refreshCatalog();
    const routeModels = Object.keys(config.routes || {}).map((id) => ({
      id,
      object: 'model',
      created: 0,
      owned_by: 'free-router',
    }));
    const listed = registry.listListedModels();
    const catalogModels = registry.listCatalogModels(listed.ids).map((model) => ({
      id: model.id,
      object: model.object,
      created: model.created,
      owned_by: model.owned_by,
      context_length: model.context_length,
    }));
    return sendJson(res, 200, {
      object: 'list',
      data: [...routeModels, ...listed.models, ...catalogModels],
    });
  }
  if (req.method === 'POST' && url.pathname === '/v1/chat/completions') {
    const gatewayFailure = gatewayGuardFailure(req);
    if (gatewayFailure) {
      return sendJson(res, 401, { error: { message: gatewayFailure, type: 'unauthorized' } });
    }
    return handleChat(req, res);
  }
  return sendJson(res, 404, {
    error: { message: `Unknown endpoint: ${req.method} ${url.pathname}`, type: 'not_found' },
  });
}

const server = http.createServer((req, res) => {
  handler(req, res).catch((error) => {
    log('unhandled request error', error);
    if (!res.headersSent) {
      sendJson(res, 500, {
        error: { message: 'Internal router error', type: 'router_internal_error' },
      });
    } else {
      res.end();
    }
  });
});

server.requestTimeout = 0;
server.headersTimeout = 65000;
server.keepAliveTimeout = 5000;

server.listen(PORT, HOST, async () => {
  log(`Free Router ${VERSION} listening on http://${HOST}:${PORT}/v1 (config: ${displayPath(CONFIG_PATH)}, ${CONFIG_FORMAT})`);
  if (UI_ENABLED) log(`web interface on http://${HOST}:${PORT}/`);
  if (gatewayAuthRequired()) {
    log(`gateway auth enabled (${gatewayKeys().length} API key(s))`);
  } else {
    log('warning: gateway auth is disabled; anyone on the network can call /v1');
  }
  if (isDefaultPassword()) log('warning: web UI still uses the default password "admin123"');
  for (const provider of PROVIDERS.values()) {
    if (!registry.hasUsableKey(provider)) log(`warning: ${provider.keyEnv} is missing`);
    else if (provider.apiKeys.length > 1) log(`${provider.name}: ${provider.apiKeys.length} keys configured`);
  }
  await refreshCatalog(true);
  await discoverFreeModels();
  scheduleNextDiscovery();
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    log(`received ${signal}; shutting down`);
    if (stateSaveTimer) flushStateSave();
    server.close(() => process.exit(0));
  });
}
