#!/usr/bin/env node
// Web UI shell: ink-and-paper tokens, three-state theme, SVG nav icons, gate.
import assert from 'node:assert/strict';
import { renderPage } from '../app/ui.mjs';

const page = renderPage();

// Design tokens: cool-canvas light baseline, explicit dark override, one accent.
assert.match(page, /--bg:\s*#f7f8fa/, 'light canvas token');
assert.match(page, /--accent:\s*#0b62d6/, 'blue accent token');
assert.match(page, /:root\[data-theme="dark"\]/, 'explicit dark token block');
assert.match(page, /--font-display:/, 'display font token');

// Theme: pre-paint resolver, persistent preference, three-state cycle button.
assert.match(page, /fr-theme/, 'theme preference key');
assert.match(page, /id="theme-btn"/, 'theme toggle button');
assert.match(page, /THEME_ORDER\s*=\s*\[/, 'three-state cycle');
assert.match(page, /prefers-color-scheme: dark/, 'system preference respected');

// Navigation: six tabs, each with an inline SVG icon (no character icons).
const navStart = page.indexOf('id="tabs"');
const navEnd = page.indexOf('</nav>', navStart);
assert.ok(navStart !== -1 && navEnd > navStart, 'header nav present');
const nav = page.slice(navStart, navEnd);
assert.equal((nav.match(/<svg/g) || []).length, 6, 'six nav icons');
assert.doesNotMatch(nav, /⧉|▦|⚙|●|○|▸|▾/, 'no character icons in nav');

// Login gate hides the app chrome until auth succeeds.
assert.match(page, /<body[^>]*data-gate="1"/, 'starts gated');
assert.match(page, /body\[data-gate="1"\] header/, 'gate hides topbar');
assert.match(page, /document\.body\.dataset\.gate/, 'JS toggles gate');

// Structure the rest of the page/tests depend on survives.
for (const id of ['usage', 'routes', 'providers', 'gateway', 'tabs', 'login', 'toast']) {
  assert.ok(page.includes(`id="${id}"`), `#${id} still present`);
}
assert.ok(page.indexOf('id="usage"') < page.indexOf('id="routes"'), 'usage before routes');

// Inline scripts must parse as one program. This catches duplicate top-level
// declarations across <script> blocks, which node --check cannot see and which
// silently blanks the whole page (the head theme resolver vs the main runtime).
const inline = [...page.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
assert.equal(inline.length >= 2, true, 'page has boot and runtime scripts');
assert.doesNotThrow(() => new Function(inline.join('\n')), 'inline scripts must parse together');

console.log('ui-theme unit tests passed');
