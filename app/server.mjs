#!/usr/bin/env node

import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  backupOverlayFile,
  buildLiveConfig,
  ensureConfigFile,
  ensureDir,
  firstBootSeeds,
  isPlainObject,
  loadConfigFile,
  loadOverlayFile,
  migrateLegacyStateFiles,
  OVERLAY_FILENAME,
  resolveLayout,
  runOverlayMigrations,
  saveOverlayFile,
} from './config.mjs';
import {
  hashPassword,
  hashPasswordAsync,
  isPasswordHash,
  verifyPassword,
  verifyPasswordAsync,
} from './auth.mjs';
import {
  createProviderRegistry,
  isChatModel,
  isZeroCost,
  normalizeModelSlug,
  supportsRequest,
} from './providers.mjs';
import { probeBatchPlan, responseLooksBilled } from './discovery.mjs';
import {
  CHAT_DONE_FRAME,
  chatDataFrame,
  countPayloadOutput,
  createChatStreamNormalizer,
  pickChatRequestFields,
} from './chat.mjs';
import {
  TIMEOUT_BACKOFF_CAP_MS,
  candidateCooldown,
  parseRetryAfterMs,
  timeoutBackoffMs,
} from './cooldown.mjs';
import { createRequestLog, outputTokensPerSecond, parseRequestLogLines } from './request-log.mjs';
import { formatMetrics } from './metrics.mjs';
import { corsHeaders } from './cors.mjs';
import { estimateRequestTokens, fitsContext } from './context.mjs';
import { installUpstreamProxy } from './proxy.mjs';
import { isInsufficientFunds, msUntilQuotaReset, parseQuotaFailure, permanentRejection } from './quota.mjs';
import {
  DEFAULT_MODEL_ALIAS,
  buildPool,
  isRetryableCooldown,
  orderCandidates,
  priceClass,
  prunePaymentBlocks,
  resolvePoolRequest,
  sanitizePaymentBlocks,
  seedScore,
} from './pool.mjs';
import { createSecretRedactor } from './redact.mjs';
import {
  createStreamTranslator,
  sseEvent,
  toChatRequest,
  toResponsesPayload,
} from './responses.mjs';
import { loadSweBenchScores, sweBenchScoreFor } from './swe-bench.mjs';
import {
  describeLanAccess,
  isLocalHostname,
  lanGuard,
  loginLockout,
  pruneLoginFailures as pruneLoginStates,
  recordLoginFailure,
} from './net.mjs';
import { normalizeTimeZone } from './timezones.mjs';
import { mergeVerdict, verdictFor as cachedVerdictFor } from './verdicts.mjs';
import { listSessions, pruneExpiredSessions, revokeSessions, sessionId } from './sessions.mjs';
import { formatAuditLine, parseAuditLines } from './audit.mjs';
import {
  gatewayKeyState,
  gatewayUsageFor,
  parseDailyLimit,
  parseExpiry,
  recordGatewayUse,
  sanitizeGatewayUsage,
} from './gateway-keys.mjs';
import { PINNED_SCORE, USAGE_KINDS, classifyFailure, ewmaLatency, isClientFaultExhaustion, isCredentialFault, latencyAdjustment, metadataBonus, metadataScore, normalizeScore, pickExplorationTarget, qualityTotals } from './ranking.mjs';
import {
  createStreamSignatureExtractor,
  createThoughtSignatureCache,
  injectThoughtSignatures,
  isMissingThoughtSignatureError,
  providerNeedsThoughtSignatures,
  rememberSignaturesFromPayload,
} from './thought-signature.mjs';
import { displayPath, maskSecret, renderPage, updateEnvFile, validateSecret } from './ui.mjs';
import { FAVICON_SVG, MASK_ICON_SVG, appleTouchIconPng } from './icons.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LAYOUT = resolveLayout({
  appDir: HERE,
  configPath: process.env.FREE_ROUTER_CONFIG || '',
  dataDir: process.env.FREE_ROUTER_DATA_DIR || '',
});
const REPO_ROOT = LAYOUT.repoDir;
const VERSION = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')).version;

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

ensureDir(LAYOUT.dataDir);
// Legacy upgrade only for the default layout: a custom config/data dir
// means the operator manages placement explicitly (and tests must never
// touch the real repo root).
if (!process.env.FREE_ROUTER_CONFIG && !process.env.FREE_ROUTER_DATA_DIR) {
  for (const name of migrateLegacyStateFiles({ repoDir: LAYOUT.repoDir, dataDir: LAYOUT.dataDir })) {
    log(`moved legacy ${name} to ${displayPath(LAYOUT.dataDir)}/`);
  }
}

const envCandidates = [...LAYOUT.envFiles, path.join(os.homedir(), '.hermes', '.env')];
// .env files are a first-boot seed inbox only: once an overlay exists, file
// content is ignored so UI edits (host/port/password) always take effect.
// Explicit process environment still wins everywhere.
const overlayExists = fs.existsSync(LAYOUT.overlayPath);
if (!overlayExists) {
  for (const file of envCandidates) {
    if (file) loadEnvFile(file);
  }
} else {
  log(`overlay exists; skipping .env files (${displayPath(LAYOUT.dataDir)}/.env is seed-only)`);
}

const CONFIG_PATH = LAYOUT.basePath;
const OVERLAY_PATH = LAYOUT.overlayPath;
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
  // Starting on defaults here would quietly drop every key, key slot and the
  // admin password the operator configured — worse than not starting at all.
  // Refuse, point at the file, and leave the broken one untouched for repair.
  console.error(
    `refusing to start: cannot parse ${displayPath(OVERLAY_PATH)}: ${overlayLoaded.error}`,
  );
  console.error(
    `Fix the JSON in that file, or restore ${displayPath(OVERLAY_PATH)}.bak from the last save.`,
  );
  process.exit(1);
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
  backupOverlayFile(OVERLAY_PATH);
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
// How long a stream may stay headerless while waiting for the first content or
// tool-call delta. Thinking models stream reasoning long before content; held
// headers read as a hang to browsers and proxies (OpenWebUI shows an empty
// reply), so the buffered prefix is flushed once this grace expires. Streams
// that finish inside the grace with nothing useful still fail over as before.
function streamCommitGraceMs() {
  const raw = Number(
    process.env.FREE_ROUTER_STREAM_COMMIT_GRACE_MS || config.streamCommitGraceMs || 10000,
  );
  return Number.isFinite(raw) && raw >= 0 ? raw : 10000;
}
// A stream that has produced no body byte by this deadline is stuck, not slow:
// abort the attempt so the next candidate can answer instead of holding the
// client for the whole attempt timeout. It covers both waits, for response
// headers and for the first chunk after them. Streaming only; 0 disables it.
function firstByteTimeoutMs() {
  const env = process.env.FREE_ROUTER_FIRST_BYTE_TIMEOUT_MS;
  const raw = Number(
    env === undefined || env === '' ? config.firstByteTimeoutMs ?? 30000 : env,
  );
  return Number.isFinite(raw) && raw >= 0 ? raw : 30000;
}
// After the headers are committed, a model can think for a long while between
// tokens. SSE comment lines keep proxies and clients from timing out a stream
// that is healthy; 0 disables the comments.
function streamKeepAliveMs() {
  const env = process.env.FREE_ROUTER_STREAM_KEEPALIVE_MS;
  const raw = Number(
    env === undefined || env === '' ? config.streamKeepAliveMs ?? 15000 : env,
  );
  return Number.isFinite(raw) && raw >= 0 ? raw : 15000;
}
// Once a response is committed the client is reading a real answer, so a long
// generation must not be cut by a total timer. Only a silent gap means the
// upstream is stuck: abort when no byte arrives for this long. 0 disables it.
function streamIdleTimeoutMs() {
  const env = process.env.FREE_ROUTER_STREAM_IDLE_TIMEOUT_MS;
  const raw = Number(
    env === undefined || env === '' ? config.streamIdleTimeoutMs ?? 60000 : env,
  );
  return Number.isFinite(raw) && raw >= 0 ? raw : 60000;
}
// Wall-clock budget for finding a candidate that answers: every failover
// attempt shares it. A committed stream is not cut by it (the idle timeout
// covers a dead upstream), so long answers still finish.
function requestBudgetMs() {
  const env = process.env.FREE_ROUTER_REQUEST_BUDGET_MS;
  const raw = Number(
    env === undefined || env === '' ? config.requestBudgetMs ?? 300000 : env,
  );
  return Number.isFinite(raw) && raw >= 1000 ? raw : 300000;
}
let catalogRefreshMs = Number(config.catalogRefreshMs || 900000);
const registry = createProviderRegistry(config, { host: HOST, port: PORT });
const PROVIDERS = registry.providers;
const discoveryConfig = config.discovery || {};
let discoveryEnabled = discoveryConfig.enabled !== false;
const DISCOVERY_INTERVAL_MS = Number(discoveryConfig.intervalMs || 7 * 24 * 60 * 60 * 1000);
// How long a "not free" verdict stands before the model is worth asking again.
const VERDICT_RETRY_MS = Number(discoveryConfig.verdictRetryMs || DISCOVERY_INTERVAL_MS);
const DISCOVERY_STATE_PATH = LAYOUT.statePath(discoveryConfig.stateFile);
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
// Background free-tier probing: small batches with a pause between them so a
// large catalog drains without hammering the provider in one burst.
const PROBE_BATCH_SIZE = Math.max(1, Number(evaluationConfig.probeBatchSize || 3));
const PROBE_BATCH_DELAY_MS = Math.max(0, Number(evaluationConfig.probeBatchDelayMs ?? 2000));
const PROBE_MAX_PER_PROVIDER = Math.max(1, Number(evaluationConfig.probeMaxPerProvider || 100));
// A paid model that reports insufficient funds stays parked this long. Only
// that provider:model, never the provider or its key.
const INSUFFICIENT_FUNDS_MS = Math.max(60000, Number(config.cooldownMs?.insufficientFunds || 86400000));
const RANK_USAGE_WEIGHT = Math.max(0, Number(evaluationConfig.usageWeight ?? 12));
const RANK_USAGE_MIN_REQUESTS = Math.max(1, Number(evaluationConfig.usageMinRequests || 20));
const PINNED_MODELS = new Set(evaluationConfig.pinnedModels || []);
// Static capability prior for models with no configured anchor and no
// evaluation score yet. Loaded once; a missing table just means no prior.
const SWE_BENCH_SCORES = loadSweBenchScores(path.join(HERE, 'data', 'swe-bench.json'));
const usageConfig = config.usage || {};
const USAGE_RETENTION_DAYS = Math.max(1, Number(usageConfig.retentionDays || 7));
const USAGE_TIMEZONE = String(usageConfig.timezone || '');
// Kind vocabulary lives in app/ranking.mjs (single source of truth, shared
// with the bucket contract enforced by unit tests).
// A rejected request never reaches the model, so it does not burn daily quota.
const USAGE_NON_CONSUMING = new Set(['rateLimit', 'notFound', 'forbidden', 'payment']);
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
// First existing seed file wins (data/.env, then the repo-root legacy);
// fresh installs write back to data/.env.
const UI_ENV_PATH =
  LAYOUT.envFiles.find((file) => {
    try {
      return fs.existsSync(file);
    } catch {
      return false;
    }
  }) || path.resolve(LAYOUT.dataDir, uiConfig.envFile || '.env');
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

async function checkWebuiPassword(input) {
  const password = String(input || '');
  if (!password) return false;
  if (process.env.FREE_ROUTER_WEBUI_PASSWORD) {
    return verifyPasswordAsync(password, process.env.FREE_ROUTER_WEBUI_PASSWORD);
  }
  return verifyPasswordAsync(password, storedWebuiPassword());
}

