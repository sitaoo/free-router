import fs from 'node:fs';
import os from 'node:os';
import { LANGS, STRINGS } from './i18n.mjs';
import { listTimeZones } from './timezones.mjs';

const MAX_SECRET_LENGTH = 500;

// Language content lives in i18n.mjs; the page gets a frozen copy so the
// browser needs no module loader. `</script>` can never appear in it: values
// only use <span> markup (verified in tests via renderPage snapshot).
const I18N_PAYLOAD = JSON.stringify({ langs: LANGS, strings: STRINGS });

// The timezone picker gets the same treatment as the dictionary: shipped with
// the page so the dropdown can never offer a zone the server would reject.
const TZ_PAYLOAD = JSON.stringify({ zones: listTimeZones() });

// Keeps the operator's username out of the interface and the log file, which
// both get shared or screenshotted more often than they get read locally.
export function displayPath(target) {
  const home = os.homedir();
  const text = String(target || '');
  if (!home) return text;
  if (text === home) return '~';
  if (text.startsWith(`${home}/`)) return `~/${text.slice(home.length + 1)}`;
  return text;
}

// Shows enough of a key to recognise which one is set, never enough to use it.
export function maskSecret(value) {
  const text = String(value || '');
  if (!text) return '';
  if (text.length <= 12) return `${'*'.repeat(text.length)} (${text.length})`;
  return `${text.slice(0, 5)}${'*'.repeat(8)}${text.slice(-4)} (${text.length})`;
}

// A newline would let one field append unrelated assignments to .env, which
// start.sh sources with `set -a`. That would be code execution on next start.
export function validateSecret(value) {
  const text = String(value ?? '');
  if (/[\r\n\0]/.test(text)) return 'value must not contain newlines';
  if (text.length > MAX_SECRET_LENGTH) return `value must be at most ${MAX_SECRET_LENGTH} characters`;
  return '';
}

function formatEnvLine(name, value) {
  const needsQuotes = /[\s#'"]/.test(value);
  if (!needsQuotes) return `${name}=${value}`;
  return `${name}="${value.replace(/(["\\])/g, '\\$1')}"`;
}

// Rewrites only the named assignments, preserving comments, ordering, and any
// unrelated variables. An empty value removes the assignment entirely.
export function updateEnvFile(file, updates) {
  const existing = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const lines = existing ? existing.split(/\r?\n/) : [];
  const pending = new Map(Object.entries(updates));
  const output = [];

  for (const line of lines) {
    const match = line.match(/^\s*(export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/);
    const name = match?.[2];
    if (!name || !pending.has(name)) {
      output.push(line);
      continue;
    }
    const value = pending.get(name);
    pending.delete(name);
    if (!value) continue;
    output.push(`${match[1] || ''}${formatEnvLine(name, value)}`);
  }

  for (const [name, value] of pending) {
    if (!value) continue;
    output.push(formatEnvLine(name, value));
  }

  while (output.length && !output[output.length - 1].trim()) output.pop();
  const body = output.length ? `${output.join('\n')}\n` : '';
  const temporaryPath = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporaryPath, body, { mode: 0o600 });
  fs.renameSync(temporaryPath, file);
  // A pre-existing file may have been group or world readable.
  fs.chmodSync(file, 0o600);
}

const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>Free Router</title>
<link rel="icon" type="image/svg+xml" href="/favicon.svg">
<link rel="mask-icon" href="/mask-icon.svg" color="#0b62d6">
<link rel="apple-touch-icon" sizes="180x180" href="/apple-touch-icon.png">
<meta name="theme-color" content="#0b62d6" id="theme-color-light">
<meta name="theme-color" content="#0f1729" id="theme-color-dark">
<script>
// Resolve the theme before first paint so a dark user never sees a white flash.
// Scoped in an IIFE: the main script declares themePref too, and two top-level
// declarations in the same global scope would abort every inline script.
(function () {
  try {
    var saved = localStorage.getItem('fr-theme');
    var dark = saved === 'dark' || (saved !== 'light' && window.matchMedia
      && window.matchMedia('(prefers-color-scheme: dark)').matches);
    document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
  } catch (error) {}
})();
</script>
<style>
/* ===== Design tokens: blue slate =====
   Light is a cool canvas with white panels and one blue accent; dark keeps
   the deep blue-grey palette. Every colour, shadow and radius comes from a
   token. The theme attribute is resolved before first paint by the tiny
   script above, so there is one dark block only (no prefers-color-scheme
   duplicate for the tokens themselves). */
:root {
  color-scheme: light;
  --bg: #f7f8fa;
  --panel: #ffffff;
  --panel2: #f1f4f8;
  --line: #e2e5ea;
  --line-soft: #eef0f4;
  --line-strong: #ccd2db;
  --fg: #1c1f24;
  --muted: #5f6773;
  --faint: #8a929e;
  --hover: #eef2f7;
  --accent: #0b62d6;
  --accent-strong: #0954b5;
  --accent-fg: #ffffff;
  --accent-soft: rgba(11, 98, 214, .10);
  --ring: rgba(11, 98, 214, .22);
  --ok: #16794a;
  --ok-soft: rgba(22, 121, 74, .10);
  --ok-line: rgba(22, 121, 74, .28);
  --ok-fg: #0f6139;
  --warn: #8a5b00;
  --warn-soft: rgba(138, 91, 0, .10);
  --warn-line: rgba(138, 91, 0, .28);
  --warn-fg: #6f4a00;
  --bad: #c22c38;
  --bad-soft: rgba(194, 44, 56, .09);
  --bad-line: rgba(194, 44, 56, .28);
  --bad-fg: #9e202b;
  --shadow-card: 0 1px 2px rgba(20, 28, 40, .05), 0 2px 10px rgba(20, 28, 40, .05), inset 0 1px 0 rgba(255, 255, 255, .8);
  --shadow-pop: 0 18px 44px rgba(20, 28, 40, .18), 0 2px 8px rgba(20, 28, 40, .07);
  --shadow-bar: 0 1px 0 rgba(20, 28, 40, .04), 0 8px 24px rgba(20, 28, 40, .06);
  --glow-accent: 0 8px 22px rgba(11, 98, 214, .22);
  --scrim: rgba(15, 23, 42, .45);
  --bar-bg: rgba(255, 255, 255, .82);
  --mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
  --font-display: ui-sans-serif, system-ui, -apple-system, "Segoe UI", "PingFang SC", "Noto Sans CJK SC", "Microsoft YaHei", sans-serif;
}

:root[data-theme="dark"] {
  color-scheme: dark;
  --bg: #14171c;
  --panel: #1d2128;
  --panel2: #22282f;
  --line: #333a44;
  --line-soft: #262c35;
  --line-strong: #3a424d;
  --fg: #e8ebef;
  --muted: #a7b0bc;
  --faint: #767f8c;
  --hover: #2f3641;
  --accent: #4d94f1;
  --accent-strong: #6aa5f3;
  --accent-fg: #0c1116;
  --accent-soft: rgba(77, 148, 241, .16);
  --ring: rgba(77, 148, 241, .30);
  --ok: #4cc38a;
  --ok-soft: rgba(76, 195, 138, .12);
  --ok-line: rgba(76, 195, 138, .32);
  --ok-fg: #8ee0b4;
  --warn: #e0a63c;
  --warn-soft: rgba(224, 166, 60, .12);
  --warn-line: rgba(224, 166, 60, .32);
  --warn-fg: #f0c079;
  --bad: #f26d79;
  --bad-soft: rgba(242, 109, 121, .12);
  --bad-line: rgba(242, 109, 121, .32);
  --bad-fg: #ff9a91;
  --shadow-card: 0 1px 2px rgba(0, 0, 0, .35), 0 2px 10px rgba(0, 0, 0, .22), inset 0 1px 0 rgba(255, 255, 255, .04);
  --shadow-pop: 0 22px 52px rgba(0, 0, 0, .55), 0 2px 8px rgba(0, 0, 0, .30);
  --shadow-bar: 0 1px 0 rgba(0, 0, 0, .25), 0 8px 24px rgba(0, 0, 0, .25);
  --glow-accent: 0 8px 22px rgba(77, 148, 241, .18);
  --scrim: rgba(0, 0, 0, .60);
  --bar-bg: rgba(20, 23, 28, .78);
  --font-display: ui-sans-serif, system-ui, -apple-system, "Segoe UI", "PingFang SC", "Noto Sans CJK SC", "Microsoft YaHei", sans-serif;
}

* { box-sizing: border-box; }
html, body { margin: 0; }
html { color-scheme: light; }
html[data-theme="dark"] { color-scheme: dark; }
body {
  background: var(--bg);
  color: var(--fg);
  font: 14px/1.65 ui-sans-serif, system-ui, -apple-system, "Segoe UI", "PingFang SC", "Noto Sans CJK SC", "Microsoft YaHei", sans-serif;
  letter-spacing: .006em;
  -webkit-font-smoothing: antialiased;
}
::selection { background: var(--accent-soft); color: var(--fg); }
* { scrollbar-width: thin; scrollbar-color: var(--line-strong) transparent; }
::-webkit-scrollbar { width: 10px; height: 10px; }
::-webkit-scrollbar-track { background: transparent; }
::-webkit-scrollbar-thumb { background: var(--line-strong); border-radius: 999px; border: 3px solid var(--bg); }
::-webkit-scrollbar-thumb:hover { background: var(--muted); }
.mono { font-family: var(--mono); font-variant-numeric: tabular-nums; }

/* ===== Top bar ===== */
header {
  position: sticky; top: 0; z-index: 30;
  background: var(--bar-bg);
  border-bottom: 1px solid var(--line);
  box-shadow: var(--shadow-bar);
  backdrop-filter: blur(14px) saturate(1.2);
}
@supports not (backdrop-filter: blur(1px)) { header { background: var(--panel); } }
.head-inner {
  max-width: 1180px; margin: 0 auto; padding: 0 24px; height: 58px;
  display: grid; grid-template-columns: 1fr auto 1fr; align-items: center; gap: 20px;
}
.brand { display: flex; align-items: center; gap: 10px; min-width: 0; justify-self: start; }
.brand-mark {
  width: 30px; height: 30px; flex: none; border-radius: 8px;
  display: grid; place-items: center;
  background: linear-gradient(145deg, var(--accent), var(--accent-strong));
  color: var(--accent-fg); box-shadow: var(--glow-accent);
}
.brand-mark svg { width: 17px; height: 17px; }
.brand-name { font-family: var(--font-display); font-size: 16px; font-weight: 600; letter-spacing: .01em; }
.head-actions { display: flex; align-items: center; gap: 6px; justify-self: end; }
#lang {
  max-width: 132px; height: 34px; padding: 0 8px; font-size: 12.5px;
  border-color: transparent; background: transparent; color: var(--muted);
}
#lang:hover { background: var(--hover); border-color: var(--line); color: var(--fg); }

/* ===== Navigation (lives in the top bar) ===== */
#tabs {
  display: flex; align-items: center; justify-content: center; gap: 2px;
  margin: 0; padding: 0; background: none; border: 0; border-radius: 0;
  position: static; overflow-x: auto; scrollbar-width: none;
}
#tabs::-webkit-scrollbar { display: none; }
#tabs button {
  display: inline-flex; align-items: center; gap: 7px;
  height: 36px; padding: 0 12px; border-radius: 9px;
  border: 1px solid transparent; background: transparent;
  color: var(--muted); font-size: 13px; font-weight: 600;
  white-space: nowrap; transition: background .16s, color .16s, border-color .16s, box-shadow .16s;
}
#tabs button svg { width: 16px; height: 16px; flex: none; }
#tabs button:hover { background: var(--hover); color: var(--fg); }
#tabs button.active {
  background: var(--panel2); border-color: var(--line); color: var(--fg);
  box-shadow: 0 1px 2px rgba(20, 28, 40, .06);
}
#tabs button.active:hover { background: var(--panel2); }
#tabs button.active svg { color: var(--accent); }

/* ===== Page shell ===== */
main { max-width: 1060px; margin: 0 auto; padding: 28px 24px 72px; display: grid; gap: 18px; }
section {
  background: var(--panel); border: 1px solid var(--line); border-radius: 16px;
  box-shadow: var(--shadow-card);
}
.sec-head { padding: 22px 24px 0; }
.sec-head h2 {
  font-size: 14px; font-weight: 600; margin: 0; letter-spacing: 0;
  display: flex; align-items: center; gap: 8px;
}
.sec-head h2::before {
  content: ""; display: inline-block; width: 14px; height: 2px; flex: none;
  border-radius: 2px; background: var(--accent); opacity: .9;
}
.sec-head p { margin: 6px 0 0; font-size: 12.5px; color: var(--muted); max-width: 78ch; line-height: 1.6; }
.sec-body { padding: 16px 24px 22px; }
[data-pane] { display: grid; gap: 18px; align-content: start; }
[data-pane][hidden] { display: none; }

/* ===== Buttons ===== */
button {
  display: inline-flex; align-items: center; justify-content: center; gap: 7px;
  height: 36px; padding: 0 14px; border-radius: 9px;
  border: 1px solid var(--line-strong); background: var(--panel); color: var(--fg);
  font: inherit; font-size: 13px; font-weight: 600; cursor: pointer; white-space: nowrap;
  transition: background .16s, border-color .16s, box-shadow .16s, color .16s, transform .12s;
}
button svg { width: 16px; height: 16px; flex: none; }
button:hover { background: var(--hover); }
button:active:not(:disabled) { transform: translateY(1px); }
button.primary {
  background: linear-gradient(180deg, var(--accent), var(--accent-strong));
  border-color: transparent; color: var(--accent-fg);
  box-shadow: var(--glow-accent);
}
button.primary:hover { filter: brightness(1.06); transform: translateY(-1px); }
button.quiet { border-color: transparent; background: transparent; color: var(--muted); box-shadow: none; }
button.quiet:hover { background: var(--hover); color: var(--fg); }
button.ghost { background: transparent; box-shadow: none; }
button.ghost:hover { background: var(--hover); border-color: var(--line-strong); }
button.danger { color: var(--bad); }
button.danger:hover { background: var(--bad-soft); border-color: var(--bad-line); color: var(--bad); }
button:disabled { opacity: .5; cursor: default; box-shadow: none; transform: none; }
button:focus-visible, input:focus-visible, select:focus-visible, summary:focus-visible {
  outline: none; border-color: var(--accent); box-shadow: 0 0 0 3px var(--ring);
}
.icononly {
  width: 34px; height: 34px; padding: 0; border-color: transparent;
  background: transparent; color: var(--muted);
}
.icononly:hover { background: var(--hover); border-color: var(--line); color: var(--fg); }
.iconbtn { height: 28px; padding: 0 9px; border-radius: 8px; font-size: 12.5px; }
.linklike {
  border: 0; background: none; padding: 0; height: auto;
  color: var(--accent); font-size: inherit; font-weight: 600; cursor: pointer;
  white-space: nowrap;
}
.linklike:hover { background: none; color: var(--accent-strong); text-decoration: underline; text-underline-offset: 3px; }

/* ===== Inputs ===== */
input, select {
  height: 40px; padding: 0 12px; border-radius: 9px;
  border: 1px solid var(--line-strong); background: var(--bg); color: var(--fg);
  font: inherit; font-size: 13px; min-width: 0;
  transition: border-color .16s, box-shadow .16s, background .16s;
}
input::placeholder { color: var(--faint); }
input:hover, select:hover { border-color: var(--muted); }
input:focus, select:focus {
  outline: none; border-color: var(--accent); box-shadow: 0 0 0 3px var(--ring);
}
select { max-width: 280px; padding-right: 10px; }
.row { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; margin-top: 12px; }
.row label { display: flex; gap: 8px; align-items: center; font-size: 13px; color: var(--muted); }
.check { font-size: 13px; color: var(--muted); display: flex; gap: 8px; align-items: center; }
.note { font-size: 12.5px; color: var(--muted); margin: 14px 0 0; line-height: 1.6; }

