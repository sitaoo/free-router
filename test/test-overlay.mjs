#!/usr/bin/env node
// Unit tests for the operator overlay file (app/config.mjs): a missing file is
// normal, a blank file is treated as empty (editors create those), but real
// corruption reports an error so the server can refuse to boot on defaults,
// and every save leaves the previous file behind as .bak.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { backupOverlayFile, loadOverlayFile, saveOverlayFile } from '../app/config.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'free-router-overlay-'));
const overlayPath = path.join(tmp, 'config.local.json');

// Missing file: empty overlay, no error (first boot).
assert.deepEqual(loadOverlayFile(overlayPath), { overlay: {}, error: '' });

// A zero-byte or whitespace-only file is what a half-finished editor save
// leaves behind; it must not read as corruption.
fs.writeFileSync(overlayPath, '');
assert.deepEqual(loadOverlayFile(overlayPath), { overlay: {}, error: '' });
fs.writeFileSync(overlayPath, '  \n\t\n');
assert.deepEqual(loadOverlayFile(overlayPath), { overlay: {}, error: '' });

// Real corruption and non-object JSON both surface an error.
fs.writeFileSync(overlayPath, '{"providers": {');
assert.ok(loadOverlayFile(overlayPath).error);
fs.writeFileSync(overlayPath, '[]');
assert.ok(loadOverlayFile(overlayPath).error);

// A valid object round-trips.
fs.writeFileSync(overlayPath, JSON.stringify({ port: 9000 }));
assert.deepEqual(loadOverlayFile(overlayPath), { overlay: { port: 9000 }, error: '' });

// Saving keeps the previous contents as .bak; the first save has nothing to
// back up, and a missing file is not an error.
assert.equal(backupOverlayFile(path.join(tmp, 'absent.json')), false);
assert.equal(backupOverlayFile(overlayPath), true);
assert.deepEqual(JSON.parse(fs.readFileSync(overlayPath + '.bak', 'utf8')), { port: 9000 });

saveOverlayFile(overlayPath, { port: 9001 });
assert.deepEqual(JSON.parse(fs.readFileSync(overlayPath, 'utf8')), { port: 9001 });
assert.deepEqual(JSON.parse(fs.readFileSync(overlayPath + '.bak', 'utf8')), { port: 9000 });

// A corrupt file is still backed up: the operator can recover it by hand.
fs.writeFileSync(overlayPath, 'not json');
assert.equal(backupOverlayFile(overlayPath), true);
assert.equal(fs.readFileSync(overlayPath + '.bak', 'utf8'), 'not json');

fs.rmSync(tmp, { recursive: true, force: true });
console.log('overlay unit tests passed');
