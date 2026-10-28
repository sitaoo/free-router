#!/usr/bin/env node
// Responses API <-> Chat Completions translation. Pure logic, no server.

import assert from 'node:assert/strict';
import {
  createStreamTranslator,
  responseEnvelope,
  sseEvent,
  toChatRequest,
  toResponsesPayload,
  toResponsesUsage,
} from '../app/responses.mjs';

// ---- request translation -------------------------------------------------

{
  const out = toChatRequest({
    model: 'free-best',
    instructions: 'Be brief.',
    input: 'hello',
  });
  assert.equal(out.ok, true);
  assert.equal(out.body.model, 'free-best');
  assert.deepEqual(out.body.messages, [
    { role: 'system', content: 'Be brief.' },
    { role: 'user', content: 'hello' },
  ]);
  assert.equal(out.body.stream, false);
}

{
  const out = toChatRequest({
    model: 'free-best',
    input: [
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'what is this' }] },
      {
        type: 'message',
        role: 'user',
        content: [
          { type: 'input_image', image_url: 'https://example.test/a.png', detail: 'low' },
          { type: 'input_file', file_id: 'file-1' },
        ],
      },
    ],
  });
  assert.equal(out.ok, true);
  assert.deepEqual(out.body.messages[0], {
    role: 'user',
    content: [{ type: 'text', text: 'what is this' }],
  });
  // image_url keeps its detail; input_file has no chat-completions equivalent.
  assert.deepEqual(out.body.messages[1], {
    role: 'user',
    content: [{ type: 'image_url', image_url: { url: 'https://example.test/a.png', detail: 'low' } }],
  });
  // The gateway's own capability scan reads image_url out of messages, so the
  // translation is what makes Responses image input routable at all.
  assert.ok(JSON.stringify(out.body.messages).includes('"image_url"'), 'image part reaches routing');
}

{
  // A tool-call history from a previous turn: consecutive calls collapse into
  // one assistant message, followed by the tool results in the same order.
  const out = toChatRequest({
    model: 'free-best',
    input: [
      { type: 'message', role: 'user', content: 'find it' },
      { type: 'reasoning', id: 'rs_1', summary: [] },
      { type: 'function_call', call_id: 'call_a', name: 'lookup', arguments: '{"q":"x"}' },
      { type: 'function_call', call_id: 'call_b', name: 'lookup', arguments: '{"q":"y"}' },
      { type: 'function_call_output', call_id: 'call_a', output: 'first' },
      { type: 'function_call_output', call_id: 'call_b', output: [{ type: 'input_text', text: 'second' }] },
    ],
  });
  assert.equal(out.ok, true);
  assert.deepEqual(out.body.messages, [
    { role: 'user', content: 'find it' },
    {
      role: 'assistant',
      content: null,
      tool_calls: [
        { id: 'call_a', type: 'function', function: { name: 'lookup', arguments: '{"q":"x"}' } },
        { id: 'call_b', type: 'function', function: { name: 'lookup', arguments: '{"q":"y"}' } },
      ],
    },
    { role: 'tool', tool_call_id: 'call_a', content: 'first' },
    { role: 'tool', tool_call_id: 'call_b', content: 'second' },
  ]);
}

{
  const out = toChatRequest({
    model: 'free-best',
    input: 'hi',
    stream: true,
    max_output_tokens: 256,
    temperature: 0.3,
    top_p: 0.9,
    parallel_tool_calls: false,
    reasoning: { effort: 'high' },
    text: { format: { type: 'json_schema', name: 'answer', schema: { type: 'object' }, strict: true } },
    tools: [
      {
        type: 'function',
        name: 'lookup',
        description: 'Look something up.',
        parameters: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] },
        strict: true,
      },
      { type: 'custom', name: 'apply_patch', description: 'Patch files.' },
      { type: 'web_search' },
    ],
    tool_choice: 'required',
    store: false,
    prompt_cache_key: 'cache-1',
    truncation: 'disabled',
  });
  assert.equal(out.ok, true);
  assert.equal(out.body.stream, true);
  assert.equal(out.body.max_tokens, 256);
  assert.equal(out.body.temperature, 0.3);
  assert.equal(out.body.top_p, 0.9);
  assert.equal(out.body.parallel_tool_calls, false);
  assert.equal(out.body.reasoning_effort, 'high');
  assert.deepEqual(out.body.response_format, {
    type: 'json_schema',
    json_schema: { name: 'answer', schema: { type: 'object' }, strict: true },
  });
  assert.equal(out.body.tool_choice, 'required');
  assert.equal(out.body.tools.length, 2, 'hosted tools have no chat equivalent');
  assert.deepEqual(out.body.tools[0], {
    type: 'function',
    function: {
      name: 'lookup',
      description: 'Look something up.',
      parameters: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] },
      strict: true,
    },
  });
  // A custom (free-form) tool becomes a function taking one string, so the
  // model can still call it through a chat-completions upstream.
  assert.equal(out.body.tools[1].function.name, 'apply_patch');
  assert.deepEqual(out.body.tools[1].function.parameters.required, ['input']);
  assert.deepEqual([...out.customTools], ['apply_patch']);
}