/* ===== Switch ===== */
.switch { position: relative; display: inline-block; width: 40px; height: 22px; flex: none; margin-top: 2px; }
.switch input { opacity: 0; width: 0; height: 0; }
.switch .slider {
  position: absolute; inset: 0; cursor: pointer;
  background: var(--line-strong); border-radius: 999px;
  transition: background .18s;
}
.switch .slider:before {
  content: ""; position: absolute; height: 16px; width: 16px; left: 3px; top: 3px;
  background: var(--panel); border-radius: 50%; transition: transform .18s;
  box-shadow: 0 1px 3px rgba(0, 0, 0, .28);
}
.switch input:checked + .slider { background: var(--accent); }
.switch input:checked + .slider:before { transform: translateX(18px); }
.switch input:focus-visible + .slider { outline: 2px solid var(--accent); outline-offset: 2px; }
.title-switch { display: flex; align-items: center; gap: 10px; }
.title-switch .switch { margin-top: 0; }

/* ===== Status cards ===== */
.cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(230px, 1fr)); gap: 12px; }
.card {
  min-width: 0; background: var(--panel2); border: 1px solid var(--line);
  border-radius: 12px; padding: 14px 16px;
}
.card .k { font-size: 11.5px; font-weight: 600; color: var(--muted); }
.card .v { font-size: 14px; font-weight: 600; margin-top: 3px; line-height: 1.5; word-break: break-word; }
.card .v .mono { font-size: 12.5px; font-weight: 500; }

/* ===== Tables ===== */
table { width: 100%; border-collapse: collapse; font-size: 13px; }
th, td { text-align: left; padding: 10px 12px; border-bottom: 1px solid var(--line-soft); vertical-align: middle; }
th {
  color: var(--muted); font-weight: 600; font-size: 11.5px; letter-spacing: .01em;
  border-bottom: 1px solid var(--line); white-space: nowrap;
}
tbody tr { transition: background .12s; }
tbody tr:hover { background: var(--hover); }
tbody tr:last-child td { border-bottom: 0; }
td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
td.mono { font-size: 12.5px; }
td.muted { color: var(--muted); }
#providers { display: block; }
/* Wide tables scroll inside their card instead of widening the page: the
   model ids and provider URLs are wider than a phone viewport, and an
   auto-sized grid item would otherwise push the whole page sideways. */
#usage, #pool, #providers, #gateway, #logs { overflow-x: auto; }
[data-pane], [data-pane] > section, .sec-body { min-width: 0; }

/* ===== Pills ===== */
.pill {
  display: inline-flex; align-items: center; gap: 5px; padding: 2px 9px;
  border-radius: 999px; font-size: 11.5px; font-weight: 600;
  border: 1px solid transparent; white-space: nowrap;
}
.pill.ok { color: var(--ok-fg); background: var(--ok-soft); border-color: var(--ok-line); }
.pill.no { color: var(--muted); background: var(--panel2); border-color: var(--line); }
.pill.warn { color: var(--warn-fg); background: var(--warn-soft); border-color: var(--warn-line); }
.pill.bad { color: var(--bad-fg); background: var(--bad-soft); border-color: var(--bad-line); }
.warn { color: var(--warn); font-weight: 600; }
.bad-text { color: var(--bad); font-weight: 600; }
.ok-text { color: var(--ok); font-weight: 600; }
/* A security warning has to read as a warning in both themes, so it uses the
   danger tokens rather than the amber "warn" ones. */
.warn-banner {
  margin-top: 12px; padding: 10px 12px; border-radius: 8px;
  color: var(--bad-fg); background: var(--bad-soft);
  border: 1px solid var(--bad-line); border-left-width: 3px;
  font-size: 13px; line-height: 1.6;
}
.warn-banner[hidden] { display: none; }

/* ===== Provider modal detail ===== */
.prov-hint { margin-top: 7px; font-size: 12px; color: var(--muted); }
.prov-field input { width: 100%; }
.keyrow {
  display: flex; gap: 10px; align-items: center; padding: 8px 0;
  font-size: 13px; border-top: 1px solid var(--line-soft);
}
.keyrow .mono { flex: 1; overflow: hidden; text-overflow: ellipsis; }

/* ===== Chips (models, pins) ===== */
.chip {
  display: inline-flex; gap: 6px; align-items: center;
  border: 1px solid var(--line); border-radius: 999px;
  padding: 3px 4px 3px 11px; margin: 0 8px 8px 0; font-size: 12.5px;
  background: var(--panel2);
}
.chip .mono { font-size: 12px; }
.chip button { width: 24px; height: 24px; padding: 0; border-radius: 999px; border-color: transparent; background: transparent; }
.chip button svg { width: 12px; height: 12px; }

/* ===== Route editor rows ===== */
.entry {
  display: flex; gap: 8px; align-items: center; padding: 7px 0;
  border-top: 1px solid var(--line-soft); font-size: 13px;
}
.entry:first-child { border-top: 0; }
.entry .mono { flex: 1; overflow: hidden; text-overflow: ellipsis; }
.entry .idx { width: 34px; color: var(--faint); font-size: 12px; font-variant-numeric: tabular-nums; }
.entry .st { font-size: 12px; color: var(--muted); min-width: 96px; text-align: right; }
.entry button { width: 30px; height: 30px; padding: 0; border-radius: 8px; border-color: transparent; background: transparent; color: var(--muted); }
.entry button:hover { background: var(--hover); color: var(--fg); }
.entry button.danger:hover { background: var(--bad-soft); color: var(--bad); }
.entry button svg { width: 14px; height: 14px; }

/* ===== Settings rows ===== */
.setrow { display: flex; gap: 16px; align-items: flex-start; justify-content: space-between; padding: 14px 0; }
.setrow + .setrow { border-top: 1px solid var(--line-soft); }
.setrow:first-child { padding-top: 4px; }
.setrow:last-child { padding-bottom: 4px; }
.setrow .set-text { flex: 1; min-width: 0; }
.setrow .set-title { font-size: 13.5px; font-weight: 600; }
.setrow .set-desc { font-size: 12.5px; color: var(--muted); margin-top: 2px; }
.setrow .set-ctl { flex: none; display: flex; gap: 8px; align-items: center; flex-wrap: wrap; justify-content: flex-end; }
.setrow .set-ctl .switch { margin-top: 0; }
.setrow input.mono { text-align: right; }
/* Searchable select: the timezone list is ~420 entries, so it is a combobox
   over a filtered listbox rather than a <select> nobody can scan. */
.combo { position: relative; display: block; }
.combo input { width: 220px; padding-right: 26px; }
/* Zone ids stay left-to-right even in an RTL interface: they are identifiers,
   and a reversed "Asia/Shanghai" reads as a different string. */
.setrow .combo input { direction: ltr; text-align: left; font-family: var(--mono); }
.combo::after {
  content: ""; position: absolute; top: 50%; inset-inline-end: 11px;
  width: 6px; height: 6px; margin-top: -5px; pointer-events: none;
  border-right: 1.6px solid var(--faint); border-bottom: 1.6px solid var(--faint);
  transform: rotate(45deg);
}
.combo-list {
  position: absolute; z-index: 30; inset-inline-start: 0; top: calc(100% + 4px);
  width: max(100%, 260px); max-height: 260px; overflow-y: auto;
  margin: 0; padding: 4px; list-style: none;
  background: var(--panel); border: 1px solid var(--line); border-radius: 10px;
  box-shadow: var(--shadow-pop);
}
.combo-list[hidden] { display: none; }
.combo-list li {
  padding: 7px 9px; border-radius: 7px; font-size: 12.5px; cursor: pointer;
  font-family: var(--mono); direction: ltr; text-align: left;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.combo-list li .off { color: var(--faint); font-family: var(--font-display); }
.combo-list li[aria-selected="true"] { background: var(--accent-soft); color: var(--accent-strong); }
/* aria-selected marks the committed value; data-active is the keyboard cursor,
   which must stay visibly distinct from it while arrowing through the list. */
.combo-list li[data-active="true"] { background: var(--hover); }
.combo-list li[data-active="true"][aria-selected="true"] { background: var(--accent-soft); }
.combo-list li.empty { color: var(--muted); font-family: var(--font-display); cursor: default; }
.setrow-full { padding: 12px 0; }
.setrow-full + .setrow-full { border-top: 1px solid var(--line-soft); }
.head-row { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; }
.head-row > div { flex: 1; min-width: 0; }

/* ===== Banner (legacy migration) ===== */
.banner {
  border: 1px solid var(--warn-line); background: var(--warn-soft); color: var(--fg);
  border-radius: 12px; padding: 12px 14px; font-size: 13px; margin-bottom: 14px;
  display: flex; gap: 12px; align-items: center; justify-content: space-between;
}
.banner[hidden] { display: none; }
.banner button { flex: none; }

details summary { cursor: pointer; }
details summary::marker { color: var(--accent); }

/* ===== Login gate ===== */
#login { min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 48px 20px; }
body[data-gate="1"] header { display: none; }
body[data-gate="1"] main#app { display: none; }
.gate {
  width: 100%; max-width: 392px; background: var(--panel);
  border: 1px solid var(--line); border-radius: 18px; padding: 30px 28px 26px;
  box-shadow: var(--shadow-pop);
  animation: pop .2s ease both;
}
.gate-mark {
  width: 40px; height: 40px; border-radius: 11px; margin-bottom: 16px;
  display: grid; place-items: center;
  background: linear-gradient(145deg, var(--accent), var(--accent-strong));
  color: var(--accent-fg); box-shadow: var(--glow-accent);
}
.gate-mark svg { width: 21px; height: 21px; }
.gate-title { font-family: var(--font-display); font-size: 25px; font-weight: 600; margin: 0; letter-spacing: .01em; }
.gate-sub { margin: 6px 0 18px; font-size: 13px; color: var(--muted); }
.gate-form { display: flex; gap: 10px; }
.gate-form input { flex: 1; min-width: 0; }
.gate-form button { flex: none; }

/* ===== Toast ===== */
#toast {
  position: fixed; right: 20px; bottom: 20px; z-index: 60;
  padding: 12px 16px; border-radius: 11px; max-width: 430px;
  background: var(--panel); border: 1px solid var(--line); color: var(--fg);
  box-shadow: var(--shadow-pop); font-size: 13px;
  opacity: 0; transform: translateY(8px);
  transition: opacity .18s, transform .18s; pointer-events: none;
}
#toast.show { opacity: 1; transform: none; }
#toast.good { border-left: 3px solid var(--ok); }
#toast.err { border-left: 3px solid var(--bad); }

/* ===== Modal ===== */
.overlay {
  position: fixed; inset: 0; z-index: 50; padding: 52px 16px;
  background: var(--scrim); backdrop-filter: blur(3px);
  display: flex; align-items: flex-start; justify-content: center;
  animation: fade .18s ease both;
}
.overlay[hidden] { display: none; }
.modal {
  width: 100%; max-width: 760px; max-height: 85vh; overflow: auto;
  background: var(--panel); border: 1px solid var(--line); border-radius: 16px;
  padding: 20px 22px 24px; box-shadow: var(--shadow-pop);
  animation: pop .2s ease both;
}
.modal h3 { font-family: var(--font-display); font-size: 21px; font-weight: 600; margin: 0; }
.modal h4 { font-size: 12px; font-weight: 600; color: var(--muted); margin: 20px 0 6px; }

/* ===== Motion ===== */
[data-pane] { animation: pageIn .28s ease both; }
@keyframes pageIn { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }
@keyframes fade { from { opacity: 0; } to { opacity: 1; } }
@keyframes pop { from { opacity: 0; transform: scale(.985) translateY(4px); } to { opacity: 1; transform: none; } }
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { animation: none !important; transition: none !important; }
}

/* ===== Responsive ===== */
@media (max-width: 980px) {
  .head-inner {
    grid-template-columns: 1fr auto; height: auto;
    padding: 9px 18px 8px; gap: 6px 12px;
  }
  .brand { grid-column: 1; grid-row: 1; }
  .head-actions { grid-column: 2; grid-row: 1; }
  #tabs { grid-column: 1 / -1; grid-row: 2; justify-content: flex-start; padding-bottom: 2px; }
}
@media (max-width: 760px) {
  main { padding: 20px 16px 56px; gap: 14px; }
  [data-pane] { gap: 14px; }
  .sec-head { padding: 18px 18px 0; }
  .sec-body { padding: 14px 18px 18px; }
  .setrow { gap: 10px; }
  .setrow .set-ctl { justify-content: flex-start; }
}
@media (max-width: 640px) {
  .head-inner { padding: 8px 14px 7px; }
  #tabs button { padding: 0 10px; font-size: 12.5px; }
  #tabs button svg { display: none; }
  .cards { grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); }
  .modal { padding: 16px 16px 20px; }
  .overlay { padding: 24px 10px; }
}
@media (max-width: 420px) {
  main { padding: 14px 10px 48px; }
  .sec-head { padding: 16px 14px 0; }
  .sec-body { padding: 12px 14px 16px; }
  .cards { grid-template-columns: 1fr; }
  #tabs button { padding: 0 8px; }
  .gate { padding: 24px 20px 22px; }
}
</style>
</head>
<body data-gate="1">
<header>
  <div class="head-inner">
    <div class="brand">
      <span class="brand-mark" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12h4l3-8 4 16 3-8h4"/></svg></span>
      <span class="brand-name">Free Router</span>
    </div>
    <nav id="tabs" aria-label="Sections">
      <button data-tab="status" class="active"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M22 12h-4l-3 9L9 3l-3 9H2"/></svg><span data-i18n="tab_status">Status</span></button>
      <button data-tab="access"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m21 2-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0 3 3L22 7l-3-3m-3.5 3.5L19 4"/></svg><span data-i18n="tab_access">Access</span></button>
      <button data-tab="providers"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 3h20v6H2zM2 15h20v6H2zM6 6h.01M6 18h.01"/></svg><span data-i18n="tab_providers">Providers</span></button>
      <button data-tab="settings"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6"/></svg><span data-i18n="tab_settings">Settings</span></button>
      <button data-tab="logs"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/></svg><span data-i18n="tab_logs">Logs</span></button>
    </nav>
    <div class="head-actions">
      <select id="lang" title="Language" data-i18n-title="lang_name"></select>
      <button id="theme-btn" class="icononly" type="button" title="Theme"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 3h20v14H2zM8 21h8M12 17v4"/></svg></button>
      <button id="logout-top" class="icononly" style="display:none" data-i18n-title="logout" aria-label="Log out"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"/></svg></button>
    </div>
  </div>
