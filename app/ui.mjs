import fs from 'node:fs';
import os from 'node:os';
import { LANGS, STRINGS } from './i18n.mjs';

const MAX_SECRET_LENGTH = 500;

// Language content lives in i18n.mjs; the page gets a frozen copy so the
// browser needs no module loader. `</script>` can never appear in it: values
// only use <span> markup (verified in tests via renderPage snapshot).
const I18N_PAYLOAD = JSON.stringify({ langs: LANGS, strings: STRINGS });

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
#usage, #routes, #providers, #limits-table, #gateway { overflow-x: auto; }
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
      <button data-tab="routes"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 19a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM18 7a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM9 16h6a3 3 0 0 0 3-3V8"/></svg><span data-i18n="tab_routes">Routes</span></button>
      <button data-tab="quota"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 14l4-4M3.34 19a10 10 0 1 1 17.32 0"/></svg><span data-i18n="tab_quota">Quota</span></button>
      <button data-tab="settings"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6"/></svg><span data-i18n="tab_settings">Settings</span></button>
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
        <h2 data-i18n="route_priority">Route priority</h2>
        <p id="routes-blurb"></p>
      </div>
      <div class="sec-body"><div id="routes"></div></div>
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

  <div data-pane="routes" hidden>
    <section>
      <div class="sec-head"><h2 data-i18n="routes_title">Routes</h2><p data-i18n="routes_blurb">Order the gateway tries models in. Entries are <span class="mono">provider:model</span> or plain model ids. Adding a model auto-allows it for price-free providers.</p></div>
      <div class="sec-body">
        <div class="row">
          <label><span data-i18n="route_label">Route</span> <select id="route-select"></select></label>
          <button id="route-new" data-i18n="route_new">New route</button>
          <button class="quiet" id="route-del" data-i18n="route_del">Delete route</button>
        </div>
        <div id="route-entries"></div>
        <div class="row">
          <input id="route-add" class="mono" data-i18n-ph="route_add_ph" placeholder="provider:model or model id" style="flex:1;min-width:200px">
          <button id="route-add-btn" data-i18n="route_add">Add</button>
          <button class="primary" id="route-save" data-i18n="route_save">Save route</button>
        </div>
        <p class="note" id="route-note"></p>
      </div>
    </section>
  </div>

  <div data-pane="quota" hidden>
    <section>
      <div class="sec-head"><h2 data-i18n="limits_title">Daily limits</h2><p data-i18n="limits_blurb">Config quota per model. Limits reported by the provider itself stay authoritative.</p></div>
      <div class="sec-body">
        <div id="limits-table"></div>
        <div class="row">
          <input id="limit-key" class="mono" data-i18n-ph="limit_key_ph" placeholder="provider:model" style="max-width:260px">
          <input id="limit-val" class="mono" data-i18n-ph="limit_val_ph" placeholder="requests/day" style="max-width:140px">
          <button class="primary" id="limit-add" data-i18n="limit_add">Set limit</button>
        </div>
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
            <div class="set-desc" data-i18n="disc_eval_desc">Benchmark new models once before they join routes.</div>
          </div>
          <div class="set-ctl"><label class="switch"><input type="checkbox" id="disc-eval"><span class="slider"></span></label></div>
        </div>
        <div class="setrow">
          <div class="set-text">
            <div class="set-title" data-i18n="disc_provider">Provider</div>
            <div class="set-desc" data-i18n="disc_provider_desc">Which catalog to discover from.</div>
          </div>
          <div class="set-ctl"><select id="disc-provider"></select></div>
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
        </div>
        <p class="note" id="disc-note"></p>
        <div id="pinned-list"></div>
        <div class="row">
          <input id="pin-input" class="mono" data-i18n-ph="pin_ph" placeholder="pin model, e.g. gemini:gemini-3.8-flash" style="flex:1;min-width:200px">
          <button id="pin-add" data-i18n="pin_add">Pin</button>
        </div>
      </div>
    </section>
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
          <div class="set-ctl"><input id="set-timezone" class="mono" data-i18n-ph="tun_timezone_ph" placeholder="America/Los_Angeles" style="max-width:200px"></div>
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
  document.documentElement.dataset.theme = themeIsDark() ? 'dark' : 'light';
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
  renderRoutes();
  renderUsage();
  renderRouteEditor();
  renderLimits();
  renderDiscovery();
  renderTuning();
  renderMigration();
  renderSession();
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
  return { models: q(provider.modelCount), free: q(provider.freeCount) };
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
  for (const key of ['pt_name', 'pt_url', 'pt_keys', 'pt_models', 'pt_free']) {
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
    const opsTd = document.createElement('td');
    const manage = document.createElement('button');
    manage.className = 'quiet';
    manage.textContent = t('prov_manage');
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
    opsTd.appendChild(manage);
    opsTd.appendChild(del);
    tr.append(nameTd, urlTd, keysTd, modelsTd, freeTd, opsTd);
    body.appendChild(tr);
    manage.onclick = () => {
      openProviderModal('edit', provider);
      const modalBody = el('provider-modal-body');
      const curTitle = document.createElement('h4');
      curTitle.textContent = t('prov_current_models');
      modalBody.appendChild(curTitle);
      modalBody.appendChild(buildProviderDetail(provider));
      const addTitle = document.createElement('h4');
      addTitle.textContent = t('prov_add_models');
      modalBody.appendChild(addTitle);
      modalBody.appendChild(buildModelPicker(provider));
    };
  }
  el('keys-blurb').textContent = t('keys_blurb', { file: state.overlayFile, format: state.configFormat });
}