{
  // Stateful features cannot be honoured by a stateless fan-out gateway.
  for (const body of [
    { input: 'hi', previous_response_id: 'resp_1' },
    { input: 'hi', store: true },
    { input: 'hi', background: true },
    { input: [{ type: 'item_reference', id: 'msg_1' }] },
  ]) {
    const out = toChatRequest(body);
    assert.equal(out.ok, false, JSON.stringify(body));
    assert.equal(out.status, 400);
    assert.equal(out.error.type, 'invalid_request_error');
  }
  assert.equal(toChatRequest({ model: 'm' }).ok, false, 'input is required');
}

// ---- response translation ------------------------------------------------

{
  const payload = toResponsesPayload(
    {
      model: 'upstream-model',
      choices: [
        {
          message: {
            role: 'assistant',
            content: 'done',
            reasoning: 'thinking',
            tool_calls: [
              { id: 'call_a', type: 'function', function: { name: 'lookup', arguments: '{"q":1}' } },
            ],
          },
          finish_reason: 'tool_calls',
        },
      ],
      usage: {
        prompt_tokens: 10,
        completion_tokens: 5,
        total_tokens: 15,
        prompt_tokens_details: { cached_tokens: 4 },
        completion_tokens_details: { reasoning_tokens: 2 },
      },
    },
    {
      model: 'gateway-model',
      request: { tools: [{ type: 'function', name: 'lookup' }], tool_choice: 'auto' },
      customTools: new Set(),
      id: 'resp_test',
      createdAt: 1700000000,
    },
  );

  assert.equal(payload.object, 'response');
  assert.equal(payload.id, 'resp_test');
  assert.equal(payload.created_at, 1700000000);
  assert.equal(payload.status, 'completed');
  assert.equal(payload.model, 'gateway-model');
  assert.equal(payload.store, false);
  assert.equal(payload.previous_response_id, null);
  assert.deepEqual(payload.tools, [{ type: 'function', name: 'lookup' }]);

  assert.deepEqual(
    payload.output.map((item) => item.type),
    ['reasoning', 'message', 'function_call'],
  );
  assert.deepEqual(payload.output[1].content, [
    { type: 'output_text', text: 'done', annotations: [], logprobs: [] },
  ]);
  assert.equal(payload.output[2].call_id, 'call_a');
  assert.equal(payload.output[2].name, 'lookup');
  assert.equal(payload.output[2].arguments, '{"q":1}');
  assert.equal(payload.output[2].status, 'completed');

  assert.deepEqual(payload.usage, {
    input_tokens: 10,
    input_tokens_details: { cached_tokens: 4, cache_write_tokens: 0 },
    output_tokens: 5,
    output_tokens_details: { reasoning_tokens: 2 },
    total_tokens: 15,
  });
}

{
  // A custom tool call round-trips as custom_tool_call with the raw input.
  const payload = toResponsesPayload(
    {
      choices: [
        {
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                id: 'call_p',
                type: 'function',
                function: { name: 'apply_patch', arguments: '{"input":"*** Begin Patch"}' },
              },
            ],
          },
          finish_reason: 'tool_calls',
        },
      ],
    },
    { model: 'm', request: {}, customTools: new Set(['apply_patch']) },
  );
  assert.equal(payload.output.length, 1);
  assert.equal(payload.output[0].type, 'custom_tool_call');
  assert.equal(payload.output[0].input, '*** Begin Patch');
  assert.equal(payload.output[0].call_id, 'call_p');
  // Usage is optional on the Response model; without an upstream report it is
  // left null rather than invented.
  assert.equal(payload.usage, null);
}

