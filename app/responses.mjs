// OpenAI Responses API <-> Chat Completions translation.
//
// The gateway fans a request out across providers that overwhelmingly speak
// Chat Completions, so /v1/responses is served by translating the request,
// running the existing routing pipeline, and translating the answer back.
// Stateful features (store, previous_response_id, background, conversations)
// cannot be honoured by a stateless fan-out and are rejected explicitly rather
// than silently ignored.

import { randomUUID } from 'node:crypto';

function newId(prefix) {
  return `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 24)}`;
}

function invalid(message) {
  return {
    ok: false,
    status: 400,
    error: { message, type: 'invalid_request_error' },
  };
}

function textParts(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => (typeof part === 'string' ? part : part?.text ?? ''))
    .join('');
}

// Chat Completions has no free-form tool type, so a Responses custom tool is
// offered to the upstream as a function taking one string. The gateway turns
// the call back into custom_tool_call on the way out.
const CUSTOM_TOOL_PARAMETERS = {
  type: 'object',
  properties: {
    input: { type: 'string', description: 'The raw input for the tool.' },
  },
  required: ['input'],
  additionalProperties: false,
};

function chatTool(tool) {
  if (tool?.type === 'function') {
    const fn = {
      name: String(tool.name || ''),
      parameters: tool.parameters || { type: 'object', properties: {} },
    };
    if (tool.description) fn.description = tool.description;
    if (typeof tool.strict === 'boolean') fn.strict = tool.strict;
    return { type: 'function', function: fn };
  }
  if (tool?.type === 'custom') {
    const fn = {
      name: String(tool.name || ''),
      description: tool.description || 'Free-form tool input.',
      parameters: CUSTOM_TOOL_PARAMETERS,
    };
    return { type: 'function', function: fn };
  }
  return null;
}

function chatToolChoice(choice) {
  if (choice === undefined || choice === null) return undefined;
  if (typeof choice === 'string') return choice;
  if (choice.type === 'function' || choice.type === 'custom') {
    return { type: 'function', function: { name: choice.name } };
  }
  return undefined;
}

function chatResponseFormat(text) {
  const format = text?.format;
  if (!format || typeof format !== 'object') return undefined;
  if (format.type === 'json_object') return { type: 'json_object' };
  if (format.type === 'json_schema') {
    const schema = { name: format.name || 'response', schema: format.schema || {} };
    if (typeof format.strict === 'boolean') schema.strict = format.strict;
    if (format.description) schema.description = format.description;
    return { type: 'json_schema', json_schema: schema };
  }
  return undefined;
}

function outputText(output) {
  if (typeof output === 'string') return output;
  if (Array.isArray(output)) {
    return output
      .map((part) => (typeof part === 'string' ? part : part?.text ?? ''))
      .join('');
  }
  return '';
}

// Flattens one Responses message content array into the Chat shape. Parts with
// no chat equivalent (input_file, refusals beyond text) are dropped rather than
// forwarded as something the upstream would reject.
function chatContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts = [];
  for (const part of content) {
    if (typeof part === 'string') {
      parts.push({ type: 'text', text: part });
      continue;
    }
    if (part?.type === 'input_text' || part?.type === 'output_text' || part?.type === 'text') {
      parts.push({ type: 'text', text: String(part.text ?? '') });
      continue;
    }
    if (part?.type === 'input_image') {
      const url = typeof part.image_url === 'string' ? part.image_url : part.image_url?.url;
      if (!url) continue;
      const image = { url };
      if (part.detail) image.detail = part.detail;
      parts.push({ type: 'image_url', image_url: image });
    }
  }
  return parts;
}

