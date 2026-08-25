#!/usr/bin/env node

import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = process.env.FREE_ROUTER_CONFIG || path.join(HERE, 'config.json');
const OPENROUTER_BASE_URL = (
  process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1'
).replace(/\/+$/, '');

function loadEnvFile(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!match || process.env[match[1]] !== undefined) continue;
    let value = match[2];
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[match[1]] = value;
  }
}

loadEnvFile(path.join(os.homedir(), '.hermes', '.env'));

const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
const HOST = process.env.FREE_ROUTER_HOST || config.host || '127.0.0.1';
const PORT = Number(process.env.FREE_ROUTER_PORT || config.port || 8787);
const ATTEMPT_TIMEOUT_MS = Number(
  process.env.FREE_ROUTER_ATTEMPT_TIMEOUT_MS || config.attemptTimeoutMs || 180000,
);
const CATALOG_REFRESH_MS = Number(config.catalogRefreshMs || 900000);
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || '';

const cooldowns = new Map();
let catalog = new Map();
let catalogFetchedAt = 0;
let catalogError = '';

function log(message, detail = undefined) {
  const prefix = `[${new Date().toISOString()}]`;
  if (detail === undefined) console.log(prefix, message);
  else console.log(prefix, message, detail);
}

function openRouterHeaders() {
  return {
    Authorization: `Bearer ${OPENROUTER_API_KEY}`,
    'Content-Type': 'application/json',
    'HTTP-Referer':
      process.env.OPENROUTER_HTTP_REFERER ||
      'https://github.com/NousResearch/hermes-agent',
    'X-Title': process.env.OPENROUTER_APP_NAME || 'Hermes Agent',
  };
}

function isZeroCost(model) {
  const prompt = Number(model?.pricing?.prompt);
  const completion = Number(model?.pricing?.completion);
  return Number.isFinite(prompt) && Number.isFinite(completion) && prompt === 0 && completion === 0;
}

