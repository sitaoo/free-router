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

  <section>
    <div class="sec-head">
      <h2>Provider keys</h2>
      <p id="keys-blurb"></p>
    </div>
    <div class="sec-body"><div id="providers"></div></div>
  </section>

  <section>
    <div class="sec-head">
      <h2>Route priority</h2>
      <p id="routes-blurb"></p>
    </div>
    <div class="sec-body"><div id="routes"></div></div>
  </section>
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

function bindOnce() {
  if (bindOnce.done) return;
  bindOnce.done = true;
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
  renderGateway();
  renderServer();
  renderProviders();
  renderRoutes();
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

load().catch((error) => toast(String(error.message || error), 'err'));
</script>
</body>
</html>
`;

export function renderPage() {
  return PAGE;
}