export function toChatRequest(input) {
  const body = input && typeof input === 'object' ? input : {};
  if (body.previous_response_id) {
    return invalid('previous_response_id is not supported: this gateway is stateless');
  }
  if (body.conversation) {
    return invalid('conversation is not supported: this gateway is stateless');
  }
  if (body.store === true) {
    return invalid('store is not supported: this gateway is stateless');
  }
  if (body.background === true) {
    return invalid('background is not supported by this gateway');
  }
  if (body.prompt !== undefined && body.prompt !== null) {
    return invalid('prompt templates are not supported by this gateway');
  }
  const rawInput = body.input;
  if (typeof rawInput !== 'string' && !Array.isArray(rawInput)) {
    return invalid('input is required');
  }

  const customTools = new Set();
  const tools = [];
  for (const tool of Array.isArray(body.tools) ? body.tools : []) {
    if (tool?.type === 'custom' && tool.name) customTools.add(String(tool.name));
    const mapped = chatTool(tool);
    // Hosted tools (web_search, file_search, ...) need provider-side execution
    // the gateway cannot perform; omitting them is kinder than a 400.
    if (mapped) tools.push(mapped);
  }

  const messages = [];
  if (typeof body.instructions === 'string' && body.instructions.trim()) {
    messages.push({ role: 'system', content: body.instructions });
  }

  // Consecutive function_call items belong to one assistant turn, so they are
  // accumulated and flushed together, mirroring what a chat transcript holds.
  let pendingCalls = null;
  const flushCalls = () => {
    if (!pendingCalls) return;
    messages.push(pendingCalls);
    pendingCalls = null;
  };
  const pushCall = (item, args) => {
    pendingCalls ??= { role: 'assistant', content: null, tool_calls: [] };
    pendingCalls.tool_calls.push({
      id: String(item.call_id || newId('call')),
      type: 'function',
      function: { name: String(item.name || ''), arguments: args },
    });
  };

  const items = typeof rawInput === 'string' ? [{ type: 'message', role: 'user', content: rawInput }] : rawInput;
  for (const item of items) {
    if (item === null || item === undefined) continue;
    if (typeof item === 'string') {
      flushCalls();
      messages.push({ role: 'user', content: item });
      continue;
    }
    const type = item.type || (item.role ? 'message' : '');
    if (type === 'message') {
      flushCalls();
      const role = item.role === 'developer' ? 'system' : String(item.role || 'user');
      messages.push({ role, content: chatContent(item.content) });
      continue;
    }
    if (type === 'function_call') {
      pushCall(item, typeof item.arguments === 'string' ? item.arguments : JSON.stringify(item.arguments ?? {}));
      continue;
    }
    if (type === 'custom_tool_call') {
      customTools.add(String(item.name || ''));
      pushCall(item, JSON.stringify({ input: outputText(item.input) }));
      continue;
    }
    if (type === 'function_call_output' || type === 'custom_tool_call_output') {
      flushCalls();
      messages.push({
        role: 'tool',
        tool_call_id: String(item.call_id || ''),
        content: outputText(item.output),
      });
      continue;
    }
    if (type === 'reasoning') continue;
    if (type === 'item_reference') {
      return invalid('item_reference is not supported: this gateway is stateless');
    }
  }
  flushCalls();

  const chat = { messages };
  if (body.model) chat.model = body.model;
  chat.stream = body.stream === true;
  for (const field of ['temperature', 'top_p', 'user', 'parallel_tool_calls', 'prompt_cache_key']) {
    if (body[field] !== undefined && body[field] !== null) chat[field] = body[field];
  }
  if (body.max_output_tokens !== undefined && body.max_output_tokens !== null) {
    chat.max_tokens = body.max_output_tokens;
  }
  const reasoningEffort = body.reasoning?.effort;
  if (reasoningEffort) chat.reasoning_effort = reasoningEffort;
  const responseFormat = chatResponseFormat(body.text);
  if (responseFormat) chat.response_format = responseFormat;
  if (tools.length) chat.tools = tools;
  const toolChoice = chatToolChoice(body.tool_choice);
  if (toolChoice !== undefined) chat.tool_choice = toolChoice;

  return { ok: true, body: chat, customTools, hasTools: tools.length > 0 };
}

// ---- response direction --------------------------------------------------