</header>
<main id="app" style="display:none">

  <div data-pane="status">
    <section>
      <div class="sec-head"><h2 data-i18n="overview">Overview</h2><p id="status-blurb"></p></div>
      <div class="sec-body"><div id="status-cards" class="cards"></div></div>
    </section>
    <section>
      <div class="sec-head"><h2 data-i18n="usage_today">Usage today</h2><p id="usage-blurb"></p></div>
      <div class="sec-body"><div id="usage"></div></div>
    </section>
    <section>
      <div class="sec-head">
        <h2 data-i18n="pool_priority">Pool priority</h2>
        <p id="pool-blurb"></p>
      </div>
      <div class="sec-body"><div id="pool"></div></div>
    </section>
  </div>

  <div data-pane="access" hidden>
    <section>
      <div class="sec-head">
        <h2 class="title-switch"><span data-i18n="access_title">API key access</span> <label class="switch" data-i18n-title="require_auth"><input type="checkbox" id="gw-require"><span class="slider"></span></label></h2>
        <p data-i18n="access_blurb">Gateway API keys for LAN clients (send as <span class="mono">Authorization: Bearer &lt;key&gt;</span> on <span class="mono">/v1/*</span>). Creating the first key enables auth; deleting the last one disables it.</p>
      </div>
      <div class="sec-body">
        <div id="gateway"></div>
        <div class="row">
          <input id="gw-name" data-i18n-ph="gw_name_ph" placeholder="Label, e.g. living-room laptop" style="max-width:260px">
          <button class="primary" id="gw-create" data-i18n="gw_create">Create API key</button>
        </div>
        <p class="note" id="gw-note"></p>
      </div>
    </section>
  </div>

  <div data-pane="providers" hidden>
    <section>
      <div class="sec-head">
        <h2 data-i18n="providers_title">Provider keys</h2>
        <p id="keys-blurb"></p>
      </div>
      <div class="sec-body">
        <div id="migrate-banner" class="banner" hidden></div>
        <div id="providers"></div>
      </div>
    </section>
    <section>
      <div class="sec-head"><h2 data-i18n="disc_title">Discovery</h2><p data-i18n="disc_blurb">Automatic free-model discovery and ranking.</p></div>
      <div class="sec-body">
        <div class="setrow">
          <div class="set-text">
            <div class="set-title" data-i18n="disc_enabled">Discovery enabled</div>
            <div class="set-desc" data-i18n="disc_enabled_desc">Periodically scan catalogs for newly free models.</div>
          </div>
          <div class="set-ctl"><label class="switch"><input type="checkbox" id="disc-enabled"><span class="slider"></span></label></div>
        </div>
        <div class="setrow">
          <div class="set-text">
            <div class="set-title" data-i18n="disc_eval">Model evaluation</div>
            <div class="set-desc" data-i18n="disc_eval_desc">Benchmark new models once before they join the pool.</div>
          </div>
          <div class="set-ctl"><label class="switch"><input type="checkbox" id="disc-eval"><span class="slider"></span></label></div>
        </div>
        <div class="setrow">
          <div class="set-text">
            <div class="set-title" data-i18n="disc_interval">Interval (hours)</div>
            <div class="set-desc" data-i18n="disc_interval_desc">How often discovery runs.</div>
          </div>
          <div class="set-ctl"><input id="disc-interval" class="mono" style="max-width:90px"></div>
        </div>
        <div class="row">
          <button id="disc-save" data-i18n="disc_save">Save</button>
          <button id="disc-run" class="quiet" data-i18n="disc_run">Run now</button>
        </div>
        <p class="note" id="disc-note"></p>
        <div id="disc-progress"></div>
        <div id="pinned-list"></div>
        <div class="row">
          <input id="pin-input" class="mono" data-i18n-ph="pin_ph" placeholder="pin model, e.g. gemini:gemini-3.8-flash" style="flex:1;min-width:200px">
          <button id="pin-add" data-i18n="pin_add">Pin</button>
        </div>
      </div>
    </section>
  </div>

  <div id="provider-modal" class="overlay" hidden>
    <div class="modal" role="dialog" aria-modal="true">
      <div class="row" style="justify-content:space-between;align-items:center">
        <h3 id="provider-modal-title" style="margin:0"></h3>
        <button class="icononly" id="provider-modal-x" aria-label="Close"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"/></svg></button>
      </div>
      <div id="provider-modal-body"></div>
    </div>
  </div>

  <div data-pane="settings" hidden>
    <section>
      <div class="sec-head">
        <h2 data-i18n="server_title">Server</h2>
        <p id="server-blurb"></p>
      </div>
      <div class="sec-body">
        <div class="setrow">
          <div class="set-text">
            <div class="set-title" data-i18n="srv_lan">Allow LAN access</div>
            <div class="set-desc" id="srv-lan-addrs"></div>
          </div>
          <div class="set-ctl"><label class="switch"><input type="checkbox" id="srv-lan"><span class="slider"></span></label></div>
        </div>
        <div class="setrow">
          <div class="set-text">
            <div class="set-title" data-i18n="srv_port">Port</div>
            <div class="set-desc" data-i18n="srv_port_desc">Takes effect after a restart.</div>
          </div>
          <div class="set-ctl"><input id="srv-port" class="mono" style="max-width:100px"></div>
        </div>
        <div class="row">
          <button id="srv-save" data-i18n="srv_save">Save</button>
          <button id="srv-restart" data-i18n="restart_btn">Restart</button>
        </div>
        <div id="srv-lan-insecure" class="warn-banner" role="alert" hidden></div>
      </div>
    </section>
    <section>
      <div class="sec-head"><h2 data-i18n="tuning_title">Tuning</h2><p data-i18n="tuning_blurb">Timeouts apply immediately; proxy and retention settings need a restart.</p></div>
      <div class="sec-body">
        <div class="setrow">
          <div class="set-text">
            <div class="set-title" data-i18n="tun_timeout">Attempt timeout (ms)</div>
            <div class="set-desc" data-i18n="tun_timeout_desc">Per-request ceiling. Applies immediately.</div>
          </div>
          <div class="set-ctl"><input id="set-timeout" class="mono" style="max-width:120px"></div>
        </div>
        <div class="setrow">
          <div class="set-text">
            <div class="set-title" data-i18n="tun_refresh">Catalog refresh (ms)</div>
            <div class="set-desc" data-i18n="tun_refresh_desc">How often provider catalogs refetch.</div>
          </div>
          <div class="set-ctl"><input id="set-refresh" class="mono" style="max-width:130px"></div>
        </div>
        <div class="setrow">
          <div class="set-text">
            <div class="set-title" data-i18n="tun_redact">Redact secrets</div>
            <div class="set-desc" data-i18n="tun_redact_desc">Strip keys from logs and upstream payloads.</div>
          </div>
          <div class="set-ctl"><label class="switch"><input type="checkbox" id="set-redact"><span class="slider"></span></label></div>
        </div>
        <div class="setrow">
          <div class="set-text">
            <div class="set-title" data-i18n="tun_default">Default provider</div>
            <div class="set-desc" data-i18n="tun_default_desc">Assumed provider for bare model ids in routes.</div>
          </div>
          <div class="set-ctl"><select id="set-default"></select></div>
        </div>
        <div class="setrow">
          <div class="set-text">
            <div class="set-title" data-i18n="tun_socks">Socks-first hosts</div>
            <div class="set-desc" data-i18n="tun_socks_desc">Comma-separated hosts that prefer the SOCKS proxy.</div>
          </div>
          <div class="set-ctl"><input id="set-socks" class="mono" data-i18n-ph="tun_socks_ph" placeholder="socks-first hosts, comma separated" style="max-width:220px"></div>
        </div>
        <div class="setrow">
          <div class="set-text">
            <div class="set-title" data-i18n="tun_retention">Usage retention (days)</div>
            <div class="set-desc" data-i18n="tun_retention_desc">How many days of usage history to keep.</div>
          </div>
          <div class="set-ctl"><input id="set-retention" class="mono" style="max-width:80px"></div>
        </div>
        <div class="setrow">
          <div class="set-text">
            <div class="set-title" data-i18n="tun_timezone">Timezone</div>
            <div class="set-desc" data-i18n="tun_timezone_desc">Daily quota boundaries, e.g. America/Los_Angeles.</div>
          </div>
          <div class="set-ctl">
            <div class="combo" id="set-timezone-combo">
              <input id="set-timezone" class="mono" role="combobox" aria-expanded="false" aria-autocomplete="list" aria-controls="set-timezone-list" autocomplete="off" spellcheck="false" data-i18n-ph="tun_timezone_ph" placeholder="America/Los_Angeles">
              <ul id="set-timezone-list" class="combo-list" role="listbox" hidden></ul>
            </div>
          </div>
        </div>
        <div class="row">
          <button class="primary" id="set-save" data-i18n="tun_save">Save tuning</button>
        </div>
        <p class="note" id="set-note"></p>
      </div>
    </section>
    <section>
      <div class="sec-head">
        <h2 data-i18n="admin_title">Admin</h2>
        <p data-i18n="admin_blurb">Web UI password (default <span class="mono">admin123</span>). Changing it logs out all sessions.</p>
      </div>
      <div class="sec-body">
        <div class="setrow">
          <div class="set-text">
            <div class="set-title" data-i18n="admin_pass_t">Admin password</div>
            <div class="set-desc" data-i18n="admin_pass_d">Changing it logs out all sessions.</div>
            <div class="set-desc" id="admin-pw-changed"></div>
          </div>
          <div class="set-ctl">
            <input id="admin-pass" type="password" data-i18n-ph="admin_pass_ph" placeholder="New admin password" style="max-width:200px">
            <button class="primary" id="admin-save" data-i18n="admin_save">Change password</button>
            <button class="quiet" id="logout" data-i18n="logout">Log out</button>
          </div>
        </div>
        <div class="setrow">
          <div class="set-text">
            <div class="set-title" data-i18n="sess_ttl">Session expires after</div>
            <div class="set-desc" data-i18n="sess_d">Login sessions expire after this long. 0 means never.</div>
          </div>
          <div class="set-ctl">
            <select id="sess-preset"></select>
            <button id="sess-save" data-i18n="sess_save">Save session</button>
          </div>
        </div>
        <p class="note" id="sess-note"></p>
      </div>
    </section>
  </div>

  <div data-pane="logs" hidden>
    <section>
      <div class="sec-head">
        <h2 data-i18n="logs_title">Request log</h2>
        <p data-i18n="logs_blurb">Newest first. Metadata only: dialect, models, outcome, timings, and top-level field names — never prompts, answers, headers, or key values. The last 500 requests are kept in memory and cleared on restart.</p>
      </div>
      <div class="sec-body">
        <div class="row" style="justify-content:flex-end">
          <button id="logs-refresh" class="ghost" data-i18n="logs_refresh">Refresh</button>
          <button id="logs-copy" class="ghost" data-i18n="logs_copy_all">Copy all</button>
          <button id="logs-export-jsonl" class="ghost" data-i18n="logs_export_jsonl">Export JSONL</button>
          <button id="logs-export-text" class="ghost" data-i18n="logs_export_text">Export text</button>
          <button id="logs-clear" class="ghost danger" data-i18n="logs_clear">Clear</button>
        </div>
        <div id="logs"></div>
        <p class="note" id="logs-note"></p>
      </div>
    </section>
  </div>
</main>
<div id="login" style="display:none">
  <div class="gate">
    <div class="gate-mark" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12h4l3-8 4 16 3-8h4"/></svg></div>
    <h1 class="gate-title">Free Router</h1>
    <p class="gate-sub" data-i18n="login_blurb">Enter the admin password to continue.</p>
    <div class="gate-form">
      <input id="login-pass" type="password" data-i18n-ph="login_pass_ph" placeholder="Default admin123">
      <button class="primary" id="login-go" data-i18n="login_go">Log in</button>
    </div>
  </div>
</div>
<div id="toast"></div>
<script>window.FR_I18N = ${I18N_PAYLOAD};</script>
<script>window.FR_TZ = ${TZ_PAYLOAD};</script>
<script>
const el = (id) => document.getElementById(id);
let state = null;

// Minimal i18n runtime. The dictionary comes from i18n.mjs via
// window.FR_I18N; semantics mirror translate() there (English fallback,
// {var} interpolation). Static markup uses data-i18n / data-i18n-ph /
// data-i18n-title attributes; dynamic strings call t() directly.
const FR_LANGS = (window.FR_I18N && window.FR_I18N.langs) || [['en', 'English']];
const FR_STR = (window.FR_I18N && window.FR_I18N.strings) || { en: {} };
let lang = 'en';
try {
  lang = localStorage.getItem('fr-lang') || detectLang();
} catch (error) {
  lang = detectLang();
}
if (!FR_LANGS.some(([code]) => code === lang)) lang = 'en';

function detectLang() {
  const nav = String((typeof navigator !== 'undefined' && navigator.language) || 'en').toLowerCase();
  for (const [code] of FR_LANGS) {
    if (code.toLowerCase() === nav) return code;
  }
  if (nav === 'zh-hk' || nav === 'zh-hant' || nav === 'zh-tw') return 'zh-TW';
  if (nav.indexOf('zh') === 0) return 'zh-CN';
  const prefix = nav.split('-')[0];
  const hit = FR_LANGS.find(([code]) => code.toLowerCase() === prefix);
  return hit ? hit[0] : 'en';
}

function t(key, vars) {
  const table = FR_STR[lang] || {};
  const value = table[key] !== undefined ? table[key] : (FR_STR.en[key] !== undefined ? FR_STR.en[key] : key);
  if (!vars) return value;
  // NOTE: this script is embedded in a JS template literal, so backslashes
  // must be doubled here to arrive intact in the served page.
  return String(value).replace(/\\{(\\w+)\\}/g, (_, name) =>
    vars[name] === undefined || vars[name] === null ? '' : String(vars[name]),
  );
}

// One icon table for every control, same stroke weight as the static nav
// icons in the markup. Multi-subpath path data is valid SVG.
const ICON_PATHS = {
  copy: 'M9 9h11v11H9zM5 15H4V4h11v1',
  x: 'M18 6 6 18M6 6l12 12',
  up: 'M12 19V5M5 12l7-7 7 7',
  down: 'M12 5v14M19 12l-7 7-7-7',
  monitor: 'M2 3h20v14H2zM8 21h8M12 17v4',
  sun: 'M12 17a5 5 0 1 0 0-10 5 5 0 0 0 0 10zM12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42',
  moon: 'M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z',
};
function svgIcon(name) {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.75');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(ns, 'path');
  path.setAttribute('d', ICON_PATHS[name]);
  svg.appendChild(path);
  return svg;
}

// Theme: system / light / dark. The head script already resolved the first
// paint from the same key; this keeps the button icon and later changes in
// sync. "system" follows the OS live until an explicit choice is made.
const THEME_KEY = 'fr-theme';
const THEME_ORDER = ['system', 'light', 'dark'];
let themePref = 'system';
try {
  const savedTheme = localStorage.getItem(THEME_KEY);
  if (THEME_ORDER.includes(savedTheme)) themePref = savedTheme;
} catch (error) {}
const themeQuery = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;
function themeIsDark() {
  if (themePref === 'dark') return true;
  if (themePref === 'light') return false;
  return Boolean(themeQuery && themeQuery.matches);
}
function applyTheme() {
  const dark = themeIsDark();
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  // Two theme-color tags, one active: the browser chrome should match the theme
  // the user actually chose, not just the OS preference.
  const lightMeta = document.getElementById('theme-color-light');
  const darkMeta = document.getElementById('theme-color-dark');
  if (lightMeta && darkMeta) {
    lightMeta.setAttribute('media', dark ? 'not all' : 'all');
    darkMeta.setAttribute('media', dark ? 'all' : 'not all');
  }
  const button = el('theme-btn');
  if (!button) return;
  button.textContent = '';
  button.appendChild(svgIcon(themePref === 'system' ? 'monitor' : (themePref === 'light' ? 'sun' : 'moon')));
  const label = t('theme_title', { mode: t('theme_' + themePref) });
  button.title = label;
  button.setAttribute('aria-label', label);
}
function cycleTheme() {
  themePref = THEME_ORDER[(THEME_ORDER.indexOf(themePref) + 1) % THEME_ORDER.length];
  try { localStorage.setItem(THEME_KEY, themePref); } catch (error) {}
  applyTheme();
}
if (themeQuery && themeQuery.addEventListener) {
  themeQuery.addEventListener('change', () => { if (themePref === 'system') applyTheme(); });
}

function applyI18n() {
  document.documentElement.lang = lang;
  document.querySelectorAll('[data-i18n]').forEach((node) => {
    const value = t(node.dataset.i18n);
    if (/<[a-z][^>]*>/i.test(value)) node.innerHTML = value;
    else node.textContent = value;
  });
  document.querySelectorAll('[data-i18n-ph]').forEach((node) => {
    node.setAttribute('placeholder', t(node.dataset.i18nPh));
  });
  document.querySelectorAll('[data-i18n-title]').forEach((node) => {
    node.setAttribute('title', t(node.dataset.i18nTitle));
  });
  const select = el('lang');
  if (select && !select.options.length) {
    for (const [code, label] of FR_LANGS) {
      const option = document.createElement('option');
      option.value = code;
      option.textContent = label;
      select.appendChild(option);
    }
  }
  if (select) select.value = lang;
  applyTheme();
}

function setLang(code) {
  if (!FR_LANGS.some(([entry]) => entry === code)) return;
  lang = code;
  try {
    localStorage.setItem('fr-lang', lang);
  } catch (error) {
    // Private browsing etc: language just doesn't persist.
  }
  applyI18n();
  if (state) renderAll();
}

function renderAll() {
  switchTab(activeTab);
  renderStatus();
  renderGateway();
  renderServer();
  renderProviders();
  renderPool();
  renderUsage();
  renderDiscovery();
  renderTuning();
  renderMigration();
  renderSession();
  renderLogs();
}


function toast(message, kind) {
  const node = el('toast');
  node.textContent = message;
  node.className = 'show ' + (kind || '');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { node.className = ''; }, 4600);
}

async function api(path, options) {
  const config = Object.assign({ headers: {} }, options || {});
  config.headers['X-Free-Router-UI'] = '1';
  if (config.body) config.headers['Content-Type'] = 'application/json';
  const response = await fetch(path, config);
  const text = await response.text();
  let payload = null;
  try { payload = text ? JSON.parse(text) : null; } catch (error) { payload = null; }
  if (!response.ok) {
    throw new Error((payload && payload.error && payload.error.message) || ('HTTP ' + response.status));
  }
  return payload;
}

function td(value, className) {
  const cell = document.createElement('td');
  if (className) cell.className = className;
  if (value instanceof Node) cell.appendChild(value);
  else cell.textContent = value;
  return cell;
}

function table(headers, rows) {
  const node = document.createElement('table');
  const head = document.createElement('thead');
  const headRow = document.createElement('tr');
  for (const header of headers) {
    const cell = document.createElement('th');
    cell.textContent = header.label;
    if (header.num) cell.className = 'num';
    headRow.appendChild(cell);
  }
  head.appendChild(headRow);
  node.appendChild(head);
  const body = document.createElement('tbody');
  for (const row of rows) {
    const tr = document.createElement('tr');
    for (const cell of row) tr.appendChild(cell);
    body.appendChild(tr);
  }
  node.appendChild(body);
  return node;
}

function pill(text, kind) {
  const node = document.createElement('span');
  node.className = 'pill ' + kind;
  node.textContent = text;
  return node;
}

function providerRowCounts(provider) {
  const q = (v) => (v === null || v === undefined ? '?' : v);
  const pool = provider.poolCounts || {};
  return {
    models: q(provider.modelCount),
    free: q(provider.freeCount),
    paid: pool.paid ?? 0,
    blocked: pool.blocked ?? 0,
  };
}

let modalReturnFocus = null;
function openProviderModal(mode, provider) {
  const overlay = el('provider-modal');
  modalReturnFocus = document.activeElement;
  el('provider-modal-title').textContent = mode === 'create' ? t('prov_modal_add') : t('prov_modal_edit', { p: provider ? provider.name : '' });
  el('provider-modal-body').textContent = '';
  const closer = el('provider-modal-x');
  closer.title = t('prov_modal_close');
  closer.setAttribute('aria-label', t('prov_modal_close'));
  overlay.hidden = false;
}
function closeProviderModal() {
  el('provider-modal').hidden = true;
  el('provider-modal-body').textContent = '';
  if (modalReturnFocus && modalReturnFocus.focus) modalReturnFocus.focus();
}

function renderProviders() {
  const host = el('providers');
  host.textContent = '';

  const toolbar = document.createElement('div');
  toolbar.className = 'row';
  const addBtn = document.createElement('button');
  addBtn.className = 'primary';
  addBtn.textContent = t('prov_modal_add');
  addBtn.onclick = () => {
    openProviderModal('create');
    const created = buildProviderForm();
    el('provider-modal-body').appendChild(created.form);
    created.cancel.onclick = () => closeProviderModal();
    const origSave = created.save.onclick;
    created.save.onclick = async (e) => {
      await origSave(e);
      // save.disabled stays true only on success (the create handler re-enables it on error).
      if (!created.save.disabled) return;
      closeProviderModal();
    };
  };
  toolbar.appendChild(addBtn);
  host.appendChild(toolbar);

  const tbl = document.createElement('table');
  const head = document.createElement('thead');
  const headRow = document.createElement('tr');
  for (const key of ['pt_name', 'pt_url', 'pt_keys', 'pt_models', 'pt_free', 'pt_paid', 'pt_blocked']) {
    const th = document.createElement('th');
    th.textContent = t(key);
    headRow.appendChild(th);
  }
  headRow.appendChild(document.createElement('th'));
  head.appendChild(headRow);
  tbl.appendChild(head);
  const body = document.createElement('tbody');
  tbl.appendChild(body);
  host.appendChild(tbl);

  for (const provider of state.providers) {
    const counts = providerRowCounts(provider);
    const tr = document.createElement('tr');
    const nameTd = document.createElement('td');
    nameTd.textContent = provider.name;
    const urlTd = document.createElement('td');
    urlTd.className = 'mono';
    urlTd.textContent = provider.baseUrl || '';
    const keysTd = document.createElement('td');
    keysTd.className = 'num';
    keysTd.textContent = provider.keyCount || 0;
    const modelsTd = document.createElement('td');
    modelsTd.className = 'num';
    modelsTd.textContent = counts.models;
    const freeTd = document.createElement('td');
    freeTd.className = 'num';
    freeTd.textContent = counts.free;
    const paidTd = document.createElement('td');
    paidTd.className = 'num';
    paidTd.textContent = counts.paid;
    const blockedTd = document.createElement('td');
    blockedTd.className = 'num';
    blockedTd.textContent = counts.blocked;
    const opsTd = document.createElement('td');
    const modelsBtn = document.createElement('button');
    modelsBtn.className = 'quiet';
    modelsBtn.textContent = t('prov_models_manage');
    modelsBtn.onclick = () => openProviderModels(provider);
    const manage = document.createElement('button');
    manage.className = 'quiet';
    manage.textContent = t('prov_manage');
    manage.onclick = () => openProviderKeys(provider);
    const del = document.createElement('button');
    del.className = 'quiet danger';
    del.textContent = t('del');
    del.onclick = async () => {
      if (!confirm(t('confirm_del_provider', { p: provider.name }))) return;
      try {
        const result = await api('api/providers', {
          method: 'POST',
          body: JSON.stringify({ action: 'delete', name: provider.name }),
        });
        toast(t('deleted_provider', { p: provider.name, n: result.purged || 0 }), 'good');
        await load();
      } catch (error) {
        toast(String(error.message || error), 'err');
      }
    };
    opsTd.appendChild(modelsBtn);
    opsTd.appendChild(manage);
    opsTd.appendChild(del);
    tr.append(nameTd, urlTd, keysTd, modelsTd, freeTd, paidTd, blockedTd, opsTd);
    body.appendChild(tr);
  }
  el('keys-blurb').textContent = t('keys_blurb', { file: state.overlayFile, format: state.configFormat });
}

function openProviderKeys(provider) {
  openProviderModal('edit', provider);
  const body = el('provider-modal-body');
  body.textContent = '';
  body.appendChild(buildProviderDetail(provider));
}

// The model table is the one place free/paid membership is decided. It is
// rebuilt after each save so the checkboxes and limits always show live state.
function openProviderModels(provider) {
  openProviderModal('edit', provider);
  el('provider-modal-title').textContent = t('prov_modal_models', { p: provider.name });
  const body = el('provider-modal-body');
  const paint = () => {
    const latest = (state.providers || []).find((entry) => entry.name === provider.name) || provider;
    body.textContent = '';
    body.appendChild(buildProviderDefaultLimit(latest, paint));
    body.appendChild(buildModelTable(latest, paint));
  };
  paint();
}

// Static fallback for presets whose sibling provider is absent (deleted or
// never configured). Live sibling data (URL, flags, catalog ids) wins
// whenever present.
const PROVIDER_PRESETS = {
  gemini: { baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', catalog: true, pricing: false, probeFreeTier: true },
  openrouter: { baseUrl: 'https://openrouter.ai/api/v1', catalog: true, pricing: true },
  tokenrouter: { baseUrl: 'https://api.tokenrouter.com/v1', catalog: true, pricing: false, probeFreeTier: true },
  bai: { baseUrl: 'https://api.b.ai/v1', catalog: true, pricing: false, probeFreeTier: true },
  hashneuron: { baseUrl: 'https://hashneuron.space/v1', catalog: true, pricing: false, probeFreeTier: true },
  groq: { baseUrl: 'https://api.groq.com/openai/v1', catalog: true, pricing: false },
  cerebras: { baseUrl: 'https://api.cerebras.ai/v1', catalog: true, pricing: false },
  mistral: { baseUrl: 'https://api.mistral.ai/v1', catalog: true, pricing: false },
  huggingface: { baseUrl: 'https://router.huggingface.co/v1', catalog: true, pricing: false },
};

function renderModelList(box, ids, freeSet, truncated, classes) {
  box.textContent = '';
  if (!ids.length) {
    const p = document.createElement('p');
    p.className = 'note';
    p.style.margin = '0';
    p.textContent = t('prov_no_catalog');
    box.appendChild(p);
    return;
  }
  const title = document.createElement('div');
  title.className = 'prov-hint';
  title.textContent = t('prov_models_pick');
  box.appendChild(title);
  for (const id of ids) {
    const label = document.createElement('label');
    label.className = 'check';
    const boxEl = document.createElement('input');
    boxEl.type = 'checkbox';
    boxEl.dataset.model = id;
    const cls = classes?.[id] || (freeSet.has(id) ? 'free' : 'paid');
    boxEl.dataset.cls = cls;
    if (freeSet.has(id)) boxEl.checked = true;
    const text = document.createElement('span');
    text.className = 'mono';
    text.textContent =
      id + (cls === 'free' ? '' : ' ' + (cls === 'unknown' ? t('prov_unknown_tag') : t('prov_paid_tag')));
    label.append(boxEl, text);
    box.appendChild(label);
  }
  if (truncated) {
    const p = document.createElement('p');
    p.className = 'note';
    p.style.margin = '0';
    p.textContent = t('prov_truncated');
    box.appendChild(p);
  }
}

function buildProviderForm() {
  const form = document.createElement('div');
  const r0 = document.createElement('div');
  r0.className = 'row';
  const presetLabel = document.createElement('span');
  presetLabel.textContent = t('prov_preset');
  const presetSelect = document.createElement('select');
  presetSelect.id = 'np-preset';
  const customOpt = document.createElement('option');
  customOpt.value = '';
  customOpt.textContent = t('prov_custom');
  presetSelect.appendChild(customOpt);
  for (const name of Object.keys(PROVIDER_PRESETS)) {
    const opt = document.createElement('option');
    opt.value = name;
    opt.textContent = name;
    presetSelect.appendChild(opt);
  }
  r0.append(presetLabel, presetSelect);
  const r1 = document.createElement('div');
  r1.className = 'row';
  const nameField = document.createElement('input');
  nameField.id = 'np-name';
  nameField.placeholder = t('np_name_ph');
  nameField.style.maxWidth = '150px';
  const urlField = document.createElement('input');
  urlField.id = 'np-baseurl';
  urlField.className = 'mono';
  urlField.placeholder = t('np_url_ph');
  urlField.style.flex = '1';
  urlField.style.minWidth = '220px';
  const keyField = document.createElement('input');
  keyField.id = 'np-key';
  keyField.type = 'password';
  keyField.autocomplete = 'off';
  keyField.spellcheck = false;
  keyField.placeholder = t('np_key_ph');
  keyField.style.flex = '1';
  keyField.style.minWidth = '180px';
  r1.append(nameField, urlField, keyField);
  const modelsBox = document.createElement('div');
  modelsBox.id = 'np-models';
  const r2 = document.createElement('div');
  r2.className = 'row';
  const modelsField = document.createElement('input');
  modelsField.id = 'np-freemodels';
  modelsField.className = 'mono';
  modelsField.placeholder = t('np_fm_ph');
  modelsField.style.flex = '1';
  modelsField.style.minWidth = '220px';
  const fetchBtn = document.createElement('button');
  fetchBtn.id = 'np-fetch';
  fetchBtn.textContent = t('prov_fetch');
  fetchBtn.onclick = async () => {
    const baseUrl = urlField.value.trim();
    if (!baseUrl) { toast(t('np_need'), 'err'); return; }
    fetchBtn.disabled = true;
    try {
      const result = await api('api/providers', {
        method: 'POST',
        body: JSON.stringify({ action: 'fetch-models', baseUrl, key: keyField.value.trim() }),
      });
      const listed = result.models || [];
      renderModelList(
        modelsBox,
        listed.map((m) => m.id),
        new Set(listed.filter((m) => m.free).map((m) => m.id)),
        Boolean(result.truncated),
        Object.fromEntries(listed.map((m) => [m.id, m.free ? 'free' : m.unknown ? 'unknown' : 'paid'])),
      );
      if (!result.models.length) toast(t('prov_no_catalog'), 'err');
    } catch (error) {
      toast(String(error.message || error), 'err');
    } finally {
      fetchBtn.disabled = false;
    }
  };
  r2.append(modelsField, fetchBtn);
  const r3 = document.createElement('div');
  r3.className = 'row';
  const catalogLabel = document.createElement('label');
  catalogLabel.className = 'switch';
  const catalogBox = document.createElement('input');
  catalogBox.type = 'checkbox';
  catalogBox.id = 'np-catalog';
  catalogBox.checked = true;
  const catalogSlider = document.createElement('span');
  catalogSlider.className = 'slider';
  catalogLabel.append(catalogBox, catalogSlider);
  const catalogText = document.createElement('span');
  catalogText.textContent = t('np_catalog');
  const pricingLabel = document.createElement('label');
  pricingLabel.className = 'switch';
  const pricingBox = document.createElement('input');
  pricingBox.type = 'checkbox';
  pricingBox.id = 'np-pricing';
  const pricingSlider = document.createElement('span');
  pricingSlider.className = 'slider';
  pricingLabel.append(pricingBox, pricingSlider);
  const pricingText = document.createElement('span');
  pricingText.textContent = t('np_pricing');
  const probeLabel = document.createElement('label');
  probeLabel.className = 'switch';
  const probeBox = document.createElement('input');
  probeBox.type = 'checkbox';
  probeBox.id = 'np-probe';
  const probeSlider = document.createElement('span');
  probeSlider.className = 'slider';
  probeLabel.append(probeBox, probeSlider);
  const probeText = document.createElement('span');
  probeText.textContent = t('np_probe');
  r3.append(catalogLabel, catalogText, pricingLabel, pricingText, probeLabel, probeText);
  const r3b = document.createElement('div');
  r3b.className = 'row';
  const flagsNote = document.createElement('p');
  flagsNote.className = 'note';
  flagsNote.style.margin = '0';
  flagsNote.textContent = t('prov_flags_note');
  r3b.appendChild(flagsNote);
  const r4 = document.createElement('div');
  r4.className = 'row';
  const save = document.createElement('button');
  save.className = 'primary';
  save.id = 'np-create';
  save.textContent = t('np_create');
  const cancel = document.createElement('button');
  cancel.className = 'quiet';
  cancel.id = 'np-cancel';
  cancel.textContent = t('prov_cancel');
  r4.append(save, cancel);
  const note = document.createElement('p');
  note.className = 'note';
  note.textContent = t('prov_auto_note');
  form.append(r0, r1, modelsBox, r2, r3, r3b, r4, note);
  function renderModelChecks() {
    modelsBox.textContent = '';
    const preset = presetSelect.value;
    if (!preset) return;
    const sibling = (state.providers || []).find((entry) => entry.name === preset);
    const ids = (sibling && Array.isArray(sibling.catalogIds) && sibling.catalogIds.length
      ? sibling.catalogIds
      : []);
    if (!ids.length) {
      const p = document.createElement('p');
      p.className = 'note';
      p.style.margin = '0';
      p.textContent = t('prov_no_catalog');
      modelsBox.appendChild(p);
      return;
    }
    renderModelList(
      modelsBox,
      ids,
      new Set(sibling.catalogFreeIds || []),
      Boolean(sibling.catalogTruncated),
      sibling.catalogClasses || {},
    );
  }
  function fillFromPreset() {
    const preset = presetSelect.value;
    const sibling = preset ? (state.providers || []).find((entry) => entry.name === preset) : null;
    const detail = preset
      ? (state.editable && state.editable.providers || []).find((entry) => entry.name === preset)
      : null;
    const fallback = PROVIDER_PRESETS[preset] || {};
    urlField.value = (sibling && sibling.baseUrl) || fallback.baseUrl || '';
    catalogBox.checked = detail ? detail.catalog === true : fallback.catalog !== false && preset !== '';
    if (!preset) catalogBox.checked = true;
    pricingBox.checked = detail ? detail.pricing === true : fallback.pricing === true;
    probeBox.checked = detail ? detail.probeFreeTier === true : fallback.probeFreeTier === true;
    renderModelChecks();
  }
  presetSelect.onchange = fillFromPreset;
  save.onclick = async () => {
    const name = nameField.value.trim().toLowerCase();
    const baseUrl = urlField.value.trim();
    if (!name || !baseUrl) { toast(t('np_need'), 'err'); return; }
    const picked = [...modelsBox.querySelectorAll('input[type="checkbox"]:checked')]
      .map((box) => ({ id: box.dataset.model, cls: box.dataset.cls || 'unknown' }))
      .filter((entry) => entry.id);
    const typed = modelsField.value.split(',').map((s) => s.trim()).filter(Boolean);
    // A priced catalog decides freeness itself, so a typed id there is an
    // explicit selection (and may cost money); an unpriced provider treats it
    // as an allowlist entry, which is what made it callable before.
    const freeModels = [
      ...new Set([
        ...picked.filter((entry) => entry.cls === 'free').map((entry) => entry.id),
        ...(pricingBox.checked ? [] : typed),
      ]),
    ];
    const selectedModels = [
      ...new Set([
        ...picked.filter((entry) => entry.cls !== 'free').map((entry) => entry.id),
        ...(pricingBox.checked ? typed : []),
      ]),
    ];
    if (selectedModels.length) {
      const warning = picked.some((entry) => entry.cls === 'unknown')
        ? t('unknown_model_warning')
        : t('paid_model_warning');
      if (!confirm(warning + '\\n\\n' + selectedModels.join('\\n'))) return;
    }
    save.disabled = true;
    try {
      await api('api/providers', {
        method: 'POST',
        body: JSON.stringify({
          action: 'create',
          name,
          baseUrl,
          catalog: catalogBox.checked,
          pricing: pricingBox.checked,
          probeFreeTier: probeBox.checked,
          freeModels,
          selectedModels,
        }),
      });
      const key = keyField.value.trim();
      if (key) {
        await api('api/keys', {
          method: 'POST',
          body: JSON.stringify({ provider: name, name: 'key-1', key }),
        });
      }
      toast(t('np_added', { n: name }), 'good');
      await load();
    } catch (error) {
      toast(String(error.message || error), 'err');
      save.disabled = false;
    }
  };
  return { form, save, cancel };
}

function buildProviderDetail(provider) {
  const fieldCell = document.createElement('div');
  fieldCell.className = 'prov-field';

  // Named multi-account keys (stored in the TOML/JSON config).
  const fileKeys = (provider.keys || []).filter((entry) => entry.source === 'file');
  for (const entry of fileKeys) {
    const line = document.createElement('div');
    line.className = 'keyrow';
    const label = document.createElement('span');
    label.textContent = entry.name + (entry.invalid ? ' ' + t('retired') : '');
    const masked = document.createElement('span');
    masked.className = 'mono';
    masked.textContent = entry.maskedKey;
    const del = document.createElement('button');
    del.className = 'quiet danger';
    del.textContent = t('del');
    del.onclick = async () => {
      if (!confirm(t('confirm_del_key', { k: entry.name, p: provider.name }))) return;
      del.disabled = true;
      try {
        await api('api/keys', {
          method: 'POST',
          body: JSON.stringify({ provider: provider.name, name: entry.name, key: '' }),
        });
        toast(t('deleted_key', { n: entry.name }), 'good');
        await load();
      } catch (error) {
        toast(String(error.message || error), 'err');
        del.disabled = false;
      }
    };
    line.appendChild(label);
    line.appendChild(masked);
    line.appendChild(del);
    fieldCell.appendChild(line);
  }

  const addRow = document.createElement('div');
  addRow.className = 'row';
  const nameField = document.createElement('input');
  nameField.placeholder = t('prov_label_ph');
  nameField.style.maxWidth = '150px';
  const keyField = document.createElement('input');
  keyField.type = 'password';
  keyField.autocomplete = 'off';
  keyField.spellcheck = false;
  keyField.placeholder = fileKeys.length ? t('prov_paste_more') : t('prov_paste_first', { env: provider.keyEnv });
  keyField.style.flex = '1';
  const add = document.createElement('button');
  add.className = 'primary';
  add.textContent = fileKeys.length ? t('prov_add') : t('prov_save');
  add.onclick = async () => {
    const value = keyField.value.trim();
    const label = nameField.value.trim() || ('key-' + ((provider.keyCount || 0) + 1));
    if (!value) { toast(t('prov_empty'), 'err'); return; }
    add.disabled = true;
    try {
      await api('api/keys', {
        method: 'POST',
        body: JSON.stringify({ provider: provider.name, name: label, key: value }),
      });
      toast(t('prov_saved', { n: label, p: provider.name }), 'good');
      await load();
    } catch (error) {
      toast(String(error.message || error), 'err');
      add.disabled = false;
    }
  };
  addRow.appendChild(nameField);
  addRow.appendChild(keyField);
  addRow.appendChild(add);
  fieldCell.appendChild(addRow);

  const hint = document.createElement('div');
  hint.className = 'prov-hint';
  const envKeys = (provider.keys || []).filter((entry) => entry.source === 'env');
  if (!provider.configured) {
    hint.textContent = t('prov_notset');
  } else if (envKeys.length) {
    hint.textContent = t('prov_env', { m: envKeys.map((entry) => entry.maskedKey).join(', ') });
  } else {
    hint.textContent = t('prov_rot', { n: provider.keyCount });
  }
  if (provider.catalogError && !provider.catalogModels) {
    hint.appendChild(document.createTextNode('  '));
    hint.appendChild(pill(t('catalog_down'), 'bad'));
  }
  fieldCell.appendChild(hint);

  if (provider.unavailableModels && provider.unavailableModels.length) {
    const gone = document.createElement('div');
    gone.className = 'prov-hint';
    gone.appendChild(pill(t('withdrawn'), 'warn'));
    gone.appendChild(document.createTextNode(' ' + t('withdrawn_models') + ' '));
    const ids = document.createElement('span');
    ids.className = 'mono';
    ids.textContent = provider.unavailableModels.join(', ');
    gone.appendChild(ids);
    fieldCell.appendChild(gone);
  }

  const adv = document.createElement('details');
  const summary = document.createElement('summary');
  summary.textContent = t('adv_title');
  summary.style.cssText = 'cursor:pointer;font-size:12.5px;color:var(--muted);margin-top:8px';
  adv.appendChild(summary);
  const detail = state.editable.providers.find((entry) => entry.name === provider.name) || {};
  const urlRow = document.createElement('div');
  urlRow.className = 'row';
  const urlField = document.createElement('input');
  urlField.className = 'mono';
  urlField.value = detail.baseUrl || '';
  urlField.style.flex = '1';
  urlField.placeholder = t('url_ph');
  const urlSave = document.createElement('button');
  urlSave.textContent = t('url_save');
  urlSave.onclick = async () => {
    urlSave.disabled = true;
    try {
      const result = await api('api/providers', {
        method: 'POST',
        body: JSON.stringify({ action: 'update', name: provider.name, baseUrl: urlField.value.trim() }),
      });
      toast(t('saved') + ((result.notes || []).length ? ' ' + result.notes.join(' ') : ''), 'good');
      await load();
    } catch (error) {
      toast(String(error.message || error), 'err');
      urlSave.disabled = false;
    }
  };
  urlRow.appendChild(urlField);
  urlRow.appendChild(urlSave);
  adv.appendChild(urlRow);

  const probeRow = document.createElement('div');
  probeRow.className = 'row';
  const probeLabel = document.createElement('label');
  probeLabel.className = 'switch';
  const probeToggle = document.createElement('input');
  probeToggle.type = 'checkbox';
  probeToggle.checked = detail.probeFreeTier === true;
  const probeSlider = document.createElement('span');
  probeSlider.className = 'slider';
  probeLabel.append(probeToggle, probeSlider);
  const probeText = document.createElement('span');
  probeText.textContent = t('np_probe');
  probeToggle.onchange = async () => {
    probeToggle.disabled = true;
    try {
      const result = await api('api/providers', {
        method: 'POST',
        body: JSON.stringify({
          action: 'update',
          name: provider.name,
          probeFreeTier: probeToggle.checked,
        }),
      });
      toast(t('saved') + ((result.notes || []).length ? ' ' + result.notes.join(' ') : ''), 'good');
      await load();
    } catch (error) {
      probeToggle.checked = !probeToggle.checked;
      toast(String(error.message || error), 'err');
    } finally {
      probeToggle.disabled = false;
    }
  };
  probeRow.append(probeLabel, probeText);
  adv.appendChild(probeRow);
  return fieldCell;
}

// Provider-wide default (provider:*) for requests/day. A per-model limit
// below overrides it; the input is blank when the provider has no default.
function buildProviderDefaultLimit(provider, refresh) {
  const wrap = document.createElement('div');
  wrap.className = 'setrow';
  const text = document.createElement('div');
  text.className = 'set-text';
  const title = document.createElement('div');
  title.className = 'set-title';
  title.textContent = t('prov_default_limit', { key: provider.name + ':*' });
  const desc = document.createElement('div');
  desc.className = 'set-desc';
  desc.textContent = t('prov_default_limit_desc');
  text.append(title, desc);
  const ctl = document.createElement('div');
  ctl.className = 'set-ctl';
  const input = document.createElement('input');
  input.className = 'mono';
  input.type = 'number';
  input.min = '1';
  input.style.maxWidth = '110px';
  input.placeholder = t('pm_limit_ph');
  const key = provider.name + ':*';
  const configured = ((state.editable && state.editable.limits) || []).find((entry) => entry.key === key);
  if (configured) input.value = configured.limit;
  input.onchange = async () => {
    input.disabled = true;
    try {
      if (!input.value.trim()) {
        await api('api/limits', { method: 'POST', body: JSON.stringify({ action: 'delete', key }) });
        toast(t('limit_deleted', { key }), 'good');
      } else {
        const limit = Number(input.value);
        if (!Number.isFinite(limit) || limit <= 0) { toast(t('limit_need'), 'err'); return; }
        await api('api/limits', { method: 'POST', body: JSON.stringify({ action: 'set', key, limit }) });
        toast(t('limit_set', { key }), 'good');
      }
      await load();
      refresh();
    } catch (error) {
      toast(String(error.message || error), 'err');
    } finally {
      input.disabled = false;
    }
  };
  ctl.appendChild(input);
  wrap.append(text, ctl);
  return wrap;
}

function modelWarning(cls) {
  return cls === 'unknown' ? t('unknown_model_warning') : t('paid_model_warning');
}

function saveProviderModels(provider, { freeModels, selectedModels }, refresh) {
  return api('api/providers', {
    method: 'POST',
    body: JSON.stringify({
      action: 'update',
      name: provider.name,
      ...(freeModels === undefined ? {} : { freeModels }),
      ...(selectedModels === undefined ? {} : { selectedModels }),
    }),
  }).then(async () => {
    toast(t('saved'), 'good');
    await load();
    refresh();
  });
}

// One table for every model of a provider: catalog rows plus explicitly
// selected ids. Free rows decided by the rules are checked and locked; paid
// and unknown rows need a confirmation before they join the pool.
function buildModelTable(provider, refresh) {
  const wrap = document.createElement('div');
  wrap.id = 'prov-model-table';
  const detail =
    ((state.editable && state.editable.providers) || []).find((entry) => entry.name === provider.name) || {};
  const priced = detail.pricing === true;
  const members = new Map((provider.models || []).map((entry) => [entry.id, entry]));
  const ids = [];
  for (const id of provider.catalogIds || []) if (!ids.includes(id)) ids.push(id);
  for (const id of provider.models || []) if (!ids.includes(id.id)) ids.push(id.id);
  for (const id of detail.selectedModels || []) if (!ids.includes(id)) ids.push(id);

  if (priced) {
    const note = document.createElement('p');
    note.className = 'note';
    note.textContent = t('paid_model_warning');
    wrap.appendChild(note);
  }
  if ((provider.models || []).some((entry) => entry.unknown) || (provider.catalogClasses && Object.values(provider.catalogClasses).includes('unknown'))) {
    const note = document.createElement('p');
    note.className = 'note';
    note.textContent = t('unknown_model_warning');
    wrap.appendChild(note);
  }

  const rows = ids.map((id) => {
    const member = members.get(id);
    const catalogClass = (provider.catalogClasses || {})[id];
    // Without a usable key the provider contributes no pool entries, but the
    // allowlist and selections are still configured and must show as such.
    const configuredFree = !priced && (detail.freeModels || []).includes(id);
    const configuredSelected = (detail.selectedModels || []).includes(id);
    const sourceKind = member?.source || (configuredFree ? 'allowlist' : configuredSelected ? 'selected' : '');
    // An id the pool did not admit is not known to be free, even when its
    // catalog row claims zero: a probe or an exclusion kept it out.
    const cls = member
      ? member.free
        ? 'free'
        : member.unknown
          ? 'unknown'
          : 'paid'
      : configuredFree
        ? 'free'
        : catalogClass === 'paid'
          ? 'paid'
          : 'unknown';
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.checked = Boolean(member) || configuredFree || configuredSelected;
    const locked = Boolean(member && member.free && member.source === 'auto');
    box.disabled = locked;
    box.title = locked ? t('pm_locked_hint') : '';
    box.onchange = async () => {
      box.disabled = true;
      const freeModels = [...(detail.freeModels || [])];
      const selectedModels = [...(detail.selectedModels || [])];
      try {
        if (!box.checked) {
          if (sourceKind === 'allowlist') {
            await saveProviderModels(provider, { freeModels: freeModels.filter((entry) => entry !== id) }, refresh);
          } else if (sourceKind === 'selected') {
            await saveProviderModels(provider, { selectedModels: selectedModels.filter((entry) => entry !== id) }, refresh);
          } else {
            // A free model that was auto-discovered cannot be removed; the
            // rules would put it straight back.
            box.checked = true;
          }
        } else if (!priced && cls === 'free') {
          await saveProviderModels(provider, { freeModels: [...new Set([...freeModels, id])] }, refresh);
        } else {
          if (!confirm(modelWarning(cls) + '\\n\\n' + provider.name + ':' + id)) {
            box.checked = false;
            return;
          }
          await saveProviderModels(provider, { selectedModels: [...new Set([...selectedModels, id])] }, refresh);
        }
      } catch (error) {
        box.checked = !box.checked;
        toast(String(error.message || error), 'err');
      } finally {
        box.disabled = locked;
      }
    };

    const stateCell = document.createElement('span');
    if (member?.blockedUntil) {
      stateCell.appendChild(pill(t('st_blocked', { at: new Date(member.blockedUntil).toLocaleString(lang) }), 'bad'));
    } else if (member?.cooldownSeconds > 0) {
      stateCell.appendChild(pill(t('st_cooldown', { n: member.cooldownSeconds }), 'warn'));
    } else if (!provider.configured) {
      stateCell.appendChild(pill(t('st_nokey'), 'no'));
    } else if (member) {
      stateCell.appendChild(pill(t('st_ready'), 'ok'));
    } else {
      stateCell.appendChild(pill(t('st_not_selected'), 'no'));
    }

    const label =
      cls === 'free' ? pill(t('st_free'), 'ok') : cls === 'paid' ? pill(t('st_paid'), 'warn') : pill(t('st_unknown'), 'no');
    const source =
      sourceKind === 'auto'
        ? t('st_auto')
        : sourceKind === 'allowlist'
          ? t('st_allowlist')
          : sourceKind === 'selected'
            ? t('st_selected')
            : '-';
    const limit = document.createElement('input');
    limit.className = 'mono';
    limit.type = 'number';
    limit.min = '1';
    limit.style.maxWidth = '90px';
    limit.placeholder = t('pm_limit_ph');
    if (member?.dailyLimit) limit.value = member.dailyLimit;
    limit.title = member?.dailyLimitSource ? t('score_source', { source: member.dailyLimitSource }) : '';
    const limitKey = provider.name + ':' + id;
    limit.onchange = async () => {
      limit.disabled = true;
      try {
        if (!limit.value.trim()) {
          await api('api/limits', { method: 'POST', body: JSON.stringify({ action: 'delete', key: limitKey }) });
          toast(t('limit_deleted', { key: limitKey }), 'good');
        } else {
          const value = Number(limit.value);
          if (!Number.isFinite(value) || value <= 0) { toast(t('limit_need'), 'err'); return; }
          await api('api/limits', { method: 'POST', body: JSON.stringify({ action: 'set', key: limitKey, limit: value }) });
          toast(t('limit_set', { key: limitKey }), 'good');
        }
        await load();
        refresh();
      } catch (error) {
        toast(String(error.message || error), 'err');
      } finally {
        limit.disabled = false;
      }
    };

    return [
      td(box),
      td(id, 'mono'),
      td(label),
      td(source, 'muted'),
      td(stateCell),
      td(limit),
    ];
  });

  if (ids.length) {
    wrap.appendChild(
      table(
        [
          { label: t('pm_on') },
          { label: t('pm_model') },
          { label: t('pm_label') },
          { label: t('pm_source') },
          { label: t('pm_state') },
          { label: t('pm_limit') },
        ],
        rows,
      ),
    );
  } else {
    const empty = document.createElement('p');
    empty.className = 'note';
    empty.textContent = t('prov_no_catalog');
    wrap.appendChild(empty);
  }

  const row = document.createElement('div');
  row.className = 'row';
  const field = document.createElement('input');
  field.className = 'mono';
  field.placeholder = t('fm_add_ph');
  field.style.flex = '1';
  field.style.minWidth = '220px';
  const fetchBtn = document.createElement('button');
  fetchBtn.textContent = t('prov_fetch');
  fetchBtn.onclick = async () => {
    // The provider is already registered, so the server uses its stored keys:
    // a listing endpoint that requires auth would otherwise answer 401 to a
    // request carrying only a base URL.
    fetchBtn.disabled = true;
    try {
      const result = await api('api/providers', {
        method: 'POST',
        body: JSON.stringify({ action: 'fetch-models', provider: provider.name }),
      });
      if (!result.models.length) toast(t('prov_no_catalog'), 'err');
      await load();
      refresh();
    } catch (error) {
      toast(String(error.message || error), 'err');
    } finally {
      fetchBtn.disabled = false;
    }
  };
  const add = document.createElement('button');
  add.className = 'primary';
  add.textContent = t('fm_add');
  add.onclick = async () => {
    const typed = field.value.split(',').map((s) => s.trim()).filter(Boolean);
    if (!typed.length) return;
    if (priced) {
      if (!confirm(modelWarning('unknown') + '\\n\\n' + typed.join('\\n'))) return;
      add.disabled = true;
      try {
        await saveProviderModels(
          provider,
          { selectedModels: [...new Set([...(detail.selectedModels || []), ...typed])] },
          refresh,
        );
        field.value = '';
      } catch (error) {
        toast(String(error.message || error), 'err');
      } finally {
        add.disabled = false;
      }
    } else {
      add.disabled = true;
      try {
        await saveProviderModels(
          provider,
          { freeModels: [...new Set([...(detail.freeModels || []), ...typed])] },
          refresh,
        );
        field.value = '';
      } catch (error) {
        toast(String(error.message || error), 'err');
      } finally {
        add.disabled = false;
      }
    }
  };
  row.append(field, fetchBtn, add);
  wrap.appendChild(row);
  return wrap;
}

function renderGateway() {
  const host = el('gateway');
  host.textContent = '';
  const keys = (state.gateway && state.gateway.keys) || [];
  if (!keys.length) {
    const p = document.createElement('p');
    p.className = 'note';
    p.style.margin = '0';
    p.textContent = t('gw_no_keys');
    host.appendChild(p);
  } else {
    host.appendChild(table(
      [{ label: t('gw_th_name') }, { label: t('gw_th_key') }, { label: t('gw_th_created') }, { label: '' }],
      keys.map((entry) => {
        const del = document.createElement('button');
        del.className = 'quiet danger';
        del.textContent = t('del');
        del.onclick = async () => {
          if (!confirm(t('gw_confirm_del', { n: entry.name }))) return;
          del.disabled = true;
          try {
            await api('api/gateway-keys', {
              method: 'POST',
              body: JSON.stringify({ action: 'delete', name: entry.name }),
            });
            toast(t('gw_deleted', { n: entry.name }), 'good');
            await load();
          } catch (error) {
            toast(String(error.message || error), 'err');
            del.disabled = false;
          }
        };
        return [
          td(entry.name),
          td(entry.masked, 'mono'),
          td(entry.createdAt ? entry.createdAt.slice(0, 10) : '—'),
          td(del),
        ];
      }),
    ));
  }
  el('gw-require').checked = Boolean(state.gateway && state.gateway.requireAuth);
  el('gw-note').textContent = keys.length
    ? 'Clients call: curl -H "Authorization: Bearer <key>" ' + gatewayEndpoint() + '/chat/completions' + ' (or /responses)'
    : '';
}

function isLanOpen(host) {
  const value = String(host || '').trim().toLowerCase();
  if (!value) return false;
  return value !== '127.0.0.1' && value !== 'localhost' && value !== '::1';
}

function renderLanAddrs(lanOn) {
  const slot = el('srv-lan-addrs');
  slot.textContent = '';
  // Reaching the UI over the LAN means every byte — the admin password, gateway
  // keys, prompts and answers — crosses the network in clear text. Say so where
  // the switch is, since that is the moment the trade-off is made.
  const insecure = el('srv-lan-insecure');
  if (insecure) {
    insecure.hidden = !lanOn;
    insecure.textContent = lanOn ? t('srv_lan_insecure') : '';
  }
  const port = state.server.runningPort || state.server.port || '';
  const lan = state.server.lan || { addresses: [], hostname: '', inDocker: false };
  const line = (text, cls) => {
    const p = document.createElement('div');
    if (cls) p.className = cls;
    p.textContent = text;
    slot.appendChild(p);
  };
  if (!lanOn) {
    line(t('srv_lan_off') + ' http://127.0.0.1:' + port + ' http://localhost:' + port);
    return;
  }
  const addrs = [...lan.addresses, '127.0.0.1', 'localhost']
    .map((addr) => 'http://' + addr + ':' + port)
    .join(' ');
  line(t('srv_lan_on') + ' ' + addrs + (lan.hostname ? ' (hostname: ' + lan.hostname + ')' : ''));
  if (lan.inDocker) line(t('srv_lan_docker'));
  if (!state.gateway || !(state.gateway.keys || []).length) line(t('srv_lan_nokey'), 'warn');
}

function renderServer() {
  el('server-blurb').textContent =
    'Config: ' + state.configFile + ' (' + state.configFormat + '). Running on ' + state.server.runningHost + ':' + state.server.runningPort + '.';
  el('srv-lan').checked = isLanOpen(state.server.host);
  el('srv-port').value = state.server.port || '';
  renderLanAddrs(el('srv-lan').checked);
}

let activeTab = 'status';

function switchTab(name) {
  activeTab = name;
  for (const button of document.querySelectorAll('#tabs button')) {
    button.classList.toggle('active', button.dataset.tab === name);
  }
  for (const pane of document.querySelectorAll('[data-pane]')) {
    pane.hidden = pane.dataset.pane !== name;
  }
}

function card(host, key, value, cls) {
  const node = document.createElement('div');
  node.className = 'card';
  const k = document.createElement('div');
  k.className = 'k';
  k.textContent = key;
  const v = document.createElement('div');
  v.className = 'v' + (cls ? ' ' + cls : '');
  if (value instanceof Node) v.appendChild(value);
  else v.textContent = value;
  node.appendChild(k);
  node.appendChild(v);
  host.appendChild(node);
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (error) {
    const area = document.createElement('textarea');
    area.value = text;
    document.body.appendChild(area);
    area.select();
    let ok = false;
    try {
      ok = document.execCommand('copy');
    } catch (ignored) {
      ok = false;
    }
    area.remove();
    return ok;
  }
}

function gotoLink(label, tab) {
  const link = document.createElement('button');
  link.className = 'linklike';
  link.textContent = label;
  link.onclick = () => switchTab(tab);
  return link;
}

// Clients call the gateway on the same origin that serves this UI, so show the
// address the admin is actually browsing. The configured bind host may be
// 0.0.0.0, which is not a routable address.
function gatewayEndpoint() {
  return location.origin + '/v1';
}

function renderStatus() {
  const host = el('status-cards');
  host.textContent = '';
  const endpoint = gatewayEndpoint();
  const endpointWrap = document.createElement('span');
  const endpointText = document.createElement('span');
  endpointText.className = 'mono';
  endpointText.textContent = endpoint + ' ';
  const copy = document.createElement('button');
  copy.className = 'iconbtn';
  copy.appendChild(svgIcon('copy'));
  copy.title = t('copy_title');
  copy.onclick = async () => {
    const ok = await copyText(endpoint);
    toast(ok ? t('copied_msg') : endpoint, ok ? 'good' : 'err');
  };
  endpointWrap.appendChild(endpointText);
  endpointWrap.appendChild(copy);
  card(host, t('card_endpoint'), endpointWrap);
  const gwCount = (state.gateway && state.gateway.keys.length) || 0;
  const gwValue = document.createElement('span');
  if (state.gateway.requireAuth) {
    gwValue.textContent = t('gw_on', { n: gwCount });
  } else {
    gwValue.textContent = (gwCount ? t('gw_off_keys') : t('gw_off')) + ' ';
    gwValue.appendChild(gotoLink(t('goto_access'), 'access'));
  }
  card(host, t('card_gateway'), gwValue, state.gateway.requireAuth ? 'ok-text' : 'warn');
  const noKey = state.providers.filter((entry) => !entry.configured).map((entry) => entry.name);
  const noKeyValue = document.createElement('span');
  if (!noKey.length) {
    noKeyValue.textContent = t('nokey_all');
  } else {
    noKeyValue.textContent = noKey.join(', ') + ' ';
    noKeyValue.appendChild(gotoLink(t('goto_providers'), 'providers'));
  }
  card(host, t('card_nokey'), noKeyValue, noKey.length ? 'warn' : 'ok-text');
  if (state.webui.defaultPassword) {
    const adminValue = document.createElement('span');
    adminValue.textContent = t('adminpw_warn') + ' ';
    adminValue.appendChild(gotoLink(t('goto_settings'), 'settings'));
    card(host, t('card_adminpw'), adminValue, 'bad-text');
  }
  el('status-blurb').textContent = t('status_blurb');
}

function renderUsage() {
  const host = el('usage');
  host.textContent = '';
  const n = state.usage.retentionDays || 7;
  el('usage-blurb').textContent = t('usage_blurb', { today: state.usage.today, tz: state.usage.timezone, n });
  const models = (state.usage.models || []).slice(0, 12);
  if (!models.length) {
    const p = document.createElement('p');
    p.className = 'note';
    p.style.margin = '0';
    p.textContent = t('usage_empty');
    host.appendChild(p);
    return;
  }
  host.appendChild(table(
    [{ label: t('th_model') }, { label: t('th_today_used'), num: true }, { label: t('th_today_ok'), num: true }, { label: t('th_today_fail'), num: true }, { label: t('th_limit'), num: true }],
    models.map((entry) => {
      const today = entry.today || {};
      const used = td(today.consumed ?? '-', 'num');
      const ok = td(today.ok ?? '-', 'num');
      ok.title = t('usage_tip_ok', { n, v: entry.ok || 0 });
      const fail = td(today.fail ?? '-', 'num');
      fail.title = t('usage_tip_fail', { n, v: entry.fail || 0 });
      return [td(entry.key, 'mono'), used, ok, fail, td(entry.dailyLimit || '-', 'num')];
    }),
  ));
}


// The request log: one row per client call, newest first. Everything here is
// metadata from /api/logs; prompts, answers, headers, and key values never
// reach this tab. All values are inserted as text, never as HTML.
let logsState = null;
let logsRefreshing = false;

function logReasonText(value, max) {
  const text = String(value || '');
  return text.length > max ? text.slice(0, max) + '…' : text;
}

// One request as three lines of plain text, in the same shape as the container
// log: the fields a bug report needs, in the order they are read. The text is
// what Copy and every export use, so what is on screen is exactly what leaves.
function logAttemptText(attempt) {
  let text = attempt.provider + ':' + attempt.model;
  if (attempt.key) text += ' [' + attempt.key + ']';
  text += ' ' + (attempt.status === null || attempt.status === undefined ? '-' : attempt.status);
  if (attempt.kind) text += ' ' + attempt.kind;
  if (attempt.reason) text += ' ' + logReasonText(attempt.reason, 200);
  text += ' ' + attempt.ms + 'ms';
  return text;
}

function logEntryText(entry) {
  const status = entry.status === null || entry.status === undefined ? '-' : entry.status;
  let head = entry.at + ' ' + entry.id + ' ' + entry.dialect + ' ' + (entry.stream ? 'stream' : 'json');
  head += ' ' + entry.outcome + ' ' + status + ' ' + entry.durationMs + 'ms';
  if (entry.firstTokenMs !== null && entry.firstTokenMs !== undefined) head += ' 1st=' + entry.firstTokenMs + 'ms';
  if (Array.isArray(entry.fields) && entry.fields.length) head += ' fields=' + entry.fields.join(',');
  const lines = [head];
  let selected = (entry.model || '-') + ' -> ';
  selected += entry.provider ? entry.provider + ':' + entry.upstreamModel : '-';
  if (entry.key) selected += ' [' + entry.key + ']';
  selected += ' finish=' + (entry.finishReason || '-');
  selected += ' tools=' + (entry.toolCalls || 0);
  selected += ' chars=' + (entry.contentChars || 0) + '/' + (entry.reasoningChars || 0);
  if (entry.reason) selected += ' reason=' + entry.reason;
  lines.push('  ' + selected);
  const attempts = Array.isArray(entry.attempts) ? entry.attempts : [];
  if (attempts.length) {
    lines.push('  ' + t('logs_tries', { n: attempts.length }) + ' ' + attempts.map(logAttemptText).join('; '));
  }
  return lines.join('\\n');
}

function logAllText() {
  const entries = (logsState && logsState.entries) || [];
  return entries.map(logEntryText).join('\\n\\n');
}

function logJsonl() {
  const entries = (logsState && logsState.entries) || [];
  return entries.map((entry) => JSON.stringify(entry)).join('\\n');
}

function logStamp() {
  return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
}

// Clipboard access needs a secure context; the gateway is usually reached over
// plain HTTP on the LAN, so keep a textarea + execCommand path for that case.
function logFallbackCopy(text) {
  const area = document.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', '');
  area.style.position = 'fixed';
  area.style.top = '-1000px';
  document.body.appendChild(area);
  area.select();
  let ok = false;
  try {
    ok = document.execCommand('copy');
  } catch {
    ok = false;
  }
  document.body.removeChild(area);
  return ok;
}

function copyLogText(text) {
  if (!text) return;
  const report = (ok) => toast(ok ? t('logs_copied') : t('logs_copy_failed'), ok ? 'good' : 'err');
  if (navigator.clipboard && window.isSecureContext) {
    navigator.clipboard.writeText(text).then(() => report(true), () => report(logFallbackCopy(text)));
    return;
  }
  report(logFallbackCopy(text));
}

function downloadLogText(filename, text, type) {
  if (!text) return;
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function logResultKind(result) {
  if (result === 'ok') return 'ok';
  if (result === 'empty' || result === 'interrupted') return 'warn';
  if (result === 'aborted' || result === 'rejected') return 'no';
  return 'bad';
}

function logAttemptsCell(entry) {
  const attempts = entry.attempts || [];
  if (!attempts.length) return td('-', 'muted');
  const cell = document.createElement('td');
  cell.style.maxWidth = '220px';
  cell.style.overflow = 'hidden';
  // The column is narrow on purpose, so the cell always truncates its lines.
  // Hovering shows every attempt in full, including the ones beyond the third
  // that only appear as "N more" below.
  cell.title = [t('logs_tries', { n: attempts.length })].concat(attempts.map(logAttemptText)).join('\\n');
  const count = document.createElement('div');
  count.textContent = t('logs_tries', { n: attempts.length });
  cell.appendChild(count);
  for (const attempt of attempts.slice(0, 3)) {
    const line = document.createElement('div');
    line.className = 'mono';
    line.style.fontSize = '11.5px';
    line.style.color = 'var(--muted)';
    line.style.whiteSpace = 'nowrap';
    line.style.overflow = 'hidden';
    line.style.textOverflow = 'ellipsis';
    let text = attempt.provider + ':' + attempt.model;
    if (attempt.key) text += ' [' + attempt.key + ']';
    text += ' · ' + (attempt.status === null || attempt.status === undefined ? '-' : attempt.status);
    if (attempt.reason) text += ' ' + logReasonText(attempt.reason, 80);
    line.textContent = text;
    line.title = logAttemptText(attempt);
    cell.appendChild(line);
  }
  if (attempts.length > 3) {
    const more = document.createElement('div');
    more.className = 'note';
    more.style.margin = '2px 0 0';
    more.textContent = t('logs_more', { n: attempts.length - 3 });
    cell.appendChild(more);
  }
  return cell;
}

function renderLogs() {
  const host = el('logs');
  const note = el('logs-note');
  host.textContent = '';
  const entries = (logsState && logsState.entries) || [];
  const capacity = (logsState && logsState.capacity) || 500;
  note.textContent = logsState ? t('logs_count', { n: entries.length, cap: capacity }) : '';
  if (!logsState) return;
  if (!entries.length) {
    const p = document.createElement('p');
    p.className = 'note';
    p.style.margin = '0';
    p.textContent = t('logs_empty');
    host.appendChild(p);
    return;
  }
  host.appendChild(table(
    [
      { label: t('th_logs_time') },
      { label: t('th_logs_dialect') },
      { label: t('th_logs_requested') },
      { label: t('th_logs_selected') },
      { label: t('th_logs_result') },
      { label: t('th_logs_duration'), num: true },
      { label: t('th_logs_first_token'), num: true },
      { label: t('th_logs_attempts') },
    ],
    entries.map((entry) => {
      const selected = entry.provider
        ? entry.provider + ':' + entry.upstreamModel + (entry.key ? ' [' + entry.key + ']' : '')
        : '-';
      const resultCell = document.createElement('td');
      resultCell.appendChild(pill(t('log_' + entry.outcome), logResultKind(entry.outcome)));
      if (entry.reason) {
        const why = document.createElement('div');
        why.className = 'note';
        why.style.margin = '3px 0 0';
        why.style.maxWidth = '160px';
        why.style.overflow = 'hidden';
        why.style.textOverflow = 'ellipsis';
        why.style.whiteSpace = 'nowrap';
        why.textContent = logReasonText(entry.reason, 120);
        why.title = String(entry.reason);
        resultCell.appendChild(why);
      }
      // What the answer was made of: an "ok" row with zero characters and a
      // tool call looks very different from one that carried text.
      if (entry.finishReason || entry.toolCalls || entry.contentChars) {
        const shape = document.createElement('div');
        shape.className = 'note';
        shape.style.margin = '3px 0 0';
        shape.style.maxWidth = '160px';
        shape.style.overflow = 'hidden';
        shape.style.textOverflow = 'ellipsis';
        shape.style.whiteSpace = 'nowrap';
        shape.textContent = t('logs_answer', {
          finish: entry.finishReason || '-',
          tools: entry.toolCalls || 0,
          chars: entry.contentChars || 0,
        });
        resultCell.appendChild(shape);
      }
      return [
        td(new Date(entry.at).toLocaleString(lang), 'muted'),
        td(entry.dialect, 'muted'),
        td(entry.model || '-', 'mono'),
        td(selected, 'mono'),
        resultCell,
        td(entry.durationMs, 'num'),
        td(entry.firstTokenMs === null || entry.firstTokenMs === undefined ? '-' : entry.firstTokenMs, 'num'),
        logAttemptsCell(entry),
      ];
    }),
  ));
}

async function refreshLogs(silent) {
  if (logsRefreshing) return;
  logsRefreshing = true;
  try {
    logsState = await api('api/logs');
    renderLogs();
  } catch (error) {
    if (!silent) toast(String(error.message || error), 'err');
  } finally {
    logsRefreshing = false;
  }
}

async function clearLogs() {
  if (!confirm(t('logs_clear_confirm'))) return;
  try {
    await api('api/logs', { method: 'DELETE' });
    await refreshLogs(true);
    toast(t('logs_cleared'), 'good');
  } catch (error) {
    toast(String(error.message || error), 'err');
  }
}

// The pool is the whole routing truth now: free models in ranking order, then
// the paid models that only a request naming them can use.
function poolTable(entries) {
  return table(
    [
      { label: t('th_num'), num: true },
      { label: t('th_status') },
      { label: t('th_provider') },
      { label: t('th_model') },
      { label: t('th_score'), num: true },
      { label: t('th_used'), num: true },
    ],
    entries.map((entry) => {
      let status = t('st_ready');
      let kind = 'ok';
      if (entry.blockedUntil) {
        status = t('st_blocked', { at: new Date(entry.blockedUntil).toLocaleString(lang) });
        kind = 'bad';
      } else if (entry.cooldownSeconds > 0) {
        status = t('st_cooldown', { n: entry.cooldownSeconds });
        kind = 'warn';
      }
      const used = entry.usage ? entry.usage.today.consumed : 0;
      const scoreCell = td(
        Number.isFinite(entry.score) && entry.score >= 0 ? String(entry.score) : '-',
        'num',
      );
      scoreCell.title = t('score_source', { source: entry.scoreSource });
      return [
        td(String(entry.priority), 'num'),
        td(pill(status, kind)),
        td(entry.provider, 'muted'),
        td(entry.id + (entry.pinned ? '  *' : ''), 'mono'),
        scoreCell,
        td(used || '-', 'num'),
      ];
    }),
  );
}

function renderPool() {
  const host = el('pool');
  host.textContent = '';
  el('pool-blurb').textContent = t('pool_blurb', {
    today: state.usage.today,
    tz: state.usage.timezone,
  });
  const pool = state.pool || { free: [], paid: [] };
  host.appendChild(poolTable(pool.free || []));

  const paidTitle = document.createElement('h4');
  paidTitle.textContent = t('pool_paid_title');
  host.appendChild(paidTitle);
  const paidNote = document.createElement('p');
  paidNote.className = 'note';
  paidNote.textContent = t('pool_paid_note');
  host.appendChild(paidNote);
  if ((pool.paid || []).length) {
    host.appendChild(poolTable(pool.paid));
  } else {
    const empty = document.createElement('p');
    empty.className = 'note';
    empty.style.margin = '0';
    empty.textContent = t('pool_paid_empty');
    host.appendChild(empty);
  }

  const note = document.createElement('p');
  note.className = 'note';
  note.textContent = t('pinned_note');
  host.appendChild(note);

  if (state.unavailableModels && state.unavailableModels.length) {
    const gone = document.createElement('p');
    gone.className = 'note';
    gone.appendChild(pill(t('withdrawn'), 'warn'));
    gone.appendChild(document.createTextNode(' ' + t('withdrawn_note') + ' '));
    const ids = document.createElement('span');
    ids.className = 'mono';
    ids.textContent = state.unavailableModels.join(', ');
    gone.appendChild(ids);
    host.appendChild(gone);
  }

  for (const entry of state.excludedByProvider || []) {
    const line = document.createElement('p');
    line.className = 'note';
    line.appendChild(pill(t('notfree_badge'), 'bad'));
    line.appendChild(document.createTextNode(' '));
    const id = document.createElement('span');
    id.className = 'mono';
    id.textContent = entry.key;
    line.appendChild(id);
    line.appendChild(document.createTextNode(' ' + t('notfree_mid') + ' ' + entry.reason + t('notfree_end')));
    host.appendChild(line);
  }
}

function renderDiscovery() {
  const disc = state.editable.discovery || {};
  el('disc-enabled').checked = Boolean(disc.enabled);
  el('disc-eval').checked = Boolean(disc.evaluationEnabled);
  el('disc-interval').value = disc.intervalHours;
  el('disc-note').textContent = t('disc_note');

  const progress = el('disc-progress');
  progress.textContent = '';
  const probing = (state.providers || []).filter(
    (provider) => provider.probing || (provider.probePending || 0) > 0,
  );
  if (probing.length) {
    const line = document.createElement('p');
    line.className = 'note';
    line.style.margin = '0';
    const pending = probing.reduce((sum, provider) => sum + (provider.probePending || 0), 0);
    line.textContent =
      t('disc_probing', { p: probing.map((provider) => provider.name).join(', ') }) +
      (pending ? ' ' + t('disc_probe_pending', { n: pending }) : '');
    progress.appendChild(line);
  }

  const host = el('pinned-list');
  host.textContent = '';
  for (const model of disc.pinnedModels || []) {
    const chip = document.createElement('span');
    chip.className = 'chip';
    const id = document.createElement('span');
    id.className = 'mono';
    id.textContent = model;
    const rm = document.createElement('button');
    rm.className = 'danger';
    rm.appendChild(svgIcon('x'));
    rm.onclick = async () => {
      try {
        await api('api/discovery', { method: 'POST', body: JSON.stringify({ unpin: model }) });
        toast(t('unpinned_msg', { m: model }), 'good');
        await load();
      } catch (error) {
        toast(String(error.message || error), 'err');
      }
    };
    chip.appendChild(id);
    chip.appendChild(rm);
    host.appendChild(chip);
  }
}

function renderMigration() {
  const banner = el('migrate-banner');
  const summary = state.migration;
  const movedProviders = summary && summary.providers ? Object.entries(summary.providers) : [];
  const movedGateway = summary ? Number(summary.gateway || 0) : 0;
  if (!summary || summary.empty || (!movedProviders.length && !movedGateway)) {
    banner.hidden = true;
    banner.textContent = '';
    return;
  }
  banner.hidden = false;
  banner.textContent = '';
  const text = document.createElement('span');
  text.textContent = t('mig_text', {
    p: movedProviders.map(([name, count]) => name + '×' + count).join(', '),
    g: movedGateway ? t('mig_gw') : '',
  });
  const dismiss = document.createElement('button');
  dismiss.textContent = t('mig_dismiss');
  dismiss.onclick = async () => {
    try {
      await api('api/settings', { method: 'POST', body: JSON.stringify({ dismissMigrationNotice: true }) });
      await load();
    } catch (error) {
      toast(String(error.message || error), 'err');
    }
  };
  banner.appendChild(text);
  banner.appendChild(dismiss);
}

const SESS_PRESETS = [
  [1, 'sess_p1h'],
  [12, 'sess_p12h'],
  [24, 'sess_p24h'],
  [168, 'sess_p7d'],
  [720, 'sess_p30d'],
  [0, 'sess_pnever'],
];

// Custom choice resolves through a prompt and is kept here until saved,
// because there is no text input anymore.
let sessCustomHours = null;

function renderSession() {
  const select = el('sess-preset');
  select.textContent = '';
  for (const [hours, labelKey] of SESS_PRESETS) {
    const option = document.createElement('option');
    option.value = String(hours);
    option.textContent = t(labelKey);
    select.appendChild(option);
  }
  const custom = document.createElement('option');
  custom.value = 'custom';
  custom.textContent = t('sess_pcustom');
  select.appendChild(custom);
  const current = String(state.webui.sessionTtlHours);
  if (SESS_PRESETS.some(([hours]) => String(hours) === current)) {
    sessCustomHours = null;
    select.value = current;
  } else {
    sessCustomHours = Number(state.webui.sessionTtlHours);
    select.value = 'custom';
  }
  el('sess-note').textContent = state.webui.sessionExpiresAt
    ? t('sess_expires', { at: state.webui.sessionExpiresAt })
    : t('sess_never');
  const changedAt = state.webui.passwordChangedAt;
  el('admin-pw-changed').textContent = changedAt
    ? t('admin_pw_changed', { at: new Date(changedAt).toLocaleString() })
    : t('admin_pw_never');
}

/* ===== Timezone combobox =====
   A plain <select> of ~420 IANA zones is unusable by scrolling, and a free-text
   box let typos through to the config where they only surfaced in the log after
   a restart. Type to filter, arrows to move, Enter to commit. The value only
   has to be a zone the server accepts, so an uncommitted filter text never
   counts as a choice — Esc or blur puts the stored zone back. */
const FR_TZ = (window.FR_TZ && window.FR_TZ.zones) || ['UTC'];
let tzActive = -1;
let tzMatches = [];
let tzCommitted = '';
// Formatters are the expensive part of an offset label, and a zone's offset
// only changes at a DST boundary. One formatter per zone, built on demand.
const tzFormatters = new Map();

function tzOffsetLabel(zone) {
  if (zone === 'UTC') return 'UTC';
  try {
    let formatter = tzFormatters.get(zone);
    if (!formatter) {
      formatter = new Intl.DateTimeFormat('en-US', { timeZone: zone, timeZoneName: 'shortOffset' });
      tzFormatters.set(zone, formatter);
    }
    const parts = formatter.formatToParts(new Date());
    return parts.find((part) => part.type === 'timeZoneName').value || '';
  } catch (error) {
    return '';
  }
}

// Lowercased, and with "/" and "_" collapsed to a space so "los angel" finds
// America/Los_Angeles as readily as "america/".
function tzFold(text) {
  return String(text).toLowerCase().replace(/[/_]+/g, ' ').replace(/\s+/g, ' ').trim();
}

// Both the label styling and the per-keystroke filter use these, so they are
// folded once rather than on every render.
function tzOptions() {
  if (tzOptions.cache) return tzOptions.cache;
  tzOptions.cache = [
    // Empty is a real setting — "use this machine's dates" — so it needs an
    // entry of its own, or the picker would make that choice unreachable. The
    // English words ride along in the search field: zone ids are English, so
    // typing "local" must find it even when the label is shown in Chinese.
    { zone: '', label: t('tz_local'), search: 'server local time' },
    ...FR_TZ.map((zone) => ({ zone, label: zone, search: tzFold(zone) })),
  ];
  return tzOptions.cache;
}

function tzRender(query) {
  const list = el('set-timezone-list');
  const needle = tzFold(query);
  tzMatches = tzOptions().filter((option) =>
    !needle || option.search.indexOf(needle) !== -1 || tzFold(option.label).indexOf(needle) !== -1);
  // A zone filtered out by a stale query must not swallow the keyboard cursor.
  tzActive = tzMatches.length ? 0 : -1;
  list.textContent = '';
  if (!tzMatches.length) {
    const empty = document.createElement('li');
    empty.className = 'empty';
    empty.textContent = t('tz_none', { q: query });
    list.appendChild(empty);
    el('set-timezone').removeAttribute('aria-activedescendant');
    return;
  }
  // One fragment, one reflow: appending 420 options one at a time is the
  // difference between an instant popup and a visible stall.
  const fragment = document.createDocumentFragment();
  tzMatches.forEach((option, index) => {
    const item = document.createElement('li');
    item.id = 'set-timezone-opt-' + index;
    item.setAttribute('role', 'option');
    item.setAttribute('aria-selected', option.zone === tzCommitted ? 'true' : 'false');
    item.dataset.zone = option.zone;
    item.textContent = option.zone ? option.zone : option.label;
    // The offset follows DST, so it is read when the row is drawn rather than
    // baked into the list — see tzFillOffsets.
    if (option.zone) item.dataset.offset = '1';
    fragment.appendChild(item);
  });
  list.appendChild(fragment);
  tzScheduleOffsets(list);
  tzMarkActive();
}

// The first render of the full list costs ~200ms, almost all of it building the
// formatters behind the offset labels. Paint the zone ids immediately and let
// the offsets arrive a frame later: the list is usable in the meantime.
function tzScheduleOffsets(list) {
  if (tzScheduleOffsets.pending) return;
  tzScheduleOffsets.pending = requestAnimationFrame(() => {
    tzScheduleOffsets.pending = 0;
    if (!list.hidden) tzFillOffsets(list);
  });
}

// Building a formatter per zone costs ~150ms for the full list, which is a
// visible stall when the picker opens. Only rows near the visible window get
// one, so the work is proportional to what the operator can actually see.
const TZ_OFFSET_MARGIN = 20;
function tzFillOffsets(list) {
  const items = list.children;
  const rowHeight = items.length ? items[0].getBoundingClientRect().height || 30 : 30;
  if (!rowHeight) return;
  // Rows only need a label once they are near the visible window, including
  // the part that is one scroll away.
  const top = Math.max(0, Math.floor(list.scrollTop / rowHeight) - TZ_OFFSET_MARGIN);
  const visible = Math.ceil((list.clientHeight || 260) / rowHeight) + TZ_OFFSET_MARGIN * 2;
  for (let index = top; index < Math.min(items.length, top + visible); index += 1) {
    const item = items[index];
    if (!item || !item.dataset.offset || item.querySelector('.off')) continue;
    const offset = tzOffsetLabel(item.dataset.zone);
    if (!offset || offset === item.dataset.zone) continue;
    const tag = document.createElement('span');
    tag.className = 'off';
    tag.textContent = '  ' + offset;
    item.appendChild(tag);
  }
}

// Only ever called on a list that has entries: tzRender clears the attribute
// when it renders the "no match" row.
function tzMarkActive() {
  const list = el('set-timezone-list');
  [...list.children].forEach((item, index) => {
    const on = index === tzActive;
    if (on) item.dataset.active = 'true'; else delete item.dataset.active;
  });
  const input = el('set-timezone');
  if (tzActive >= 0 && tzMatches[tzActive]) {
    input.setAttribute('aria-activedescendant', 'set-timezone-opt-' + tzActive);
    const item = list.children[tzActive];
    if (item && item.scrollIntoView) item.scrollIntoView({ block: 'nearest' });
  } else {
    input.removeAttribute('aria-activedescendant');
  }
}

function tzOpen() {
  const list = el('set-timezone-list');
  if (!list) return;
  if (list.hidden) list.hidden = false;
  el('set-timezone').setAttribute('aria-expanded', 'true');
  // Fit on every open, not only the first: the page may have been resized or
  // flipped to RTL since, and a popup that fit then can overflow now.
  tzFit();
}

// The popup is wider than its input, so in a narrow pane — or on the RTL side
// of one — growing from the inline start would push it off screen. Flip it to
// the input's other edge before shrinking it: a 400-entry list is not worth
// reading at half width.
function tzFit() {
  const list = el('set-timezone-list');
  const margin = 8;
  list.style.maxWidth = '';
  list.style.insetInlineStart = '';
  list.style.insetInlineEnd = '';
  const first = list.getBoundingClientRect();
  if (first.left >= margin && first.right <= window.innerWidth - margin) return;
  list.style.insetInlineStart = 'auto';
  list.style.insetInlineEnd = '0';
  const flipped = list.getBoundingClientRect();
  if (flipped.left >= margin && flipped.right <= window.innerWidth - margin) return;
  // Neither edge fits: anchor as before and let it scroll internally.
  list.style.insetInlineStart = '0';
  list.style.insetInlineEnd = 'auto';
  list.style.maxWidth = Math.max(160, window.innerWidth - margin * 2) + 'px';
}

function tzClose() {
  const list = el('set-timezone-list');
  if (!list) return;
  list.hidden = true;
  el('set-timezone').setAttribute('aria-expanded', 'false');
  el('set-timezone').removeAttribute('aria-activedescendant');
}

function tzChoose(zone) {
  tzCommitted = zone;
  tzShowCommitted();
  tzClose();
}

// Empty means "this machine", and there is no IANA id to show for it, so the
// empty state has to be named somewhere or it just looks unset.
function tzShowCommitted() {
  const input = el('set-timezone');
  input.value = tzCommitted;
  input.placeholder = tzCommitted ? t('tun_timezone_ph') : t('tz_local');
}

function tzBind() {
  const input = el('set-timezone');
  const list = el('set-timezone-list');
  if (!input || !list || tzBind.done) return;
  tzBind.done = true;
  input.onfocus = () => {
    input.select();
    tzRender('');
    tzOpen();
  };  input.oninput = () => {
    tzRender(input.value);
    tzOpen();
  };
  input.onkeydown = (event) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      if (list.hidden) { tzRender(input.value); tzOpen(); }
      if (!tzMatches.length) return;
      event.preventDefault();
      const step = event.key === 'ArrowDown' ? 1 : -1;
      tzActive = (tzActive + step + tzMatches.length) % tzMatches.length;
      tzMarkActive();
      return;
    }
    if (event.key === 'Enter') {
      if (list.hidden || tzActive < 0 || !tzMatches[tzActive]) return;
      event.preventDefault();
      tzChoose(tzMatches[tzActive].zone);
      return;
    }
    if (event.key === 'Escape' && !list.hidden) {
      // Undo the filter without touching the stored setting.
      event.preventDefault();
      tzShowCommitted();
      tzClose();
    }
  };
  // mousedown, not click: the input's blur fires first and would close the
  // list out from under the pointer.
  list.onmousedown = (event) => {
    const item = event.target.closest('li[data-zone]');
    if (!item) return;
    event.preventDefault();
    tzChoose(item.dataset.zone);
  };
  // Scrolling a fresh part of the list into view is what asks for its offsets.
  list.onscroll = () => tzFillOffsets(list);
  // A reopened list may have scrolled or resized since its offsets were filled.
  list.onscrollend = () => tzFillOffsets(list);
  input.onblur = () => {
    // A half-typed filter is not a setting: restore what is actually stored.
    tzShowCommitted();
    tzClose();
  };
  // Clicking anywhere else is also a dismiss, including the rest of the page.
  document.addEventListener('mousedown', (event) => {
    if (list.hidden) return;
    if (event.target === input || list.contains(event.target)) return;
    tzShowCommitted();
    tzClose();
  });
}

