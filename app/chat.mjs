// Chat Completions hardening: the request whitelist and the stream
// normalizer. Both are pure so they can be unit tested; server.mjs wires them
// into the routing pipeline.
//
// The gateway fans a request out across providers who all claim OpenAI
// compatibility but differ in how strictly they validate. Clients (Open
// WebUI in particular) attach fields of their own, and a strict upstream such
// as Gemini's compatibility layer answers `400 Unknown name "features"`
// instead of ignoring them. Rebuilding the request from the documented Chat
// Completions fields keeps that junk out of every provider.
//
// On the way back, providers disagree about chunk shape: some omit `id`,
// `object`, or `created`, some name reasoning `reasoning` and others
// `reasoning_content`, and some simply stop without a terminal frame. The
// normalizer makes every chunk look like one well-formed OpenAI stream.

import { randomUUID } from 'node:crypto';

// The fields the Chat Completions API defines. Anything else is a client or
// provider extension the upstream may reject; it is dropped by default.
export const CHAT_REQUEST_FIELDS = [
  'model',
  'messages',
  'stream',
  'temperature',
  'top_p',
  'n',
  'stop',
  'max_tokens',
  'max_completion_tokens',
  'presence_penalty',
  'frequency_penalty',
  'logit_bias',
  'logprobs',
  'top_logprobs',
  'user',
  'seed',
  'response_format',
  'tools',
  'tool_choice',
  'parallel_tool_calls',
  'reasoning_effort',
  'service_tier',
  'modalities',
  'audio',
  'prediction',
];

const CHAT_FIELD_SET = new Set(CHAT_REQUEST_FIELDS);

// `streamOptions` is a provider capability, not an API fact: Gemini's
// compatibility layer rejects it while most OpenAI-compatible gateways need
// it for usage in the final chunk.
export function pickChatRequestFields(body, { streamOptions = true } = {}) {
  const out = {};
  if (!body || typeof body !== 'object') return out;
  for (const field of CHAT_REQUEST_FIELDS) {
    const value = body[field];
    if (value !== undefined) out[field] = value;
  }
  const options = body.stream_options;
  if (streamOptions && options && typeof options === 'object' && !Array.isArray(options)) {
    out.stream_options = options;
  }
  return out;
}

export function chatDataFrame(payload) {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

export const CHAT_DONE_FRAME = 'data: [DONE]\n\n';

function generatedId() {
  return `chatcmpl-${randomUUID().replace(/-/g, '').slice(0, 24)}`;
}

// Normalizes one provider chunk at a time. `model` is the id the client
// requested (`free-best` or a named model), never the provider's internal
// model, so a failover never changes the model the client believes it used.
export function createChatStreamNormalizer({ model, id, created } = {}) {
  let streamId = typeof id === 'string' && id ? id : '';
  let createdAt = Number(created);
  let finishSeen = false;

  const resolvedId = () => {
    if (!streamId) streamId = generatedId();
    return streamId;
  };

  function push(payload) {
    if (!payload || typeof payload !== 'object') return payload;
    // Error frames are already valid OpenAI error payloads.
    if (payload.error) return payload;
    const choices = Array.isArray(payload.choices) ? payload.choices : [];
    for (const choice of choices) {
      if (choice?.finish_reason) finishSeen = true;
      const delta = choice?.delta;
      if (!delta || typeof delta !== 'object') continue;
      if (typeof delta.reasoning === 'string' && typeof delta.reasoning_content !== 'string') {
        delta.reasoning_content = delta.reasoning;
      }
      if (typeof delta.reasoning_content === 'string' && typeof delta.reasoning !== 'string') {
        delta.reasoning = delta.reasoning_content;
      }
    }
    const upstreamId = typeof payload.id === 'string' && payload.id ? payload.id : '';
    if (upstreamId && !streamId) streamId = upstreamId;
    const upstreamCreated = Number(payload.created);
    if (!Number.isFinite(createdAt) || createdAt <= 0) {
      createdAt = Number.isFinite(upstreamCreated) && upstreamCreated > 0
        ? upstreamCreated
        : Math.floor(Date.now() / 1000);
    }
    return {
      ...payload,
      id: resolvedId(),
      object: 'chat.completion.chunk',
      created: createdAt,
      model,
    };
  }

  return {
    push,
    finishSeen: () => finishSeen,
    // Clients stop on [DONE], but a missing finish_reason leaves some of them
    // believing the answer was cut off. Emit a terminal chunk when needed.
    terminal(finishReason = 'stop') {
      return {
        id: resolvedId(),
        object: 'chat.completion.chunk',
        created: Number.isFinite(createdAt) && createdAt > 0 ? createdAt : Math.floor(Date.now() / 1000),
        model,
        choices: [{ index: 0, delta: {}, finish_reason: finishReason || 'stop' }],
      };
    },
  };
}
