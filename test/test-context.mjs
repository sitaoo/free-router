#!/usr/bin/env node
// Request-size estimation and context-window filtering.
// The estimate only ever removes a candidate that clearly cannot fit; an
// unknown window or an unknown size keeps it.
import assert from 'node:assert/strict';

import {
  estimateRequestTokens,
  estimateTokens,
  fitsContext,
  requestedOutputTokens,
} from '../app/context.mjs';

// Latin text averages ~4 chars/token; wide scripts are closer to 1 char/token.
assert.equal(estimateTokens(''), 0);
assert.equal(estimateTokens('hello'), 2);
assert.equal(estimateTokens('你好'), 2);
assert.equal(estimateTokens('a你b好c'), 3);

// The window holds the requested output too, and providers use the same sum.
assert.equal(requestedOutputTokens({ max_tokens: 100 }), 100);
assert.equal(requestedOutputTokens({ max_completion_tokens: 200, max_tokens: 100 }), 200);
assert.equal(requestedOutputTokens({ max_output_tokens: 300 }), 300);
assert.equal(requestedOutputTokens({ max_tokens: 0 }), 0);
assert.equal(requestedOutputTokens({ max_tokens: 'nope' }), 0);
assert.equal(requestedOutputTokens({}), 0);

{
  const body = {
    messages: [{ role: 'user', content: 'hello' }],
    max_tokens: 10,
  };
  assert.equal(estimateRequestTokens(body), estimateTokens(JSON.stringify({ messages: body.messages, tools: [] })) + 10);
}
assert.equal(estimateRequestTokens(null), 0);
// Inline media is billed by resolution, not characters: its base64 must not
// produce a number a candidate is dropped on.
assert.equal(
  estimateRequestTokens({
    messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:...' } }] }],
  }),
  0,
);
assert.equal(
  estimateRequestTokens({
    messages: [{ role: 'user', content: [{ type: 'input_video', input_video: 'data:...' }] }],
  }),
  0,
);

// Only a published window is trusted; unknown on either side keeps the model.
assert.equal(fitsContext({ context_length: 1000 }, 999), true);
assert.equal(fitsContext({ context_length: 1000 }, 1000), true);
assert.equal(fitsContext({ context_length: 1000 }, 1001), false);
assert.equal(fitsContext({ context_length: 0 }, 1001), true);
assert.equal(fitsContext({}, 1001), true);
assert.equal(fitsContext(null, 1001), true);
assert.equal(fitsContext({ context_length: 1000 }, 0), true);

console.log('context unit tests passed');
