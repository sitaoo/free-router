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
<style>
:root {
  color-scheme: light;
  --bg: #f7f8fa;
  --card: #ffffff;
  --line: #e2e5ea;
  --line-soft: #eef0f4;
  --text: #1c1f24;
  --muted: #5f6773;
  --faint: #8a929e;
  --accent: #0b62d6;
  --accent-soft: #eaf1fd;
  --ok: #16794a;
  --ok-soft: #e6f4ec;
  --warn: #8a5b00;
  --warn-soft: #fdf2dd;
  --bad: #c22c38;
  --bad-soft: #fdeced;
}
* { box-sizing: border-box; }
html, body { margin: 0; }
body {
  background: var(--bg);
  color: var(--text);
  font: 14px/1.55 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  -webkit-font-smoothing: antialiased;
}
.mono { font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace; }

header {
  background: var(--card);
  border-bottom: 1px solid var(--line);
  padding: 16px 28px;
  box-shadow: 0 1px 10px rgba(20, 28, 40, .06);
}
.head-inner {
  max-width: 1040px; margin: 0 auto;
  display: flex; align-items: center; gap: 12px; flex-wrap: wrap;
}
.head-spacer { flex: 1; }
#lang { max-width: 150px; }
#logout-top { padding: 6px 12px; font-size: 12.5px; }
h1 { font-size: 19px; font-weight: 650; margin: 0; letter-spacing: -.2px; }
.head-inner .sep { color: var(--line); }
.head-inner .mono {
  font-size: 12.5px; color: var(--muted);
  background: var(--accent-soft); padding: 3px 12px; border-radius: 999px;
  max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}

main { max-width: 1040px; margin: 0 auto; padding: 28px; display: grid; gap: 26px; }

section { background: var(--card); border: 1px solid var(--line); border-radius: 12px; }
.sec-head { padding: 18px 22px 0; }
.sec-head h2 { font-size: 15px; font-weight: 650; margin: 0; letter-spacing: -.1px; }
.sec-head p { margin: 5px 0 0; font-size: 13px; color: var(--muted); max-width: 74ch; }
.sec-body { padding: 14px 22px 20px; }

