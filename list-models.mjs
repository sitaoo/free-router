#!/usr/bin/env node

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

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

for (const file of [path.join(HERE, '.env'), path.join(os.homedir(), '.hermes', '.env')]) {
  loadEnvFile(file);
}

const CONFIG_PATH = process.env.FREE_ROUTER_CONFIG || path.join(HERE, 'config.json');
const config = fs.existsSync(CONFIG_PATH)
  ? JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'))
  : {};
const HOST = process.env.FREE_ROUTER_HOST || config.host || '127.0.0.1';
const PORT = Number(process.env.FREE_ROUTER_PORT || config.port || 8787);
const DEFAULT_ROUTE = config.discovery?.route || 'free-best';

function usage() {
  console.log(`Usage: ./models.sh [options]

Show free-router models in priority order (same ranking as route \`free-best\`).

Options:
  --route <name>   Route alias to inspect (default: ${DEFAULT_ROUTE})
  --ready-only     Only show models that are ready right now
  --json           Machine-readable JSON output
  -h, --help       Show this help
`);
}

function parseArgs(argv) {
  const options = { route: DEFAULT_ROUTE, readyOnly: false, json: false, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '-h' || arg === '--help') {
      options.help = true;
      continue;
    }
    if (arg === '--ready-only') {
      options.readyOnly = true;
      continue;
    }
    if (arg === '--json') {
      options.json = true;
      continue;
    }
    if (arg === '--route') {
      options.route = String(argv[index + 1] || '');
      index += 1;
      continue;
    }
    throw new Error(`unknown option: ${arg}`);
  }
  if (!options.route) throw new Error('--route requires a value');
  return options;
}

function statusFor(entry, providerConfigured) {
  if (!providerConfigured) return 'no-key';
  if (entry.zeroCost === false) return 'paid';
  if (entry.cooldownSeconds > 0) return 'cooldown';
  return 'ready';
}

function annotate(entry, providers) {
  const providerConfigured = Boolean(providers?.[entry.provider]?.configured);
  const status = statusFor(entry, providerConfigured);
  return {
    priority: entry.priority,
    status,
    ready: status === 'ready',
    provider: entry.provider,
    model: entry.id,
    pinned: entry.pinned,
    score: entry.score,
    scoreSource: entry.scoreSource,
    zeroCost: entry.zeroCost,
    supportsTools: entry.supportsTools,
    cooldownSeconds: entry.cooldownSeconds,
    cooldownReason: entry.cooldownReason || null,
    providerConfigured,
  };
}

function pad(value, width) {
  const text = String(value ?? '');
  return text.length >= width ? text : text + ' '.repeat(width - text.length);
}

function formatTable(models, route, health, totalCount) {
  const lines = [];
  lines.push(`route: ${route}`);
  lines.push(`endpoint: http://${HOST}:${PORT}/v1`);
  if (health.lastSelection?.model) {
    const last = health.lastSelection;
    lines.push(
      `last used: ${last.provider}:${last.model} (${last.selectedAt || 'unknown time'})`,
    );
  }
  lines.push('');
  lines.push(
    `${pad('#', 3)}  ${pad('status', 9)}  ${pad('provider', 12)}  model`,
  );
  for (const entry of models) {
    const pin = entry.pinned ? ' *' : '';
    let status = entry.status;
    if (entry.status === 'cooldown') {
      status = `cooldown ${entry.cooldownSeconds}s`;
    }
    lines.push(
      `${pad(entry.priority, 3)}  ${pad(status, 9)}  ${pad(entry.provider, 12)}  ${entry.model}${pin}`,
    );
  }
  lines.push('');
  lines.push(`ready: ${models.filter((entry) => entry.ready).length}/${totalCount}`);
  lines.push('* = pinned');
  return lines.join('\n');
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    usage();
    return;
  }

  const url = `http://${HOST}:${PORT}/health`;
  let health;
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    health = await response.json();
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.error(`free-router is not reachable at http://${HOST}:${PORT} (${reason})`);
    console.error('start it with: ./start.sh');
    process.exit(1);
  }

  const routeModels = health.routes?.[options.route];
  if (!routeModels) {
    console.error(`route not found: ${options.route}`);
    console.error(`available routes: ${Object.keys(health.routes || {}).join(', ') || '(none)'}`);
    process.exit(1);
  }

  let models = routeModels.map((entry) => annotate(entry, health.providers));
  const totalCount = models.length;
  if (options.readyOnly) models = models.filter((entry) => entry.ready);

  if (options.json) {
    console.log(
      JSON.stringify(
        {
          route: options.route,
          endpoint: `http://${HOST}:${PORT}/v1`,
          readyCount: models.filter((entry) => entry.ready).length,
          totalCount,
          lastSelection: health.lastSelection || null,
          models,
        },
        null,
        2,
      ),
    );
    return;
  }

  console.log(formatTable(models, options.route, health, totalCount));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
