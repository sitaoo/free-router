import fs from 'node:fs';
import os from 'node:os';

const MAX_SECRET_LENGTH = 500;

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
  padding: 20px 28px;
}
.head-inner {
  max-width: 1040px; margin: 0 auto;
  display: flex; align-items: baseline; gap: 12px; flex-wrap: wrap;
}
h1 { font-size: 19px; font-weight: 650; margin: 0; letter-spacing: -.2px; }
.head-inner .sep { color: var(--line); }
.head-inner .mono { font-size: 13px; color: var(--muted); }

main { max-width: 1040px; margin: 0 auto; padding: 28px; display: grid; gap: 26px; }

section { background: var(--card); border: 1px solid var(--line); border-radius: 12px; }
.sec-head { padding: 18px 22px 0; }
.sec-head h2 { font-size: 15px; font-weight: 650; margin: 0; letter-spacing: -.1px; }
.sec-head p { margin: 5px 0 0; font-size: 13px; color: var(--muted); max-width: 74ch; }
.sec-body { padding: 14px 22px 20px; }

.prov {
  display: grid; grid-template-columns: minmax(160px, 210px) 1fr auto;
  gap: 18px; align-items: start;
  padding: 18px 0; border-top: 1px solid var(--line-soft);
}
.prov:first-child { border-top: 0; padding-top: 6px; }
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
}
button:hover { background: #f3f5f8; }
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
.keyrow {
  display: flex; gap: 10px; align-items: center; padding: 6px 0;
  font-size: 13px; border-top: 1px solid var(--line-soft);
}
.keyrow .mono { flex: 1; overflow: hidden; text-overflow: ellipsis; }
#login main { padding-top: 60px; }

#tabs {
  position: sticky; top: 0; z-index: 5;
  display: flex; gap: 6px; flex-wrap: wrap;
  background: var(--bg); padding: 14px 0 12px;
}
#tabs button {
  border: 1px solid var(--line); background: var(--card);
  padding: 8px 16px; font-weight: 600;
}
#tabs button.active {
  background: var(--accent); border-color: var(--accent); color: #fff;
}
#tabs button.active:hover { background: #0954b5; }

.cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 12px; }
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
  </div>