async function refreshCatalog(force = false) {
  if (!force && Date.now() - catalogFetchedAt < CATALOG_REFRESH_MS && catalog.size) return;
  try {
    const response = await fetch(`${OPENROUTER_BASE_URL}/models`, {
      headers: OPENROUTER_API_KEY
        ? { Authorization: `Bearer ${OPENROUTER_API_KEY}` }
        : undefined,
      signal: AbortSignal.timeout(30000),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = await response.json();
    catalog = new Map((payload.data || []).map((model) => [model.id, model]));
    catalogFetchedAt = Date.now();
    catalogError = '';
    const freeCount = [...catalog.values()].filter(isZeroCost).length;
    log(`catalog refreshed: ${catalog.size} models, ${freeCount} zero-cost`);
  } catch (error) {
    catalogError = error instanceof Error ? error.message : String(error);
    log(`catalog refresh failed; retaining previous catalog: ${catalogError}`);
  }
}

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

function supportsRequest(model, needs) {
  if (!model) return true;
  const supported = new Set(model.supported_parameters || []);
  if (needs.tools && !supported.has('tools')) return false;
  if (
    needs.responseFormat &&
    !supported.has('response_format') &&
    !supported.has('structured_outputs')
  ) {
    return false;
  }
  const inputs = new Set(model?.architecture?.input_modalities || ['text']);
  for (const modality of needs.modalities) {
    if (!inputs.has(modality)) return false;
  }
  return true;
}

function cooldownRemaining(modelId) {
  const entry = cooldowns.get(modelId);
  if (!entry) return 0;
  const remaining = entry.until - Date.now();
  if (remaining <= 0) {
    cooldowns.delete(modelId);
    return 0;
  }
  return remaining;
}

function setCooldown(modelId, kind, reason) {
  const durations = config.cooldownMs || {};
  const duration = Number(durations[kind] || 0);
  if (!duration) return;
  cooldowns.set(modelId, {
    until: Date.now() + duration,
    kind,
    reason: String(reason || '').slice(0, 300),
  });
}

function candidateModels(requestedModel, body) {
  const configured = config.routes?.[requestedModel];
  if (!configured) return [requestedModel];

  const needs = requestNeeds(body);
  const active = [];
  const skipped = [];
  for (const id of configured) {
    const model = catalog.get(id);
    if (model && !isZeroCost(model)) {
      skipped.push({ model: id, reason: 'not currently zero-cost' });
      continue;
    }
    if (!supportsRequest(model, needs)) {
      skipped.push({ model: id, reason: 'missing requested capability' });
      continue;
    }
    const remaining = cooldownRemaining(id);
    if (remaining > 0) {
      skipped.push({ model: id, reason: `cooldown ${Math.ceil(remaining / 1000)}s` });
      continue;
    }
    active.push(id);
  }

  // If every compatible model is cooling down, retry them in order instead of
  // turning a temporary cooldown into a hard outage.
  if (!active.length) {
    for (const id of configured) {
      const model = catalog.get(id);
      if ((!model || isZeroCost(model)) && supportsRequest(model, needs)) active.push(id);
    }
  }

  if (skipped.length) log(`${requestedModel}: skipped ${skipped.length} candidate(s)`, skipped);
  return active;
}

function sanitizeUpstreamBody(body, modelId) {
  const upstream = { ...body, model: modelId };
  delete upstream.models;
  delete upstream.route;
  return upstream;
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

function errorSummary(status, raw) {
  try {
    const parsed = JSON.parse(raw);
    return (
      parsed?.error?.metadata?.raw ||
      parsed?.error?.message ||
      parsed?.message ||
      `HTTP ${status}`
    );
  } catch {
    return raw.trim().slice(0, 500) || `HTTP ${status}`;
  }
}

async function fetchModel(modelId, body, clientSignal) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('attempt timeout')), ATTEMPT_TIMEOUT_MS);
  const abortFromClient = () => controller.abort(new Error('client disconnected'));
  clientSignal?.addEventListener('abort', abortFromClient, { once: true });
  const cleanup = () => {
    clearTimeout(timer);
    clientSignal?.removeEventListener('abort', abortFromClient);
  };
  try {
    const response = await fetch(`${OPENROUTER_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: openRouterHeaders(),
      body: JSON.stringify(sanitizeUpstreamBody(body, modelId)),
      signal: controller.signal,
    });
    return { response, cleanup };
  } catch (error) {
    cleanup();
    throw error;
  }
}

async function attemptJson(modelId, body, clientSignal) {
  let response;
  let cleanup = () => {};
  try {
    ({ response, cleanup } = await fetchModel(
      modelId,
      { ...body, stream: false },
      clientSignal,
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
  return {
    ok: true,
    payload,
    contentType: response.headers.get('content-type') || 'application/json',
  };
}

async function attemptStream(modelId, body, res, clientSignal) {
  let response;
  let cleanup = () => {};
  try {
    ({ response, cleanup } = await fetchModel(
      modelId,
      { ...body, stream: true },
      clientSignal,
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
    };
  }
  if (!response.body) {
    cleanup();
    return { ok: false, status: 502, reason: 'empty response body', kind: 'empty' };
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const bufferedChunks = [];
  let parserBuffer = '';
  let committed = false;
  let finishReason = '';

  while (true) {
    let read;
    try {
      read = await reader.read();
    } catch (error) {
      cleanup();
      if (committed) {
        res.end();
        return { ok: true, modelId, interrupted: true };
      }
      return { ok: false, status: 502, reason: String(error), kind: 'serverError' };
    }
    if (read.done) break;
    const bytes = Buffer.from(read.value);
    if (committed) {
      res.write(bytes);
      continue;
    }

    bufferedChunks.push(bytes);
    parserBuffer += decoder.decode(read.value, { stream: true });
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
            'X-Free-Router-Model': modelId,
          });
          for (const chunk of bufferedChunks) res.write(chunk);
          bufferedChunks.length = 0;
          committed = true;
          log(`selected ${modelId} (stream)`);
          break;
        }
      } catch {
        // Ignore keepalives and malformed provider-specific event lines.
      }
    }
  }

  if (committed) {
    cleanup();
    res.end();
    return { ok: true, modelId };
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
  for (const [name, ids] of Object.entries(config.routes || {})) {
    routes[name] = ids.map((id, priority) => {
      const model = catalog.get(id);
      const cooldown = cooldowns.get(id);
      return {
        priority: priority + 1,
        id,
        zeroCost: model ? isZeroCost(model) : null,
        supportsTools: model ? (model.supported_parameters || []).includes('tools') : null,
        cooldownSeconds:
          cooldown && cooldown.until > now ? Math.ceil((cooldown.until - now) / 1000) : 0,
        cooldownReason: cooldown?.reason,
      };
    });
  }
  return routes;
}

async function handleChat(req, res) {
  if (!OPENROUTER_API_KEY) {
    return sendJson(res, 503, {
      error: {
        message: 'OPENROUTER_API_KEY is not configured',
        type: 'router_configuration_error',
      },
    });
  }

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
  const clientController = new AbortController();
  res.on('close', () => {
    if (!res.writableEnded) clientController.abort();
  });

  for (const modelId of candidates) {
    if (clientController.signal.aborted) return;
    log(`trying ${modelId} for ${requestedModel}`);
    const result = body.stream
      ? await attemptStream(modelId, body, res, clientController.signal)
      : await attemptJson(modelId, body, clientController.signal);

    if (result.ok) {
      if (!body.stream) {
        log(`selected ${modelId}`);
        return sendJson(res, 200, result.payload, { 'X-Free-Router-Model': modelId });
      }
      return;
    }

    failures.push({ model: modelId, status: result.status, reason: result.reason });
    if (result.kind) setCooldown(modelId, result.kind, result.reason);
    log(`failed ${modelId}: ${result.status} ${result.reason}`);
    if (result.fatal) break;
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

async function handler(req, res) {
  const url = new URL(req.url || '/', `http://${req.headers.host || `${HOST}:${PORT}`}`);
  if (req.method === 'GET' && (url.pathname === '/health' || url.pathname === '/v1/health')) {
    await refreshCatalog();
    return sendJson(res, 200, {
      ok: true,
      service: 'openrouter-free-router',
      catalogModels: catalog.size,
      catalogFetchedAt: catalogFetchedAt ? new Date(catalogFetchedAt).toISOString() : null,
      catalogError: catalogError || null,
      routes: routeStatus(),
    });
  }
  if (req.method === 'GET' && url.pathname === '/v1/models') {
    await refreshCatalog();
    return sendJson(res, 200, {
      object: 'list',
      data: Object.keys(config.routes || {}).map((id) => ({
        id,
        object: 'model',
        created: 0,
        owned_by: 'openrouter-free-router',
      })),
    });
  }
  if (req.method === 'POST' && url.pathname === '/v1/chat/completions') {
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
  log(`OpenRouter free router listening on http://${HOST}:${PORT}/v1`);
  if (!OPENROUTER_API_KEY) log('warning: OPENROUTER_API_KEY is missing');
  await refreshCatalog(true);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    log(`received ${signal}; shutting down`);
    server.close(() => process.exit(0));
  });
}
