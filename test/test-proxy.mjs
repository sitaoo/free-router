#!/usr/bin/env node
// The SOCKS5 path shells out to curl. Its stdout is split into response
// headers and body incrementally so a streamed answer reaches the client
// while curl is still running, instead of after the whole transfer.
import assert from 'node:assert/strict';

import { splitLeadingHttpBlocks } from '../app/proxy.mjs';

const buffer = (text) => Buffer.from(text, 'utf8');

// Incomplete headers: wait for more bytes.
assert.equal(splitLeadingHttpBlocks(buffer('HTTP/1.1 200 OK\r\nContent-Type: te')), null);
assert.equal(splitLeadingHttpBlocks(Buffer.alloc(0)), null);

// Headers only, body still to come.
{
  const split = splitLeadingHttpBlocks(buffer('HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\n\r\n'));
  assert.equal(split.status, 200);
  assert.equal(split.headers.get('content-type'), 'text/event-stream');
  assert.equal(split.body.length, 0);
}

// Headers and the first body chunk in one read.
{
  const split = splitLeadingHttpBlocks(
    buffer('HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\n\r\ndata: first\n\n'),
  );
  assert.equal(split.status, 200);
  assert.equal(split.body.toString('utf8'), 'data: first\n\n');
}

// An interim 100-continue block is not the final response.
{
  const split = splitLeadingHttpBlocks(
    buffer('HTTP/1.1 100 Continue\r\n\r\nHTTP/1.1 201 Created\r\nX-Test: yes\r\n\r\nok'),
  );
  assert.equal(split.status, 201);
  assert.equal(split.headers.get('x-test'), 'yes');
  assert.equal(split.body.toString('utf8'), 'ok');
}

// Redirects print one block per hop; the last one is the response.
{
  const split = splitLeadingHttpBlocks(
    buffer(
      'HTTP/1.1 302 Found\r\nLocation: /next\r\n\r\nHTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\r\n{"ok":true}',
    ),
  );
  assert.equal(split.status, 200);
  assert.equal(split.body.toString('utf8'), '{"ok":true}');
}

// Error statuses are parsed like any other response.
{
  const split = splitLeadingHttpBlocks(buffer('HTTP/1.1 429 Too Many Requests\r\nRetry-After: 9\r\n\r\n{}'));
  assert.equal(split.status, 429);
  assert.equal(split.headers.get('retry-after'), '9');
}

console.log('proxy unit tests passed');
