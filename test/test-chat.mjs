#!/usr/bin/env node
// Chat-path hardening: upstream requests keep only fields the Chat
// Completions API defines (Gemini 400s on unknown names), and upstream stream
// chunks are normalized into the shape clients actually parse.
import assert from 'node:assert/strict';

import { createChatStreamNormalizer, pickChatRequestFields } from '../app/chat.mjs';

// ---- request whitelist ---------------------------------------------------

// Fields Open WebUI and other UIs add for their own bookkeeping never reach
// the provider; the standard ones survive untouched.
{
  const body = {
    model: 'free-best',
    messages: [{ role: 'user', content: 'hi' }],
    stream: true,
    temperature: 0.2,
    top_p: 0.9,
    stop: ['END'],
    max_tokens: 64,
    tools: [{ type: 'function', function: { name: 'x' } }],
    tool_choice: 'auto',
    response_format: { type: 'json_object' },
    user: 'u-1',
    seed: 7,
    presence_penalty: 0.1,
    frequency_penalty: 0.1,
    logit_bias: { '1': -1 },
    parallel_tool_calls: false,
    reasoning_effort: 'low',
    stream_options: { include_usage: true },
    // Not Chat Completions:
    features: { web: true },
    variables: {},
    files: [],
    tool_ids: ['x'],
    metadata: { chat_id: 'abc' },
    models: ['a'],
    route: 'r',
    undefined_field: undefined,
  };
  const picked = pickChatRequestFields(body, { streamOptions: true });
  assert.equal(picked.model, 'free-best');
  assert.equal(picked.stream, true);
  assert.deepEqual(picked.stream_options, { include_usage: true });
  assert.equal(picked.tools.length, 1);
  for (const key of ['features', 'variables', 'files', 'tool_ids', 'metadata', 'models', 'route', 'undefined_field']) {
    assert.equal(key in picked, false, `${key} must be stripped`);
  }
}

// Providers that reject stream_options get a request without it; the switch
// is per provider so OpenAI-compatible ones keep reporting usage.
{
  const body = { model: 'm', messages: [], stream: true, stream_options: { include_usage: true } };
  const picked = pickChatRequestFields(body, { streamOptions: false });
  assert.equal('stream_options' in picked, false);
  assert.equal(picked.stream, true);
}

// A non-object stream_options is never forwarded.
{
  const picked = pickChatRequestFields({ stream: true, stream_options: 'yes' }, { streamOptions: true });
  assert.equal('stream_options' in picked, false);
}

// ---- stream normalization ------------------------------------------------

// Chunks gain a stable id, object, created, and the model the client asked
// for; provider-private fields are preserved.
{
  const normalizer = createChatStreamNormalizer({ model: 'free-best' });
  const first = normalizer.push({
    id: 'chatcmpl-up',
    created: 123,
    object: 'chat.completion.chunk',
    model: 'gemini-3.5-flash-lite',
    choices: [{ index: 0, delta: { content: 'hi' }, finish_reason: null }],
    provider_note: 'kept',
  });
  assert.equal(first.id, 'chatcmpl-up');
  assert.equal(first.object, 'chat.completion.chunk');
  assert.equal(first.created, 123);
  assert.equal(first.model, 'free-best');
  assert.equal(first.provider_note, 'kept');

  const second = normalizer.push({
    choices: [{ index: 0, delta: { content: '!' }, finish_reason: 'stop' }],
  });
  assert.equal(second.id, 'chatcmpl-up', 'later chunks reuse the first id');
  assert.equal(second.created, 123);
  assert.equal(second.model, 'free-best');
  assert.equal(normalizer.finishSeen(), true);
}

// Reasoning field naming is unified: whichever key the provider used, both
// spellings carry the text.
{
  const normalizer = createChatStreamNormalizer({ model: 'free-best' });
  const fromReasoning = normalizer.push({
    choices: [{ index: 0, delta: { reasoning: 'think-a' }, finish_reason: null }],
  });
  assert.equal(fromReasoning.choices[0].delta.reasoning, 'think-a');
  assert.equal(fromReasoning.choices[0].delta.reasoning_content, 'think-a');

  const fromReasoningContent = normalizer.push({
    choices: [{ index: 0, delta: { reasoning_content: 'think-b' }, finish_reason: null }],
  });
  assert.equal(fromReasoningContent.choices[0].delta.reasoning, 'think-b');
  assert.equal(fromReasoningContent.choices[0].delta.reasoning_content, 'think-b');
}