export function toResponsesUsage(usage) {
  if (!usage || typeof usage !== 'object') return null;
  const inputTokens = Number(usage.prompt_tokens ?? usage.input_tokens ?? 0) || 0;
  const outputTokens = Number(usage.completion_tokens ?? usage.output_tokens ?? 0) || 0;
  const total = Number(usage.total_tokens);
  return {
    input_tokens: inputTokens,
    input_tokens_details: {
      cached_tokens: Number(usage.prompt_tokens_details?.cached_tokens ?? 0) || 0,
      cache_write_tokens: Number(usage.prompt_tokens_details?.cache_write_tokens ?? 0) || 0,
    },
    output_tokens: outputTokens,
    output_tokens_details: {
      reasoning_tokens: Number(usage.completion_tokens_details?.reasoning_tokens ?? 0) || 0,
    },
    total_tokens: Number.isFinite(total) ? total : inputTokens + outputTokens,
  };
}

function statusFromFinish(finishReason) {
  if (finishReason === 'length') {
    return { status: 'incomplete', incompleteDetails: { reason: 'max_output_tokens' } };
  }
  if (finishReason === 'content_filter') {
    return { status: 'incomplete', incompleteDetails: { reason: 'content_filter' } };
  }
  return { status: 'completed', incompleteDetails: null };
}

function messageItem(id, text) {
  return {
    type: 'message',
    id,
    status: 'completed',
    role: 'assistant',
    content: [{ type: 'output_text', text, annotations: [], logprobs: [] }],
  };
}

function reasoningItem(id, text) {
  return {
    type: 'reasoning',
    id,
    summary: [{ type: 'summary_text', text }],
    content: [],
  };
}

function extractCustomInput(args) {
  const raw = String(args ?? '');
  if (!raw) return '';
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed === 'string') return parsed;
    if (typeof parsed?.input === 'string') return parsed.input;
  } catch {
    // Not JSON: the model's raw text is the input.
  }
  return raw;
}

function toolCallItem(call, customTools) {
  const name = String(call?.function?.name || '');
  const args = typeof call?.function?.arguments === 'string'
    ? call.function.arguments
    : JSON.stringify(call?.function?.arguments ?? {});
  const id = newId('fc');
  const callId = String(call?.id || newId('call'));
  if (customTools.has(name)) {
    return { type: 'custom_tool_call', id, call_id: callId, name, input: extractCustomInput(args), status: 'completed' };
  }
  return { type: 'function_call', id, call_id: callId, name, arguments: args, status: 'completed' };
}

export function responseEnvelope({
  id,
  model,
  createdAt,
  request = {},
  output = [],
  status = 'in_progress',
  incompleteDetails = null,
  usage = null,
  error = null,
} = {}) {
  const envelope = {
    id: id || newId('resp'),
    object: 'response',
    created_at: createdAt || Math.floor(Date.now() / 1000),
    status,
    error,
    incomplete_details: incompleteDetails,
    model,
    output,
    parallel_tool_calls: request.parallel_tool_calls !== false,
    previous_response_id: null,
    reasoning: request.reasoning ?? null,
    store: false,
    temperature: request.temperature ?? null,
    text: request.text ?? null,
    tool_choice: request.tool_choice ?? 'auto',
    tools: Array.isArray(request.tools) ? request.tools : [],
    top_p: request.top_p ?? null,
    truncation: request.truncation ?? null,
    usage,
    user: request.user ?? null,
    metadata: request.metadata ?? null,
  };
  if (request.instructions !== undefined) envelope.instructions = request.instructions;
  if (request.max_output_tokens !== undefined) envelope.max_output_tokens = request.max_output_tokens;
  return envelope;
}

// A complete (non-streaming) answer translated from one chat payload.
export function toResponsesPayload(payload, options = {}) {
  const { model, request = {}, customTools = new Set() } = options;
  const choice = payload?.choices?.[0];
  const message = choice?.message || {};
  const output = [];
  const reasoning = textParts(message.reasoning);
  if (reasoning) output.push(reasoningItem(newId('rs'), reasoning));
  const text = textParts(message.content);
  if (text) output.push(messageItem(newId('msg'), text));
  for (const call of Array.isArray(message.tool_calls) ? message.tool_calls : []) {
    output.push(toolCallItem(call, customTools));
  }
  const finish = statusFromFinish(choice?.finish_reason);
  return responseEnvelope({
    id: options.id,
    model,
    createdAt: options.createdAt,
    request,
    output,
    status: finish.status,
    incompleteDetails: finish.incompleteDetails,
    usage: toResponsesUsage(payload?.usage),
  });
}