</header>
<main id="app" style="display:none">
  <nav id="tabs">
    <button data-tab="status" class="active">状态 Status</button>
    <button data-tab="access">访问 Access</button>
    <button data-tab="providers">上游 Providers</button>
    <button data-tab="routes">路由 Routes</button>
    <button data-tab="quota">配额 Quota</button>
    <button data-tab="settings">设置 Settings</button>
  </nav>

  <div data-pane="status">
    <section>
      <div class="sec-head"><h2>Overview</h2><p id="status-blurb"></p></div>
      <div class="sec-body"><div id="status-cards" class="cards"></div></div>
    </section>
    <section>
      <div class="sec-head">
        <h2>Route priority</h2>
        <p id="routes-blurb"></p>
      </div>
      <div class="sec-body"><div id="routes"></div></div>
    </section>
    <section>
      <div class="sec-head"><h2>Usage today</h2><p id="usage-blurb"></p></div>
      <div class="sec-body"><div id="usage"></div></div>
    </section>
  </div>

  <div data-pane="access" hidden>
    <section>
      <div class="sec-head">
        <h2>Access</h2>
        <p>Gateway API keys for LAN clients (send as <span class="mono">Authorization: Bearer &lt;key&gt;</span> on <span class="mono">/v1/*</span>). Creating the first key enables auth; deleting the last one disables it.</p>
      </div>
      <div class="sec-body">
        <div id="gateway"></div>
        <div class="row">
          <input id="gw-name" placeholder="备注名称，如 客厅笔记本" style="max-width:260px">
          <button class="primary" id="gw-create">Create API key</button>
          <label class="check"><input type="checkbox" id="gw-require"> require auth</label>
        </div>
        <p class="note" id="gw-note"></p>
      </div>
    </section>
  </div>

  <div data-pane="providers" hidden>
    <section>
      <div class="sec-head">
        <h2>Provider keys</h2>
        <p id="keys-blurb"></p>
      </div>
      <div class="sec-body"><div id="providers"></div></div>
    </section>
    <section>
      <div class="sec-head"><h2>Add provider</h2><p>Any OpenAI-compatible endpoint. After adding, paste its key above.</p></div>
      <div class="sec-body">
        <div class="row">
          <input id="np-name" placeholder="name: groq" style="max-width:150px">
          <input id="np-baseurl" class="mono" placeholder="https://api.groq.com/openai/v1" style="flex:1;min-width:220px">
        </div>
        <div class="row">
          <input id="np-freemodels" class="mono" placeholder="free models, comma separated (for APIs without prices)" style="flex:1;min-width:220px">
        </div>
        <div class="row">
          <label class="check"><input type="checkbox" id="np-catalog" checked> catalog (/models)</label>
          <label class="check"><input type="checkbox" id="np-pricing" checked> publishes prices</label>
          <button class="primary" id="np-create">Add provider</button>
        </div>
      </div>
    </section>
  </div>

  <div data-pane="routes" hidden>
    <section>
      <div class="sec-head"><h2>Routes</h2><p>Order the gateway tries models in. Entries are <span class="mono">provider:model</span> or plain model ids. Adding a model auto-allows it for price-free providers.</p></div>
      <div class="sec-body">
        <div class="row">
          <label>Route <select id="route-select"></select></label>
          <button id="route-new">New route</button>
          <button class="quiet" id="route-del">Delete route</button>
        </div>
        <div id="route-entries"></div>
        <div class="row">
          <input id="route-add" class="mono" placeholder="provider:model 或 model id" style="flex:1;min-width:200px">
          <button id="route-add-btn">Add</button>
          <button class="primary" id="route-save">Save route</button>
        </div>
        <p class="note" id="route-note"></p>
      </div>
    </section>
  </div>

  <div data-pane="quota" hidden>
    <section>
      <div class="sec-head"><h2>Daily limits</h2><p>Config quota per model. Limits reported by the provider itself stay authoritative.</p></div>
      <div class="sec-body">
        <div id="limits-table"></div>
        <div class="row">
          <input id="limit-key" class="mono" placeholder="provider:model" style="max-width:260px">
          <input id="limit-val" class="mono" placeholder="requests/day" style="max-width:140px">
          <button class="primary" id="limit-add">Set limit</button>
        </div>
      </div>
    </section>
    <section>
      <div class="sec-head"><h2>Discovery</h2><p>Automatic free-model discovery and ranking.</p></div>
      <div class="sec-body">
        <div class="row">
          <label class="check"><input type="checkbox" id="disc-enabled"> discovery enabled</label>
          <label class="check"><input type="checkbox" id="disc-eval"> model evaluation</label>
        </div>
        <div class="row">
          <label>Provider <select id="disc-provider"></select></label>
          <label>Interval (hours) <input id="disc-interval" class="mono" style="max-width:90px"></label>
          <button id="disc-save">Save</button>
        </div>
        <p class="note">Route: <span class="mono" id="disc-route"></span>. Interval changes need a restart.</p>
        <div id="pinned-list"></div>
        <div class="row">
          <input id="pin-input" class="mono" placeholder="pin model, e.g. gemini:gemini-3.8-flash" style="flex:1;min-width:200px">
          <button id="pin-add">Pin</button>
        </div>
      </div>
    </section>
  </div>

  <div data-pane="settings" hidden>
    <section>
      <div class="sec-head">
        <h2>Server</h2>
        <p id="server-blurb"></p>
      </div>
      <div class="sec-body">
        <div class="row">
          <label>Host <input id="srv-host" class="mono" style="max-width:200px"></label>
          <label>Port <input id="srv-port" class="mono" style="max-width:100px"></label>
          <button id="srv-save">Save (restart needed)</button>
        </div>
        <p class="note">Bind <span class="mono">0.0.0.0</span> to allow LAN access. Keep the admin password set.</p>
      </div>
    </section>
    <section>
      <div class="sec-head"><h2>Tuning</h2><p>Timeouts apply immediately; proxy and retention settings need a restart.</p></div>
      <div class="sec-body">
        <div class="row">
          <label>Attempt timeout (ms) <input id="set-timeout" class="mono" style="max-width:120px"></label>
          <label>Catalog refresh (ms) <input id="set-refresh" class="mono" style="max-width:130px"></label>
          <label class="check"><input type="checkbox" id="set-redact"> redact secrets</label>
        </div>
        <div class="row">
          <label>Default provider <select id="set-default"></select></label>
        </div>
        <div class="row">
          <input id="set-socks" class="mono" placeholder="socks-first hosts, comma separated" style="flex:1;min-width:200px">
        </div>
        <div class="row">
          <label>Usage retention (days) <input id="set-retention" class="mono" style="max-width:80px"></label>
          <label>Timezone <input id="set-timezone" class="mono" placeholder="America/Los_Angeles" style="max-width:200px"></label>
          <button class="primary" id="set-save">Save tuning</button>
        </div>
        <p class="note" id="set-note"></p>
      </div>
    </section>
    <section>
      <div class="sec-head">
        <h2>Admin</h2>
        <p>Web UI password (default <span class="mono">admin</span>). Changing it logs out all sessions.</p>
      </div>
      <div class="sec-body">
        <div class="row">
          <input id="admin-pass" type="password" placeholder="New admin password" style="max-width:260px">
          <button class="primary" id="admin-save">Change password</button>
          <button class="quiet" id="logout">Log out</button>
        </div>
      </div>
    </section>
  </div>
</main>
<div id="login" style="display:none">
  <main style="max-width:440px">
    <section><div class="sec-body" style="padding:26px">
      <h2 style="margin:0 0 4px">Free Router</h2>
      <p class="note" style="margin:0 0 14px">Enter the admin password to continue.</p>
      <div class="row">
        <input id="login-pass" type="password" placeholder="Admin password (default admin)" style="flex:1">
        <button class="primary" id="login-go">Log in</button>
      </div>
    </div></section>
  </main>
</div>
<div id="toast"></div>
<script>
const el = (id) => document.getElementById(id);
let state = null;

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
    env.textContent = provider.keyEnv + ' · ' + (provider.keyCount || 0) + ' key(s)';
    name.appendChild(env);

    const fieldCell = document.createElement('div');
    fieldCell.className = 'prov-field';

    // Named multi-account keys (stored in the TOML/JSON config).
    const fileKeys = (provider.keys || []).filter((entry) => entry.source === 'file');
    for (const entry of fileKeys) {
      const line = document.createElement('div');
      line.className = 'keyrow';
      const label = document.createElement('span');
      label.textContent = entry.name + (entry.invalid ? ' (401 retired)' : '');
      const masked = document.createElement('span');
      masked.className = 'mono';
      masked.textContent = entry.maskedKey;
      const del = document.createElement('button');
      del.className = 'quiet';
      del.textContent = 'Delete';
      del.onclick = async () => {
        if (!confirm('Delete provider key [' + entry.name + '] for ' + provider.name + '?')) return;
        del.disabled = true;
        try {
          await api('api/keys', {
            method: 'POST',
            body: JSON.stringify({ provider: provider.name, name: entry.name, key: '' }),
          });
          toast('Deleted [' + entry.name + '].', 'good');
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
    nameField.placeholder = '备注名称，如 账号2';
    nameField.style.maxWidth = '150px';
    const keyField = document.createElement('input');
    keyField.type = 'password';
    keyField.autocomplete = 'off';
    keyField.spellcheck = false;
    keyField.placeholder = fileKeys.length ? 'Paste another key for this provider' : 'Paste ' + provider.keyEnv;
    keyField.style.flex = '1';
    const add = document.createElement('button');
    add.className = 'primary';
    add.textContent = fileKeys.length ? 'Add key' : 'Save';
    add.onclick = async () => {
      const value = keyField.value.trim();
      const label = nameField.value.trim() || ('key-' + ((provider.keyCount || 0) + 1));
      if (!value) { toast('Paste a key first, the field is empty.', 'err'); return; }
      add.disabled = true;
      try {
        await api('api/keys', {
          method: 'POST',
          body: JSON.stringify({ provider: provider.name, name: label, key: value }),
        });
        toast('Saved [' + label + '] for ' + provider.name + '. Applied immediately.', 'good');
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
      hint.textContent = 'Not set. This provider and its models are skipped.';
    } else if (envKeys.length) {
      hint.textContent = 'Also from environment: ' + envKeys.map((entry) => entry.maskedKey).join(', ');
    } else {
      hint.textContent = provider.keyCount + ' key(s) configured; requests rotate across them.';
    }
    if (provider.catalogError && !provider.catalogModels) {
      hint.appendChild(document.createTextNode('  '));
      hint.appendChild(pill('catalog unreachable', 'bad'));
    }
    fieldCell.appendChild(hint);

    if (provider.unavailableModels && provider.unavailableModels.length) {
      const gone = document.createElement('div');
      gone.className = 'prov-hint';
      gone.appendChild(pill('withdrawn', 'warn'));
      gone.appendChild(document.createTextNode(' no longer offered upstream, skipped: '));
      const ids = document.createElement('span');
      ids.className = 'mono';
      ids.textContent = provider.unavailableModels.join(', ');
      gone.appendChild(ids);
      fieldCell.appendChild(gone);
    }

    const adv = document.createElement('details');
    const summary = document.createElement('summary');
    summary.textContent = 'Advanced: endpoint, free models, delete';
    summary.style.cssText = 'cursor:pointer;font-size:12.5px;color:var(--muted);margin-top:8px';
    adv.appendChild(summary);
    const detail = state.editable.providers.find((entry) => entry.name === provider.name) || {};
    const urlRow = document.createElement('div');
    urlRow.className = 'row';
    const urlField = document.createElement('input');
    urlField.className = 'mono';
    urlField.value = detail.baseUrl || '';
    urlField.style.flex = '1';
    urlField.placeholder = 'https://... OpenAI-compatible base URL';
    const urlSave = document.createElement('button');
    urlSave.textContent = 'Save URL';
    urlSave.onclick = async () => {
      urlSave.disabled = true;
      try {
        const result = await api('api/providers', {
          method: 'POST',
          body: JSON.stringify({ action: 'update', name: provider.name, baseUrl: urlField.value.trim() }),
        });
        toast('Saved.' + ((result.notes || []).length ? ' ' + result.notes.join(' ') : ''), 'good');
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
    fmLabel.textContent = detail.pricing
      ? 'Priced catalog decides freeness; freeModels below is informational.'
      : 'freeModels allowlist (models routable without published prices):';
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
      rm.title = 'Remove ' + model;
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
          toast('Removed ' + model + '.', 'good');
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
    fmField.placeholder = 'add model id';
    fmField.style.maxWidth = '240px';
    const fmAdd = document.createElement('button');
    fmAdd.textContent = 'Add model';
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
        toast('Added ' + value + '.', 'good');
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
    delProv.textContent = 'Delete provider';
    delProv.onclick = async () => {
      if (!confirm('Delete provider ' + provider.name + '? Its route entries are purged too.')) return;
      try {
        const result = await api('api/providers', {
          method: 'POST',
          body: JSON.stringify({ action: 'delete', name: provider.name }),
        });
        toast('Deleted ' + provider.name + ' (purged ' + (result.purged || 0) + ' route entries).', 'good');
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
  el('keys-blurb').textContent =
    'Named keys are stored in ' + state.configFile + ' (' + state.configFormat + ') and applied immediately. '
    + 'Multiple keys per provider rotate automatically; a 401 retires only that key.';
}

function renderGateway() {
  const host = el('gateway');
  host.textContent = '';
  const keys = (state.gateway && state.gateway.keys) || [];
  if (!keys.length) {
    const p = document.createElement('p');
    p.className = 'note';
    p.style.margin = '0';
    p.textContent = 'No API keys yet. /v1 is open to the whole network — create one to lock it down.';
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
    del.textContent = 'Delete';
    del.onclick = async () => {
      if (!confirm('Delete gateway API key [' + entry.name + ']? Clients using it stop working.')) return;
      del.disabled = true;
      try {
        await api('api/gateway-keys', {
          method: 'POST',
          body: JSON.stringify({ action: 'delete', name: entry.name }),
        });
        toast('Deleted [' + entry.name + '].', 'good');
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

function renderStatus() {
  const host = el('status-cards');
  host.textContent = '';
  card(host, 'endpoint', state.endpoint);
  card(host, 'config', state.configFile + ' (' + state.configFormat + ')');
  const gwCount = (state.gateway && state.gateway.keys.length) || 0;
  card(
    host,
    'gateway auth',
    state.gateway.requireAuth ? 'required (' + gwCount + ' keys)' : (gwCount ? 'keys exist, not required' : 'disabled (open LAN)'),
    state.gateway.requireAuth ? 'ok-text' : 'warn',
  );
  const noKey = state.providers.filter((entry) => !entry.configured).map((entry) => entry.name);
  card(host, 'providers without key', noKey.length ? noKey.join(', ') : 'all configured', noKey.length ? 'warn' : 'ok-text');
  if (state.webui.defaultPassword) {
    card(host, 'admin password', 'still default "admin" — change it in Settings', 'bad-text');
  }
  el('status-blurb').textContent =
    'Live overview. Details live under the other tabs; route order below decides every request.';
}

function renderUsage() {
  const host = el('usage');
  host.textContent = '';
  el('usage-blurb').textContent =
    'used is today (' + state.usage.today + ' ' + state.usage.timezone + '); rate limits and 404s are excluded.';
  const models = (state.usage.models || []).slice(0, 12);
  if (!models.length) {
    const p = document.createElement('p');
    p.className = 'note';
    p.style.margin = '0';
    p.textContent = 'No requests recorded yet.';
    host.appendChild(p);
    return;
  }
  host.appendChild(table(
    [{ label: 'model' }, { label: 'today', num: true }, { label: 'ok', num: true }, { label: 'fail', num: true }, { label: 'limit', num: true }],
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
    option.textContent = name + (name === state.route ? ' (discovery)' : '');
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
    if (!status) st.textContent = 'unsaved';
    else if (!status.providerConfigured) st.textContent = 'no key';
    else if (status.zeroCost === false) st.textContent = 'paid';
    else if (status.cooldownSeconds > 0) st.textContent = 'cooldown';
    else st.textContent = 'ready';
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
  el('route-note').textContent = draftEntries.length
    ? 'Save writes the whole list. Unsaved reorder is lost on reload.'
    : 'Empty route: add models below, then save.';
}

function renderLimits() {
  const host = el('limits-table');
  host.textContent = '';
  const limits = (state.editable && state.editable.limits) || [];
  if (!limits.length) {
    const p = document.createElement('p');
    p.className = 'note';
    p.style.margin = '0';
    p.textContent = 'No config limits. Provider-reported quotas still apply automatically.';
    host.appendChild(p);
    return;
  }
  host.appendChild(table(
    [{ label: 'model' }, { label: 'limit/day', num: true }, { label: 'source' }, { label: '' }],
    limits.map((entry) => {
      const del = document.createElement('button');
      del.className = 'quiet';
      del.textContent = 'Delete';
      del.onclick = async () => {
        try {
          await api('api/limits', { method: 'POST', body: JSON.stringify({ action: 'delete', key: entry.key }) });
          toast('Deleted limit for ' + entry.key + '.', 'good');
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
  el('disc-route').textContent = disc.route;
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
        toast('Unpinned ' + model + '.', 'good');
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
  el('gw-create').onclick = async () => {
    const label = el('gw-name').value.trim();
    if (!label) { toast('Give the key a name first (备注名称).', 'err'); return; }
    try {
      const result = await api('api/gateway-keys', {
        method: 'POST',
        body: JSON.stringify({ action: 'create', name: label }),
      });
      el('gw-name').value = '';
      prompt('Copy this key now — it is shown only once:', result.key);
      toast('Created [' + label + ']; auth is now required.', 'good');
      await load();
    } catch (error) {
      toast(String(error.message || error), 'err');
    }
  };
  el('gw-require').onchange = async () => {
    try {
      await api('api/gateway-keys', {
        method: 'POST',
        body: JSON.stringify({ action: 'setRequireAuth', requireAuth: el('gw-require').checked }),
      });
      toast(el('gw-require').checked ? 'Gateway auth required.' : 'Gateway auth disabled.', 'good');
      await load();
    } catch (error) {
      toast(String(error.message || error), 'err');
      await load();
    }
  };
  el('admin-save').onclick = async () => {
    const value = el('admin-pass').value;
    if (!value) { toast('Enter a new password first.', 'err'); return; }
    try {
      await api('api/webui-password', { method: 'POST', body: JSON.stringify({ password: value }) });
      el('admin-pass').value = '';
      toast('Password changed. Please log in again.', 'good');
      showLogin();
    } catch (error) {
      toast(String(error.message || error), 'err');
    }
  };
  el('logout').onclick = async () => {
    try { await api('api/logout', { method: 'POST' }); } catch (error) { /* ignore */ }
    showLogin();
  };
  el('srv-save').onclick = async () => {
    try {
      const result = await api('api/server', {
        method: 'POST',
        body: JSON.stringify({ host: el('srv-host').value.trim(), port: Number(el('srv-port').value) }),
      });
      toast('Saved. ' + (result.notes || []).join(' '), 'good');
      await load();
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
    if (!name || !baseUrl) { toast('Name and base URL are required.', 'err'); return; }
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
      toast('Added provider ' + name + '. Paste its key above.', 'good');
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
    if (draftEntries.includes(value)) { toast('Already in the list.', 'err'); return; }
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
      toast('Saved route ' + draftRoute + ' (' + result.count + ' entries).', 'good');
      await load();
    } catch (error) {
      toast(String(error.message || error), 'err');
    }
  };
  el('route-new').onclick = async () => {
    const name = prompt('New route name (letters, digits, _ or -):', 'my-route');
    if (!name) return;
    try {
      await api('api/routes', { method: 'POST', body: JSON.stringify({ action: 'save', route: name.trim(), models: [] }) });
      draftRoute = name.trim();
      draftEntries = [];
      toast('Created route ' + draftRoute + '.', 'good');
      await load();
    } catch (error) {
      toast(String(error.message || error), 'err');
    }
  };
  el('route-del').onclick = async () => {
    if (!confirm('Delete route ' + draftRoute + '?')) return;
    try {
      await api('api/routes', { method: 'POST', body: JSON.stringify({ action: 'delete', route: draftRoute }) });
      draftRoute = '';
      draftEntries = [];
      toast('Deleted route.', 'good');
      await load();
    } catch (error) {
      toast(String(error.message || error), 'err');
    }
  };
  el('limit-add').onclick = async () => {
    const key = el('limit-key').value.trim();
    const limit = Number(el('limit-val').value);
    if (!key || !Number.isFinite(limit)) { toast('Model key and a numeric limit are required.', 'err'); return; }
    try {
      await api('api/limits', { method: 'POST', body: JSON.stringify({ action: 'set', key, limit }) });
      el('limit-key').value = '';
      el('limit-val').value = '';
      toast('Set limit for ' + key + '.', 'good');
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
      toast('Saved.' + ((result.notes || []).length ? ' ' + result.notes.join(' ') : ''), 'good');
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
      toast('Pinned ' + value + '.', 'good');
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
      toast('Saved.' + ((result.notes || []).length ? ' ' + result.notes.join(' ') : ''), 'good');
      await load();
    } catch (error) {
      toast(String(error.message || error), 'err');
    }
  };
}