function renderTuning() {
  const general = state.editable.general;
  el('set-timeout').value = general.attemptTimeoutMs;
  el('set-refresh').value = general.catalogRefreshMs;
  el('set-redact').checked = Boolean(general.redactSecrets);
  el('set-socks').value = (general.socksFirstHosts || []).join(', ');
  const select = el('set-default');
  select.textContent = '';
  for (const provider of state.providers) {
    const option = document.createElement('option');
    option.value = provider.name;
    option.textContent = provider.name;
    select.appendChild(option);
  }
  select.value = general.defaultProvider;
  el('set-retention').value = general.retentionDays;
  // The stored zone may be empty (meaning "this machine") or a zone the
  // shipped list does not carry; both must show as-is rather than as a blank
  // box that looks unset.
  tzCommitted = general.timezone || '';
  tzBind();
  tzShowCommitted();
  tzClose();
}

function bindOnce() {
  if (bindOnce.done) return;
  bindOnce.done = true;
  for (const button of document.querySelectorAll('#tabs button')) {
    button.onclick = () => {
      switchTab(button.dataset.tab);
      // Fetch on first visit; the interval keeps it fresh while visible.
      if (button.dataset.tab === 'logs') refreshLogs(true);
    };
  }
  el('logs-refresh').onclick = () => refreshLogs(false);
  el('logs-copy').onclick = () => copyLogText(logAllText());
  el('logs-export-jsonl').onclick = () =>
    downloadLogText('free-router-logs-' + logStamp() + '.jsonl', logJsonl(), 'application/x-ndjson');
  el('logs-export-text').onclick = () =>
    downloadLogText('free-router-logs-' + logStamp() + '.log', logAllText(), 'text/plain');
  el('logs-clear').onclick = () => clearLogs();
  el('lang').onchange = () => setLang(el('lang').value);
  el('theme-btn').onclick = cycleTheme;
  applyTheme();
  el('provider-modal-x').onclick = closeProviderModal;
  el('provider-modal').addEventListener('mousedown', (e) => { if (e.target.id === 'provider-modal') closeProviderModal(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !el('provider-modal').hidden) closeProviderModal(); });
  const doLogout = async () => {
    try { await api('api/logout', { method: 'POST' }); } catch (error) { /* ignore */ }
    showLogin();
  };
  el('logout').onclick = doLogout;
  el('logout-top').onclick = doLogout;
  el('gw-create').onclick = async () => {
    const label = el('gw-name').value.trim();
    if (!label) { toast(t('gw_name_need'), 'err'); return; }
    try {
      const result = await api('api/gateway-keys', {
        method: 'POST',
        body: JSON.stringify({ action: 'create', name: label }),
      });
      el('gw-name').value = '';
      prompt(t('gw_copy_once'), result.key);
      toast(t('gw_created', { n: label }), 'good');
      await load();
    } catch (error) {
      toast(String(error.message || error), 'err');
    }
  };
  el('gw-require').onchange = async () => {
    const want = el('gw-require').checked;
    if (want && !((state.gateway && state.gateway.keys) || []).length) {
      el('gw-require').checked = false;
      toast(t('gw_need_key'), 'err');
      return;
    }
    try {
      await api('api/gateway-keys', {
        method: 'POST',
        body: JSON.stringify({ action: 'setRequireAuth', requireAuth: want }),
      });
      toast(want ? t('gw_on_msg') : t('gw_off_msg'), 'good');
      await load();
    } catch (error) {
      toast(String(error.message || error), 'err');
      await load();
    }
  };
  el('admin-save').onclick = async () => {
    const value = el('admin-pass').value;
    if (!value) { toast(t('admin_need'), 'err'); return; }
    try {
      await api('api/webui-password', { method: 'POST', body: JSON.stringify({ password: value }) });
      el('admin-pass').value = '';
      toast(t('admin_changed'), 'good');
      showLogin();
    } catch (error) {
      toast(String(error.message || error), 'err');
    }
  };
  el('sess-preset').onchange = () => {
    const value = el('sess-preset').value;
    if (value !== 'custom') {
      sessCustomHours = null;
      return;
    }
    const raw = prompt(t('sess_custom_prompt'), String(state.webui.sessionTtlHours));
    if (raw === null) {
      renderSession();
      return;
    }
    const hours = Number(raw);
    if (!Number.isFinite(hours) || hours < 0 || hours > 8760) {
      toast(t('sess_invalid'), 'err');
      renderSession();
      return;
    }
    sessCustomHours = hours;
  };
  el('sess-save').onclick = async () => {
    const hours = el('sess-preset').value === 'custom'
      ? sessCustomHours
      : Number(el('sess-preset').value);
    if (hours === null || !Number.isFinite(hours)) {
      toast(t('sess_invalid'), 'err');
      return;
    }
    try {
      const result = await api('api/settings', {
        method: 'POST',
        body: JSON.stringify({ sessionTtlHours: hours }),
      });
      toast(t('saved') + ((result.notes || []).length ? ' ' + result.notes.join(' ') : ''), 'good');
      await load();
    } catch (error) {
      toast(String(error.message || error), 'err');
    }
  };
  el('srv-save').onclick = async () => {
    try {
      const result = await api('api/server', {
        method: 'POST',
        body: JSON.stringify({ host: el('srv-lan').checked ? '0.0.0.0' : '127.0.0.1', port: Number(el('srv-port').value) }),
      });
      toast(t('srv_saved', { notes: (result.notes || []).join(' ') }), 'good');
      await load();
    } catch (error) {
      toast(String(error.message || error), 'err');
    }
  };
  el('srv-restart').onclick = async () => {
    if (!confirm(t('restart_confirm'))) return;
    try {
      await api('api/restart', { method: 'POST' });
      toast(t('restarting_msg'), 'good');
    } catch (error) {
      toast(String(error.message || error), 'err');
    }
  };
  el('login-go').onclick = doLogin;
  el('login-pass').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') doLogin();
  });
  el('disc-save').onclick = async () => {
    try {
      const result = await api('api/discovery', {
        method: 'POST',
        body: JSON.stringify({
          enabled: el('disc-enabled').checked,
          evaluationEnabled: el('disc-eval').checked,
          intervalHours: Number(el('disc-interval').value),
        }),
      });
      toast(t('saved') + ((result.notes || []).length ? ' ' + result.notes.join(' ') : ''), 'good');
      await load();
    } catch (error) {
      toast(String(error.message || error), 'err');
    }
  };
  el('disc-run').onclick = async () => {
    el('disc-run').disabled = true;
    try {
      const result = await api('api/discovery', {
        method: 'POST',
        body: JSON.stringify({ runNow: true }),
      });
      toast(
        t('disc_run_started') + ((result.notes || []).length ? ' ' + result.notes.join(' ') : ''),
        'good',
      );
      await load();
    } catch (error) {
      toast(String(error.message || error), 'err');
    } finally {
      el('disc-run').disabled = false;
    }
  };
  el('pin-add').onclick = async () => {
    const value = el('pin-input').value.trim();
    if (!value) return;
    try {
      await api('api/discovery', { method: 'POST', body: JSON.stringify({ pin: value }) });
      el('pin-input').value = '';
      toast(t('pinned_msg', { m: value }), 'good');
      await load();
    } catch (error) {
      toast(String(error.message || error), 'err');
    }
  };
  el('set-save').onclick = async () => {
    try {
      const result = await api('api/settings', {
        method: 'POST',
        body: JSON.stringify({
          attemptTimeoutMs: Number(el('set-timeout').value),
          catalogRefreshMs: Number(el('set-refresh').value),
          redactSecrets: el('set-redact').checked,
          defaultProvider: el('set-default').value,
          socksFirstHosts: el('set-socks').value.split(',').map((s) => s.trim()).filter(Boolean),
          retentionDays: Number(el('set-retention').value),
          // The committed choice, not whatever half-typed filter is in the box.
          timezone: tzCommitted,
        }),
      });
      toast(t('saved') + ((result.notes || []).length ? ' ' + result.notes.join(' ') : ''), 'good');
      await load();
    } catch (error) {
      toast(String(error.message || error), 'err');
    }
  };
}

