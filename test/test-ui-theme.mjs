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

// Navigation: five tabs (Routes and Quota were folded into the pool and
// Providers; Logs arrived with the request log), each with an inline SVG icon
// (no character icons).
const navStart = page.indexOf('id="tabs"');
const navEnd = page.indexOf('</nav>', navStart);
assert.ok(navStart !== -1 && navEnd > navStart, 'header nav present');
const nav = page.slice(navStart, navEnd);
assert.equal((nav.match(/<svg/g) || []).length, 5, 'five nav icons');
assert.doesNotMatch(nav, /⧉|▦|⚙|●|○|▸|▾/, 'no character icons in nav');

// Login gate hides the app chrome until auth succeeds.
assert.match(page, /<body[^>]*data-gate="1"/, 'starts gated');
assert.match(page, /body\[data-gate="1"\] header/, 'gate hides topbar');
assert.match(page, /document\.body\.dataset\.gate/, 'JS toggles gate');

// Structure the rest of the page/tests depend on survives.
for (const id of ['usage', 'pool', 'providers', 'gateway', 'tabs', 'login', 'toast']) {
  assert.ok(page.includes(`id="${id}"`), `#${id} still present`);
}
assert.ok(page.indexOf('id="usage"') < page.indexOf('id="pool"'), 'usage before pool');

// Inline scripts must parse as one program. This catches duplicate top-level
// declarations across <script> blocks, which node --check cannot see and which
// silently blanks the whole page (the head theme resolver vs the main runtime).
const inline = [...page.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
assert.equal(inline.length >= 2, true, 'page has boot and runtime scripts');
assert.doesNotThrow(() => new Function(inline.join('\n')), 'inline scripts must parse together');

// Provider/discovery controls: verified presets, a probe toggle, a manual run,
// and the paid-model warning in the model table.
for (const preset of ['groq', 'cerebras', 'mistral', 'huggingface']) {
  assert.match(page, new RegExp(`${preset}:\\s*\\{ baseUrl:`), `${preset} preset missing`);
}
assert.match(page, /np-probe/, 'probe-free-tier toggle missing from provider form');
assert.match(page, /id="disc-run"/, 'manual discovery button missing');
assert.match(page, /runNow:\s*true/, 'manual discovery must send runNow');
assert.match(page, /paid_model_warning/, 'paid-model warning missing from the model table');
assert.match(page, /buildModelTable/, 'provider model table missing');

// Favicon: served by the gateway (CSP forbids external assets), declared with
// an explicit type, and not a data: URI the browser would have to re-parse.
assert.match(page, /<link rel="icon" type="image\/svg\+xml" href="\/favicon\.svg"/, 'favicon link missing');
assert.doesNotMatch(page, /<link[^>]+href="data:/, 'favicon must be a real asset, not a data URI');
// Each format has its own rules, so each gets its own file: Safari's pinned tab
// needs a black alpha mask, and iOS's home screen needs a PNG (see app/icons.mjs).
assert.match(page, /<link rel="mask-icon" href="\/mask-icon\.svg" color="#0b62d6"/, 'pinned-tab icon missing or sharing the tab icon');
assert.match(
  page,
  /<link rel="apple-touch-icon" sizes="180x180" href="\/apple-touch-icon\.png"/,
  'home-screen icon must be a sized PNG, not the SVG',
);
// Browser chrome colour follows the theme actually in effect, not just the OS.
assert.match(page, /id="theme-color-light"/, 'light chrome colour missing');
assert.match(page, /id="theme-color-dark"/, 'dark chrome colour missing');
assert.match(page, /theme-color-light'\)/, 'chrome colour is not switched by the theme runtime');

console.log('ui-theme unit tests passed');
