#!/usr/bin/env node
// Sync external model scores into the overlay's baselineScores (consumed by
// explicitScore() with zero server changes).
//
// Sources:
//   openrouter  live catalog (no key): free/pricing report only, writes nothing.
//   file        JSON leaderboard: { "source": "name",
//                "scores": { "<display name or id>": <number>, ... } }
//               min/max auto-derived; normalized into the 40-80 prior band.
//
// Merge policy: fetched keys overwrite (refresh beats stale), manual-only
// keys are never deleted. Dry run by default; --apply writes.
// Usage: node script/sync-scores.mjs --source file --file scores.json [--apply]
//        node script/sync-scores.mjs --source openrouter
//        node script/sync-scores.mjs --data-dir /tmp/seed-test --source file ...
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  isPlainObject,
  loadOverlayFile,
  resolveLayout,
  saveOverlayFile,
} from '../app/config.mjs';
import {
  mapModelKey,
  mergeBaselineScores,
  normalizeBand,
  summarizeCatalog,
} from '../app/scores.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..');

// Curated alias table: normalized source name -> baselineScores key (bare
// model id; capability is model-intrinsic, explicitScore also matches it
// under any provider prefix). Extend as new leaderboard names appear.
const MODEL_ALIASES = {
  gemini38flash: 'gemini-3.8-flash',
  gemini37flash: 'gemini-3.7-flash',
  gemini35flashlite: 'gemini-3.5-flash-lite',
  gemini31flashlite: 'gemini-3.1-flash-lite',
  zaiglm53free: 'z-ai/glm-5.3-free',
  glm53flash: 'glm-5.3-flash',
  qwen38flash: 'qwen3.8-flash',
  deepseekv4flash: 'deepseek-v4-flash',
  hy3: 'hy3',
  mimo25: 'mimo-v2.5',
};

function usage() {
  console.log(`Usage: node script/sync-scores.mjs [options]

Sync external model scores into overlay baselineScores.

Options:
  --source <openrouter|file>  Score source (default: file)
  --file <path>               Leaderboard JSON for --source file:
                              { "source": "name", "scores": { "Name": 123 } }
  --data-dir <dir>            Data dir holding config.local.json
                              (default: <repo>/data)
  --apply                     Write the overlay (default: dry run)
  -h, --help                  Show this help
`);
}

function parseArgs(argv) {
  const options = { source: 'file', file: '', dataDir: '', apply: false, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '-h' || arg === '--help') options.help = true;
    else if (arg === '--apply') options.apply = true;
    else if (arg === '--source') options.source = String(argv[i + 1] || '');
    else if (arg === '--file') options.file = String(argv[i + 1] || '');
    else if (arg === '--data-dir') options.dataDir = String(argv[i + 1] || '');
    else if (arg.startsWith('--source=')) options.source = arg.slice('--source='.length);
    else if (arg.startsWith('--file=')) options.file = arg.slice('--file='.length);
    else if (arg.startsWith('--data-dir=')) options.dataDir = arg.slice('--data-dir='.length);
    else throw new Error(`unknown option: ${arg}`);
    if (['--source', '--file', '--data-dir'].includes(arg)) i += 1;
  }
  if (options.help) return options;
  if (!['openrouter', 'file'].includes(options.source)) {
    throw new Error(`--source must be openrouter or file, got: ${options.source}`);
  }
  if (options.source === 'file' && !options.file) throw new Error('--source file requires --file <path>');
  return options;
}

async function fetchOpenRouterModels() {
  const response = await fetch('https://openrouter.ai/api/v1/models', {
    signal: AbortSignal.timeout(30000),
    headers: { Accept: 'application/json' },
  });
  if (!response.ok) throw new Error(`OpenRouter catalog HTTP ${response.status}`);
  const payload = await response.json();
  if (!Array.isArray(payload?.data)) throw new Error('OpenRouter catalog has no data array');
  return payload.data;
}