async function doLogin() {
  const value = el('login-pass').value;
  if (!value) { toast(t('err_admin_pass'), 'err'); return; }
  try {
    await api('api/login', { method: 'POST', body: JSON.stringify({ password: value }) });
    el('login-pass').value = '';
    await load();
  } catch (error) {
    toast(String(error.message || error), 'err');
  }
}

function showLogin() {
  document.body.dataset.gate = '1';
  el('login').style.display = '';
  el('app').style.display = 'none';
  el('logout-top').style.display = 'none';
  state = null;
  logsState = null;
  applyI18n();
}

async function load() {
  try {
    state = await api('api/state');
  } catch (error) {
    showLogin();
    if (!String(error.message || '').includes('login')) toast(String(error.message || error), 'err');
    return;
  }
  delete document.body.dataset.gate;
  el('login').style.display = 'none';
  el('app').style.display = '';
  el('logout-top').style.display = '';
  bindOnce();
  applyI18n();
  renderAll();
}


// Status tab auto-refresh: poll /api/state every 5s while the status pane
// is visible. Skips when another tab is active (so form inputs elsewhere are
// never clobbered), when the page is hidden, when logged out, or when a
// previous poll is still in flight.
const STATUS_REFRESH_MS = 5000;
let statusRefreshing = false;
function startStatusAutoRefresh() {
  if (startStatusAutoRefresh.done) return;
  startStatusAutoRefresh.done = true;
  setInterval(async () => {
    if (activeTab !== 'status' || document.hidden || !state || statusRefreshing) return;
    statusRefreshing = true;
    try {
      await load();
    } catch (error) {
      // load() already surfaces login/toast feedback.
    } finally {
      statusRefreshing = false;
    }
  }, STATUS_REFRESH_MS);
}