// Gemini's compatibility layer streams a whole tool call without `index` and
// then closes with finish_reason "stop". OpenAI clients aggregate tool calls
// by index and only run them when the finish reason says tool_calls, so both
// are repaired before the chunk leaves the gateway.
{
  const normalizer = createChatStreamNormalizer({ model: 'free-best' });
  const first = normalizer.push({
    choices: [
      {
        index: 0,
        delta: {
          role: 'assistant',
          tool_calls: [
            {
              id: 'call_a',
              type: 'function',
              extra_content: { google: { thought_signature: 'sig' } },
              function: { name: 'get_time', arguments: '{"tz":"UTC"}' },
            },
          ],
        },
        finish_reason: null,
      },
    ],
  });
  assert.equal(first.choices[0].delta.tool_calls[0].index, 0, 'an indexless tool call gets a slot');
  assert.equal(first.choices[0].delta.tool_calls[0].id, 'call_a');
  assert.deepEqual(
    first.choices[0].delta.tool_calls[0].extra_content,
    { google: { thought_signature: 'sig' } },
    'provider extensions survive normalization',
  );
  assert.equal(first.choices[0].delta.tool_calls[0].type, 'function');

  // A parallel call takes the next slot ...
  const parallel = normalizer.push({
    choices: [{ index: 0, delta: { tool_calls: [{ id: 'call_b', function: { name: 'get_date', arguments: '{}' } }] }, finish_reason: null }],
  });
  assert.equal(parallel.choices[0].delta.tool_calls[0].index, 1);

  // ... while a later fragment for an earlier id keeps that id's slot.
  const fragment = normalizer.push({
    choices: [{ index: 0, delta: { tool_calls: [{ id: 'call_a', function: { arguments: 'x' } }] }, finish_reason: null }],
  });
  assert.equal(fragment.choices[0].delta.tool_calls[0].index, 0);

  // An explicit index is kept, and later synthetic slots start after it.
  const explicit = normalizer.push({
    choices: [{ index: 0, delta: { tool_calls: [{ id: 'call_c', index: 4, function: { name: 'x', arguments: '{}' } }] }, finish_reason: null }],
  });
  assert.equal(explicit.choices[0].delta.tool_calls[0].index, 4);
  const next = normalizer.push({
    choices: [{ index: 0, delta: { tool_calls: [{ id: 'call_d', function: { name: 'y', arguments: '{}' } }] }, finish_reason: null }],
  });
  assert.equal(next.choices[0].delta.tool_calls[0].index, 5);

  // The terminal frame advertises tool_calls even when the upstream said stop.
  const stop = normalizer.push({
    choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
  });
  assert.equal(stop.choices[0].finish_reason, 'tool_calls');
  assert.equal(normalizer.terminal('stop').choices[0].finish_reason, 'tool_calls');
}

// Content-only streams keep the finish reason the upstream sent.
{
  const normalizer = createChatStreamNormalizer({ model: 'free-best' });
  normalizer.push({ choices: [{ index: 0, delta: { content: 'hi' }, finish_reason: null }] });
  const stop = normalizer.push({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
  assert.equal(stop.choices[0].finish_reason, 'stop');
  assert.equal(normalizer.terminal('stop').choices[0].finish_reason, 'stop');
}

// Error payloads pass through untouched, so a mid-stream failure can be
// forwarded verbatim.
{
  const normalizer = createChatStreamNormalizer({ model: 'free-best' });
  const error = { error: { message: 'boom', type: 'upstream_error' } };
  assert.deepEqual(normalizer.push(error), error);
}

// When the upstream never sent a finish reason, a terminal chunk can be
// synthesized so clients see a complete answer.
{
  const normalizer = createChatStreamNormalizer({ model: 'free-best', id: 'chatcmpl-fixed', created: 5 });
  normalizer.push({ choices: [{ index: 0, delta: { content: 'x' }, finish_reason: null }] });
  assert.equal(normalizer.finishSeen(), false);
  const terminal = normalizer.terminal();
  assert.equal(terminal.id, 'chatcmpl-fixed');
  assert.equal(terminal.model, 'free-best');
  assert.equal(terminal.choices[0].finish_reason, 'stop');
  assert.deepEqual(terminal.choices[0].delta, {});
}

console.log('chat unit tests passed');