function readLeaderboard(file) {
  const raw = fs.readFileSync(file, 'utf8');
  const parsed = JSON.parse(raw);
  const scores = parsed?.scores && typeof parsed.scores === 'object' ? parsed.scores : null;
  if (!scores || !Object.keys(scores).length) {
    throw new Error(`${file}: need { "source": "name", "scores": { "Name": <number> } }`);
  }
  return { source: String(parsed.source || path.basename(file)), scores };
}

function toBaselineScores(scores, source) {
  const values = Object.values(scores).map(Number).filter(Number.isFinite);
  if (!values.length) throw new Error(`${source}: no finite scores`);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const mapped = {};
  const skipped = [];
  for (const [name, raw] of Object.entries(scores)) {
    const value = Number(raw);
    if (!Number.isFinite(value)) {
      skipped.push(String(name));
      continue;
    }
    const key = mapModelKey(name, MODEL_ALIASES);
    if (!key) {
      skipped.push(String(name));
      continue;
    }
    mapped[key] = normalizeBand(value, min, max);
  }
  return { mapped, skipped };
}

function overlayPaths(dataDir) {
  const layout = resolveLayout({
    appDir: path.join(REPO_ROOT, 'app'),
    dataDir: dataDir || path.join(REPO_ROOT, 'data'),
  });
  return layout.overlayPath;
}

function readBaselineScores(overlayPath) {
  const { overlay } = loadOverlayFile(overlayPath);
  const chain = overlay?.discovery?.evaluation?.baselineScores;
  return chain && typeof chain === 'object' ? chain : {};
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    usage();
    return;
  }
  if (options.source === 'openrouter') {
    const models = await fetchOpenRouterModels();
    const summary = summarizeCatalog(models);
    console.log(`openrouter catalog: ${summary.total} models`);
    console.log(`free (${summary.free.length}): ${summary.free.join(', ') || '(none)'}`);
    console.log(`priced: ${summary.priced.length}, no-pricing-info: ${summary.unknown.length}`);
    console.log('report only: quality priors come from --source file leaderboards.');
    return;
  }
  const { source, scores } = readLeaderboard(options.file);
  const { mapped, skipped } = toBaselineScores(scores, source);
  if (!Object.keys(mapped).length) throw new Error(`${source}: nothing mapped (extend MODEL_ALIASES)`);
  const overlayPath = overlayPaths(options.dataDir);
  const existing = readBaselineScores(overlayPath);
  const { merged, added, updated, kept } = mergeBaselineScores(existing, mapped);
  console.log(`source: ${source} (${Object.keys(scores).length} entries, ${Object.keys(mapped).length} mapped)`);
  if (skipped.length) console.log(`skipped unmapped: ${skipped.join(', ')}`);
  console.log(`overlay: ${overlayPath}`);
  console.log(`add ${added.length}${added.length ? ` (${added.join(', ')})` : ''}, update ${updated.length}${updated.length ? ` (${updated.join(', ')})` : ''}, keep manual ${kept.length}`);
  if (!options.apply) {
    console.log('dry run: pass --apply to write.');
    return;
  }
  const { overlay } = loadOverlayFile(overlayPath);
  const root = isPlainObject(overlay) ? overlay : {};
  root.discovery = isPlainObject(root.discovery) ? root.discovery : {};
  root.discovery.evaluation = isPlainObject(root.discovery.evaluation) ? root.discovery.evaluation : {};
  root.discovery.evaluation.baselineScores = merged;
  root.discovery.evaluation.baselineScoreSources = {
    ...(isPlainObject(root.discovery.evaluation.baselineScoreSources)
      ? root.discovery.evaluation.baselineScoreSources
      : {}),
    [source]: { at: new Date().toISOString(), count: Object.keys(mapped).length },
  };
  saveOverlayFile(overlayPath, root);
  console.log(`wrote ${Object.keys(merged).length} baselineScores to ${overlayPath}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