// Background probing is deliberately non-blocking: a newly added provider
// drains its catalog over several batches. While it does, keep the Providers
// tab live so discovered free models appear without a reload. The modal is
// left alone; only the page state refreshes.
const PROVIDERS_REFRESH_MS = 3000;
let providersRefreshing = false;
function startProvidersAutoRefresh() {
  if (startProvidersAutoRefresh.done) return;
  startProvidersAutoRefresh.done = true;
  setInterval(async () => {
    if (activeTab !== 'providers' || document.hidden || !state || providersRefreshing) return;
    const probing = (state.providers || []).some(
      (provider) => provider.probing || (provider.probePending || 0) > 0,
    );
    if (!probing) return;
    providersRefreshing = true;
    try {
      await load();
    } catch (error) {
      // load() already surfaces login/toast feedback.
    } finally {
      providersRefreshing = false;
    }
  }, PROVIDERS_REFRESH_MS);
}

// The Logs tab refreshes itself while it is the one on screen. Like the other
// pollers it skips hidden pages, logged-out sessions, and overlapping calls.
const LOGS_REFRESH_MS = 5000;
function startLogsAutoRefresh() {
  if (startLogsAutoRefresh.done) return;
  startLogsAutoRefresh.done = true;
  setInterval(() => {
    if (activeTab !== 'logs' || document.hidden || !state || logsRefreshing) return;
    refreshLogs(true);
  }, LOGS_REFRESH_MS);
}

// Bind buttons before the first load: an unauthenticated visit fails
// /api/state and returns early, which must not leave the login button dead.
bindOnce();
startStatusAutoRefresh();
startProvidersAutoRefresh();
startLogsAutoRefresh();
load().catch((error) => toast(String(error.message || error), 'err'));
</script>
</body>
</html>
`;

export function renderPage() {
  return PAGE;
}