async function doLogin() {
  const value = el('login-pass').value;
  if (!value) { toast('Enter the admin password.', 'err'); return; }
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
  state = null;
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
  el('endpoint').textContent = state.endpoint;
  bindOnce();
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
}

function renderRoutes() {
  const host = el('routes');
  host.textContent = '';
  el('routes-blurb').textContent =
    'Order the gateway tries models in. It stops at the first one that returns usable content. '
    + 'used is today (' + state.usage.today + ' ' + state.usage.timezone
    + '); rate limits and 404s are excluded, because the provider rejected those before running the model.';
  const rows = state.routes.map((entry) => {
    let status = 'ready';
    let kind = 'ok';
    if (!entry.providerConfigured) { status = 'no key'; kind = 'no'; }
    else if (entry.zeroCost === false) { status = 'paid'; kind = 'bad'; }
    else if (entry.cooldownSeconds > 0) { status = 'cooldown ' + entry.cooldownSeconds + 's'; kind = 'warn'; }
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
      { label: '#', num: true },
      { label: 'status' },
      { label: 'provider' },
      { label: 'model' },
      { label: 'used', num: true },
    ],
    rows,
  ));
  const note = document.createElement('p');
  note.className = 'note';
  note.textContent = '* = pinned, always tried first.';
  host.appendChild(note);

  if (state.unavailableModels && state.unavailableModels.length) {
    const gone = document.createElement('p');
    gone.className = 'note';
    gone.appendChild(pill('withdrawn', 'warn'));
    gone.appendChild(document.createTextNode(
      ' Configured but missing from the provider catalog, so left out of the route above: ',
    ));
    const ids = document.createElement('span');
    ids.className = 'mono';
    ids.textContent = state.unavailableModels.join(', ');
    gone.appendChild(ids);
    host.appendChild(gone);
  }

  for (const entry of state.excludedByProvider || []) {
    const line = document.createElement('p');
    line.className = 'note';
    line.appendChild(pill('not free', 'bad'));
    line.appendChild(document.createTextNode(' '));
    const id = document.createElement('span');
    id.className = 'mono';
    id.textContent = entry.key;
    line.appendChild(id);
    line.appendChild(document.createTextNode(' \u2014 configured but '
      + entry.reason + '. Left out of the route above, since retrying cannot succeed.'));
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