// ---- streaming -----------------------------------------------------------

export function sseEvent(event) {
  return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

// Turns chat-completions deltas into the Responses event sequence. Items are
// opened lazily and closed in order, so a stream that switches from reasoning
// to text to tool calls yields well-formed output_item pairs throughout.
export function createStreamTranslator({
  model,
  request = {},
  customTools = new Set(),
  id,
  createdAt,
} = {}) {
  const responseId = id || newId('resp');
  const created = createdAt || Math.floor(Date.now() / 1000);
  let sequence = 0;
  let usage = null;
  const output = [];
  let message = null;
  let reasoning = null;
  const calls = new Map();

  const event = (type, payload) => ({ type, sequence_number: sequence++, ...payload });

  // Allocated up front so every later event numbers after it, no matter how
  // long the server buffers before flushing the backlog.
  const createdEvent = event('response.created', {
    response: responseEnvelope({
      id: responseId,
      model,
      createdAt: created,
      request,
      output: [],
    }),
  });

  function openReasoning(events) {
    if (reasoning) return;
    reasoning = { id: newId('rs'), outputIndex: output.length, text: '' };
    events.push(
      event('response.output_item.added', {
        output_index: reasoning.outputIndex,
        item: reasoningItem(reasoning.id, ''),
      }),
    );
  }

  function closeReasoning(events) {
    if (!reasoning) return;
    const item = reasoningItem(reasoning.id, reasoning.text);
    events.push(
      event('response.reasoning_summary_text.done', {
        item_id: reasoning.id,
        output_index: reasoning.outputIndex,
        summary_index: 0,
        text: reasoning.text,
      }),
    );
    output.push(item);
    events.push(event('response.output_item.done', { output_index: reasoning.outputIndex, item }));
    reasoning = null;
  }

  function openMessage(events) {
    if (message) return;
    message = { id: newId('msg'), outputIndex: output.length, text: '' };
    events.push(
      event('response.output_item.added', {
        output_index: message.outputIndex,
        item: { type: 'message', id: message.id, status: 'in_progress', role: 'assistant', content: [] },
      }),
    );
    events.push(
      event('response.content_part.added', {
        item_id: message.id,
        output_index: message.outputIndex,
        content_index: 0,
        part: { type: 'output_text', text: '', annotations: [], logprobs: [] },
      }),
    );
  }

  function closeMessage(events) {
    if (!message) return;
    const item = messageItem(message.id, message.text);
    events.push(
      event('response.output_text.done', {
        item_id: message.id,
        output_index: message.outputIndex,
        content_index: 0,
        text: message.text,
        logprobs: [],
      }),
    );
    events.push(
      event('response.content_part.done', {
        item_id: message.id,
        output_index: message.outputIndex,
        content_index: 0,
        part: { type: 'output_text', text: message.text, annotations: [], logprobs: [] },
      }),
    );
    output.push(item);
    events.push(event('response.output_item.done', { output_index: message.outputIndex, item }));
    message = null;
  }

  function openCall(events, index, call) {
    const name = String(call?.function?.name || '');
    // Name normally arrives with the first fragment; when it does not, the item
    // is opened as a function call and corrected on the next fragment.
    const state = {
      index,
      itemId: newId('fc'),
      callId: String(call?.id || newId('call')),
      name,
      custom: customTools.has(name),
      arguments: '',
      outputIndex: output.length,
      open: true,
    };
    calls.set(index, state);
    const item = state.custom
      ? { type: 'custom_tool_call', id: state.itemId, call_id: state.callId, name, input: '', status: 'in_progress' }
      : { type: 'function_call', id: state.itemId, call_id: state.callId, name, arguments: '', status: 'in_progress' };
    events.push(event('response.output_item.added', { output_index: state.outputIndex, item }));
    return state;
  }

  function closeCall(events, state) {
    if (!state.open) return;
    state.open = false;
    if (state.custom) {
      const input = extractCustomInput(state.arguments);
      // Codex reads custom_tool_call_input.delta for free-form tools; the input
      // is only extractable once the JSON wrapper is complete, so it is emitted
      // as one fragment at close.
      events.push(
        event('response.custom_tool_call_input.delta', {
          item_id: state.itemId,
          output_index: state.outputIndex,
          delta: input,
        }),
      );
      const item = {
        type: 'custom_tool_call',
        id: state.itemId,
        call_id: state.callId,
        name: state.name,
        input,
        status: 'completed',
      };
      output.push(item);
      events.push(event('response.output_item.done', { output_index: state.outputIndex, item }));
      return;
    }
    events.push(
      event('response.function_call_arguments.done', {
        item_id: state.itemId,
        output_index: state.outputIndex,
        arguments: state.arguments,
      }),
    );
    const item = {
      type: 'function_call',
      id: state.itemId,
      call_id: state.callId,
      name: state.name,
      arguments: state.arguments,
      status: 'completed',
    };
    output.push(item);
    events.push(event('response.output_item.done', { output_index: state.outputIndex, item }));
  }

  return {
    created() {
      return [createdEvent];
    },

    push(chunk) {
      const events = [];
      if (chunk?.usage) usage = chunk.usage;
      const delta = chunk?.choices?.[0]?.delta;
      if (!delta) return events;

      const reasoningDelta = typeof delta.reasoning === 'string' ? delta.reasoning : '';
      if (reasoningDelta) {
        openReasoning(events);
        reasoning.text += reasoningDelta;
        events.push(
          event('response.reasoning_summary_text.delta', {
            item_id: reasoning.id,
            output_index: reasoning.outputIndex,
            summary_index: 0,
            delta: reasoningDelta,
          }),
        );
      }

      const contentDelta = typeof delta.content === 'string' ? delta.content : '';
      if (contentDelta) {
        closeReasoning(events);
        openMessage(events);
        message.text += contentDelta;
        events.push(
          event('response.output_text.delta', {
            item_id: message.id,
            output_index: message.outputIndex,
            content_index: 0,
            delta: contentDelta,
            logprobs: [],
          }),
        );
      }

      const toolCalls = Array.isArray(delta.tool_calls) ? delta.tool_calls : [];
      if (toolCalls.length) {
        closeReasoning(events);
        closeMessage(events);
        for (const call of toolCalls) {
          const index = Number(call?.index ?? 0);
          let state = calls.get(index);
          const name = call?.function?.name;
          if (!state) {
            state = openCall(events, index, call);
          } else {
            if (call?.id) state.callId = String(call.id);
            if (name && !state.name) {
              state.name = String(name);
              state.custom = customTools.has(state.name);
            }
          }
          const fragment = call?.function?.arguments;
          if (typeof fragment === 'string' && fragment) {
            state.arguments += fragment;
            if (!state.custom) {
              events.push(
                event('response.function_call_arguments.delta', {
                  item_id: state.itemId,
                  output_index: state.outputIndex,
                  delta: fragment,
                }),
              );
            }
          }
        }
      }
      return events;
    },

    finish({ finishReason = '' } = {}) {
      const events = [];
      closeReasoning(events);
      closeMessage(events);
      for (const state of calls.values()) closeCall(events, state);
      const finish = statusFromFinish(finishReason);
      const response = responseEnvelope({
        id: responseId,
        model,
        createdAt: created,
        request,
        output: [...output],
        status: finish.status,
        incompleteDetails: finish.incompleteDetails,
        usage: toResponsesUsage(usage),
      });
      events.push(
        event(finish.status === 'incomplete' ? 'response.incomplete' : 'response.completed', { response }),
      );
      return events;
    },

    fail(reason) {
      const response = responseEnvelope({
        id: responseId,
        model,
        createdAt: created,
        request,
        output: [...output],
        status: 'failed',
        error: { code: 'server_error', message: String(reason || 'upstream failure') },
      });
      return [event('response.failed', { response })];
    },
  };
}
