// Gemini 3 (and thinking 2.5) refuse a tool-call follow-up that does not echo
// the `thought_signature` from the previous model turn. Hermes and other
// OpenAI-only clients strip `extra_content`, so the next hop is a 400 that
// still burns Gemini's free-tier request quota, then the router falls through
// to TokenRouter / B.AI. Replay signatures we have seen; if the history never
// passed through this process, Google's documented skip sentinel avoids the 400.
//
// https://ai.google.dev/gemini-api/docs/thought-signatures

export const SKIP_THOUGHT_SIGNATURE = 'skip_thought_signature_validator';

export function providerNeedsThoughtSignatures(provider) {
  if (!provider) return false;
  if (provider.name === 'gemini') return true;
  return /generativelanguage\.googleapis\.com/i.test(String(provider.baseUrl || ''));
}

export function isMissingThoughtSignatureError(status, message) {
  return Number(status) === 400 && /thought[_ ]signature/i.test(String(message || ''));
}

export function readThoughtSignature(toolCall) {
  if (!toolCall || typeof toolCall !== 'object') return '';
  const extra = toolCall.extra_content?.google;
  const candidates = [
    extra?.thought_signature,
    extra?.thoughtSignature,
    toolCall.thought_signature,
    toolCall.thoughtSignature,
  ];
  for (const value of candidates) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

export function writeThoughtSignature(toolCall, signature) {
  if (!toolCall || typeof toolCall !== 'object') return;
  const extra =
    toolCall.extra_content && typeof toolCall.extra_content === 'object'
      ? toolCall.extra_content
      : (toolCall.extra_content = {});
  const google = extra.google && typeof extra.google === 'object' ? extra.google : {};
  extra.google = { ...google, thought_signature: signature };
}

export function createThoughtSignatureCache(maxEntries = 5000) {
  const entries = new Map();
  return {
    remember(id, signature) {
      const key = String(id || '');
      const value = String(signature || '').trim();
      if (!key || !value) return;
      if (entries.has(key)) entries.delete(key);
      entries.set(key, value);
      while (entries.size > maxEntries) {
        entries.delete(entries.keys().next().value);
      }
    },
    lookup(id) {
      return entries.get(String(id || '')) || '';
    },
    get size() {
      return entries.size;
    },
  };
}

export function rememberSignaturesFromPayload(payload, cache) {
  if (!payload || !cache) return;
  for (const choice of payload.choices || []) {
    for (const calls of [choice?.message?.tool_calls, choice?.delta?.tool_calls]) {
      if (!Array.isArray(calls)) continue;
      for (const call of calls) {
        const signature = readThoughtSignature(call);
        if (call?.id && signature) cache.remember(call.id, signature);
      }
    }
  }
}

export function injectThoughtSignatures(body, cache) {
  if (!Array.isArray(body?.messages)) return body;
  for (const message of body.messages) {
    if (message?.role !== 'assistant' || !Array.isArray(message.tool_calls)) continue;
    for (const call of message.tool_calls) {
      if (readThoughtSignature(call)) continue;
      writeThoughtSignature(call, (call?.id && cache?.lookup?.(call.id)) || SKIP_THOUGHT_SIGNATURE);
    }
  }
  return body;
}

export function createStreamSignatureExtractor(remember) {
  let buffer = '';
  const pending = new Map();

  function ingestCall(call, fallbackIndex) {
    const index = Number.isInteger(call?.index) ? call.index : fallbackIndex;
    const slot = pending.get(index) || { id: '', signature: '' };
    if (call?.id) slot.id = String(call.id);
    const signature = readThoughtSignature(call);
    if (signature) slot.signature = signature;
    pending.set(index, slot);
    if (slot.id && slot.signature) remember(slot.id, slot.signature);
  }

  function ingestPayload(payload) {
    for (const choice of payload?.choices || []) {
      const groups = [choice?.delta?.tool_calls, choice?.message?.tool_calls];
      for (const calls of groups) {
        if (!Array.isArray(calls)) continue;
        calls.forEach((call, index) => ingestCall(call, index));
      }
    }
  }

  function ingestLine(line) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('data:')) return;
    const data = trimmed.slice(5).trim();
    if (!data || data === '[DONE]') return;
    try {
      ingestPayload(JSON.parse(data));
    } catch {
      // Keepalives and vendor comment lines are not signatures.
    }
  }

  return {
    ingestPayload,
    push(text) {
      buffer += text;
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) ingestLine(line.replace(/\r$/, ''));
    },
    flush() {
      if (buffer.trim()) ingestLine(buffer.replace(/\r$/, ''));
      buffer = '';
    },
  };
}