// One-time upgrade: replace a plaintext stored password with a salted hash.
// Runs at boot and after successful legacy logins (operators hand-editing
// the file between restarts converge on the next login either way).
async function upgradePasswordStorage(reason) {
  if (process.env.FREE_ROUTER_WEBUI_PASSWORD) return;
  const stored = storedWebuiPassword();
  if (isPasswordHash(stored)) return;
  setStoredWebuiPassword(await hashPasswordAsync(stored));
  log(`upgraded web UI password storage to salted scrypt hash (${reason})`);
}
// Login session TTL in hours (default 24, 0 = never expires).
const sessionTtlHours = () => {
  const raw = Number(config.webui?.sessionTtlHours ?? 24);
  return Number.isFinite(raw) && raw >= 0 ? raw : 24;
};
const webuiSessions = new Map();
// Failed web UI logins per client IP: 5 strikes lock the IP for 5 minutes
// (see app/net.mjs). Success clears the record; expired locks prune lazily.
const loginFailures = new Map();
function pruneLoginFailures(now = Date.now()) {
  pruneLoginStates(loginFailures, now);
}
function webuiSessionToken(req) {
  const cookie = String(req.headers.cookie || '');
  const match = cookie.match(/(?:^|;\s*)fr_session=([^;]+)/);
  return match ? decodeURIComponent(match[1]) : '';
}
function pruneWebuiSessions() {
  pruneExpiredSessions(webuiSessions);
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
  // First boot only (guarded by migratedFromEnv above): file-provided
  // host/port/password move into the overlay once, so later UI edits win
  // and the ignore-.env-after-first-boot rule has something to stand on.
  const seeds = firstBootSeeds(fileVars, overlay);
  if (seeds.host !== undefined) setOverlayValue(['host'], seeds.host);
  if (seeds.port !== undefined) setOverlayValue(['port'], seeds.port);
  if (seeds.password !== undefined) {
    setStoredWebuiPassword(hashPassword(seeds.password), { persist: false });
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
await upgradePasswordStorage('boot');

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

function gatewayKeyUsedToday(name) {
  return gatewayUsageFor(gatewayKeyUsage, name, usageDay());
}

function recordGatewayKeyUse(name) {
  recordGatewayUse(gatewayKeyUsage, name, usageDay(), USAGE_RETENTION_DAYS);
  scheduleStateSave();
}

// Validates the bearer key without counting the call. /metrics uses this so a
// scrape never eats into a client's daily quota.
function gatewayCredentialFailure(req) {
  if (!gatewayAuthRequired()) return null;
  const key = bearerKey(req);
  if (!key) {
    return { status: 401, type: 'unauthorized', message: 'missing API key (Authorization: Bearer <key>)' };
  }
  const entry = gatewayKeys().find((item) => item.key === key);
  if (!entry) return { status: 401, type: 'unauthorized', message: 'invalid API key' };
  const state = gatewayKeyState(entry, {
    now: Date.now(),
    used: gatewayKeyUsedToday(entry.name),
    timeZone: USAGE_TIMEZONE || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
  });
  if (!state.ok) {
    return {
      status: state.status,
      type: state.status === 429 ? 'rate_limited' : 'unauthorized',
      message: state.message,
      retryAfterMs: state.retryAfterMs,
    };
  }
  return null;
}

// Returns null when the call may proceed, else the refusal to send. Counting
// happens here, so every authenticated /v1 call (models included) uses quota.
function gatewayGuard(req) {
  if (!gatewayAuthRequired()) return null;
  const failure = gatewayCredentialFailure(req);
  if (failure) return failure;
  const entry = gatewayKeys().find((item) => item.key === bearerKey(req));
  if (entry) recordGatewayKeyUse(entry.name);
  return null;
}

function sendGatewayFailure(res, failure) {
  const headers = failure.retryAfterMs
    ? { 'Retry-After': String(Math.max(1, Math.ceil(failure.retryAfterMs / 1000))) }
    : {};
  return sendJson(res, failure.status, { error: { message: failure.message, type: failure.type } }, headers);
}

const cooldowns = new Map();
const thoughtSignatures = createThoughtSignatureCache();
// Finished client gateway calls for the Logs tab. Metadata only, in memory:
// nothing here survives a restart and nothing carries request content.
const clientRequestLog = createRequestLog();
// Process lifetime counters for /metrics. The request log is a bounded ring
// and is cleared by the operator, so it cannot answer "how many requests has
// this process served"; these counters only ever grow.
const processTotals = {
  startedAt: Date.now(),
  requests: 0,
  outcomes: {},
  inputTokens: 0,
  outputTokens: 0,
  durationMs: 0,
  firstTokenMs: 0,
  firstTokenSamples: 0,
};

function recordProcessTotals(entry) {
  processTotals.requests += 1;
  const outcome = entry.outcome || 'failed';
  processTotals.outcomes[outcome] = (processTotals.outcomes[outcome] || 0) + 1;
  processTotals.durationMs += Number(entry.durationMs) || 0;
  if (typeof entry.firstTokenMs === 'number') {
    processTotals.firstTokenMs += entry.firstTokenMs;
    processTotals.firstTokenSamples += 1;
  }
  processTotals.inputTokens += Number(entry.inputTokens) || 0;
  processTotals.outputTokens += Number(entry.outputTokens) || 0;
}
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
// Paid models parked after an insufficient-funds answer, keyed by
// `provider:model`. Persisted: a restart must not resurrect a model whose
// account cannot pay for it.
let paymentBlocks = {};
// Per-provider probe drains (background, budget-limited).
const probeTimers = new Map();
const probeRunning = new Set();
let lastSelection = null;
let usageByDay = {};
// Gateway client-key request counts per day, keyed by key name (never value).
let gatewayKeyUsage = {};
// Live latency portraits (EWMA mean + sample count per model key). Persisted
// next to usage; pruned with it. Feeds the small capped latency term.
let usageLatency = {};
let stateSaveTimer = null;

function log(message, detail = undefined) {
  const prefix = `[${new Date().toISOString()}]`;
  if (detail === undefined) console.log(prefix, message);
  else console.log(prefix, message, detail);
}

// Optional request-log persistence: off by default (the log is metadata-only
// and memory-only unless the operator opts in). One JSON object per line,
// rotated at 5 MB, reloaded into the ring at boot.
const REQUEST_LOG_PATH = LAYOUT.statePath('request-log.jsonl');
const REQUEST_LOG_MAX_BYTES = 5 * 1024 * 1024;
function requestLogPersistEnabled() {
  return config.webui?.requestLogPersist === true;
}
function appendRequestLog(record) {
  if (!requestLogPersistEnabled()) return;
  try {
    if (fs.existsSync(REQUEST_LOG_PATH) && fs.statSync(REQUEST_LOG_PATH).size > REQUEST_LOG_MAX_BYTES) {
      fs.renameSync(REQUEST_LOG_PATH, `${REQUEST_LOG_PATH}.1`);
    }
    fs.appendFileSync(REQUEST_LOG_PATH, `${JSON.stringify(record)}\n`, { mode: 0o600 });
  } catch (error) {
    log(`failed to persist request log: ${error instanceof Error ? error.message : String(error)}`);
  }
}
function loadPersistedRequestLog() {
  if (!requestLogPersistEnabled() || !fs.existsSync(REQUEST_LOG_PATH)) return;
  try {
    const text = fs.readFileSync(REQUEST_LOG_PATH, 'utf8');
    for (const record of parseRequestLogLines(text, { limit: clientRequestLog.capacity })) {
      clientRequestLog.add(record);
    }
  } catch (error) {
    log(`failed to load persisted request log: ${error instanceof Error ? error.message : String(error)}`);
  }
}

// Security-relevant actions go to an append-only JSONL file next to the
// state. Writes are best effort (an audit failure must never fail the action)
// and the file rotates once at 5 MB, keeping one previous file.
const AUDIT_PATH = path.join(LAYOUT.dataDir, 'audit.log');
const AUDIT_MAX_BYTES = 5 * 1024 * 1024;
function audit(action, { actor = 'admin', target = '', result = 'ok', detail = '', ip = '' } = {}) {
  try {
    if (fs.existsSync(AUDIT_PATH) && fs.statSync(AUDIT_PATH).size > AUDIT_MAX_BYTES) {
      fs.renameSync(AUDIT_PATH, `${AUDIT_PATH}.1`);
    }
    fs.appendFileSync(AUDIT_PATH, `${formatAuditLine({ action, actor, target, result, detail, ip })}\n`, {
      mode: 0o600,
    });
  } catch (error) {
    log(`failed to write audit log: ${error instanceof Error ? error.message : String(error)}`);
  }
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

function isPinnedKey(key) {
  const modelId = key.includes(':') ? key.slice(key.indexOf(':') + 1) : key;
  return PINNED_MODELS.has(key) || PINNED_MODELS.has(modelId);
}

// Capability portrait for a ranked key: null when the provider is unknown,
// so callers award no bonus instead of guessing.
function metadataForKey(key) {
  const parsed = registry.parsePrefixed(key);
  if (!parsed) return null;
  return candidateMetadata(parsed);
}

// A negative verdict is worth acting on but not worth trusting forever: a
// provider blip would otherwise retire a model permanently with no way back.
// Positive verdicts need no expiry, since ordinary traffic revisits them and a
// later refusal overwrites them.
function verdictFor(key) {
  return cachedVerdictFor(modelVerdicts, key, Date.now(), VERDICT_RETRY_MS);
}

function setModelVerdict(key, verdict) {
  // Always refresh observedAt, even when the answer did not change: a model
  // that keeps failing must not keep its stale timestamp and be re-probed on
  // every request once the TTL passes.
  modelVerdicts[key] = mergeVerdict(modelVerdicts[key], verdict, new Date().toISOString());
  scheduleStateSave();
}

// Models named in config.json: a provider allowlist or an explicit selection.
function configuredCandidateKeys() {
  const keys = new Set();
  for (const provider of PROVIDERS.values()) {
    for (const model of provider.freeModels) keys.add(`${provider.name}:${model}`);
    for (const model of provider.selectedModels) keys.add(`${provider.name}:${model}`);
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
  return registry.parsePrefixed(id) || { provider: registry.defaultProvider, model: id };
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
  for (const id of discoverySeenIds) {
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
  // Latency portraits without usage in the window are stale: drop them so
  // retired models stop influencing the ranking.
  const seen = new Set();
  for (const perDay of Object.values(usageByDay)) {
    for (const key of Object.keys(perDay || {})) seen.add(key);
  }
  for (const key of Object.keys(usageLatency)) {
    if (!seen.has(key)) delete usageLatency[key];
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

function recordLatency(candidate, latencyMs) {
  const key = candidateKey(candidate);
  const next = ewmaLatency(usageLatency[key], latencyMs);
  if (next) usageLatency[key] = next;
  scheduleStateSave();
}

function latencyAdjustmentFor(key) {
  const entry = usageLatency[key];
  if (!entry || typeof entry !== 'object') return 0;
  return latencyAdjustment(entry.meanMs, entry.n);
}

// All live (traffic-driven) score adjustments in one place so ordering and
// display can never diverge.
function liveScoreAdjustment(key) {
  return usageAdjustment(key) + latencyAdjustmentFor(key);
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
    gatewayKeyUsage = sanitizeGatewayUsage(state.gatewayUsage, usageDays());
    usageLatency = {};
    const storedLatency = state.latency;
    if (storedLatency && typeof storedLatency === 'object') {
      for (const [key, entry] of Object.entries(storedLatency)) {
        if (!entry || typeof entry !== 'object') continue;
        const meanMs = Number(entry.meanMs);
        const n = Math.floor(Number(entry.n));
        if (Number.isFinite(meanMs) && meanMs >= 0 && Number.isInteger(n) && n > 0) {
          usageLatency[key] = { meanMs, n };
        }
      }
    }
    pruneUsage();
    // Verdicts, scores, the 24h payment blocks, and the last selection are
    // evidence about models, not discovery bookkeeping: they stay meaningful
    // even when automatic discovery is switched off.
    modelVerdicts =
      state.modelVerdicts && typeof state.modelVerdicts === 'object' ? state.modelVerdicts : {};
    modelEvaluations =
      state.evaluations && typeof state.evaluations === 'object' ? state.evaluations : {};
    paymentBlocks = sanitizePaymentBlocks(state.paymentBlocks);
    const pruned = prunePaymentBlocks(paymentBlocks);
    paymentBlocks = pruned.blocks;
    if (state.lastSelection && typeof state.lastSelection === 'object') {
      lastSelection = state.lastSelection;
    }
    if (!discoveryEnabled) return;
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
    discoveryLastCheckedAt = Date.parse(state.lastCheckedAt || '') || 0;
  } catch (error) {
    discoveryError = `state load failed: ${error instanceof Error ? error.message : String(error)}`;
    log(discoveryError);
  }
}

function saveDiscoveryState() {
  const payload = {
    lastCheckedAt: new Date(discoveryLastCheckedAt).toISOString(),
    freeModels: discoverySeenIds,
    removedModels: discoveryRemovedIds,
    excludedModels: discoveryExcludedIds,
    unavailableModels: discoveryUnavailableIds,
    modelVerdicts,
    evaluations: modelEvaluations,
    paymentBlocks,
    lastSelection,
    usage: usageByDay,
    gatewayUsage: gatewayKeyUsage,
    latency: usageLatency,
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
  const modelId = String(key).includes(':') ? String(key).slice(String(key).indexOf(':') + 1) : key;
  const explicit = Number(
    evaluationConfig.baselineScores?.[key] ?? evaluationConfig.baselineScores?.[modelId],
  );
  if (!Number.isFinite(explicit)) return null;
  return normalizeScore(explicit);
}

function modelIdFromKey(key) {
  return String(key).includes(':') ? String(key).slice(String(key).indexOf(':') + 1) : String(key);
}

function configuredScore(id, configuredIndex) {
  const explicit = explicitScore(id);
  if (explicit !== null) return explicit;
  return seedScore(configuredIndex);
}

// Observed reliability nudges a model up or down once it has served enough
// traffic to be more trustworthy than a single one-shot evaluation.
// Only quality failures count: capacity signals (rateLimit/timeout) and
// routing faults (notFound/forbidden) describe conditions, not the model.
function usageAdjustment(key) {
  if (!RANK_USAGE_WEIGHT) return 0;
  const counts = {};
  for (const day of usageDays()) mergeUsage(counts, usageByDay[day]?.[key]);
  const totals = qualityTotals(counts);
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
  if (PINNED_MODELS.has(key) || PINNED_MODELS.has(modelId)) return PINNED_SCORE;
  if (configured.has(key)) {
    return configuredScore(key, configuredIndex.get(key)) + metadataBonus(metadataForKey(key));
  }
  for (const [configuredKey, index] of configuredIndex) {
    if (keySlug(configuredKey) === slug) {
      return configuredScore(configuredKey, index) + metadataBonus(metadataForKey(key));
    }
  }
  const explicit = explicitScore(key);
  if (explicit !== null) return explicit;
  const evaluated = Number(modelEvaluations[modelId]?.score);
  if (Number.isFinite(evaluated)) return evaluated;
  // No local measurement yet: fall back to the published capability prior,
  // which is weaker evidence but better than treating every newcomer as worst.
  const prior = sweBenchScoreFor(SWE_BENCH_SCORES, modelId);
  return prior !== null ? prior : -1;
}

function rankedModelScore(key, configured, configuredIndex) {
  const base = baseModelScore(key, configured, configuredIndex);
  if (!Number.isFinite(base) || base < 0) return base;
  if (isPinnedKey(key)) return base;
  return Math.round((base + liveScoreAdjustment(key)) * 10) / 10;
}

function scoreSourceFor(key, configured) {
  if (configured.has(key)) return 'baseline';
  const slug = keySlug(key);
  for (const configuredKey of configured) {
    if (keySlug(configuredKey) === slug) return 'baseline';
  }
  if (explicitScore(key) !== null) return 'baseline';
  const modelId = modelIdFromKey(key);
  if (Number.isFinite(Number(modelEvaluations[modelId]?.score))) return 'evaluation';
  if (sweBenchScoreFor(SWE_BENCH_SCORES, modelId) !== null) return 'swe-bench';
  return 'unranked';
}

function groupRank(group, configuredSet, configuredIndex) {
  let pinned = false;
  let pinIndex = Number.POSITIVE_INFINITY;
  let configuredIdx = Number.POSITIVE_INFINITY;
  let configuredKey = '';
  let evalScore = -1;
  let sweScore = -1;
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
    const prior = sweBenchScoreFor(SWE_BENCH_SCORES, candidate.model);
    if (prior !== null) sweScore = Math.max(sweScore, prior);
  }
  for (const [key, index] of configuredIndex) {
    if (keySlug(key) !== group.slug || index >= configuredIdx) continue;
    configuredIdx = index;
    configuredKey = key;
  }
  const base = pinned
    ? PINNED_SCORE
    : configuredIdx !== Number.POSITIVE_INFINITY
      ? configuredScore(configuredKey, configuredIdx) +
        metadataBonus(group.members.length ? candidateMetadata(group.members[0].candidate) : null)
      : explicit !== null
        ? explicit
        : evalScore >= 0
          ? evalScore
          : sweScore;
  let score = base;
  if (!pinned && Number.isFinite(base) && base >= 0) {
    const adjustments = group.members.map(({ candidate }) =>
      liveScoreAdjustment(candidateKey(candidate)),
    );
    score = base + (adjustments.length ? Math.max(...adjustments) : 0);
  }
  return { pinned, score, tie: pinned ? pinIndex : group.firstIndex };
}

function groupScarcity(group) {
  const first = group?.members?.[0]?.candidate;
  if (!first) return null;
  return usageForKey(candidateKey(first)).remainingToday;
}

// The implicit pool replaces the route lists. Membership and free/paid labels
// come from app/pool.mjs; this file only supplies the live signals: verdicts,
// exclusion patterns, and the persisted payment blocks.
function currentPool() {
  return buildPool({
    providers: [...PROVIDERS.values()],
    verdictFor,
    excludeReason: (key) => discoveryExclusionReason(key),
    paymentBlocks,
  });
}

// An explicit list position (allowlist or selection order) is the only
// hand-authored anchor left, so it seeds the score ladder.
function poolRanking(pool) {
  const configuredSet = new Set();
  const configuredIndex = new Map();
  for (const entry of [...pool.free, ...pool.paid]) {
    if (entry.seedIndex === null || entry.seedIndex === undefined) continue;
    if (configuredSet.has(entry.key)) continue;
    configuredSet.add(entry.key);
    configuredIndex.set(entry.key, entry.seedIndex + 1);
  }
  return { configuredSet, configuredIndex };
}

function rankFreePool(pool, configuredSet, configuredIndex) {
  return orderCandidates(pool.free, {
    rankGroup: (group) => groupRank(group, configuredSet, configuredIndex),
    scarcityFor: groupScarcity,
    siblingsFor: (slug) =>
      pool.free.filter((entry) => normalizeModelSlug(entry.model) === slug),
  });
}

function orderedPool() {
  const pool = currentPool();
  const { configuredSet, configuredIndex } = poolRanking(pool);
  return {
    pool,
    configuredSet,
    configuredIndex,
    free: rankFreePool(pool, configuredSet, configuredIndex),
    paid: pool.paid,
  };
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
  if (gone.length) log(`no longer offered upstream; skipped in the pool`, gone);
  if (restored.length) log(`offered upstream again; restored to the pool`, restored);
  scheduleStateSave();
}

async function refreshCatalog(force = false) {
  await registry.refreshCatalogs(force, catalogRefreshMs, log);
  syncModelAvailability();
}

// A request must not wait on a provider catalog round trip: the snapshot it
// already has is good enough to route. Only a cold start (a catalog that has
// never loaded) blocks, because otherwise every model would look unavailable.
function catalogsCold() {
  return [...PROVIDERS.values()].some(
    (provider) => provider.usesCatalog && !(provider.catalog?.size > 0),
  );
}

function refreshCatalogSoon() {
  refreshCatalog().catch((error) => {
    log(`catalog refresh failed: ${error instanceof Error ? error.message : String(error)}`);
  });
}

// Requests only piggyback on a stale catalog; this timer keeps it fresh even
// when the gateway is idle. The delay is re-read every round so a settings
// change applies without a restart.
function scheduleNextCatalogRefresh() {
  const delay = Math.max(60000, Number(catalogRefreshMs) || 900000);
  const timer = setTimeout(async () => {
    try {
      await refreshCatalog();
    } catch (error) {
      log(`catalog refresh failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    scheduleNextCatalogRefresh();
  }, delay);
  timer.unref?.();
}

// One provider, usually because its key just became usable: refreshing every
// catalog would spend a request per provider to learn nothing about the rest.
async function refreshProviderCatalog(name) {
  if (!PROVIDERS.get(name)?.usesCatalog) return;
  try {
    await registry.refreshCatalogFor(name, true, catalogRefreshMs);
  } catch (error) {
    log(`catalog refresh for ${name} failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  scheduleProbeDrain(name, 0);
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

async function evaluateModel(target) {
  const startedAt = Date.now();
  const candidate =
    typeof target === 'string'
      ? { provider: registry.defaultProvider, model: target }
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
  // Ask for as little thinking as the provider understands. Sending
  // `reasoning` to a model that only advertises `reasoning_effort` (or the
  // reverse) is how the evaluation used to spend its budget on thinking.
  if (supported.has('reasoning_effort')) {
    evaluationBody.reasoning_effort = 'low';
  } else if (supported.has('reasoning')) {
    evaluationBody.reasoning = { effort: 'low' };
  }
  const result = await attemptJson(candidate, evaluationBody);
  const latencyMs = Date.now() - startedAt;
  if (!isCredentialFault(result.status)) {
    recordUsage(candidate, result.ok ? 'ok' : result.kind || 'other');
  }
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
  // Serving the request is not proof it was free when the response carries a
  // positive bill. That answer costs money, so the model must not enter a
  // zero-cost route no matter what the catalog published.
  if (responseLooksBilled(result.payload)) {
    setModelVerdict(candidateKey(candidate), {
      free: false,
      reason: 'probe response reported billing',
    });
    return {
      status: 'pending',
      version: EVALUATION_VERSION,
      attemptedAt: new Date().toISOString(),
      latencyMs,
      error: 'probe response reported billing',
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
// model is free is to ask it. Probes run in the background in small batches,
// so adding a provider starts producing free models without blocking the
// request and without hammering the upstream with a whole catalog at once.
function probePendingCount(name) {
  const provider = PROVIDERS.get(name);
  if (!provider?.probeFreeTier) return 0;
  return probeBatchPlan({
    provider,
    verdictFor,
    isExcluded: (key) => discoveryExclusionReason(key),
    limit: PROBE_MAX_PER_PROVIDER,
  }).candidates.length;
}

function scheduleProbeDrain(name, delayMs = 0) {
  if (!discoveryEnabled || !evaluationEnabled) return;
  const provider = PROVIDERS.get(name);
  if (!provider?.probeFreeTier || !registry.hasUsableKey(provider)) return;
  if (probeTimers.has(name) || probeRunning.has(name)) return;
  const timer = setTimeout(() => {
    probeTimers.delete(name);
    runProbeBatch(name).catch((error) => {
      log(`free-tier probing failed for ${name}: ${error instanceof Error ? error.message : String(error)}`);
    });
  }, Math.max(0, Number(delayMs) || 0));
  timer.unref?.();
  probeTimers.set(name, timer);
}

async function runProbeBatch(name) {
  if (!discoveryEnabled || !evaluationEnabled) return;
  const provider = PROVIDERS.get(name);
  if (!provider?.probeFreeTier || !registry.hasUsableKey(provider) || !provider.catalog?.size) return;
  if (probeRunning.has(name)) return;
  probeRunning.add(name);
  let nextDelayMs = PROBE_BATCH_DELAY_MS;
  try {
    const plan = probeBatchPlan({
      provider,
      verdictFor,
      isExcluded: (key) => discoveryExclusionReason(key),
      limit: PROBE_BATCH_SIZE,
    });
    if (!plan.candidates.length) return;
    log(`probing ${plan.candidates.length} ${name} model(s) for free-tier access`, plan.candidates);
    for (const model of plan.candidates) {
      if (!discoveryEnabled || !evaluationEnabled) break;
      const candidate = { provider: name, model };
      const key = candidateKey(candidate);
      const evaluation = await evaluateModel(candidate);
      if (evaluation.status === 'scored') {
        modelEvaluations[model] = evaluation;
        log(`${key} is free: score ${evaluation.score}`);
      } else if (modelVerdicts[key]?.free === false) {
        log(`excluding ${key}: ${modelVerdicts[key]?.reason || 'not free'}`);
      } else {
        log(`probe inconclusive for ${key}: ${evaluation.error}`);
        // A billing or rate-limit answer says the batch should wait, not that
        // the next model will answer differently.
        if (/(^|\D)(402|403|429)(\D|$)/.test(evaluation.error || '')) {
          nextDelayMs = 60000;
          break;
        }
      }
      saveDiscoveryState();
    }
  } finally {
    probeRunning.delete(name);
  }
  if (probePendingCount(name) > 0) scheduleProbeDrain(name, nextDelayMs);
}

function clearProbeTimers(name) {
  const timer = probeTimers.get(name);
  if (timer) clearTimeout(timer);
  probeTimers.delete(name);
}

async function performFreeModelDiscovery(forceCatalogRefresh = false) {
  if (!discoveryEnabled) return;
  if (
    discoveryLastCheckedAt &&
    Date.now() - discoveryLastCheckedAt < DISCOVERY_INTERVAL_MS
  ) {
    return;
  }

  const seen = [];
  const excluded = new Map();
  const freeEntries = [];
  try {
    if (forceCatalogRefresh || ![...PROVIDERS.values()].some((provider) => provider.catalog?.size)) {
      await refreshCatalog(true);
    }

    // Every priced catalog contributes its own zero-cost chat models. A
    // provider whose listing failed keeps its previous membership: absence in
    // a failed fetch is not evidence that a model was withdrawn.
    for (const provider of PROVIDERS.values()) {
      if (!provider.catalogHasPricing || !provider.catalog?.size) continue;
      // No key means the models cannot be called, so neither their membership
      // nor their score matters yet. Adding a key refreshes this provider's
      // catalog; the next discovery run scores what became usable.
      if (!registry.hasUsableKey(provider)) continue;
      for (const model of provider.catalog.values()) {
        if (!model || typeof model.id !== 'string' || !model.id) continue;
        if (!isZeroCost(model) || !isChatModel(model)) continue;
        const key = `${provider.name}:${model.id}`;
        // An explicit selection outranks the domain filter.
        if (!provider.selectedModels.has(model.id)) {
          const reason = discoveryExclusionReason(key);
          if (reason) {
            excluded.set(key, reason);
            continue;
          }
        }
        seen.push(key);
        freeEntries.push({ provider: provider.name, model: model.id });
      }
    }

    discoveryExcludedIds = [...excluded.keys()].sort();
    if (excluded.size) {
      log(
        `excluding ${excluded.size} domain-specific model(s) from automatic discovery`,
        [...excluded].map(([key, reason]) => `${key} (${reason})`),
      );
    }
    // Entries that stopped being zero-cost or were withdrawn upstream. Only a
    // successful catalog fetch can judge this, which the loop above guarantees.
    discoveryRemovedIds = discoverySeenIds.filter((key) => !seen.includes(key));
    if (discoveryRemovedIds.length) {
      log(`removed ${discoveryRemovedIds.length} non-free or unavailable model(s)`, discoveryRemovedIds);
    }
    discoverySeenIds = seen;

    // Benchmark models that are free but have no current score. Scores are
    // keyed by bare model id: a benchmark describes the model, not the provider
    // serving it.
    const toEvaluate = [];
    for (const entry of freeEntries) {
      const evaluation = modelEvaluations[entry.model];
      if (evaluation?.status === 'scored' && evaluation.version === EVALUATION_VERSION) continue;
      if (verdictFor(`${entry.provider}:${entry.model}`)?.free === false) continue;
      toEvaluate.push(entry);
      if (toEvaluate.length >= EVALUATION_MAX_PER_RUN) break;
    }
    if (evaluationEnabled && toEvaluate.length) {
      log(`evaluating ${toEvaluate.length} free model(s)`);
      for (const entry of toEvaluate) {
        const candidate = { provider: entry.provider, model: entry.model };
        const evaluation = await evaluateModel(candidate);
        modelEvaluations[entry.model] = evaluation;
        if (evaluation.status === 'scored') {
          log(`evaluated ${candidateKey(candidate)}: score ${evaluation.score}`);
        } else {
          log(`evaluation deferred for ${candidateKey(candidate)}: ${evaluation.error}`);
        }
        saveDiscoveryState();
      }
    }

    discoveryError = '';
  } catch (error) {
    discoveryError = error instanceof Error ? error.message : String(error);
    log(`free-model discovery failed: ${discoveryError}`);
  }

  // Probing is independent of the priced catalogs and of their failures.
  if (evaluationEnabled) {
    for (const provider of PROVIDERS.values()) {
      if (!provider.probeFreeTier) continue;
      scheduleProbeDrain(provider.name, 0);
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
loadPersistedRequestLog();

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
    estimatedTokens: estimateRequestTokens(body),
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

// Consecutive timeouts per candidate/key. A model that kept hanging is not
// worth retrying on the same five-minute cadence as one that failed once, so
// each consecutive timeout doubles the wait; any other outcome resets it.
const consecutiveTimeouts = new Map();

function resetTimeoutStreak(candidate, slot) {
  consecutiveTimeouts.delete(cooldownKey(candidate, slot));
}

function setCooldown(candidate, kind, reason, overrideMs = 0, slot = null) {
  const durations = config.cooldownMs || {};
  const key = cooldownKey(candidate, slot);
  let duration = overrideMs || Number(durations[kind] || 0);
  if (kind === 'timeout') {
    const streak = (consecutiveTimeouts.get(key) || 0) + 1;
    consecutiveTimeouts.set(key, streak);
    duration = timeoutBackoffMs(
      streak,
      duration,
      Number(durations.timeoutMax || TIMEOUT_BACKOFF_CAP_MS),
    );
  } else {
    consecutiveTimeouts.delete(key);
  }
  if (!duration) return;
  cooldowns.set(key, {
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

// Active cooldown that makes the whole candidate unusable, with its kind so
// the all-cooling fallback can retry capacity faults only. A candidate stays
// available while any of its keys is free; the attempt loop skips the keys
// that are still cooling.
function worstCooldown(candidate) {
  const now = Date.now();
  const keyEntries = registry
    .keySlots(candidate.provider)
    .map((slot) => cooldowns.get(cooldownKey(candidate, slot)));
  return candidateCooldown({
    now,
    modelEntry: cooldowns.get(candidateKey(candidate)),
    keyEntries,
  });
}

function blockPayment(candidate, reason) {
  const key = candidateKey(candidate);
  const until = new Date(Date.now() + INSUFFICIENT_FUNDS_MS).toISOString();
  paymentBlocks[key] = {
    until,
    reason: String(reason || 'insufficient funds').slice(0, 300),
    observedAt: new Date().toISOString(),
  };
  scheduleStateSave();
  log(`payment blocked ${key} until ${until}`);
  return paymentBlocks[key];
}

function sendPaymentBlocked(res, requestedModel, blocked) {
  const entries = (blocked || []).filter(Boolean);
  const times = entries
    .map((entry) => Date.parse(entry.blockedUntil || ''))
    .filter(Number.isFinite)
    .sort((left, right) => left - right);
  const until = times.length ? times[0] : Date.now() + INSUFFICIENT_FUNDS_MS;
  const retryAfter = Math.max(1, Math.ceil((until - Date.now()) / 1000));
  const names = entries.map((entry) => candidateKey(entry)).join(', ') || requestedModel;
  return sendJson(
    res,
    402,
    {
      error: {
        message: `insufficient funds for ${names}; disabled until ${new Date(until).toISOString()}`,
        type: 'insufficient_funds',
        retry_after_seconds: retryAfter,
        blocked_models: entries.map((entry) => candidateKey(entry)),
      },
    },
    { 'Retry-After': String(retryAfter) },
  );
}

// Resolution: the request names either the default alias (free only), one
// enabled `provider:model`, or a bare model id (free offerings first, then any
// explicitly selected paid copy). Capability, context, cooldown, and the 24h
// payment block are applied afterwards.
function resolveRequest(requestedModel, body) {
  const ordered = orderedPool();
  const resolution = resolvePoolRequest(
    requestedModel,
    { free: ordered.free, paid: ordered.paid },
    { alias: DEFAULT_MODEL_ALIAS, parsePrefixed: registry.parsePrefixed },
  );
  const needs = requestNeeds(body);
  const active = [];
  const skipped = [];
  const blocked = [];
  const cooling = [];
  for (const candidate of resolution.candidates) {
    const model = candidateMetadata(candidate);
    if (candidate.paid && !resolution.allowPaid) {
      skipped.push({ model: candidateKey(candidate), reason: 'paid model not named by the request' });
      continue;
    }
    if (candidate.paid && candidate.blockedUntil) {
      blocked.push(candidate);
      continue;
    }
    if (!supportsRequest(model, needs)) {
      skipped.push({ model: candidateKey(candidate), reason: 'missing requested capability' });
      continue;
    }
    if (!fitsContext(model, needs.estimatedTokens)) {
      skipped.push({ model: candidateKey(candidate), reason: 'request exceeds context window' });
      continue;
    }
    const cooldown = worstCooldown(candidate);
    if (cooldown) {
      cooling.push({ candidate, kind: cooldown.kind });
      skipped.push({
        model: candidateKey(candidate),
        reason: `cooldown ${Math.ceil((cooldown.until - Date.now()) / 1000)}s`,
      });
      continue;
    }
    active.push(candidate);
  }

  // If every compatible model is cooling down, retry the capacity faults in
  // order instead of turning a temporary cooldown into a hard outage. Billing,
  // routing, and credential refusals are not temporary and must not be retried;
  // a 24h insufficient-funds block is never bypassed here.
  if (!active.length) {
    for (const { candidate, kind } of cooling) {
      if (!isRetryableCooldown(kind)) continue;
      if (candidate.paid && !resolution.allowPaid) continue;
      const model = candidateMetadata(candidate);
      if (!supportsRequest(model, needs) || !fitsContext(model, needs.estimatedTokens)) continue;
      active.push(candidate);
    }
  }

  if (skipped.length) log(`${requestedModel}: skipped ${skipped.length} candidate(s)`, skipped);
  return { ...resolution, candidates: active, blocked };
}

// Rebuilds the upstream request from the documented Chat Completions fields.
// Clients add their own keys (Open WebUI sends features, variables, files,
// tool_ids, ...) and strict providers reject unknown top-level names with a
// 400 instead of ignoring them. `stream_options` is gated per provider because
// not every OpenAI-compatible layer implements it.
function sanitizeUpstreamBody(body, candidate) {
  const provider = PROVIDERS.get(candidate.provider);
  // Deep copy: thought-signature injection mutates messages, and the same
  // request is retried against other providers.
  const upstream = JSON.parse(
    JSON.stringify(
      pickChatRequestFields(body, { streamOptions: provider?.streamOptions !== false }),
    ),
  );
  upstream.model = candidate.model;
  if (providerNeedsThoughtSignatures(provider)) {
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

async function fetchModel(candidate, body, clientSignal, slot, options = {}) {
  const controller = new AbortController();
  // A stream passes 0: its first-byte and idle deadlines cover the whole
  // attempt, and a total timer here would truncate a long answer mid-stream.
  const timeoutMs =
    options.timeoutMs === undefined ? attemptTimeoutMs : Number(options.timeoutMs);
  const timer =
    Number.isFinite(timeoutMs) && timeoutMs > 0
      ? setTimeout(() => controller.abort(new Error('attempt timeout')), timeoutMs)
      : null;
  const abortFromClient = () => controller.abort(new Error('client disconnected'));
  clientSignal?.addEventListener('abort', abortFromClient, { once: true });
  // A stream aborts this one when the first-byte deadline expires, which
  // cancels the body read too once the headers are already in.
  const abortFromFirstByte = () => controller.abort(new Error('first byte timeout'));
  options.firstByteSignal?.addEventListener('abort', abortFromFirstByte, { once: true });
  const abortFromIdle = () => controller.abort(new Error('stream idle timeout'));
  options.idleSignal?.addEventListener('abort', abortFromIdle, { once: true });
  const cleanup = () => {
    if (timer) clearTimeout(timer);
    clientSignal?.removeEventListener('abort', abortFromClient);
    options.firstByteSignal?.removeEventListener('abort', abortFromFirstByte);
    options.idleSignal?.removeEventListener('abort', abortFromIdle);
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

async function attemptJson(candidate, body, clientSignal, slot, options = {}) {
  let response;
  let cleanup = () => {};
  try {
    ({ response, cleanup } = await fetchModel(
      candidate,
      { ...body, stream: false },
      clientSignal,
      slot,
      { timeoutMs: options.timeoutMs },
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
      retryAfterMs: parseRetryAfterMs(response.headers.get('retry-after')),
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
    stats: countPayloadOutput(payload),
    contentType: response.headers.get('content-type') || 'application/json',
  };
}

async function attemptStream(candidate, body, res, clientSignal, slot, options = {}) {
  const translator = options.translator || null;
  // Chat chunks are rebuilt into one well-formed stream; the Responses
  // dialect has its own translator.
  const normalizer = translator
    ? null
    : createChatStreamNormalizer({ model: options.model || candidate.model });
  const attemptStartedAt = Number(options.startedAt) || Date.now();
  // The request budget also bounds the wait for a first byte, so a stream
  // attempt cannot outlive it before anything was committed.
  const firstByteWaitMs = Math.min(
    firstByteTimeoutMs(),
    Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : Infinity,
  );
  const firstByteController = new AbortController();
  const firstByteTimer =
    firstByteWaitMs > 0
      ? setTimeout(() => firstByteController.abort(new Error('first byte timeout')), firstByteWaitMs)
      : null;
  const firstByteTimedOut = () => firstByteController.signal.aborted;
  const clearFirstByteTimer = () => {
    if (firstByteTimer) clearTimeout(firstByteTimer);
  };
  // A committed answer may legitimately take minutes; only silence is fatal.
  const idleController = new AbortController();
  let response;
  let cleanup = () => {};
  try {
    ({ response, cleanup } = await fetchModel(
      candidate,
      { ...body, stream: true },
      clientSignal,
      slot,
      { firstByteSignal: firstByteController.signal, idleSignal: idleController.signal, timeoutMs: 0 },
    ));
  } catch (error) {
    clearFirstByteTimer();
    if (firstByteTimedOut()) {
      return { ok: false, status: 504, reason: 'first byte timeout', kind: 'timeout' };
    }
    const timedOut = error?.name === 'AbortError' || /timeout/i.test(String(error));
    return {
      ok: false,
      status: timedOut ? 504 : 502,
      reason: timedOut ? 'attempt timeout' : String(error),
      kind: classifyFailure(0, String(error), timedOut),
    };
  }

  const bufferedChunks = [];
  const bufferedEvents = [];
  const graceMs = streamCommitGraceMs();
  const keepAliveMs = streamKeepAliveMs();
  const streamStartedAt = Date.now();
  let graceTimer = null;
  let keepAliveTimer = null;
  let lastUpstreamAt = Date.now();
  // Idle watchdog: the upstream must produce a byte at least this often.
  const idleMs = streamIdleTimeoutMs();
  const idleTimer =
    idleMs > 0
      ? setInterval(
          () => {
            if (Date.now() - lastUpstreamAt > idleMs) {
              idleController.abort(new Error('stream idle timeout'));
            }
          },
          Math.max(250, Math.min(5000, Math.floor(idleMs / 4))),
        )
      : null;
  let parserBuffer = '';
  let committed = false;
  let sawUseful = false;
  let finishReason = '';
  let firstTokenMs = 0;
  // Answer accounting for the request log: how much text and how many tool
  // calls actually went out, never the content itself.
  const stats = {
    contentChars: 0,
    reasoningChars: 0,
    toolCalls: 0,
    finishReason: '',
    inputTokens: 0,
    outputTokens: 0,
  };

  // Every exit from this attempt goes through here: a timer that outlives its
  // attempt would later write into a response another candidate now owns.
  function releaseAttempt() {
    clearFirstByteTimer();
    if (graceTimer) clearTimeout(graceTimer);
    if (keepAliveTimer) clearInterval(keepAliveTimer);
    if (idleTimer) clearInterval(idleTimer);
    graceTimer = null;
    keepAliveTimer = null;
    cleanup();
  }

  if (!response.ok) {
    let raw;
    try {
      raw = await response.text();
    } finally {
      releaseAttempt();
    }
    const reason = errorSummary(response.status, raw);
    return {
      ok: false,
      status: response.status,
      reason,
      kind: classifyFailure(response.status, reason),
      fatal: response.status === 401,
      errorBody: parseErrorPayload(raw),
      retryAfterMs: parseRetryAfterMs(response.headers.get('retry-after')),
    };
  }
  if (!response.body) {
    releaseAttempt();
    return { ok: false, status: 502, reason: 'empty response body', kind: 'empty' };
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const extractor = geminiStreamExtractor(candidate);

  function emitEvents(events) {
    if (!events.length) return;
    const text = events.map(sseEvent).join('');
    if (committed) res.write(text);
    else bufferedEvents.push(text);
  }

  // Chat output is never the provider's own bytes: every chunk is normalized
  // so ids, timestamps, the requested model, and the reasoning field name are
  // consistent, and non-data lines never leak into the client stream.
  function emitChat(payload) {
    const frame = chatDataFrame(normalizer.push(payload));
    if (committed) res.write(frame);
    else bufferedChunks.push(frame);
  }

  function commitStream() {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Free-Router-Model': candidate.model,
      'X-Free-Router-Provider': candidate.provider,
    });
    // The response object has to exist before anything refers to its id, so
    // response.created always leads the flushed backlog.
    if (translator) res.write(translator.created().map(sseEvent).join(''));
    for (const chunk of bufferedEvents) res.write(chunk);
    bufferedEvents.length = 0;
    for (const chunk of bufferedChunks) res.write(chunk);
    bufferedChunks.length = 0;
    committed = true;
    startKeepAlive();
    log(`selected ${candidateKey(candidate)} (stream)`);
  }

  function startKeepAlive() {
    if (keepAliveMs <= 0 || keepAliveTimer) return;
    keepAliveTimer = setInterval(() => {
      if (res.writableEnded || res.destroyed) return;
      // Only fill real gaps: a stream that is still writing needs no comments.
      if (Date.now() - lastUpstreamAt < keepAliveMs) return;
      res.write(': keep-alive\n\n');
    }, keepAliveMs);
  }

  function finishStream(reason) {
    if (translator) {
      res.write(translator.finish({ finishReason: reason }).map(sseEvent).join(''));
    } else if (!normalizer.finishSeen()) {
      // Some providers just stop. A terminal chunk keeps clients from showing
      // a truncated answer.
      res.write(chatDataFrame(normalizer.terminal(reason || 'stop')));
    }
    // OpenAI SDKs stop on [DONE]; Responses clients stop on the terminal
    // event. Both terminators keep every client happy.
    res.write(CHAT_DONE_FRAME);
    res.end();
  }

  // The commit deadline has to be a timer, not a side effect of the next read:
  // an upstream that sends one delta and then thinks for many seconds would
  // otherwise keep the headers buffered the whole time. A completely silent
  // upstream has nothing to flush and stays open for failover until the
  // first-byte deadline instead.
  if (graceMs >= 0) {
    graceTimer = setTimeout(() => {
      graceTimer = null;
      if (!committed && !res.writableEnded && (bufferedChunks.length || bufferedEvents.length)) {
        commitStream();
      }
    }, graceMs);
  }

  while (true) {
    let read;
    try {
      read = await reader.read();
    } catch (error) {
      extractor?.flush();
      releaseAttempt();
      if (committed) {
        // Headers are out and the client is reading; a silent end looks like
        // a truncated answer, so say what happened instead.
        if (translator) {
          res.write(translator.fail(String(error)).map(sseEvent).join(''));
        } else {
          res.write(chatDataFrame({ error: { message: String(error), type: 'upstream_error' } }));
        }
        res.write(CHAT_DONE_FRAME);
        res.end();
        return { ok: true, candidate, interrupted: true, firstTokenMs: firstTokenMs || undefined, stats };
      }
      if (clientSignal?.aborted) {
        return { ok: false, status: 499, reason: 'client disconnected', kind: 'aborted' };
      }
      if (firstByteTimedOut()) {
        return { ok: false, status: 504, reason: 'first byte timeout', kind: 'timeout' };
      }
      return { ok: false, status: 502, reason: String(error), kind: 'serverError' };
    }
    if (read.done) break;
    lastUpstreamAt = Date.now();
    clearFirstByteTimer();
    const text = decoder.decode(read.value, { stream: true });
    extractor?.push(text);
    // Output is generated from parsed payloads only: the provider's raw bytes
    // never reach the client, so both dialects share one scan and one shape.
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
        const counted = countPayloadOutput(payload);
        stats.contentChars += counted.contentChars;
        stats.reasoningChars += counted.reasoningChars;
        stats.toolCalls += counted.toolCalls;
        if (counted.finishReason) stats.finishReason = counted.finishReason;
        // Usage arrives once on the final chunk on most providers, but Gemini
        // repeats a cumulative total on every chunk: the last non-zero sample
        // wins, so summing would multiply the count by the chunk count.
        if (counted.inputTokens) stats.inputTokens = counted.inputTokens;
        if (counted.outputTokens) stats.outputTokens = counted.outputTokens;
        // The include_usage request was the gateway's own. A Chat Completions
        // client that did not ask for usage must not see the extra numbers or
        // the usage-only chunk that carries them; the Responses dialect always
        // reports usage in its completed event, so its translator keeps them.
        const usageOnly =
          !translator && payload.usage && (!Array.isArray(payload.choices) || payload.choices.length === 0);
        const clientWantsUsage = translator || body?.stream_options?.include_usage === true;
        if (!clientWantsUsage) delete payload.usage;
        if (translator) emitEvents(translator.push(payload));
        else if (!usageOnly) emitChat(payload);
        if (usefulDelta(payload)) {
          sawUseful = true;
          if (!firstTokenMs) firstTokenMs = Date.now() - attemptStartedAt;
          if (!committed) commitStream();
        }
      } catch {
        // Ignore keepalives and malformed provider-specific event lines.
      }
    }
    if (!committed && Date.now() - streamStartedAt >= graceMs && (bufferedChunks.length || bufferedEvents.length)) {
      commitStream();
    }
  }

  extractor?.flush();
  if (committed) {
    releaseAttempt();
    if (!sawUseful) {
      if (translator) {
        res.write(
          translator
            .fail(`reasoning only or empty stream (finish_reason=${finishReason || 'unknown'})`)
            .map(sseEvent)
            .join(''),
        );
      } else if (!normalizer.finishSeen()) {
        res.write(chatDataFrame(normalizer.terminal(finishReason || 'stop')));
      }
      res.write(CHAT_DONE_FRAME);
      res.end();
      const reason = `reasoning only or empty stream (finish_reason=${finishReason || 'unknown'})`;
      setCooldown(candidate, 'empty', reason, 0, slot);
      return { ok: true, candidate, hollow: true, stats };
    }
    finishStream(finishReason);
    return { ok: true, candidate, firstTokenMs: firstTokenMs || undefined, stats };
  }
  releaseAttempt();
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

// The pool's two views as the UI and /health report them: automatic free
// models first, then the explicitly selected paid ones (which a request has to
// name). Ranking fields come from the same helpers the router uses, so what the
// operator sees is what a request would get.
function poolEntryState(entry, priority, now, configuredSet, configuredIndex) {
  const key = candidateKey(entry);
  const model = entry.catalogModel || candidateMetadata(entry);
  const pinned = isPinnedKey(key) || PINNED_MODELS.has(entry.model);
  const cooldown = worstCooldown(entry);
  return {
    priority,
    provider: entry.provider,
    id: entry.model,
    free: entry.free,
    paid: entry.paid,
    unknown: entry.unknown,
    source: entry.source,
    pinned,
    score: rankedModelScore(key, configuredSet, configuredIndex),
    baseScore: baseModelScore(key, configuredSet, configuredIndex),
    scoreAdjustment: pinned ? 0 : usageAdjustment(key),
    scoreSource: scoreSourceFor(key, configuredSet),
    zeroCost: entry.free,
    supportsTools: model ? (model.supported_parameters || []).includes('tools') : null,
    cooldownSeconds: cooldown ? Math.ceil((cooldown.until - now) / 1000) : 0,
    cooldownReason: cooldown?.reason,
    blockedUntil: entry.blockedUntil || null,
    dailyLimit: dailyLimitFor(key),
    dailyLimitSource: dailyLimitSource(key),
    usage: usageForKey(key),
  };
}

function poolStatus() {
  const now = Date.now();
  const { pool, free, paid, configuredSet, configuredIndex } = orderedPool();
  const describe = (entry, index) =>
    poolEntryState(entry, index + 1, now, configuredSet, configuredIndex);
  return {
    free: free.map(describe),
    paid: paid.map(describe),
    counts: { free: pool.free.length, paid: pool.paid.length },
  };
}

// Turn the in-flight record into the finished shape the ring buffer stores.
// The outcome is derived once from what was actually sent, so every return
// path (including bare aborts) is accounted for without instrumenting each one.
function finishRequestRecord(record, res, startedAt) {
  const finishedAt = Date.now();
  const sent = res.headersSent;
  const status = sent ? res.statusCode : record.aborted ? 499 : 500;
  let outcome;
  if (!sent) {
    outcome = record.aborted ? 'aborted' : 'failed';
  } else if (status === 200) {
    outcome = record.hollow ? 'empty' : record.interrupted ? 'interrupted' : 'ok';
  } else if (status === 402) {
    outcome = 'blocked';
  } else if (status === 502) {
    outcome = 'failed';
  } else {
    outcome = 'rejected';
  }
  const entry = {
    id: record.id,
    at: new Date(finishedAt).toISOString(),
    startedAt: new Date(startedAt).toISOString(),
    durationMs: finishedAt - startedAt,
    dialect: record.dialect,
    stream: record.stream === true,
    model: record.model || '',
    provider: record.provider || '',
    upstreamModel: record.upstreamModel || '',
    key: record.key || '',
    status,
    outcome,
    reason: record.reason || '',
    firstTokenMs: Number.isFinite(record.firstTokenMs) ? record.firstTokenMs : null,
    finishReason: record.finishReason || '',
    toolCalls: record.toolCalls || 0,
    contentChars: record.contentChars || 0,
    reasoningChars: record.reasoningChars || 0,
    inputTokens: record.inputTokens || 0,
    outputTokens: record.outputTokens || 0,
    fields: record.fields || [],
    attempts: record.attempts || [],
  };
  const outputTps = outputTokensPerSecond(entry);
  // One line per finished request in the container log: the same metadata the
  // Logs tab shows, enough to tell a text answer from a tool call from nothing
  // without opening an admin session.
  const selected = entry.provider ? `${entry.provider}:${entry.upstreamModel}` : '-';
  log(
    `${entry.dialect} ${entry.id} ${entry.outcome} ${status} ${entry.durationMs}ms ${selected}` +
      ` finish=${entry.finishReason || '-'} tools=${entry.toolCalls}` +
      ` chars=${entry.contentChars}/${entry.reasoningChars}` +
      ` tokens=${entry.inputTokens}/${entry.outputTokens}` +
      ` tps=${outputTps === null ? '-' : outputTps}`,
  );
  return entry;
}

async function handleChat(req, res, options = {}) {
  const startedAt = Date.now();
  const record = {
    id: `req_${crypto.randomBytes(8).toString('hex')}`,
    dialect: options.dialect === 'responses' ? 'responses' : 'chat',
    attempts: [],
  };
  // Set before any writeHead: Node merges this into whichever response the
  // attempt ends up sending, JSON or SSE.
  res.setHeader('X-Free-Router-Request-Id', record.id);
  try {
    await runChatRequest(req, res, options, record);
  } finally {
    const entry = finishRequestRecord(record, res, startedAt);
    const stored = clientRequestLog.add(secretRedactor ? secretRedactor.redact(entry).value : entry);
    recordProcessTotals(stored);
    appendRequestLog(stored);
  }
}

// The model list served by /v1/models and reused by /v1/models/{id}, so the
// two can never disagree about what the pool contains.
async function gatewayModels() {
  if (catalogsCold()) await refreshCatalog();
  else refreshCatalogSoon();
  const ordered = orderedPool();
  const { models } = registry.buildModelList({
    aliases: [{ id: DEFAULT_MODEL_ALIAS }],
    entries: [...ordered.free, ...ordered.paid],
  });
  return models;
}

// /v1/embeddings is a passthrough, not a routed call: embeddings are not part
// of the free chat pool, so the caller names the model (bare id for the
// default provider, or provider:model) and the request goes to that provider
// with the usual key rotation. The response is returned untouched.
async function handleEmbeddings(req, res) {
  const startedAt = Date.now();
  const record = {
    id: `req_${crypto.randomBytes(8).toString('hex')}`,
    dialect: 'embeddings',
    attempts: [],
  };
  res.setHeader('X-Free-Router-Request-Id', record.id);
  try {
    let body;
    try {
      body = await readJson(req);
    } catch (error) {
      record.reason = 'invalid JSON body';
      return sendJson(res, 400, {
        error: { message: String(error), type: 'invalid_request_error' },
      });
    }
    const requested = String(body?.model || '').trim();
    record.model = requested;
    record.fields = Object.keys(body || {}).slice(0, 40);
    if (!requested) {
      record.reason = 'model is required';
      return sendJson(res, 400, {
        error: { message: 'model is required', type: 'invalid_request_error' },
      });
    }
    const parsed = registry.parsePrefixed(requested);
    const providerName = parsed ? parsed.provider : registry.defaultProvider;
    const upstreamModel = parsed ? parsed.model : requested;
    const slot = registry.keySlots(providerName)[0];
    const endpoint = registry.embeddingsUrl(providerName);
    if (!endpoint || !slot) {
      record.reason = `provider ${providerName} is not configured`;
      return sendJson(res, 503, {
        error: { message: record.reason, type: 'provider_unavailable' },
      });
    }
    registry.rotateKeyCursor(providerName);
    const controller = new AbortController();
    const timer = Number(attemptTimeoutMs) > 0
      ? setTimeout(() => controller.abort(new Error('attempt timeout')), Number(attemptTimeoutMs))
      : null;
    let response;
    let raw;
    try {
      response = await fetch(endpoint, {
        method: 'POST',
        headers: registry.headers(providerName, slot.key),
        body: JSON.stringify({ ...body, model: upstreamModel }),
        signal: controller.signal,
      });
      raw = await response.text();
    } catch (error) {
      record.reason = String(error);
      record.attempts.push({
        provider: providerName,
        model: upstreamModel,
        key: slot.name,
        status: 502,
        ok: false,
        kind: 'network',
        reason: String(error),
        ms: Date.now() - startedAt,
      });
      return sendJson(res, 502, {
        error: { message: `embedding request failed: ${String(error)}`, type: 'upstream_error' },
      });
    } finally {
      if (timer) clearTimeout(timer);
    }
    const contentType = response.headers.get('content-type') || 'application/json';
    record.attempts.push({
      provider: providerName,
      model: upstreamModel,
      key: slot.name,
      status: response.status,
      ok: response.ok,
      kind: response.ok ? 'ok' : 'http',
      reason: response.ok ? '' : errorSummary(response.status, raw),
      ms: Date.now() - startedAt,
    });
    if (!response.ok) {
      record.reason = errorSummary(response.status, raw);
      let payload;
      try {
        payload = JSON.parse(raw);
      } catch {
        payload = { error: { message: record.reason, type: 'upstream_error' } };
      }
      res.writeHead(response.status, { 'Content-Type': contentType });
      return res.end(JSON.stringify(payload));
    }
    record.provider = providerName;
    record.upstreamModel = upstreamModel;
    record.key = slot.name;
    res.writeHead(response.status, { 'Content-Type': contentType });
    return res.end(raw);
  } finally {
    const entry = finishRequestRecord(record, res, startedAt);
    const stored = clientRequestLog.add(secretRedactor ? secretRedactor.redact(entry).value : entry);
    recordProcessTotals(stored);
    appendRequestLog(stored);
  }
}

async function runChatRequest(req, res, options, record) {
  let body;
  try {
    body = await readJson(req);
  } catch (error) {
    record.reason = 'invalid JSON body';
    return sendJson(res, 400, {
      error: { message: String(error), type: 'invalid_request_error' },
    });
  }

  // Field names only: enough to see what a client sent, never its content.
  // They are client-controlled, so strip anything that could forge a log line.
  const requestFields = Object.keys(body)
    .slice(0, 40)
    .map((name) => name.replace(/[^\w.-]/g, '_').slice(0, 40))
    .sort();
  const dialect = options.dialect === 'responses' ? 'responses' : 'chat';
  record.fields = requestFields;
  record.model = String(body.model || '');
  record.stream = body.stream === true;

  // /v1/responses is served by translating to chat shape, running the same
  // routing pipeline, and translating back: routing, quota, cooldown, key
  // rotation, and usage accounting all stay identical for both dialects.
  let responses = null;
  if (options.dialect === 'responses') {
    const translated = toChatRequest(body);
    if (!translated.ok) {
      record.reason = translated.error?.message || 'invalid request';
      return sendJson(res, translated.status, { error: translated.error });
    }
    responses = { request: body, customTools: translated.customTools };
    body = translated.body;
  }
  const requestedModel = String(body.model || DEFAULT_MODEL_ALIAS);
  record.model = requestedModel;
  log(`${dialect} request ${requestedModel} id=${record.id} fields=${requestFields.join(',')}`);
  if (catalogsCold()) await refreshCatalog();
  else refreshCatalogSoon();
  const requestPlan = resolveRequest(requestedModel, body);
  const candidates = requestPlan.candidates;
  if (!candidates.length) {
    if (requestPlan.blocked.length) {
      record.reason = 'insufficient funds';
      return sendPaymentBlocked(res, requestedModel, requestPlan.blocked);
    }
    if (requestPlan.kind === 'unknown' || requestPlan.kind === 'not_enabled') {
      // Enabled models come from the pool; an id the operator never selected
      // is a configuration answer, not an outage, so it is a 404 with a type
      // the client can tell apart from a typo.
      const enabled = requestPlan.kind === 'not_enabled';
      record.reason = enabled
        ? `model is not enabled: ${requestedModel}`
        : `unknown model: ${requestedModel}`;
      return sendJson(res, 404, {
        error: {
          message: enabled
            ? `model is not enabled: ${requestedModel}`
            : `unknown model: ${requestedModel}`,
          type: enabled ? 'model_not_enabled' : 'model_not_found',
        },
      });
    }
    record.reason = 'no compatible free model';
    return sendJson(res, 503, {
      error: {
        message: `No currently free model supports this request for ${requestedModel}`,
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

  // Epsilon-greedy exploration: occasionally route to an underexplored model
  // so cold models can earn the traffic that quality adjustments require.
  // Pinned models always stay first; the sampled detour is logged. Only the
  // default alias explores: a request that named a model gets that model, or
  // the next free copy of the same slug, never an unrelated one.
  if (requestPlan.kind === 'alias') {
    const explorePercent = Number(config.routing?.explorePercent ?? 5);
    const windowAttempts = new Map();
    for (const day of usageDays()) {
      const perDay = usageByDay[day] || {};
      for (const [key, counts] of Object.entries(perDay)) {
        windowAttempts.set(key, (windowAttempts.get(key) || 0) + usageTotals(counts).total);
      }
    }
    const orderedKeys = candidates
      .map((candidate) => candidateKey(candidate))
      .filter((key) => !isPinnedKey(key));
    const exploreKey = pickExplorationTarget(
      orderedKeys,
      windowAttempts,
      explorePercent,
      Math.random(),
      RANK_USAGE_MIN_REQUESTS,
    );
    if (exploreKey) {
      const idx = candidates.findIndex((candidate) => candidateKey(candidate) === exploreKey);
      if (idx > 0) {
        const [target] = candidates.splice(idx, 1);
        const firstOpen = candidates.findIndex((candidate) => !isPinnedKey(candidateKey(candidate)));
        candidates.splice(firstOpen < 0 ? candidates.length : firstOpen, 0, target);
        log(`exploring ${exploreKey} (sampling underexplored model)`);
      }
    }
  }

  // One wall-clock budget for the whole failover phase, measured from the
  // request's arrival. Once a stream is committed the client is reading and
  // the budget stops mattering; the idle watchdog covers a dead upstream.
  const budgetDeadline = Number(record.startedAt || Date.now()) + requestBudgetMs();
  let budgetExhausted = false;

  for (const candidate of candidates) {
    if (clientController.signal.aborted) {
      record.aborted = true;
      return;
    }
    if (Date.now() >= budgetDeadline) {
      budgetExhausted = true;
      break;
    }
    if (failedProviders.has(candidate.provider)) continue;
    // Multi-account: each candidate is tried with every usable key in
    // round-robin order. A 401 retires just that key; rate limits cool down
    // just that key.
    const slots = registry.keySlots(candidate.provider);
    if (!slots.length && registry.keyCount(candidate.provider) > 0) {
      // Every configured key was retired after a 401. A keyless request would
      // just be refused again, so skip the whole provider until it is
      // reconfigured.
      log(`skipping ${candidate.provider}: every configured key is retired`);
      failedProviders.add(candidate.provider);
      continue;
    }
    registry.rotateKeyCursor(candidate.provider);
    const attempts = slots.length ? slots : [null];
    let candidateOk = false;
    for (const slot of attempts) {
      if (clientController.signal.aborted) {
        record.aborted = true;
        return;
      }
      if (Date.now() >= budgetDeadline) {
        budgetExhausted = true;
        break;
      }
      if (slot && cooldownRemaining(candidate, slot) > 0) continue;
      const slotLabel = slot ? ` [${slot.name}]` : '';
      log(`trying ${candidateKey(candidate)}${slotLabel} for ${requestedModel}`);
      const attemptStartedAt = Date.now();
      const translator = responses
        ? createStreamTranslator({
            model: requestedModel,
            request: responses.request,
            customTools: responses.customTools,
          })
        : null;
      const result = body.stream
        ? await attemptStream(candidate, body, res, clientController.signal, slot, {
            translator,
            model: requestedModel,
            startedAt: attemptStartedAt,
            timeoutMs: Math.max(1, budgetDeadline - Date.now()),
          })
        : await attemptJson(candidate, body, clientController.signal, slot, {
            // Never let one attempt outlive the request budget.
            timeoutMs: Math.max(1, budgetDeadline - Date.now()),
          });

      record.attempts.push({
        provider: candidate.provider,
        model: candidate.model,
        key: slot?.name || '',
        status: result.ok ? 200 : result.status,
        ok: result.ok === true,
        kind: result.kind || '',
        reason: result.reason || '',
        ms: Date.now() - attemptStartedAt,
      });

      if (result.ok) {
        record.provider = candidate.provider;
        record.upstreamModel = candidate.model;
        record.key = slot?.name || '';
        record.firstTokenMs = result.firstTokenMs;
        record.hollow = result.hollow === true;
        record.interrupted = result.interrupted === true;
        // Shape of the answer, not the answer: text volume, tool calls, and
        // the upstream finish reason, so an "ok" row that a client rendered as
        // nothing can be told apart from one that carried a tool call.
        record.finishReason = result.stats?.finishReason || '';
        record.toolCalls = result.stats?.toolCalls || 0;
        record.contentChars = result.stats?.contentChars || 0;
        record.reasoningChars = result.stats?.reasoningChars || 0;
        // The provider's own usage block, when it reports one; 0 means the
        // upstream did not say, and the Logs tab shows a dash for it.
        record.inputTokens = result.stats?.inputTokens || 0;
        record.outputTokens = result.stats?.outputTokens || 0;
        // A grace-committed stream that never yielded content kept the
        // client's 200 but served nothing: count it as empty (the cooldown
        // was already set inside the attempt) instead of a success. A stream
        // that died mid-answer is also not a success, but it is a serving
        // condition, so it gets its own capacity kind instead of a quality
        // failure.
        recordUsage(
          candidate,
          result.hollow ? 'empty' : result.interrupted ? 'interrupted' : 'ok',
        );
        resetTimeoutStreak(candidate, slot);
        if (!result.hollow) {
          // Time to first useful token, not time to completion: a long answer
          // is not a slow start, while a model that thinks for a minute is.
          recordLatency(candidate, result.firstTokenMs ?? Date.now() - attemptStartedAt);
          rememberSelection({
            requested: requestedModel,
            provider: candidate.provider,
            model: candidate.model,
            selectedAt: new Date().toISOString(),
          });
        }
        if (!body.stream) {
          log(`selected ${candidateKey(candidate)}${slotLabel}`);
          const payload = responses
            ? toResponsesPayload(result.payload, {
                model: requestedModel,
                request: responses.request,
                customTools: responses.customTools,
              })
            : result.payload;
          return sendJson(res, 200, payload, {
            'X-Free-Router-Model': candidate.model,
            'X-Free-Router-Provider': candidate.provider,
          });
        }
        return;
      }

      // A 401 is a credential fault, never a model fault: retire the key
      // below without letting it pollute the model's quality record.
      if (!isCredentialFault(result.status)) {
        recordUsage(
          candidate,
          clientController.signal.aborted ? 'aborted' : result.kind || 'other',
        );
      }
      failures.push({
        provider: candidate.provider,
        model: candidate.model,
        key: slot?.name || undefined,
        status: result.status,
        kind: result.kind || '',
        reason: result.reason,
      });
      // A paid model that answers "no funds" is parked for 24h, by
      // `provider:model` only. The account may still pay for other models, and
      // the model itself is fine; there is nothing to learn about its quality,
      // so no verdict and no shared cooldown are written. Free models keep the
      // ordinary 1h payment cooldown and fall through to the next candidate.
      if (
        candidate.paid &&
        isInsufficientFunds(result.status, result.errorBody, result.reason)
      ) {
        blockPayment(candidate, result.reason);
        record.reason = 'insufficient funds';
        if (!res.headersSent) {
          return sendPaymentBlocked(res, requestedModel, [
            { ...candidate, blockedUntil: paymentBlocks[candidateKey(candidate)]?.until },
          ]);
        }
        return;
      }
      const providerWaitMs = applyProviderVerdict(candidate, result);
      // The provider's own Retry-After is more accurate than the configured
      // cooldown; take whichever is longer. A client-side rejection says
      // nothing about the model or the key, so it neither cools the candidate
      // down nor poisons its quality record.
      const waitMs = Math.max(providerWaitMs || 0, result.retryAfterMs || 0);
      if (result.kind && result.kind !== 'clientError') {
        setCooldown(candidate, result.kind, result.reason, waitMs, slot);
      }
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

  // An attempt can consume the last of the budget without the next loop
  // check running; report the timeout rather than a generic pool failure.
  if (!budgetExhausted && Date.now() >= budgetDeadline) budgetExhausted = true;

  if (!res.headersSent) {
    if (budgetExhausted) {
      record.reason = 'request budget exhausted';
      return sendJson(res, 504, {
        error: {
          message: `No model answered within the ${Math.round(requestBudgetMs() / 1000)}s request budget`,
          type: 'gateway_timeout',
          failures,
        },
      });
    }
    // If every candidate refused the request itself, the pool is not
    // exhausted: the caller sent something no provider accepts.
    const clientFault = isClientFaultExhaustion(failures);
    record.reason = clientFault ? 'request rejected by every provider' : 'all models failed';
    sendJson(res, clientFault ? 400 : 502, {
      error: {
        message: clientFault
          ? failures[0]?.reason || 'request rejected by every provider'
          : `All models failed for ${requestedModel}`,
        type: clientFault ? 'invalid_request_error' : 'free_router_exhausted',
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
// Reverse-proxy knobs live in `webui`: trustedHosts lets a public hostname
// through the rebinding guard, trustProxy makes X-Forwarded-* authoritative
// (needed for the login brake to see real client addresses), and secureCookie
// marks the session cookie Secure when TLS terminates upstream.
function webuiConfig() {
  return config.webui && typeof config.webui === 'object' ? config.webui : {};
}

function trustedHosts() {
  const list = webuiConfig().trustedHosts;
  return Array.isArray(list) ? list.map((entry) => String(entry).toLowerCase().trim()).filter(Boolean) : [];
}

function trustProxy() {
  return webuiConfig().trustProxy === true;
}

function secureCookie() {
  return webuiConfig().secureCookie === true;
}

function isLocalHost(hostname) {
  return isLocalHostname(hostname, trustedHosts());
}

function uiGuardFailure(req) {
  const forwardedHost = trustProxy() ? String(req.headers['x-forwarded-host'] || '') : '';
  const host = forwardedHost || String(req.headers.host || '');
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
    let originUrl;
    try {
      originUrl = new URL(origin);
    } catch {
      return `invalid Origin header: ${origin}`;
    }
    const sameHost = originUrl.hostname.toLowerCase() === hostname.toLowerCase();
    // Behind a proxy the browser's Origin carries the public hostname and the
    // backend sees only the forwarded one; the forwarded host is compared
    // above, so an allowed hostname is enough here.
    if (!sameHost && !isLocalHost(originUrl.hostname)) {
      return `unexpected Origin header: ${origin}`;
    }
  }
  return '';
}

function webuiAuthFailure(req) {
  const token = webuiSessionToken(req);
  if (!token || !webuiSessions.has(token)) return 'web UI login required';
  const session = webuiSessions.get(token);
  if (!session || session.expiresAt <= Date.now()) {
    webuiSessions.delete(token);
    return 'session expired, please log in again';
  }
  return '';
}

function uiProviderState() {
  const catalogHealth = registry.health();
  const pool = currentPool();
  const providers = [...PROVIDERS.values()];
  providers.sort((left, right) => Number(right.name === 'gemini') - Number(left.name === 'gemini'));
  return providers.map((provider) => {
    const unavailable = catalogHealth[provider.name]?.unavailableModels || [];
    // Model totals next to the free-model availability: priced catalogs count
    // zero-cost chat models, allowlists count entries still offered upstream.
    // The id lists below feed the add-provider preset picker (capped).
    const CATALOG_ID_CAP = 200;
    let modelCount = null;
    let freeCount = null;
    let catalogIds = [];
    let catalogClasses = {};
    let catalogTruncated = false;
    if (provider.catalogHasPricing) {
      if (provider.catalog?.size) {
        const chat = [...provider.catalog.values()].filter((m) => isChatModel(m));
        modelCount = provider.catalog.size;
        freeCount = chat.filter((m) => isZeroCost(m)).length;
        catalogTruncated = chat.length > CATALOG_ID_CAP;
        catalogIds = chat.slice(0, CATALOG_ID_CAP).map((m) => m.id);
        // The model picker needs the price class per row, and it must come
        // from the same fields the pool uses, not from a second heuristic.
        catalogClasses = Object.fromEntries(
          chat.slice(0, CATALOG_ID_CAP).map((m) => [m.id, priceClass(m)]),
        );
      }
    } else {
      modelCount = provider.freeModels.size;
      freeCount = [...provider.freeModels].filter((id) => !unavailable.includes(id)).length;
      const allowed = [...provider.freeModels];
      catalogTruncated = allowed.length > CATALOG_ID_CAP;
      catalogIds = allowed.slice(0, CATALOG_ID_CAP);
    }
    const freeSet = new Set(
      provider.catalogHasPricing && provider.catalog?.size
        ? [...provider.catalog.values()].filter((m) => isZeroCost(m) && isChatModel(m)).map((m) => m.id)
        : [...provider.freeModels],
    );
    const poolEntries = [...pool.free, ...pool.paid].filter((entry) => entry.provider === provider.name);
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
      catalogIds,
      catalogClasses,
      catalogFreeIds: catalogIds.filter((id) => freeSet.has(id)),
      catalogTruncated,
      catalogError: catalogHealth[provider.name]?.catalogError || null,
      unavailableModels: unavailable,
      selectedModels: [...provider.selectedModels],
      probing: probeRunning.has(provider.name),
      probePending: probePendingCount(provider.name),
      poolCounts: {
        free: poolEntries.filter((entry) => entry.free).length,
        paid: poolEntries.filter((entry) => !entry.free).length,
        blocked: poolEntries.filter((entry) => entry.blockedUntil).length,
      },
      // What the model table shows: live membership with its label and state.
      // Unselected catalog ids come from catalogIds/catalogClasses above.
      models: poolEntries.map((entry) => {
        const cooldown = worstCooldown(entry);
        return {
          id: entry.model,
          free: entry.free,
          paid: entry.paid,
          unknown: entry.unknown,
          source: entry.source,
          blockedUntil: entry.blockedUntil,
          cooldownSeconds: cooldown ? Math.ceil((cooldown.until - Date.now()) / 1000) : 0,
          dailyLimit: dailyLimitFor(entry.key),
          dailyLimitSource: dailyLimitSource(entry.key),
        };
      }),
    };
  });
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
    audit(key ? 'provider.key.set' : 'provider.key.clear', {
      target: `${name}:${keyName}`,
      ip: clientAddress(req),
    });
    if (key) await refreshProviderCatalog(name);
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
  audit(key ? 'provider.key.set' : 'provider.key.clear', {
    target: `${name}:env`,
    ip: clientAddress(req),
  });
  if (key) await refreshProviderCatalog(name);
  return sendJson(res, 200, { ok: true, provider: name, configured: Boolean(key) });
}

function randomGatewayKey() {
  return `sk-fr-${crypto.randomBytes(24).toString('base64url')}`;
}

// Reads the optional policy fields shared by create and update. Returns
// { error } for a bad value so the caller can answer 400.
function gatewayKeyPolicy(body) {
  const dailyLimit = parseDailyLimit(body.dailyLimit);
  if (dailyLimit === null) {
    return { error: 'dailyLimit must be a whole number from 0 to 1000000 (0 = unlimited)' };
  }
  const expiresAt = parseExpiry(body.expiresAt);
  if (expiresAt === null) {
    return { error: 'expiresAt must be YYYY-MM-DD or an ISO timestamp (empty = no expiry)' };
  }
  return { dailyLimit, expiresAt };
}

function gatewayKeySummary(entry) {
  return {
    name: entry.name,
    createdAt: entry.createdAt || null,
    expiresAt: entry.expiresAt || null,
    dailyLimit: Number(entry.dailyLimit) > 0 ? Math.floor(Number(entry.dailyLimit)) : null,
    usedToday: gatewayKeyUsedToday(entry.name),
  };
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
    audit('gateway.require-auth', {
      ip: clientAddress(req),
      detail: gatewayAuthRequired() ? 'enabled' : 'disabled',
    });
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
    delete gatewayKeyUsage[keyName];
    scheduleStateSave();
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
    audit('gateway.key.delete', { target: keyName, ip: clientAddress(req) });
    return sendJson(res, 200, { ok: true });
  }

  if (action === 'update') {
    const keyName = String(body.name || '');
    const index = gatewayKeys().findIndex((entry) => entry?.name === keyName);
    if (index < 0) {
      return sendJson(res, 404, { error: { message: `unknown key: ${keyName}`, type: 'not_found' } });
    }
    const policy = gatewayKeyPolicy(body);
    if (policy.error) {
      return sendJson(res, 400, { error: { message: policy.error, type: 'invalid_request_error' } });
    }
    const keys = gatewayKeys().slice();
    const updated = { ...keys[index] };
    if (policy.dailyLimit) updated.dailyLimit = policy.dailyLimit;
    else delete updated.dailyLimit;
    if (policy.expiresAt) updated.expiresAt = policy.expiresAt;
    else delete updated.expiresAt;
    keys[index] = updated;
    setOverlayValue(['gateway', 'keys'], keys);
    try {
      persistOverlayFile();
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return sendJson(res, 500, {
        error: { message: `could not write ${OVERLAY_FILENAME}: ${reason}`, type: 'config_write_failed' },
      });
    }
    log(`updated gateway API key [${keyName}] via web interface`);
    audit('gateway.key.update', {
      target: keyName,
      ip: clientAddress(req),
      detail: `dailyLimit=${policy.dailyLimit || 0} expiresAt=${policy.expiresAt || '-'}`,
    });
    return sendJson(res, 200, { ok: true, key: gatewayKeySummary(updated) });
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
    const policy = gatewayKeyPolicy(body);
    if (policy.error) {
      return sendJson(res, 400, { error: { message: policy.error, type: 'invalid_request_error' } });
    }
    const entry = { name: keyName, key: value, createdAt: new Date().toISOString() };
    if (policy.dailyLimit) entry.dailyLimit = policy.dailyLimit;
    if (policy.expiresAt) entry.expiresAt = policy.expiresAt;
    setOverlayValue(['gateway', 'keys'], [...gatewayKeys(), entry]);
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
    audit('gateway.key.create', {
      target: keyName,
      ip: clientAddress(req),
      detail: `dailyLimit=${policy.dailyLimit || 0} expiresAt=${policy.expiresAt || '-'}`,
    });
    return sendJson(res, 200, {
      ok: true,
      name: keyName,
      key: value,
      requireAuth: true,
      entry: gatewayKeySummary(entry),
    });
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
  // The admin password guards the whole management surface; one character is
  // not a password. The default "admin123" is 10 characters, so the
  // floor applies to replacements, not to the shipped value.
  const MIN_ADMIN_PASSWORD = 12;
  if (problem || !password) {
    return sendJson(res, 400, {
      error: { message: problem || 'password is required', type: 'invalid_request_error' },
    });
  }
  if (password.length < MIN_ADMIN_PASSWORD) {
    return sendJson(res, 400, {
      error: {
        message: `password must be at least ${MIN_ADMIN_PASSWORD} characters`,
        type: 'invalid_request_error',
      },
    });
  }
  config.webui ||= {};
  // Stamp explicit changes only (not boot upgrades or first-boot seeds) so
  // the UI can tell whether the password was ever changed by hand.
  setOverlayValue(['webui', 'passwordChangedAt'], new Date().toISOString());
  if (!setStoredWebuiPassword(await hashPasswordAsync(password))) {
    return sendJson(res, 500, {
      error: { message: `could not write ${OVERLAY_FILENAME}`, type: 'config_write_failed' },
    });
  }
  webuiSessions.clear();
  refreshSecretRedactor();
  log('web UI password changed via web interface; all sessions revoked');
  audit('auth.password', { ip: clientAddress(req), detail: 'password changed; all sessions revoked' });
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
  audit('server.config', {
    ip: clientAddress(req),
    detail: Object.keys(body).join(',') || 'none',
  });
  return sendJson(res, 200, { ok: true, host: config.host, port: config.port, notes });
}

// ---- Editable configuration (web UI settings tabs) ----

function editableConfigState() {
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
      selectedModels: [...provider.selectedModels],
      keyCount: provider.apiKeys?.length || 0,
    })),
    discovery: {
      enabled: discoveryEnabled,
      intervalHours: Math.round(DISCOVERY_INTERVAL_MS / 3600000),
      evaluationEnabled,
      pinnedModels: [...PINNED_MODELS],
      probeBatchSize: PROBE_BATCH_SIZE,
      probeBatchDelayMs: PROBE_BATCH_DELAY_MS,
      probeMaxPerProvider: PROBE_MAX_PER_PROVIDER,
    },
    limits,
    general: {
      attemptTimeoutMs,
      streamIdleTimeoutMs: streamIdleTimeoutMs(),
      requestBudgetMs: requestBudgetMs(),
      catalogRefreshMs,
      redactSecrets: config.redactSecrets !== false,
      socksFirstHosts: config.socksFirstHosts || [],
      defaultProvider: registry.defaultProvider,
      retentionDays: USAGE_RETENTION_DAYS,
      // The configured zone, not the one in effect: `USAGE_TIMEZONE` is fixed at
      // boot, so reporting it here would bounce the operator's fresh pick back to
      // the old value on the reload that follows every save. `usage.timezone` in
      // the status payload is the one actually in effect.
      timezone: String(config.usage?.timezone || ''),
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

  if (action === 'fetch-models') {
    // List models from a provider so the add and edit forms can offer
    // checkboxes instead of manual typing. Free flags come straight from
    // catalog pricing; anything else is for the user (or discovery) to decide.
    // A registered provider contributes its stored keys and auth header, so
    // the edit modal never has to make the operator re-paste a key it already
    // holds; a pasted key is tried first, and a rejected one falls back to the
    // stored keys rather than failing the listing outright.
    const providerName = String(body.provider || '').trim();
    const known = providerName ? PROVIDERS.get(providerName) : null;
    if (providerName && !known) {
      return sendJson(res, 404, { error: { message: `unknown provider: ${providerName}`, type: 'not_found' } });
    }
    const baseUrl = String((body.baseUrl !== undefined ? body.baseUrl : known?.baseUrl) || '')
      .trim()
      .replace(/\/+$/, '');
    if (!validHttpUrl(baseUrl)) {
      return sendJson(res, 400, { error: { message: 'baseUrl must be an http(s) URL', type: 'invalid_request_error' } });
    }
    const pasted = typeof body.key === 'string' ? body.key.trim() : '';
    const keyCandidates = [pasted, ...(known?.apiKeys || []).map((entry) => entry.key)].filter(Boolean);
    if (!keyCandidates.length) keyCandidates.push('');
    const catalogUrl = /\/models$/i.test(baseUrl) ? baseUrl : `${baseUrl}/models`;
    const authHeaders = (key) => {
      if (!key) return {};
      // A catalog on its own auth scheme (Google's x-goog-api-key) still needs
      // that header when the listing URL is passed in explicitly.
      if (known?.modelsKeyHeader) return { [known.modelsKeyHeader]: key };
      return { Authorization: `Bearer ${key}` };
    };
    let payload;
    let status = 0;
    let lastError = '';
    for (const key of keyCandidates) {
      try {
        const response = await fetch(catalogUrl, {
          signal: AbortSignal.timeout(15000),
          headers: { Accept: 'application/json', ...authHeaders(key) },
        });
        status = response.status;
        if (!response.ok) {
          lastError = `catalog HTTP ${response.status}`;
          // Only a rejected credential is worth retrying with the next key.
          if (response.status !== 401 && response.status !== 403) break;
          continue;
        }
        payload = await response.json();
        lastError = '';
        break;
      } catch (error) {
        lastError = `catalog fetch failed: ${error instanceof Error ? error.message : String(error)}`;
        break;
      }
    }
    if (!payload) {
      const hint =
        status === 401 || status === 403
          ? ' — the provider rejected every key configured for it; save a working key first'
          : '';
      return sendJson(res, 502, { error: { message: `${lastError || 'catalog fetch failed'}${hint}`, type: 'upstream_error' } });
    }
    const entries = Array.isArray(payload?.data) ? payload.data : [];
    const models = [];
    for (const entry of entries) {
      const id = typeof entry?.id === 'string' ? entry.id.trim() : '';
      if (!id || models.some((m) => m.id === id)) continue;
      if (models.length >= 200) break;
      // Three answers, not a boolean: a listing without prices cannot say a
      // model is free, and the UI must warn on both paid and unknown picks.
      const price = priceClass(entry);
      models.push({ id, free: price === 'free', paid: price === 'paid', unknown: price === 'unknown' });
    }
    return sendJson(res, 200, { ok: true, models, truncated: entries.length > models.length });
  }

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
    const selectedModels = Array.isArray(body.selectedModels)
      ? [...new Set(body.selectedModels.map((m) => String(m || '').trim()).filter(Boolean))]
      : [];
    const catalog = body.catalog === true;
    const cfg = {
      baseUrl,
      keyEnv: String(body.keyEnv || `${name.replace(/-/g, '_').toUpperCase()}_API_KEY`),
      catalog,
      pricing: body.pricing !== false,
      // A catalog without published prices is exactly the case probing exists
      // for, so a new provider opts in unless the operator turns it off. The
      // flag only takes effect on such a catalog (see providers.mjs).
      probeFreeTier: catalog && body.probeFreeTier !== false,
      freeModels,
      keys: [],
    };
    if (selectedModels.length) cfg.selectedModels = selectedModels;
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
    scheduleProbeDrain(name, 0);
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
    // No route lists to purge any more, but the provider's models leave the
    // pool, so their 24h payment blocks and any queued probe batches would only
    // outlive the entry they describe.
    clearProbeTimers(name);
    let purged = 0;
    for (const key of Object.keys(paymentBlocks)) {
      if (!key.startsWith(`${name}:`)) continue;
      delete paymentBlocks[key];
      purged += 1;
    }
    if (purged) scheduleStateSave();
    if (!persistOrFail(res)) return undefined;
    refreshSecretRedactor();
    log(`deleted provider ${name} via web interface (cleared ${purged} payment block(s))`);
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
    if (body.selectedModels !== undefined) {
      if (!Array.isArray(body.selectedModels)) {
        return sendJson(res, 400, { error: { message: 'selectedModels must be an array', type: 'invalid_request_error' } });
      }
      registry.setSelectedModels(name, body.selectedModels);
      // Route the live list through the overlay-owning object so the write
      // lands in the file that survives a restart.
      cfg.selectedModels = [...provider.selectedModels];
      notes.push('selectedModels updated');
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
      // The discovery loop reads this straight off the live provider object,
      // so probing can start or stop without a restart.
      provider.probeFreeTier = cfg.probeFreeTier;
      notes.push('probeFreeTier updated');
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
    scheduleProbeDrain(name, 0);
    return sendJson(res, 200, { ok: true, name, notes });
  }

  return sendJson(res, 400, { error: { message: `unknown action: ${action}`, type: 'invalid_request_error' } });
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
  // Switching discovery or evaluation back on should not wait for the next
  // interval: any provider already known to need probing starts draining now.
  if (
    (body.enabled !== undefined || body.evaluationEnabled !== undefined) &&
    discoveryEnabled &&
    evaluationEnabled
  ) {
    for (const provider of PROVIDERS.values()) scheduleProbeDrain(provider.name, 0);
  }
  // Manual run: bypass the interval check and start in the background, since
  // probing and evaluating can take far longer than an HTTP request should.
  if (body.runNow === true) {
    if (!discoveryEnabled) {
      notes.push('discovery is disabled');
    } else {
      discoveryLastCheckedAt = 0;
      discoverFreeModels(true).catch((error) => {
        log(`manual discovery failed: ${error instanceof Error ? error.message : String(error)}`);
      });
      notes.push('discovery started in the background');
    }
  }
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
  if (body.streamIdleTimeoutMs !== undefined) {
    const value = Number(body.streamIdleTimeoutMs);
    if (!Number.isFinite(value) || value < 0 || value > 600000) {
      return sendJson(res, 400, { error: { message: 'streamIdleTimeoutMs must be 0-600000', type: 'invalid_request_error' } });
    }
    setOverlayValue(['streamIdleTimeoutMs'], value);
  }
  if (body.requestBudgetMs !== undefined) {
    const value = Number(body.requestBudgetMs);
    if (!Number.isFinite(value) || value < 5000 || value > 1800000) {
      return sendJson(res, 400, { error: { message: 'requestBudgetMs must be 5000-1800000', type: 'invalid_request_error' } });
    }
    setOverlayValue(['requestBudgetMs'], value);
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
    // Refuse an unknown zone here rather than storing it: the runtime can only
    // fall back to local dates after a restart, which silently moves the quota
    // day boundary. Empty stays legal and means "this machine's timezone".
    const zone = normalizeTimeZone(body.timezone);
    if (zone === null) {
      return sendJson(res, 400, {
        error: { message: `unknown timezone: ${String(body.timezone)}`, type: 'invalid_request_error' },
      });
    }
    setOverlayValue(['usage', 'timezone'], zone);
    notes.push(`timezone ${zone || '(local)'} saved; restart to take effect`);
  }
  if (body.sessionTtlHours !== undefined) {
    const value = Number(body.sessionTtlHours);
    if (!Number.isFinite(value) || value < 0 || value > 8760) {
      return sendJson(res, 400, { error: { message: 'sessionTtlHours must be 0-8760 (0 = never expires)', type: 'invalid_request_error' } });
    }
    setOverlayValue(['webui', 'sessionTtlHours'], value);
    notes.push(value === 0 ? 'sessions never expire' : `sessions expire after ${value} hour(s); existing sessions keep their old expiry`);
  }
  if (body.requestLogPersist !== undefined) {
    const value = Boolean(body.requestLogPersist);
    setOverlayValue(['webui', 'requestLogPersist'], value);
    notes.push(value ? 'request log persistence enabled' : 'request log persistence disabled');
  }
  if (body.dismissMigrationNotice === true) {
    deleteOverlayValue(['migratedFromEnv']);
  }
  if (!persistOrFail(res)) return undefined;
  audit('settings.update', {
    ip: clientAddress(req),
    detail: Object.keys(body).join(',') || 'none',
  });
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
    audit('system.restart', { actor: 'system', detail: 'requested from the web interface' });
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

// Behind a reverse proxy every connection comes from 127.0.0.1, so the login
// brake has to key on the forwarded client address once trustProxy is on.
function clientAddress(req) {
  if (trustProxy()) {
    const forwarded = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    if (forwarded) return forwarded;
  }
  return req.socket?.remoteAddress || 'unknown';
}

async function handleLogin(req, res) {
  let body;
  try {
    body = await readJson(req, 64 * 1024);
  } catch (error) {
    return sendJson(res, 400, { error: { message: String(error), type: 'invalid_request_error' } });
  }
  const password = typeof body.password === 'string' ? body.password : '';
  const clientIp = clientAddress(req);
  pruneLoginFailures();
  const lock = loginLockout(loginFailures.get(clientIp));
  if (lock.locked) {
    log(`blocked web UI login brute force from ${clientIp}`);
    audit('auth.login.locked', { actor: 'anonymous', result: 'fail', ip: clientIp, detail: 'too many failed attempts' });
    return sendJson(res, 429, { error: { message: 'too many failed attempts', type: 'rate_limited' } }, {
      'Retry-After': String(Math.ceil((lock.retryAfterMs || 0) / 1000)),
    });
  }
  if (!(await checkWebuiPassword(password))) {
    loginFailures.set(clientIp, recordLoginFailure(loginFailures.get(clientIp)));
    log(`failed web UI login from ${clientIp}`);
    audit('auth.login', { actor: 'anonymous', result: 'fail', ip: clientIp, detail: 'invalid password' });
    return sendJson(res, 401, { error: { message: 'invalid password', type: 'unauthorized' } });
  }
  loginFailures.delete(clientIp);
  await upgradePasswordStorage('login');
  const token = crypto.randomBytes(32).toString('hex');
  pruneWebuiSessions();
  const ttlHours = sessionTtlHours();
  const expiresAt = ttlHours > 0 ? Date.now() + Math.round(ttlHours * 3600000) : Number.POSITIVE_INFINITY;
  webuiSessions.set(token, {
    expiresAt,
    createdAt: Date.now(),
    ip: clientIp,
    userAgent: String(req.headers['user-agent'] || ''),
  });
  audit('auth.login', { ip: clientIp, target: sessionId(token), detail: 'session created' });
  // Cookie lifetime mirrors the server-side TTL; "never" becomes a browser
  // session cookie so it still dies with the browser.
  const maxAge = ttlHours > 0 ? `; Max-Age=${Math.round(ttlHours * 3600)}` : '';
  const secure = secureCookie() ? '; Secure' : '';
  res.writeHead(200, {
    'Content-Type': 'application/json; charset=utf-8',
    'Set-Cookie': `fr_session=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax${secure}${maxAge}`,
    'Cache-Control': 'no-store',
  });
  return res.end(JSON.stringify({
    ok: true,
    expiresAt: Number.isFinite(expiresAt) ? new Date(expiresAt).toISOString() : null,
  }));
}

async function handler(req, res) {
  const url = new URL(req.url || '/', `http://${req.headers.host || `${HOST}:${PORT}`}`);
  // CORS is for the gateway API only; the web UI is same-origin by design and
  // deliberately gets no cross-origin permission.
  if (url.pathname.startsWith('/v1/')) {
    const cors = corsHeaders(config.gateway?.cors, req.headers.origin);
    if (cors) {
      for (const [name, value] of Object.entries(cors)) res.setHeader(name, value);
      // A preflight asks for permission, not for data, and carries no
      // Authorization header: answer it before any auth check.
      if (req.method === 'OPTIONS') {
        res.writeHead(204);
        return res.end();
      }
    }
  }
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
      // img-src is not decoration: the favicon is an image the page declares,
      // and `default-src 'none'` blocks it before the request is even made, so
      // the tab silently shows no icon. Anything else stays forbidden.
      'Content-Security-Policy':
        "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self'; form-action 'none'; base-uri 'none'",
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
    const logoutToken = webuiSessionToken(req);
    webuiSessions.delete(logoutToken);
    audit('auth.logout', { ip: clientAddress(req), target: sessionId(logoutToken) });
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Set-Cookie': `fr_session=; Path=/; HttpOnly; SameSite=Lax${secureCookie() ? '; Secure' : ''}; Max-Age=0`,
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
  // Icons are part of the login page, so they cannot sit behind the session.
  // Browsers request them without credentials, and CSP forbids external assets.
  // Each format is served as its own file because Safari's pinned tab and iOS's
  // home screen reject the tab icon's shape (see app/icons.mjs).
  if (req.method === 'GET' && url.pathname === '/favicon.svg') {
    res.writeHead(200, {
      'Content-Type': 'image/svg+xml; charset=utf-8',
      'Content-Length': Buffer.byteLength(FAVICON_SVG),
      'Cache-Control': 'public, max-age=86400',
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'",
      'X-Content-Type-Options': 'nosniff',
    });
    return res.end(FAVICON_SVG);
  }
  if (req.method === 'GET' && url.pathname === '/mask-icon.svg') {
    res.writeHead(200, {
      'Content-Type': 'image/svg+xml; charset=utf-8',
      'Content-Length': Buffer.byteLength(MASK_ICON_SVG),
      // Pinned tabs keep the icon for the life of the tab, so a day is plenty
      // and a stale shape clears fast after an update.
      'Cache-Control': 'public, max-age=86400',
      'Content-Security-Policy': "default-src 'none'",
      'X-Content-Type-Options': 'nosniff',
    });
    return res.end(MASK_ICON_SVG);
  }
  if (req.method === 'GET' && url.pathname === '/apple-touch-icon.png') {
    const icon = appleTouchIconPng();
    res.writeHead(200, {
      'Content-Type': 'image/png',
      'Content-Length': icon.length,
      'Cache-Control': 'public, max-age=86400',
      'Content-Security-Policy': "default-src 'none'",
      'X-Content-Type-Options': 'nosniff',
    });
    return res.end(icon);
  }
  if (req.method === 'GET' && url.pathname === '/api/state') {
    if (catalogsCold()) await refreshCatalog();
    else refreshCatalogSoon();
    return sendJson(
      res,
      200,
      {
        endpoint: `http://${HOST}:${PORT}/v1`,
        envFile: displayPath(UI_ENV_PATH),
        configFile: displayPath(CONFIG_PATH),
        configFormat: CONFIG_FORMAT,
        overlayFile: displayPath(OVERLAY_PATH),
        defaultModel: DEFAULT_MODEL_ALIAS,
        server: { host: config.host, port: config.port, runningHost: HOST, runningPort: PORT, lan: describeLanAccess() },
        gateway: {
          requireAuth: gatewayAuthRequired(),
          keys: gatewayKeys().map((entry) => ({
            name: entry.name,
            masked: maskSecret(entry.key),
            createdAt: entry.createdAt || null,
            expiresAt: entry.expiresAt || null,
            dailyLimit: Number(entry.dailyLimit) > 0 ? Math.floor(Number(entry.dailyLimit)) : null,
            usedToday: gatewayKeyUsedToday(entry.name),
          })),
        },
        webui: {
          defaultPassword: isDefaultPassword(),
          requestLogPersist: requestLogPersistEnabled(),
          passwordChangedAt: config.webui?.passwordChangedAt || null,
          sessionTtlHours: sessionTtlHours(),
          sessionExpiresAt: (() => {
            const session = webuiSessions.get(webuiSessionToken(req));
            if (!session) return null;
            return Number.isFinite(session.expiresAt) ? new Date(session.expiresAt).toISOString() : null;
          })(),
        },
        providers: uiProviderState(),
        usage: usageSummary(),
        pool: poolStatus(),
        paymentBlocks,
        migration: config.migratedFromEnv || null,
        editable: editableConfigState(),
        unavailableModels: discoveryUnavailableIds,
        excludedByProvider: rejectedConfiguredModels(),
        lastSelection,
      },
      { 'Cache-Control': 'no-store' },
    );
  }
  if (req.method === 'GET' && url.pathname === '/api/logs') {
    // Session-protected by the global /api/* gate above. Newest first; the
    // buffer is already bounded, so there is nothing to page or filter here.
    return sendJson(res, 200, clientRequestLog.snapshot(), { 'Cache-Control': 'no-store' });
  }
  if (req.method === 'GET' && url.pathname === '/api/audit') {
    // Session-protected by the global /api/* gate. Reads the tail of the
    // append-only file; `limit` is capped so a big file cannot be pulled in
    // one response.
    const requested = Number(url.searchParams.get('limit') || 100);
    const limit = Number.isFinite(requested) ? Math.min(500, Math.max(1, Math.floor(requested))) : 100;
    let records = [];
    try {
      if (fs.existsSync(AUDIT_PATH)) {
        const lines = fs.readFileSync(AUDIT_PATH, 'utf8').split(/\r?\n/).filter(Boolean);
        records = parseAuditLines(lines.slice(-limit).join('\n'));
      }
    } catch (error) {
      log(`failed to read audit log: ${error instanceof Error ? error.message : String(error)}`);
    }
    return sendJson(
      res,
      200,
      { path: displayPath(AUDIT_PATH), limit, entries: records.reverse() },
      { 'Cache-Control': 'no-store' },
    );
  }
  if (req.method === 'DELETE' && url.pathname === '/api/logs') {
    // Clearing drops the ring and, when persistence is on, the file too:
    // Clear means gone, not hidden until the next restart.
    const cleared = clientRequestLog.clear();
    if (requestLogPersistEnabled()) {
      try {
        fs.rmSync(REQUEST_LOG_PATH, { force: true });
      } catch (error) {
        log(`failed to clear persisted request log: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return sendJson(res, 200, { ok: true, cleared }, { 'Cache-Control': 'no-store' });
  }
  if (req.method === 'GET' && url.pathname === '/api/sessions') {
    // Tokens never leave the server: rows carry a hash-derived id only.
    pruneWebuiSessions();
    return sendJson(
      res,
      200,
      {
        ttlHours: sessionTtlHours(),
        sessions: listSessions(webuiSessions, { currentToken: webuiSessionToken(req) }),
      },
      { 'Cache-Control': 'no-store' },
    );
  }
  if (req.method === 'POST' && url.pathname === '/api/sessions') {
    let body;
    try {
      body = await readJson(req, 16 * 1024);
    } catch (error) {
      return sendJson(res, 400, { error: { message: String(error), type: 'invalid_request_error' } });
    }
    const action = String(body.action || '');
    const currentToken = webuiSessionToken(req);
    const clearedCookie = `fr_session=; Path=/; HttpOnly; SameSite=Lax${secureCookie() ? '; Secure' : ''}; Max-Age=0`;
    if (action === 'revoke') {
      const id = String(body.id || '').slice(0, 64);
      const removed = revokeSessions(webuiSessions, { id, currentToken });
      if (!removed) {
        return sendJson(res, 404, { error: { message: `unknown session: ${id}`, type: 'not_found' } });
      }
      const signedOut = !webuiSessions.has(currentToken);
      log(`revoked a web UI session via web interface${signedOut ? ' (the current one)' : ''}`);
      audit('auth.session.revoke', {
        target: id,
        ip: clientAddress(req),
        detail: signedOut ? 'current session' : '',
      });
      return sendJson(
        res,
        200,
        { ok: true, removed, signedOut },
        signedOut
          ? { 'Cache-Control': 'no-store', 'Set-Cookie': clearedCookie }
          : { 'Cache-Control': 'no-store' },
      );
    }
    if (action === 'revoke-others') {
      const removed = revokeSessions(webuiSessions, { others: true, currentToken });
      log(`revoked ${removed} other web UI session(s) via web interface`);
      audit('auth.session.revoke-others', {
        ip: clientAddress(req),
        detail: `${removed} session(s)`,
      });
      return sendJson(res, 200, { ok: true, removed }, { 'Cache-Control': 'no-store' });
    }
    return sendJson(res, 400, { error: { message: `unknown action: ${action}`, type: 'invalid_request_error' } });
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
  if (req.method === 'POST' && url.pathname === '/api/limits') {
    return handleLimits(req, res);
  }
  if (req.method === 'POST' && url.pathname === '/api/discovery') {
    return handleDiscovery(req, res);
  }
  if (req.method === 'POST' && url.pathname === '/api/settings') {
    return handleSettings(req, res);
  }
  // The minimal shape names nothing sensitive and is what container probes
  // and remote callers get.
  if (req.method === 'GET' && url.pathname === '/healthz') {
    return sendJson(res, 200, { ok: true, service: 'free-router', version: VERSION });
  }
  if (req.method === 'GET' && (url.pathname === '/health' || url.pathname === '/v1/health')) {
    // The full payload lists provider key labels, payment blocks, usage and
    // the whole pool. Serve it to loopback (container probes) and to an
    // authenticated admin; a LAN or proxied caller gets the minimal answer.
    const local = isLoopbackAddress(req.socket.remoteAddress);
    if (!local && webuiAuthFailure(req)) {
      return sendJson(res, 200, { ok: true, service: 'free-router', version: VERSION });
    }
    return sendJson(res, 200, healthPayload());
  }
  if (req.method === 'GET' && url.pathname === '/api/health') {
    return sendJson(res, 200, healthPayload());
  }
  // Prometheus scrape target. It follows the same credential rule as /v1
  // (bearer key once keys exist) but does not count the scrape against the
  // key's daily quota.
  if (req.method === 'GET' && url.pathname === '/metrics') {
    const failure = gatewayCredentialFailure(req);
    if (failure) return sendGatewayFailure(res, failure);
    const pool = orderedPool();
    const now = Date.now();
    const text = formatMetrics({
      version: VERSION,
      startedAt: processTotals.startedAt,
      now,
      pool: { free: pool.free, paid: pool.paid },
      totals: processTotals,
      cooldowns: [...cooldowns.values()].filter((entry) => Number(entry?.until) > now),
      gatewayKeys: gatewayKeys().map((entry) => ({
        name: entry.name,
        usedToday: gatewayKeyUsedToday(entry.name),
        dailyLimit: entry.dailyLimit ?? null,
      })),
    });
    res.writeHead(200, {
      'Content-Type': 'text/plain; version=0.0.4; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    return res.end(text);
  }
  if (req.method === 'GET' && url.pathname === '/v1/models') {
    const gatewayFailure = gatewayGuard(req);
    if (gatewayFailure) return sendGatewayFailure(res, gatewayFailure);
    const models = await gatewayModels();
    return sendJson(res, 200, {
      object: 'list',
      data: models,
    });
  }
  // OpenAI clients fetch a single model before using it; a 404 here is how
  // they learn the id is not in this pool.
  if (req.method === 'GET' && url.pathname.startsWith('/v1/models/')) {
    const gatewayFailure = gatewayGuard(req);
    if (gatewayFailure) return sendGatewayFailure(res, gatewayFailure);
    let id = url.pathname.slice('/v1/models/'.length);
    try {
      id = decodeURIComponent(id);
    } catch {
      // Keep the raw text; it simply will not match.
    }
    const models = await gatewayModels();
    const model = models.find((entry) => entry.id === id);
    if (!model) {
      return sendJson(res, 404, {
        error: { message: `unknown model: ${id}`, type: 'model_not_found' },
      });
    }
    return sendJson(res, 200, model);
  }
  if (req.method === 'POST' && url.pathname === '/v1/embeddings') {
    const gatewayFailure = gatewayGuard(req);
    if (gatewayFailure) return sendGatewayFailure(res, gatewayFailure);
    return handleEmbeddings(req, res);
  }
  if (req.method === 'POST' && url.pathname === '/v1/chat/completions') {
    const gatewayFailure = gatewayGuard(req);
    if (gatewayFailure) return sendGatewayFailure(res, gatewayFailure);
    return handleChat(req, res);
  }
  if (req.method === 'POST' && url.pathname === '/v1/responses') {
    const gatewayFailure = gatewayGuard(req);
    if (gatewayFailure) return sendGatewayFailure(res, gatewayFailure);
    return handleChat(req, res, { dialect: 'responses' });
  }
  return sendJson(res, 404, {
    error: { message: `Unknown endpoint: ${req.method} ${url.pathname}`, type: 'not_found' },
  });
}

function healthPayload() {
  const defaultCatalog = PROVIDERS.get(registry.defaultProvider);
  return {
    ok: true,
    service: 'free-router',
    version: VERSION,
    defaultProvider: registry.defaultProvider,
    defaultModel: DEFAULT_MODEL_ALIAS,
    catalogModels: defaultCatalog?.catalog?.size || 0,
    catalogFetchedAt: defaultCatalog?.catalogFetchedAt
      ? new Date(defaultCatalog.catalogFetchedAt).toISOString()
      : null,
    catalogError: defaultCatalog?.catalogError || null,
    providers: registry.health(),
    discovery: {
      enabled: discoveryEnabled,
      intervalMs: DISCOVERY_INTERVAL_MS,
      lastCheckedAt: discoveryLastCheckedAt
        ? new Date(discoveryLastCheckedAt).toISOString()
        : null,
      freeModelsSeen: discoverySeenIds.length,
      removedModels: discoveryRemovedIds,
      excludedModels: excludedModelIds(),
      unavailableModels: discoveryUnavailableIds,
      modelVerdicts,
      // Which providers can contribute new models, and which are only
      // checked for models that disappeared.
      addsFrom: [...PROVIDERS.values()]
        .filter((provider) => provider.discover || provider.probeFreeTier)
        .map((provider) => provider.name),
      availabilityOnly: [...PROVIDERS.values()]
        .filter((provider) => provider.usesCatalog && !provider.catalogHasPricing && !provider.probeFreeTier)
        .map((provider) => provider.name),
      evaluations: modelEvaluations,
      probing: [...probeRunning],
      probePending: Object.fromEntries(
        [...PROVIDERS.values()]
          .map((provider) => [provider.name, probePendingCount(provider.name)])
          .filter(([, count]) => count > 0),
      ),
      error: discoveryError || null,
    },
    lastSelection,
    usage: usageSummary(),
    pool: poolStatus(),
    paymentBlocks,
  };
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

// A non-loopback bind without gateway keys or with the default password
// would start open to the LAN: refuse instead of warning into the void.
const guardReasons = lanGuard({
  host: HOST,
  keyCount: gatewayKeys().length,
  isDefaultPassword: isDefaultPassword(),
});
if (guardReasons.length) {
  console.error(`refusing to start on ${HOST}: ${guardReasons.join('; ')}`);
  console.error('Create a gateway key and change the admin password first, or bind 127.0.0.1.');
  process.exit(1);
}

server.listen(PORT, HOST, async () => {
  log(`Free Router ${VERSION} listening on http://${HOST}:${PORT}/v1 (config: ${displayPath(CONFIG_PATH)}, ${CONFIG_FORMAT})`);
  audit('system.boot', { actor: 'system', detail: `version ${VERSION} on ${HOST}:${PORT}` });
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
  scheduleNextCatalogRefresh();
  await discoverFreeModels();
  scheduleNextDiscovery();
});

// How long a shutdown waits for in-flight requests before cutting their
// sockets. Long enough for a normal answer to finish, short enough to fit
// inside Docker's default 10 s stop timeout.
const SHUTDOWN_GRACE_MS = 8000;

// Bind failures are fatal and should say why: EADDRINUSE otherwise surfaces as
// an unhandled 'error' event with a stack that hides the one useful fact.
server.on('error', (error) => {
  const code = error?.code;
  if (code === 'EADDRINUSE') {
    console.error(`cannot listen on ${HOST}:${PORT}: address already in use (is free-router already running?)`);
  } else if (code === 'EACCES') {
    console.error(`cannot listen on ${HOST}:${PORT}: permission denied (ports below 1024 need privileges)`);
  } else {
    console.error(`server error: ${error?.message || error}`);
  }
  process.exit(1);
});

let shuttingDown = false;
function shutdown(signal) {
  // A second signal means "now": the first pass already tried to drain.
  if (shuttingDown) {
    log(`received ${signal} during shutdown; exiting now`);
    process.exit(1);
  }
  shuttingDown = true;
  log(`received ${signal}; shutting down`);
  if (stateSaveTimer) flushStateSave();
  // An in-flight SSE stream keeps close() waiting until the upstream finishes,
  // which can take minutes. Give connections a grace period, then cut them.
  const forceExit = setTimeout(() => {
    log('shutdown grace period elapsed; closing remaining connections');
    server.closeAllConnections?.();
    process.exit(0);
  }, SHUTDOWN_GRACE_MS);
  forceExit.unref();
  server.close(() => {
    clearTimeout(forceExit);
    process.exit(0);
  });
  // Idle keep-alive sockets are not tracked by close(); drop them so a quiet
  // process exits at once instead of after keepAliveTimeout.
  server.closeIdleConnections?.();
}
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => shutdown(signal));
}