// Static fallback for presets whose sibling provider is absent (deleted or
// never configured). Live sibling data (URL, flags, catalog ids) wins
// whenever present.
const PROVIDER_PRESETS = {
  gemini: { baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', catalog: true, pricing: false },
  openrouter: { baseUrl: 'https://openrouter.ai/api/v1', catalog: true, pricing: true },
  tokenrouter: { baseUrl: 'https://api.tokenrouter.com/v1', catalog: true, pricing: false },
  bai: { baseUrl: 'https://api.b.ai/v1', catalog: true, pricing: false },
  hashneuron: { baseUrl: 'https://hashneuron.space/v1', catalog: true, pricing: false },
};

function renderModelList(box, ids, freeSet, truncated) {
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
    if (freeSet.has(id)) boxEl.checked = true;
    const text = document.createElement('span');
    text.className = 'mono';
    text.textContent = id + (freeSet.has(id) ? '' : ' ' + t('prov_paid_tag'));
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
      renderModelList(
        modelsBox,
        (result.models || []).map((m) => m.id),
        new Set((result.models || []).filter((m) => m.free).map((m) => m.id)),
        Boolean(result.truncated),
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
  r3.append(catalogLabel, catalogText, pricingLabel, pricingText);
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
    renderModelList(modelsBox, ids, new Set(sibling.catalogFreeIds || []), Boolean(sibling.catalogTruncated));
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
    renderModelChecks();
  }
  presetSelect.onchange = fillFromPreset;
  save.onclick = async () => {
    const name = nameField.value.trim().toLowerCase();
    const baseUrl = urlField.value.trim();
    if (!name || !baseUrl) { toast(t('np_need'), 'err'); return; }
    const checked = [...modelsBox.querySelectorAll('input[type="checkbox"]:checked')]
      .map((box) => box.dataset.model)
      .filter(Boolean);
    const typed = modelsField.value.split(',').map((s) => s.trim()).filter(Boolean);
    const freeModels = [...new Set([...checked, ...typed])];
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
          freeModels,
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

  const fmWrap = document.createElement('div');
  fmWrap.style.marginTop = '8px';
  const fmLabel = document.createElement('div');
  fmLabel.className = 'prov-hint';
  fmLabel.textContent = detail.pricing ? t('fm_priced') : t('fm_allow');
  fmWrap.appendChild(fmLabel);
  for (const model of detail.freeModels || []) {
    const chip = document.createElement('span');
    chip.className = 'chip';
    const id = document.createElement('span');
    id.className = 'mono';
    id.textContent = model;
    const rm = document.createElement('button');
    rm.className = 'danger';
    rm.appendChild(svgIcon('x'));
    rm.title = t('rm_model_title', { m: model });
    rm.onclick = async () => {
      try {
        await api('api/providers', {
          method: 'POST',
          body: JSON.stringify({
            action: 'update',
            name: provider.name,
            freeModels: (detail.freeModels || []).filter((entry) => entry !== model),
          }),
        });
        toast(t('removed_model', { m: model }), 'good');
        await load();
      } catch (error) {
        toast(String(error.message || error), 'err');
      }
    };
    chip.appendChild(id);
    chip.appendChild(rm);
    fmWrap.appendChild(chip);
  }
  const fmRow = document.createElement('div');
  fmRow.className = 'row';
  const fmField = document.createElement('input');
  fmField.className = 'mono';
  fmField.placeholder = t('fm_add_ph');
  fmField.style.maxWidth = '240px';
  const fmAdd = document.createElement('button');
  fmAdd.textContent = t('fm_add');
  fmAdd.onclick = async () => {
    const value = fmField.value.trim();
    if (!value) return;
    try {
      await api('api/providers', {
        method: 'POST',
        body: JSON.stringify({
          action: 'update',
          name: provider.name,
          freeModels: [...(detail.freeModels || []), value],
        }),
      });
      toast(t('added_model', { m: value }), 'good');
      await load();
    } catch (error) {
      toast(String(error.message || error), 'err');
    }
  };
  fmRow.appendChild(fmField);
  fmRow.appendChild(fmAdd);
  fmWrap.appendChild(fmRow);
  adv.appendChild(fmWrap);
  return fieldCell;
}

// Add-models picker for the edit modal: catalog checkbox list (shared
// renderModelList) plus manual entry, saved via update {freeModels:[...]}.
// Union-only: unchecking here never removes; removal stays on the × chips
// in buildProviderDetail.
function buildModelPicker(provider) {
  const wrap = document.createElement('div');
  const box = document.createElement('div');
  wrap.appendChild(box);
  const detail = (state.editable && state.editable.providers || []).find((entry) => entry.name === provider.name) || {};
  const current = new Set(detail.freeModels || []);
  const paint = (ids, freeSet, truncated) => {
    const checked = new Set(freeSet);
    for (const id of current) if (ids.includes(id)) checked.add(id);
    renderModelList(box, ids, checked, truncated);
  };
  paint(
    Array.isArray(provider.catalogIds) ? provider.catalogIds : [],
    new Set(provider.catalogFreeIds || []),
    Boolean(provider.catalogTruncated),
  );
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
    const baseUrl = (provider.baseUrl || '').trim();
    if (!baseUrl) { toast(t('np_need'), 'err'); return; }
    fetchBtn.disabled = true;
    try {
      const result = await api('api/providers', {
        method: 'POST',
        body: JSON.stringify({ action: 'fetch-models', baseUrl }),
      });
      paint(
        (result.models || []).map((m) => m.id),
        new Set((result.models || []).filter((m) => m.free).map((m) => m.id)),
        Boolean(result.truncated),
      );
      if (!result.models.length) toast(t('prov_no_catalog'), 'err');
    } catch (error) {
      toast(String(error.message || error), 'err');
    } finally {
      fetchBtn.disabled = false;
    }
  };
  const save = document.createElement('button');
  save.className = 'primary';
  save.textContent = t('fm_add');
  save.onclick = async () => {
    const checked = [...box.querySelectorAll('input[type="checkbox"]:checked')]
      .map((item) => item.dataset.model)
      .filter(Boolean);
    const typed = field.value.split(',').map((s) => s.trim()).filter(Boolean);
    const freeModels = [...new Set([...(detail.freeModels || []), ...checked, ...typed])];
    if (!freeModels.length) return;
    save.disabled = true;
    try {
      await api('api/providers', {
        method: 'POST',
        body: JSON.stringify({ action: 'update', name: provider.name, freeModels }),
      });
      toast(t('saved'), 'good');
      await load();
      closeProviderModal();
    } catch (error) {
      toast(String(error.message || error), 'err');
      save.disabled = false;
    }
  };
  row.append(field, fetchBtn, save);
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
    ? 'Clients call: curl -H "Authorization: Bearer <key>" ' + gatewayEndpoint() + '/chat/completions'
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
let draftRoute = '';
let draftEntries = [];

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

function routeStatusFor(routeName, modelString) {
  const entries = (state.allRoutes && state.allRoutes[routeName]) || [];
  const match = (entry) => {
    const id = entry.id || '';
    if (modelString.includes(':') && entry.provider) {
      return entry.provider + ':' + id === modelString;
    }
    return id === modelString || ('openrouter:' + id) === modelString;
  };
  return entries.find(match) || null;
}

function renderRouteEditor() {
  const select = el('route-select');
  const names = Object.keys(state.editable.routes || {});
  const current = names.includes(draftRoute) ? draftRoute : (state.route || names[0]);
  select.textContent = '';
  for (const name of names) {
    const option = document.createElement('option');
    option.value = name;
    option.textContent = name + (name === state.route ? t('route_disc_suffix') : '');
    select.appendChild(option);
  }
  select.value = current;
  if (draftRoute !== current) {
    draftRoute = current;
    draftEntries = [...(state.editable.routes[current] || [])];
  }
  const host = el('route-entries');
  host.textContent = '';
  draftEntries.forEach((modelString, index) => {
    const line = document.createElement('div');
    line.className = 'entry';
    const num = document.createElement('span');
    num.className = 'idx';
    num.textContent = '#' + (index + 1);
    const id = document.createElement('span');
    id.className = 'mono';
    id.textContent = modelString;
    const st = document.createElement('span');
    st.className = 'st';
    const status = routeStatusFor(current, modelString);
    if (!status) st.textContent = t('st_unsaved');
    else if (!status.providerConfigured) st.textContent = t('st_nokey');
    else if (status.zeroCost === false) st.textContent = t('st_paid');
    else if (status.cooldownSeconds > 0) st.textContent = t('st_cooldown', { n: status.cooldownSeconds });
    else st.textContent = t('st_ready');
    const up = document.createElement('button');
    up.appendChild(svgIcon('up'));
    up.title = t('route_move_up');
    up.disabled = index === 0;
    up.onclick = () => {
      draftEntries.splice(index - 1, 0, draftEntries.splice(index, 1)[0]);
      renderRouteEditor();
    };
    const down = document.createElement('button');
    down.appendChild(svgIcon('down'));
    down.title = t('route_move_down');
    down.disabled = index === draftEntries.length - 1;
    down.onclick = () => {
      draftEntries.splice(index + 1, 0, draftEntries.splice(index, 1)[0]);
      renderRouteEditor();
    };
    const rm = document.createElement('button');
    rm.className = 'danger';
    rm.appendChild(svgIcon('x'));
    rm.title = t('route_remove');
    rm.onclick = () => {
      draftEntries.splice(index, 1);
      renderRouteEditor();
    };
    line.appendChild(num);
    line.appendChild(id);
    line.appendChild(st);
    line.appendChild(up);
    line.appendChild(down);
    line.appendChild(rm);
    host.appendChild(line);
  });
  el('route-note').textContent = draftEntries.length ? t('route_unsaved_note') : t('route_empty');
}

function renderLimits() {
  const host = el('limits-table');
  host.textContent = '';
  const limits = (state.editable && state.editable.limits) || [];
  if (!limits.length) {
    const p = document.createElement('p');
    p.className = 'note';
    p.style.margin = '0';
    p.textContent = t('limits_empty');
    host.appendChild(p);
    return;
  }
  host.appendChild(table(
    [{ label: t('th_model') }, { label: t('th_limit_day'), num: true }, { label: t('th_source') }, { label: '' }],
    limits.map((entry) => {
      const del = document.createElement('button');
      del.className = 'quiet danger';
      del.textContent = t('del');
      del.onclick = async () => {
        try {
          await api('api/limits', { method: 'POST', body: JSON.stringify({ action: 'delete', key: entry.key }) });
          toast(t('limit_deleted', { key: entry.key }), 'good');
          await load();
        } catch (error) {
          toast(String(error.message || error), 'err');
        }
      };
      return [td(entry.key, 'mono'), td(String(entry.limit), 'num'), td(entry.source), td(del)];
    }),
  ));
}

function renderDiscovery() {
  const disc = state.editable.discovery;
  el('disc-enabled').checked = Boolean(disc.enabled);
  el('disc-eval').checked = Boolean(disc.evaluationEnabled);
  const providerSelect = el('disc-provider');
  providerSelect.textContent = '';
  for (const provider of state.providers) {
    const option = document.createElement('option');
    option.value = provider.name;
    option.textContent = provider.name;
    providerSelect.appendChild(option);
  }
  providerSelect.value = disc.provider;
  el('disc-interval').value = disc.intervalHours;
  el('disc-note').innerHTML = t('disc_note', { route: disc.route });
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
  el('set-timezone').value = general.timezone || '';
}

function bindOnce() {
  if (bindOnce.done) return;
  bindOnce.done = true;
  for (const button of document.querySelectorAll('#tabs button')) {
    button.onclick = () => switchTab(button.dataset.tab);
  }
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
  el('route-select').onchange = () => {
    draftRoute = el('route-select').value;
    draftEntries = [...(state.editable.routes[draftRoute] || [])];
    renderRouteEditor();
  };
  el('route-add-btn').onclick = () => {
    const value = el('route-add').value.trim();
    if (!value) return;
    if (draftEntries.includes(value)) { toast(t('route_in_list'), 'err'); return; }
    draftEntries.push(value);
    el('route-add').value = '';
    renderRouteEditor();
  };
  el('route-save').onclick = async () => {
    try {
      const result = await api('api/routes', {
        method: 'POST',
        body: JSON.stringify({ action: 'save', route: draftRoute, models: draftEntries }),
      });
      if ((result.notes || []).length) toast(result.notes.join(' '), 'good');
      toast(t('route_saved', { r: draftRoute, n: result.count }), 'good');
      await load();
    } catch (error) {
      toast(String(error.message || error), 'err');
    }
  };
  el('route-new').onclick = async () => {
    const name = prompt(t('route_new_prompt'), 'my-route');
    if (!name) return;
    try {
      await api('api/routes', { method: 'POST', body: JSON.stringify({ action: 'save', route: name.trim(), models: [] }) });
      draftRoute = name.trim();
      draftEntries = [];
      toast(t('route_created', { r: draftRoute }), 'good');
      await load();
    } catch (error) {
      toast(String(error.message || error), 'err');
    }
  };
  el('route-del').onclick = async () => {
    if (!confirm(t('route_confirm_del', { r: draftRoute }))) return;
    try {
      await api('api/routes', { method: 'POST', body: JSON.stringify({ action: 'delete', route: draftRoute }) });
      draftRoute = '';
      draftEntries = [];
      toast(t('route_deleted'), 'good');
      await load();
    } catch (error) {
      toast(String(error.message || error), 'err');
    }
  };
  el('limit-add').onclick = async () => {
    const key = el('limit-key').value.trim();
    const limit = Number(el('limit-val').value);
    if (!key || !Number.isFinite(limit)) { toast(t('limit_need'), 'err'); return; }
    try {
      await api('api/limits', { method: 'POST', body: JSON.stringify({ action: 'set', key, limit }) });
      el('limit-key').value = '';
      el('limit-val').value = '';
      toast(t('limit_set', { key }), 'good');
      await load();
    } catch (error) {
      toast(String(error.message || error), 'err');
    }
  };
  el('disc-save').onclick = async () => {
    try {
      const result = await api('api/discovery', {
        method: 'POST',
        body: JSON.stringify({
          enabled: el('disc-enabled').checked,
          evaluationEnabled: el('disc-eval').checked,
          provider: el('disc-provider').value,
          intervalHours: Number(el('disc-interval').value),
        }),
      });
      toast(t('saved') + ((result.notes || []).length ? ' ' + result.notes.join(' ') : ''), 'good');
      await load();
    } catch (error) {
      toast(String(error.message || error), 'err');
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
          timezone: el('set-timezone').value.trim(),
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

function renderRoutes() {
  const host = el('routes');
  host.textContent = '';
  el('routes-blurb').innerHTML = t('routes_blurb', { today: state.usage.today, tz: state.usage.timezone });
  const rows = state.routes.map((entry) => {
    let status = t('st_ready');
    let kind = 'ok';
    if (!entry.providerConfigured) { status = t('st_nokey'); kind = 'no'; }
    else if (entry.zeroCost === false) { status = t('st_paid'); kind = 'bad'; }
    else if (entry.cooldownSeconds > 0) { status = t('st_cooldown', { n: entry.cooldownSeconds }); kind = 'warn'; }
    const used = entry.usage ? entry.usage.today.consumed : 0;
    return [
      td(String(entry.priority), 'num'),
      td(pill(status, kind)),
      td(entry.provider, 'muted'),
      td(entry.model + (entry.pinned ? '  *' : ''), 'mono'),
      td(used || '-', 'num'),
    ];
  });
  host.appendChild(table(
    [
      { label: t('th_num'), num: true },
      { label: t('th_status') },
      { label: t('th_provider') },
      { label: t('th_model') },
      { label: t('th_used'), num: true },
    ],
    rows,
  ));
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

// Status tab auto-refresh: poll /api/state every 5s while the status pane
// is visible. Skips when another tab is active (so route drafts and form
// inputs elsewhere are never clobbered), when the page is hidden, when
// logged out, or when a previous poll is still in flight.
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

// Bind buttons before the first load: an unauthenticated visit fails
// /api/state and returns early, which must not leave the login button dead.
bindOnce();
startStatusAutoRefresh();
load().catch((error) => toast(String(error.message || error), 'err'));
</script>
</body>
</html>
`;

export function renderPage() {
  return PAGE;
}