{
  // Truncation is reported as incomplete, not completed.
  const payload = toResponsesPayload(
    {
      choices: [{ message: { role: 'assistant', content: 'part' }, finish_reason: 'length' }],
    },
    { model: 'm', request: {} },
  );
  assert.equal(payload.status, 'incomplete');
  assert.equal(payload.incomplete_details.reason, 'max_output_tokens');
}

{
  assert.equal(toResponsesUsage(null), null);
  assert.deepEqual(toResponsesUsage({ prompt_tokens: 3, completion_tokens: 0 }), {
    input_tokens: 3,
    input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
    output_tokens: 0,
    output_tokens_details: { reasoning_tokens: 0 },
    total_tokens: 3,
  });
}

{
  const envelope = responseEnvelope({
    id: 'resp_x',
    model: 'm',
    createdAt: 1,
    request: { instructions: 'be nice', max_output_tokens: 9 },
    output: [],
  });
  assert.equal(envelope.object, 'response');
  assert.equal(envelope.status, 'in_progress');
  assert.equal(envelope.instructions, 'be nice');
  assert.equal(envelope.max_output_tokens, 9);
  assert.equal(envelope.parallel_tool_calls, true);
  assert.equal(envelope.tool_choice, 'auto');
  assert.deepEqual(envelope.tools, []);
  assert.equal(envelope.usage, null);
}

// ---- stream translation --------------------------------------------------

{
  const translator = createStreamTranslator({
    model: 'm',
    request: {},
    id: 'resp_s',
    createdAt: 1,
  });
  const events = [];
  events.push(...translator.created());
  events.push(...translator.push({ choices: [{ delta: { content: 'Hel' } }] }));
  events.push(...translator.push({ choices: [{ delta: { content: 'lo' } }] }));
  events.push(
    ...translator.push({
      choices: [{ delta: {}, finish_reason: 'stop' }],
      usage: { prompt_tokens: 7, completion_tokens: 2, total_tokens: 9 },
    }),
  );
  events.push(...translator.finish({ finishReason: 'stop' }));

  assert.deepEqual(
    events.map((event) => event.type),
    [
      'response.created',
      'response.output_item.added',
      'response.content_part.added',
      'response.output_text.delta',
      'response.output_text.delta',
      'response.output_text.done',
      'response.content_part.done',
      'response.output_item.done',
      'response.completed',
    ],
  );

  // Sequence numbers are contiguous and monotonic across the whole stream.
  assert.deepEqual(
    events.map((event) => event.sequence_number),
    [0, 1, 2, 3, 4, 5, 6, 7, 8],
  );

  const created = events[0];
  assert.equal(created.response.status, 'in_progress');
  assert.deepEqual(created.response.output, []);

  const deltas = events.filter((event) => event.type === 'response.output_text.delta');
  assert.equal(deltas.map((event) => event.delta).join(''), 'Hello');
  assert.equal(deltas[0].output_index, 0);
  assert.equal(deltas[0].content_index, 0);
  assert.ok(deltas[0].item_id.startsWith('msg_'));

  const done = events.at(-1);
  assert.equal(done.type, 'response.completed');
  assert.equal(done.response.status, 'completed');
  assert.equal(done.response.id, 'resp_s');
  assert.deepEqual(
    done.response.output.map((item) => item.type),
    ['message'],
  );
  assert.equal(done.response.output[0].content[0].text, 'Hello');
  assert.equal(done.response.output[0].status, 'completed');
  assert.equal(done.response.usage.input_tokens, 7);
  assert.equal(done.response.usage.output_tokens, 2);

  // The wire format carries both the event name and the JSON type.
  const wire = sseEvent(events[0]);
  assert.match(wire, /^event: response\.created\ndata: \{.*"type":"response\.created"/);
  assert.match(wire, /\n\n$/);
}

{
  // Tool calls stream as a function_call item with argument deltas.
  const translator = createStreamTranslator({ model: 'm', request: {}, id: 'resp_t' });
  const events = [];
  events.push(...translator.created());
  events.push(
    ...translator.push({
      choices: [
        {
          delta: {
            tool_calls: [
              { index: 0, id: 'call_1', type: 'function', function: { name: 'lookup', arguments: '' } },
            ],
          },
        },
      ],
    }),
  );
  events.push(
    ...translator.push({
      choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"q":' } }] } }],
    }),
  );
  events.push(
    ...translator.push({
      choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '1}' } }] } }],
    }),
  );
  events.push(...translator.finish({ finishReason: 'tool_calls' }));

  assert.deepEqual(
    events.map((event) => event.type),
    [
      'response.created',
      'response.output_item.added',
      'response.function_call_arguments.delta',
      'response.function_call_arguments.delta',
      'response.function_call_arguments.done',
      'response.output_item.done',
      'response.completed',
    ],
  );
  const added = events[1];
  assert.equal(added.output_index, 0);
  assert.equal(added.item.type, 'function_call');
  assert.equal(added.item.call_id, 'call_1');
  assert.equal(added.item.name, 'lookup');
  assert.equal(added.item.status, 'in_progress');

  const final = events.find((event) => event.type === 'response.output_item.done');
  assert.equal(final.item.arguments, '{"q":1}');
  assert.equal(final.item.status, 'completed');

  const completed = events.at(-1);
  assert.equal(completed.response.output[0].type, 'function_call');
  assert.equal(completed.response.output[0].arguments, '{"q":1}');
}

