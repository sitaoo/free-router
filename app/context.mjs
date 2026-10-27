// Request-size estimation for the context-window pre-filter.
//
// This is a heuristic, not a tokenizer: it only ever removes a candidate whose
// published window clearly cannot hold the request, so undercounting costs an
// extra upstream attempt rather than a rejected answer.

// Wide scripts (CJK and fullwidth punctuation) run close to one token per
// character where latin averages about four. Counted apart so a mostly Chinese
// prompt cannot slip past a limit it exceeds.
const WIDE_CHAR = /[⺀-鿿豈-﫿＀-￯]/g;

export function estimateTokens(text) {
  const value = String(text ?? '');
  if (!value) return 0;
  const wide = (value.match(WIDE_CHAR) || []).length;
  return Math.ceil(wide + (value.length - wide) / 4);
}

// Providers reject input + requested output together, so the output cap has to
// be counted against the window too. The first field set wins, matching the
// order the OpenAI-compatible APIs document.
export function requestedOutputTokens(body) {
  for (const value of [body?.max_completion_tokens, body?.max_tokens, body?.max_output_tokens]) {
    const tokens = Number(value);
    if (Number.isFinite(tokens) && tokens > 0) return tokens;
  }
  return 0;
}

function hasInlineMedia(body) {
  for (const message of body?.messages || []) {
    if (!Array.isArray(message?.content)) continue;
    for (const part of message.content) {
      if (
        part?.type === 'image_url' ||
        part?.type === 'input_image' ||
        part?.type === 'video_url' ||
        part?.type === 'input_video' ||
        part?.type === 'input_audio'
      ) {
        return true;
      }
    }
  }
  return false;
}

// Inline media is billed by resolution, not by characters, and its base64 would
// swamp the estimate. Such requests are left unestimated (0) so no candidate is
// dropped on a number that cannot be trusted.
export function estimateRequestTokens(body) {
  if (!body || typeof body !== 'object') return 0;
  if (hasInlineMedia(body)) return 0;
  const text = JSON.stringify({ messages: body.messages || [], tools: body.tools || [] });
  return estimateTokens(text) + requestedOutputTokens(body);
}

// Only a published size is trusted: an unknown one must never drop a candidate
// that might have worked.
export function fitsContext(model, estimatedTokens) {
  const limit = Number(model?.context_length);
  const needed = Number(estimatedTokens);
  if (!(limit > 0) || !(needed > 0)) return true;
  return needed <= limit;
}
