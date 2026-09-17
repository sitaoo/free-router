#!/usr/bin/env node
// Unit tests for the data-dir layout hub (app/config.mjs): resolveLayout,
// its wrapper delegates, and first-boot seeding of UI-editable scalars.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  defaultConfigPath,
  firstBootSeeds,
  migrateLegacyStateFiles,
  resolveConfigPaths,
  resolveLayout,
} from '../app/config.mjs';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'free-router-layout-'));
const appDir = path.join(tmp, 'repo', 'app');

// Default layout: tracked base under app/, all operator state under data/.
{
  const layout = resolveLayout({ appDir });
  assert.equal(layout.repoDir, path.join(tmp, 'repo'));
  assert.equal(layout.basePath, path.join(appDir, 'config', 'config.json'));
  assert.equal(layout.dataDir, path.join(tmp, 'repo', 'data'));
  assert.equal(layout.overlayPath, path.join(tmp, 'repo', 'data', 'config.local.json'));
  assert.deepEqual(layout.envFiles, [
    path.join(tmp, 'repo', 'data', '.env'),
    path.join(tmp, 'repo', '.env'),
  ]);
  assert.equal(layout.statePath('custom-state.json'), path.join(tmp, 'repo', 'data', 'custom-state.json'));
  assert.equal(layout.statePath(), path.join(tmp, 'repo', 'data', 'discovered-free-models.json'));
  assert.equal(layout.statePath('/abs/elsewhere/x.json'), path.join(tmp, 'repo', 'data', 'x.json'));
}

// Custom base (tests) keeps its data next to it for isolation, and gets
// no repo-root legacy fallback (a test must never touch the real repo).
{
  const custom = path.join(tmp, 'other', 'config.json');
  const layout = resolveLayout({ appDir, configPath: custom });
  assert.equal(layout.basePath, custom);
  assert.equal(layout.dataDir, path.join(tmp, 'other'));
  assert.equal(layout.overlayPath, path.join(tmp, 'other', 'config.local.json'));
  assert.deepEqual(layout.envFiles, [path.join(tmp, 'other', '.env')]);
}

// Explicit data dir wins over both.
{
  const layout = resolveLayout({ appDir, dataDir: path.join(tmp, 'shared') });
  assert.equal(layout.dataDir, path.join(tmp, 'shared'));
  assert.equal(layout.overlayPath, path.join(tmp, 'shared', 'config.local.json'));
  assert.deepEqual(layout.envFiles, [path.join(tmp, 'shared', '.env')]);
}

// Wrapper delegates keep their contracts (overlay now lives in data/).
{
  assert.equal(defaultConfigPath(appDir), path.join(appDir, 'config', 'config.json'));
  const paths = resolveConfigPaths(appDir, '');
  assert.equal(paths.basePath, path.join(appDir, 'config', 'config.json'));
  assert.equal(paths.overlayPath, path.join(tmp, 'repo', 'data', 'config.local.json'));
  const custom = path.join(tmp, 'other', 'config.json');
  const customPaths = resolveConfigPaths(appDir, custom);
  assert.equal(customPaths.basePath, custom);
  assert.equal(customPaths.overlayPath, path.join(tmp, 'other', 'config.local.json'));
}

// First boot: file-provided host/port/password seed the overlay so later
// UI edits (and the ignore-.env-after-first-boot rule) have something to win.
{
  const seeds = firstBootSeeds(
    new Map([
      ['FREE_ROUTER_HOST', '0.0.0.0'],
      ['FREE_ROUTER_PORT', '9999'],
      ['FREE_ROUTER_WEBUI_PASSWORD', 's3cret'],
    ]),
    {},
  );
  assert.deepEqual(seeds, { host: '0.0.0.0', port: 9999, password: 's3cret' });
}

// Overlay already has values: nothing to seed, UI edits stay authoritative.
{
  const seeds = firstBootSeeds(
    new Map([
      ['FREE_ROUTER_HOST', '0.0.0.0'],
      ['FREE_ROUTER_PORT', '9999'],
      ['FREE_ROUTER_WEBUI_PASSWORD', 's3cret'],
    ]),
    { host: '1.2.3.4', port: 1, webui: { password: 'hash' } },
  );
  assert.deepEqual(seeds, {});
}

// Empty or invalid file values seed nothing (absent keys, not undefined).
{
  assert.deepEqual(firstBootSeeds(new Map(), {}), {});
  assert.deepEqual(firstBootSeeds(new Map([['FREE_ROUTER_PORT', 'abc']]), {}), {});
  assert.deepEqual(firstBootSeeds(new Map([['FREE_ROUTER_WEBUI_PASSWORD', '']]), {}), {});
}

// Root legacy state moves into data/ when the data counterpart is absent.
{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'free-router-mig-'));
  const data = path.join(root, 'data');
  fs.mkdirSync(data);
  fs.writeFileSync(path.join(root, 'config.local.json'), '{}');
  fs.writeFileSync(path.join(root, '.env'), 'A=1');
  const moved = migrateLegacyStateFiles({ repoDir: root, dataDir: data });
  assert.deepEqual(moved.sort(), ['.env', 'config.local.json']);
  assert.ok(!fs.existsSync(path.join(root, 'config.local.json')));
  assert.ok(fs.existsSync(path.join(data, 'config.local.json')));
  assert.ok(fs.existsSync(path.join(data, '.env')));
  fs.rmSync(root, { recursive: true, force: true });
}

// Existing data files are never overwritten; root leftovers stay put.
{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'free-router-mig-'));
  const data = path.join(root, 'data');
  fs.mkdirSync(data);
  fs.writeFileSync(path.join(root, 'config.local.json'), '{"old":true}');
  fs.writeFileSync(path.join(data, 'config.local.json'), '{"new":true}');
  const moved = migrateLegacyStateFiles({ repoDir: root, dataDir: data });
  assert.deepEqual(moved, []);
  assert.ok(fs.existsSync(path.join(root, 'config.local.json')));
  assert.equal(
    fs.readFileSync(path.join(data, 'config.local.json'), 'utf8'),
    '{"new":true}',
  );
  fs.rmSync(root, { recursive: true, force: true });
}

// Missing dirs are a no-op, not an error.
{
  const moved = migrateLegacyStateFiles({
    repoDir: path.join(tmp, 'no-such-root'),
    dataDir: path.join(tmp, 'no-such-data'),
  });
  assert.deepEqual(moved, []);
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log('layout unit tests passed');
