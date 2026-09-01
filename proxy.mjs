import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function parseSocksProxy(raw) {
  if (!raw) return null;
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  const protocol = parsed.protocol.replace(/:$/, '').toLowerCase();
  if (!['socks', 'socks5', 'socks5h'].includes(protocol)) return null;
  if (!parsed.hostname) return null;
  return {
    host: parsed.hostname,
    port: Number(parsed.port || 1080),
    user: decodeURIComponent(parsed.username || ''),
    pass: decodeURIComponent(parsed.password || ''),
  };
}

function proxyFromEnv() {
  return parseSocksProxy(
    process.env.ALL_PROXY ||
      process.env.all_proxy ||
      process.env.HTTPS_PROXY ||
      process.env.https_proxy ||
      process.env.HTTP_PROXY ||
      process.env.http_proxy,
  );
}

function noProxyList() {
  return String(process.env.NO_PROXY || process.env.no_proxy || '')
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
}

export function shouldBypassProxy(hostname, list = noProxyList()) {
  const host = String(hostname || '').toLowerCase();
  if (!host) return true;
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (host === '127.0.0.1' || host === '::1' || host === '[::1]') return true;
  for (const rule of list) {
    if (rule === '*') return true;
    if (rule === host) return true;
    if (rule.startsWith('.') && (host.endsWith(rule) || host === rule.slice(1))) return true;
    if (!rule.startsWith('.') && host.endsWith(`.${rule}`)) return true;
  }
  return false;
}

function isDirectDnsFailure(error) {
  let current = error;
  for (let depth = 0; depth < 4 && current; depth += 1) {
    const code = current.code || '';
    if (code === 'EAI_AGAIN' || code === 'ENOTFOUND') return true;
    current = current.cause;
  }
  return /getaddrinfo|eai_again|enotfound/i.test(String(error));
}

function parseHeaderDump(text) {
  const normalized = text.replace(/\r\n/g, '\n');
  const blocks = normalized.split('\n\n').filter((block) => /HTTP\/\d/i.test(block));
  const block = blocks[blocks.length - 1] || normalized;
  const lines = block.split('\n').filter(Boolean);
  const status = Number((lines[0] || '').match(/\s(\d{3})\s/)?.[1] || 0);
  const headers = new Headers();
  for (const line of lines.slice(1)) {
    const index = line.indexOf(':');
    if (index <= 0) continue;
    headers.append(line.slice(0, index).trim(), line.slice(index + 1).trim());
  }
  return { status: status || 502, headers };
}

function socksFetch(url, init = {}) {
  const proxy = proxyFromEnv();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'free-router-curl-'));
  const headerDump = path.join(tmp, 'headers');
  const requestHeaders = path.join(tmp, 'request-headers');
  const headers = new Headers(init.headers);
  const headerLines = [];
  for (const [name, value] of headers) headerLines.push(`${name}: ${value}`);
  fs.writeFileSync(requestHeaders, `${headerLines.join('\n')}\n`, { mode: 0o600 });
  const args = [
    '-sS',
    '-D',
    headerDump,
    '-o',
    '-',
    '--socks5-hostname',
    `${proxy.host}:${proxy.port}`,
    '--max-time',
    '180',
    '-X',
    init.method || 'GET',
    '-H',
    `@${requestHeaders}`,
  ];
  if (proxy.user) args.push('--proxy-user', `${proxy.user}:${proxy.pass}`);
  const body = init.body == null ? null : Buffer.from(init.body);
  if (body) args.push('--data-binary', '@-');
  args.push(url.href);

  const cleanup = () => {
    fs.rmSync(tmp, { recursive: true, force: true });
  };

  return new Promise((resolve, reject) => {
    const child = spawn('curl', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    const chunks = [];
    let stderr = '';
    child.stdout.on('data', (chunk) => chunks.push(chunk));
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
      if (stderr.length > 2000) stderr = stderr.slice(-2000);
    });
    const abort = () => child.kill('SIGTERM');
    init.signal?.addEventListener('abort', abort, { once: true });
    const done = (error, response) => {
      init.signal?.removeEventListener('abort', abort);
      cleanup();
      if (error) reject(error);
      else resolve(response);
    };
    child.on('error', (error) => done(error));
    child.on('close', (code) => {
      try {
        const text = fs.existsSync(headerDump) ? fs.readFileSync(headerDump, 'utf8') : '';
        const parsed = parseHeaderDump(text);
        const payload = Buffer.concat(chunks);
        if (code && !payload.length) {
          done(new Error(stderr.trim() || `curl exited ${code}`));
          return;
        }
        done(null, new Response(payload, { status: parsed.status, headers: parsed.headers }));
      } catch (error) {
        done(error);
      }
    });
    if (body) child.stdin.write(body);
    child.stdin.end();
  });
}

export function installUpstreamProxy(log = console.log) {
  const proxy = proxyFromEnv();
  if (!proxy) return false;
  const nativeFetch = globalThis.fetch.bind(globalThis);
  const bypass = noProxyList();
  globalThis.fetch = async (input, init) => {
    const href = typeof input === 'string' || input instanceof URL ? String(input) : input.url;
    const url = new URL(href);
    if (shouldBypassProxy(url.hostname, bypass)) return nativeFetch(input, init);
    try {
      return await nativeFetch(input, init);
    } catch (error) {
      if (!isDirectDnsFailure(error)) throw error;
      return socksFetch(url, init || {});
    }
  };
  log('upstream SOCKS5 fallback enabled when DNS fails');
  return true;
}
