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

// Splits curl's `-i` output into the final response head and the body that
// follows it. Returns null while the head is still incomplete, so a streaming
// caller can wait for more bytes instead of buffering the whole transfer.
export function splitLeadingHttpBlocks(buffer) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) return null;
  let offset = 0;
  const statusLine = /^HTTP\/\d(?:\.\d)?\s+\d{3}/;
  while (offset < buffer.length) {
    const end = buffer.indexOf('\r\n\r\n', offset);
    if (end < 0) return null;
    const headerText = buffer.subarray(offset, end).toString('latin1');
    if (!statusLine.test(headerText.trimStart())) return null;
    const bodyStart = end + 4;
    const rest = buffer.subarray(bodyStart);
    // A following status line is another hop: an interim 100-continue, or a
    // redirect curl followed. Keep scanning for the final one.
    if (rest.length && statusLine.test(rest.toString('latin1').trimStart())) {
      offset = bodyStart;
      continue;
    }
    const parsed = parseHeaderDump(headerText);
    return { status: parsed.status, headers: parsed.headers, body: Buffer.from(rest) };
  }
  return null;
}

// Streaming bridge: curl writes headers and body interleaved to stdout, and
// the bytes after the final header block are exposed as the Response body as
// they arrive. Previously the whole transfer was buffered, which made SSE
// answers arrive in one burst (and hit curl's hard deadline) whenever the
// SOCKS fallback was active.
function socksFetch(url, init = {}) {
  const proxy = proxyFromEnv();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'free-router-curl-'));
  const requestHeaders = path.join(tmp, 'request-headers');
  const headers = new Headers(init.headers);
  const headerLines = [];
  for (const [name, value] of headers) headerLines.push(`${name}: ${value}`);
  fs.writeFileSync(requestHeaders, `${headerLines.join('\n')}\n`, { mode: 0o600 });
  // `-i` puts the response head on stdout in front of the body, `-N` keeps
  // curl from buffering, and the caller's signal (attempt timeout, client
  // disconnect) is what bounds the transfer. The hard deadline only guards a
  // caller that forgot to pass one.
  const args = [
    '-sS',
    '-i',
    '-N',
    '--connect-timeout',
    '30',
    '--max-time',
    '1800',
    '--socks5-hostname',
    `${proxy.host}:${proxy.port}`,
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
    let pending = Buffer.alloc(0);
    let response = null;
    let stderr = '';
    let closed = false;
    let streamController = null;
    const stream = new ReadableStream({
      start(controller) {
        streamController = controller;
      },
      cancel() {
        child.kill('SIGTERM');
      },
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
      if (stderr.length > 2000) stderr = stderr.slice(-2000);
    });
    const abort = () => child.kill('SIGTERM');
    init.signal?.addEventListener('abort', abort, { once: true });
    const done = (error) => {
      if (closed) return;
      closed = true;
      init.signal?.removeEventListener('abort', abort);
      cleanup();
      if (!response) {
        if (error) reject(error);
        else reject(new Error('curl exited without a response'));
        return;
      }
      if (error) streamController.error(error);
      else streamController.close();
    };
    const deliver = (split) => {
      const status = split.status >= 200 && split.status <= 599 ? split.status : 502;
      response = new Response(stream, { status, headers: split.headers });
      resolve(response);
      if (split.body.length) streamController.enqueue(split.body);
    };
    if (init.signal?.aborted) {
      child.kill('SIGTERM');
      done(new Error('aborted'));
      return;
    }
    child.stdout.on('data', (chunk) => {
      if (closed) return;
      if (response) {
        streamController.enqueue(chunk);
        return;
      }
      pending = pending.length ? Buffer.concat([pending, chunk]) : Buffer.from(chunk);
      const split = splitLeadingHttpBlocks(pending);
      if (!split) return;
      pending = Buffer.alloc(0);
      deliver(split);
    });
    child.on('error', (error) => done(error));
    child.on('close', (code) => {
      if (!response) {
        // A complete head with no body bytes is a valid empty response; any
        // other ending without a head is the error curl reported.
        const split = pending.length ? splitLeadingHttpBlocks(pending) : null;
        if (split) {
          deliver(split);
          done(code ? new Error(stderr.trim() || `curl exited ${code}`) : null);
          return;
        }
        done(new Error(stderr.trim() || `curl exited ${code}`));
        return;
      }
      done(code ? new Error(stderr.trim() || `curl exited ${code}`) : null);
    });
    if (body) child.stdin.write(body);
    child.stdin.end();
  });
}

function hostMatches(hostname, hosts) {
  const host = String(hostname || '').toLowerCase();
  for (const raw of hosts) {
    const rule = String(raw || '').toLowerCase().replace(/^\./, '');
    if (!rule) continue;
    if (host === rule || host.endsWith(`.${rule}`)) return true;
  }
  return false;
}

export function installUpstreamProxy(log = console.log, options = {}) {
  const proxy = proxyFromEnv();
  if (!proxy) return false;
  const nativeFetch = globalThis.fetch.bind(globalThis);
  const bypass = noProxyList();
  const socksFirstHosts = options.socksFirstHosts || [];
  globalThis.fetch = async (input, init) => {
    const href = typeof input === 'string' || input instanceof URL ? String(input) : input.url;
    const url = new URL(href);
    if (shouldBypassProxy(url.hostname, bypass)) return nativeFetch(input, init);
    if (hostMatches(url.hostname, socksFirstHosts)) return socksFetch(url, init || {});
    try {
      return await nativeFetch(input, init);
    } catch (error) {
      if (!isDirectDnsFailure(error)) throw error;
      return socksFetch(url, init || {});
    }
  };
  log(
    socksFirstHosts.length
      ? `upstream SOCKS5 enabled (DNS fallback; first-hop hosts: ${socksFirstHosts.join(', ')})`
      : 'upstream SOCKS5 fallback enabled when DNS fails',
  );
  return true;
}