.prov {
  display: grid; grid-template-columns: minmax(160px, 210px) 1fr auto;
  gap: 18px; align-items: start;
  background: var(--card); border: 1px solid var(--line); border-radius: 12px;
  padding: 16px 18px;
  transition: box-shadow .18s, border-color .18s;
}
.prov:hover { border-color: #c6cdd6; box-shadow: 0 4px 16px rgba(20, 28, 40, .07); }
#providers { display: grid; gap: 10px; }
.prov-name { font-weight: 600; padding-top: 7px; }
.prov-name span { display: block; font-weight: 400; font-size: 12px; color: var(--faint); margin-top: 2px; }
.prov-field input {
  width: 100%; padding: 9px 12px; border-radius: 8px;
  border: 1px solid #ccd2db; background: #fff; color: var(--text);
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 13px;
}
.prov-field input::placeholder { color: var(--faint); font-family: inherit; }
.prov-field input:focus {
  outline: none; border-color: var(--accent);
  box-shadow: 0 0 0 3px rgba(11, 98, 214, .13);
}
.prov-hint { margin-top: 7px; font-size: 12px; color: var(--muted); }
.prov-actions { display: flex; gap: 8px; align-items: center; padding-top: 3px; }

button {
  padding: 9px 15px; border-radius: 8px; font-size: 13px; font-weight: 550;
  border: 1px solid #ccd2db; background: #fff; color: var(--text); cursor: pointer;
  transition: background .15s, border-color .15s, box-shadow .15s, transform .05s;
}
button:hover { background: #f3f5f8; }
button:active:not(:disabled) { transform: translateY(1px); }
button:focus-visible, input:focus-visible, select:focus-visible {
  outline: 2px solid var(--accent); outline-offset: 1px;
}
button.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
button.primary:hover { background: #0954b5; }
button.quiet { border-color: transparent; background: transparent; color: var(--muted); }
button.quiet:hover { background: var(--bad-soft); color: var(--bad); }
button:disabled { opacity: .55; cursor: default; }

.pill {
  display: inline-block; padding: 2px 9px; border-radius: 999px;
  font-size: 12px; font-weight: 600; white-space: nowrap;
}
.pill.ok { color: var(--ok); background: var(--ok-soft); }
.pill.no { color: var(--muted); background: #eef0f4; }
.pill.warn { color: var(--warn); background: var(--warn-soft); }
.pill.bad { color: var(--bad); background: var(--bad-soft); }

table { width: 100%; border-collapse: collapse; font-size: 13px; }
th, td { text-align: left; padding: 10px 12px; border-bottom: 1px solid var(--line-soft); }
th {
  color: var(--muted); font-weight: 600; font-size: 12px;
  border-bottom: 1px solid var(--line);
}
tbody tr:last-child td { border-bottom: 0; }
td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
td.mono { font-size: 12.5px; }
tbody tr:hover { background: #fafbfc; }

.note { font-size: 12.5px; color: var(--muted); margin: 14px 0 0; }
.row { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; margin-top: 12px; }
.row input {
  padding: 9px 12px; border-radius: 8px; border: 1px solid #ccd2db;
  font-size: 13px;
}
.row label { display: flex; gap: 8px; align-items: center; font-size: 13px; color: var(--muted); }
.check { font-size: 13px; color: var(--muted); display: flex; gap: 6px; align-items: center; }

/* Inline text link (card shortcuts across tabs). */
.linklike {
  border: 0; background: none; padding: 0;
  color: var(--accent); font-size: inherit; font-weight: 600; cursor: pointer;
  white-space: nowrap;
}
.linklike:hover { background: none; text-decoration: underline; }

/* Small icon button (copy endpoint). */
.iconbtn { padding: 3px 9px; font-size: 13px; line-height: 1.3; border-radius: 7px; }
.keyrow {
  display: flex; gap: 10px; align-items: center; padding: 6px 0;
  font-size: 13px; border-top: 1px solid var(--line-soft);
}
.keyrow .mono { flex: 1; overflow: hidden; text-overflow: ellipsis; }
#login main { padding-top: 60px; }
#login section { border-radius: 16px; box-shadow: 0 14px 44px rgba(20, 28, 40, .14); }

details summary::marker { color: var(--accent); }

#tabs {
  position: sticky; top: 0; z-index: 5;
  display: flex; gap: 4px; flex-wrap: wrap;
  background: var(--bg); padding: 10px;
  border: 1px solid var(--line); border-radius: 12px;
}
#tabs button {
  border: 1px solid transparent; background: transparent;
  padding: 8px 16px; font-weight: 600; color: var(--muted);
}
#tabs button:hover { background: var(--accent-soft); color: var(--text); }
#tabs button.active {
  background: var(--accent); border-color: var(--accent); color: #fff;
  box-shadow: 0 2px 8px rgba(11, 98, 214, .3);
}
#tabs button.active:hover { background: #0954b5; }

/* Tab panes stack their cards with a fixed gap (main's grid gap does not
   reach inside the pane wrapper). */
[data-pane] { display: grid; gap: 10px; align-content: start; }
[data-pane][hidden] { display: none; }

.cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 10px; }
.card {
  border: 1px solid var(--line-soft); border-radius: 10px; padding: 12px 14px;
  background: #fafbfc;
}
.card .k { font-size: 12px; color: var(--muted); }
.card .v { font-size: 14px; font-weight: 600; margin-top: 2px; word-break: break-all; }

select {
  padding: 9px 12px; border-radius: 8px; border: 1px solid #ccd2db;
  background: #fff; color: var(--text); font-size: 13px; max-width: 280px;
}

.chip {
  display: inline-flex; gap: 8px; align-items: center;
  border: 1px solid var(--line); border-radius: 999px;
  padding: 4px 8px 4px 12px; margin: 0 8px 8px 0; font-size: 12.5px;
  background: #f6f8fb;
}
.chip .mono { font-size: 12px; }
.chip button { padding: 2px 9px; font-size: 12px; }

.entry {
  display: flex; gap: 8px; align-items: center; padding: 7px 0;
  border-top: 1px solid var(--line-soft); font-size: 13px;
}
.entry .mono { flex: 1; overflow: hidden; text-overflow: ellipsis; }
.entry .st { font-size: 12px; color: var(--muted); min-width: 90px; text-align: right; }
.entry button { padding: 4px 10px; font-size: 12px; }

.warn { color: var(--warn); font-weight: 600; }
.bad-text { color: var(--bad); font-weight: 600; }
.ok-text { color: var(--ok); font-weight: 600; }

/* Title row with a trailing switch (Access pane). */
.head-row { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; }
.head-row > div { flex: 1; min-width: 0; }
.title-switch { display: flex; align-items: center; gap: 10px; }
.title-switch .switch { margin-top: 0; }
.switch { position: relative; display: inline-block; width: 44px; height: 24px; flex: none; margin-top: 2px; }
.switch input { opacity: 0; width: 0; height: 0; }
.switch .slider {
  position: absolute; inset: 0; cursor: pointer;
  background: #ccd2db; border-radius: 999px; transition: .18s;
}
.switch .slider:before {
  content: ""; position: absolute; height: 18px; width: 18px;
  left: 3px; top: 3px; background: #fff; border-radius: 50%; transition: .18s;
  box-shadow: 0 1px 3px rgba(0,0,0,.25);
}
.switch input:checked + .slider { background: var(--accent); }
.switch input:checked + .slider:before { transform: translateX(20px); }

/* One-time migration notice. */
.banner {
  border: 1px solid var(--warn); background: var(--warn-soft); color: var(--text);
  border-radius: 10px; padding: 12px 14px; font-size: 13px; margin-bottom: 14px;
  display: flex; gap: 12px; align-items: center; justify-content: space-between;
}
/* display:flex above beats the hidden attribute's UA rule without this. */
.banner[hidden] { display: none; }
.banner button { flex: none; }

@media (prefers-color-scheme: dark) {
  :root {
    --bg: #14171c; --card: #1d2128; --line: #333a44; --line-soft: #262c35;
    --text: #e8ebef; --muted: #a7b0bc; --faint: #767f8c;
    --accent: #4d94f1; --accent-soft: #1c2f4d;
    --ok: #4cc38a; --ok-soft: #173b2a;
    --warn: #e0a63c; --warn-soft: #3d2f14;
    --bad: #f26d79; --bad-soft: #431b20;
  }
  .prov-field input, .row input, select { background: #14171c; border-color: #3a424d; color: var(--text); }
  button { background: #262c35; border-color: #3a424d; color: var(--text); }
  button:hover { background: #2f3641; }
  button.primary { background: var(--accent); border-color: var(--accent); color: #0c1116; }
  button.primary:hover { background: #6aa5f3; }
  tbody tr:hover { background: #22282f; }
  .card, .chip { background: #22282f; }
  .prov:hover { border-color: #3a424d; box-shadow: 0 4px 16px rgba(0, 0, 0, .35); }
  .iconbtn { background: #262c35; border-color: #3a424d; }
  .switch .slider { background: #3a424d; }
}

#toast {
  position: fixed; right: 20px; bottom: 20px; padding: 12px 16px; border-radius: 9px;
  background: var(--card); border: 1px solid var(--line); color: var(--text);
  box-shadow: 0 6px 24px rgba(20, 28, 40, .13);
  max-width: 430px; font-size: 13px;
  opacity: 0; transform: translateY(8px); transition: .18s; pointer-events: none;
}
#toast.show { opacity: 1; transform: none; }
#toast.good { border-left: 3px solid var(--ok); }
#toast.err { border-left: 3px solid var(--bad); }

@media (max-width: 760px) {
  .prov { grid-template-columns: 1fr; gap: 10px; }
  .prov-name { padding-top: 0; }
  main, header { padding-left: 18px; padding-right: 18px; }
}
</style>
</head>
<body>
<header>
  <div class="head-inner">
    <h1>Free Router</h1>
    <span class="sep">/</span>
    <span class="mono" id="endpoint"></span>
    <span class="head-spacer"></span>
    <select id="lang" title="Language"></select>
    <button id="logout-top" class="quiet" style="display:none" data-i18n="logout">Log out</button>
  </div>
</header>
<main id="app" style="display:none">
  <nav id="tabs">
    <button data-tab="status" class="active" data-i18n="tab_status">Status</button>
    <button data-tab="access" data-i18n="tab_access">Access</button>
    <button data-tab="providers" data-i18n="tab_providers">Providers</button>
    <button data-tab="routes" data-i18n="tab_routes">Routes</button>
    <button data-tab="quota" data-i18n="tab_quota">Quota</button>
    <button data-tab="settings" data-i18n="tab_settings">Settings</button>
  </nav>

  <div data-pane="status">
    <section>
      <div class="sec-head"><h2 data-i18n="overview">Overview</h2><p id="status-blurb"></p></div>
      <div class="sec-body"><div id="status-cards" class="cards"></div></div>
    </section>
    <section>
      <div class="sec-head">
        <h2 data-i18n="route_priority">Route priority</h2>
        <p id="routes-blurb"></p>
      </div>
      <div class="sec-body"><div id="routes"></div></div>
    </section>
    <section>
      <div class="sec-head"><h2 data-i18n="usage_today">Usage today</h2><p id="usage-blurb"></p></div>
      <div class="sec-body"><div id="usage"></div></div>
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
      <div class="sec-head"><h2 data-i18n="add_provider">Add provider</h2><p data-i18n="add_provider_blurb">Any OpenAI-compatible endpoint. After adding, paste its key above.</p></div>
      <div class="sec-body">
        <div class="row">
          <input id="np-name" data-i18n-ph="np_name_ph" placeholder="name: groq" style="max-width:150px">
          <input id="np-baseurl" class="mono" data-i18n-ph="np_url_ph" placeholder="https://api.groq.com/openai/v1" style="flex:1;min-width:220px">
        </div>
        <div class="row">
          <input id="np-freemodels" class="mono" data-i18n-ph="np_fm_ph" placeholder="free models, comma separated (for APIs without prices)" style="flex:1;min-width:220px">
        </div>
        <div class="row">
          <label class="check"><input type="checkbox" id="np-catalog" checked> <span data-i18n="np_catalog">catalog (/models)</span></label>
          <label class="check"><input type="checkbox" id="np-pricing" checked> <span data-i18n="np_pricing">publishes prices</span></label>
          <button class="primary" id="np-create" data-i18n="np_create">Add provider</button>
        </div>
      </div>
    </section>
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
        <div class="row">
          <label class="check"><input type="checkbox" id="disc-enabled"> <span data-i18n="disc_enabled">discovery enabled</span></label>
          <label class="check"><input type="checkbox" id="disc-eval"> <span data-i18n="disc_eval">model evaluation</span></label>
        </div>
        <div class="row">
          <label><span data-i18n="disc_provider">Provider</span> <select id="disc-provider"></select></label>
          <label><span data-i18n="disc_interval">Interval (hours)</span> <input id="disc-interval" class="mono" style="max-width:90px"></label>
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
        <div class="row">
          <label><span data-i18n="srv_host">Host</span> <input id="srv-host" class="mono" style="max-width:200px"></label>
          <label><span data-i18n="srv_port">Port</span> <input id="srv-port" class="mono" style="max-width:100px"></label>
          <button id="srv-save" data-i18n="srv_save">Save</button>
          <button id="srv-restart" data-i18n="restart_btn">Restart</button>
        </div>
        <p class="note" data-i18n="srv_note">Bind <span class="mono">0.0.0.0</span> to allow LAN access. Keep the admin password set. Host and port changes need a restart — use the Restart button.</p>
      </div>
    </section>
    <section>
      <div class="sec-head"><h2 data-i18n="tuning_title">Tuning</h2><p data-i18n="tuning_blurb">Timeouts apply immediately; proxy and retention settings need a restart.</p></div>
      <div class="sec-body">
        <div class="row">
          <label><span data-i18n="tun_timeout">Attempt timeout (ms)</span> <input id="set-timeout" class="mono" style="max-width:120px"></label>
          <label><span data-i18n="tun_refresh">Catalog refresh (ms)</span> <input id="set-refresh" class="mono" style="max-width:130px"></label>
          <label class="check"><input type="checkbox" id="set-redact"> <span data-i18n="tun_redact">redact secrets</span></label>
        </div>
        <div class="row">
          <label><span data-i18n="tun_default">Default provider</span> <select id="set-default"></select></label>
        </div>
        <div class="row">
          <input id="set-socks" class="mono" data-i18n-ph="tun_socks_ph" placeholder="socks-first hosts, comma separated" style="flex:1;min-width:200px">
        </div>
        <div class="row">
          <label><span data-i18n="tun_retention">Usage retention (days)</span> <input id="set-retention" class="mono" style="max-width:80px"></label>
          <label><span data-i18n="tun_timezone">Timezone</span> <input id="set-timezone" class="mono" data-i18n-ph="tun_timezone_ph" placeholder="America/Los_Angeles" style="max-width:200px"></label>
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
        <div class="row">
          <input id="admin-pass" type="password" data-i18n-ph="admin_pass_ph" placeholder="New admin password" style="max-width:260px">
          <button class="primary" id="admin-save" data-i18n="admin_save">Change password</button>
          <button class="quiet" id="logout" data-i18n="logout">Log out</button>
        </div>
        <div class="row">
          <label><span data-i18n="sess_ttl">Session expires after</span>
            <select id="sess-preset"></select>
          </label>
          <button id="sess-save" data-i18n="sess_save">Save session</button>
        </div>
        <p class="note" id="sess-note"></p>
      </div>
    </section>
  </div>
</main>
<div id="login" style="display:none">
  <main style="max-width:440px">
    <section><div class="sec-body" style="padding:26px">
      <h2 style="margin:0 0 4px">Free Router</h2>
      <p class="note" style="margin:0 0 14px" data-i18n="login_blurb">Enter the admin password to continue.</p>
      <div class="row">
        <input id="login-pass" type="password" data-i18n-ph="login_pass_ph" placeholder="Default admin123" style="flex:1">
        <button class="primary" id="login-go" data-i18n="login_go">Log in</button>
      </div>
    </div></section>
  </main>
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

function renderProviders() {
  const host = el('providers');
  host.textContent = '';
  for (const provider of state.providers) {
    const row = document.createElement('div');
    row.className = 'prov';

    const name = document.createElement('div');
    name.className = 'prov-name';
    name.textContent = provider.name;
    const env = document.createElement('span');
    env.className = 'mono';
    env.textContent = t('prov_counts', {
      env: provider.keyEnv,
      k: provider.keyCount || 0,
      m: provider.modelCount === null || provider.modelCount === undefined ? '?' : provider.modelCount,
      f: provider.freeCount === null || provider.freeCount === undefined ? '?' : provider.freeCount,
    });
    name.appendChild(env);

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
      del.className = 'quiet';
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
      rm.className = 'quiet';
      rm.textContent = '×';
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

    const delRow = document.createElement('div');
    delRow.className = 'row';
    const delProv = document.createElement('button');
    delProv.className = 'quiet';
    delProv.textContent = t('del_provider');
    delProv.onclick = async () => {
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
    delRow.appendChild(delProv);
    adv.appendChild(delRow);
    fieldCell.appendChild(adv);

    const actions = document.createElement('div');
    actions.className = 'prov-actions';

    row.appendChild(name);
    row.appendChild(fieldCell);
    row.appendChild(actions);
    host.appendChild(row);
  }
  el('keys-blurb').textContent = t('keys_blurb', { file: state.overlayFile, format: state.configFormat });
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
  }
  for (const entry of keys) {
    const line = document.createElement('div');
    line.className = 'keyrow';
    const label = document.createElement('span');
    label.textContent = entry.name;
    const masked = document.createElement('span');
    masked.className = 'mono';
    masked.textContent = entry.masked + (entry.createdAt ? ' · ' + entry.createdAt.slice(0, 10) : '');
    const del = document.createElement('button');
    del.className = 'quiet';
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
    line.appendChild(label);
    line.appendChild(masked);
    line.appendChild(del);
    host.appendChild(line);
  }
  el('gw-require').checked = Boolean(state.gateway && state.gateway.requireAuth);
  el('gw-note').textContent = keys.length
    ? 'Clients call: curl -H "Authorization: Bearer <key>" ' + state.endpoint + '/chat/completions'
    : '';
}

function renderServer() {
  el('server-blurb').textContent =
    'Config: ' + state.configFile + ' (' + state.configFormat + '). Running on ' + state.server.runningHost + ':' + state.server.runningPort + '.';
  el('srv-host').value = state.server.host || '';
  el('srv-port').value = state.server.port || '';
}

function renderServer() {
  el('server-blurb').textContent =
    'Config: ' + state.configFile + ' (' + state.configFormat + '). Running on ' + state.server.runningHost + ':' + state.server.runningPort + '.';
  el('srv-host').value = state.server.host || '';
  el('srv-port').value = state.server.port || '';
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

function renderStatus() {
  const host = el('status-cards');
  host.textContent = '';
  const endpointWrap = document.createElement('span');
  const endpointText = document.createElement('span');
  endpointText.className = 'mono';
  endpointText.textContent = state.endpoint + ' ';
  const copy = document.createElement('button');
  copy.className = 'iconbtn';
  copy.textContent = '⧉';
  copy.title = t('copy_title');
  copy.onclick = async () => {
    const ok = await copyText(state.endpoint);
    toast(ok ? t('copied_msg') : state.endpoint, ok ? 'good' : 'err');
  };
  endpointWrap.appendChild(endpointText);
  endpointWrap.appendChild(copy);
  card(host, t('card_endpoint'), endpointWrap);
  card(host, t('card_config'), state.configFile + ' (' + state.configFormat + ')');
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
  el('usage-blurb').textContent = t('usage_blurb', { today: state.usage.today, tz: state.usage.timezone });
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
    [{ label: t('th_model') }, { label: t('th_today'), num: true }, { label: t('th_ok'), num: true }, { label: t('th_fail'), num: true }, { label: t('th_limit'), num: true }],
    models.map((entry) => [
      td(entry.key, 'mono'),
      td(entry.today ? entry.today.consumed : '-', 'num'),
      td(entry.ok || '-', 'num'),
      td(entry.fail || '-', 'num'),
      td(entry.dailyLimit || '-', 'num'),
    ]),
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
    num.className = 'st';
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
    up.textContent = '↑';
    up.disabled = index === 0;
    up.onclick = () => {
      draftEntries.splice(index - 1, 0, draftEntries.splice(index, 1)[0]);
      renderRouteEditor();
    };
    const down = document.createElement('button');
    down.textContent = '↓';
    down.disabled = index === draftEntries.length - 1;
    down.onclick = () => {
      draftEntries.splice(index + 1, 0, draftEntries.splice(index, 1)[0]);
      renderRouteEditor();
    };
    const rm = document.createElement('button');
    rm.className = 'quiet';
    rm.textContent = '×';
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
      del.className = 'quiet';
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
    rm.className = 'quiet';
    rm.textContent = '×';
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
        body: JSON.stringify({ host: el('srv-host').value.trim(), port: Number(el('srv-port').value) }),
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
  el('np-create').onclick = async () => {
    const name = el('np-name').value.trim().toLowerCase();
    const baseUrl = el('np-baseurl').value.trim();
    if (!name || !baseUrl) { toast(t('np_need'), 'err'); return; }
    try {
      await api('api/providers', {
        method: 'POST',
        body: JSON.stringify({
          action: 'create',
          name,
          baseUrl,
          catalog: el('np-catalog').checked,
          pricing: el('np-pricing').checked,
          freeModels: el('np-freemodels').value.split(',').map((s) => s.trim()).filter(Boolean),
        }),
      });
      el('np-name').value = '';
      el('np-baseurl').value = '';
      el('np-freemodels').value = '';
      toast(t('np_added', { n: name }), 'good');
      await load();
    } catch (error) {
      toast(String(error.message || error), 'err');
    }
  };
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
  el('login').style.display = 'none';
  el('app').style.display = '';
  el('logout-top').style.display = '';
  el('endpoint').textContent = state.endpoint;
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

// Bind buttons before the first load: an unauthenticated visit fails
// /api/state and returns early, which must not leave the login button dead.
bindOnce();
load().catch((error) => toast(String(error.message || error), 'err'));
</script>
</body>
</html>
`;

export function renderPage() {
  return PAGE;
}