{
  // A custom tool keeps its raw string input, and Codex reads
  // custom_tool_call_input.delta for it.
  const translator = createStreamTranslator({
    model: 'm',
    request: {},
    customTools: new Set(['apply_patch']),
    id: 'resp_c',
  });
  const events = [];
  events.push(...translator.created());
  events.push(
    ...translator.push({
      choices: [
        {
          delta: {
            tool_calls: [
              {
                index: 0,
                id: 'call_p',
                type: 'function',
                function: { name: 'apply_patch', arguments: '{"input":"patch"}' },
              },
            ],
          },
        },
      ],
    }),
  );
  events.push(...translator.finish({ finishReason: 'tool_calls' }));

  assert.deepEqual(
    events.map((event) => event.type),
    [
      'response.created',
      'response.output_item.added',
      'response.custom_tool_call_input.delta',
      'response.output_item.done',
      'response.completed',
    ],
  );
  assert.equal(events[1].item.type, 'custom_tool_call');
  assert.equal(events[2].delta, 'patch');
  assert.equal(events[3].item.input, 'patch');
}

{
  // Reasoning arrives before the answer and becomes its own item, closed
  // before the message item opens.
  const translator = createStreamTranslator({ model: 'm', request: {}, id: 'resp_r' });
  const events = [];
  events.push(...translator.created());
  events.push(...translator.push({ choices: [{ delta: { reasoning: 'hm' } }] }));
  events.push(...translator.push({ choices: [{ delta: { content: 'hi' } }] }));
  events.push(...translator.finish({ finishReason: 'stop' }));

  assert.deepEqual(
    events.map((event) => event.type),
    [
      'response.created',
      'response.output_item.added',
      'response.reasoning_summary_text.delta',
      'response.reasoning_summary_text.done',
      'response.output_item.done',
      'response.output_item.added',
      'response.content_part.added',
      'response.output_text.delta',
      'response.output_text.done',
      'response.content_part.done',
      'response.output_item.done',
      'response.completed',
    ],
  );
  assert.equal(events[1].item.type, 'reasoning');
  assert.deepEqual(
    events.at(-1).response.output.map((item) => item.type),
    ['reasoning', 'message'],
  );
}

{
  // Length-limited streams end as response.incomplete.
  const translator = createStreamTranslator({ model: 'm', request: {}, id: 'resp_l' });
  const events = [];
  events.push(...translator.created());
  events.push(...translator.push({ choices: [{ delta: { content: 'x' } }] }));
  events.push(...translator.finish({ finishReason: 'length' }));
  const last = events.at(-1);
  assert.equal(last.type, 'response.incomplete');
  assert.equal(last.response.status, 'incomplete');
  assert.equal(last.response.incomplete_details.reason, 'max_output_tokens');
}

{
  // Failures surface as response.failed so a client is not left hanging on a
  // stream that simply stops.
  const translator = createStreamTranslator({ model: 'm', request: {}, id: 'resp_f' });
  const events = [];
  events.push(...translator.created());
  events.push(...translator.fail('upstream exploded'));
  const last = events.at(-1);
  assert.equal(last.type, 'response.failed');
  assert.equal(last.response.status, 'failed');
  assert.equal(last.response.error.message, 'upstream exploded');
}

{
  // A chunk with no choice (keepalive or provider-specific event) emits nothing.
  const translator = createStreamTranslator({ model: 'm', request: {} });
  assert.deepEqual(translator.push({ type: 'ping' }), []);
  assert.deepEqual(translator.push({ choices: [{ delta: {} }] }), []);
}

console.log('responses unit tests passed');
