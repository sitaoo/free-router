// Append-only audit trail for security-relevant actions. One JSON object per
// line, so the file is both human-readable and trivially parseable. Values are
// flattened and capped: nothing here may contain a newline (which would forge
// a second record) and nothing carries a secret.

const MAX_ACTION = 64;
const MAX_ACTOR = 64;
const MAX_TARGET = 120;
const MAX_DETAIL = 240;
const MAX_IP = 64;

function clean(value, max) {
  const text = String(value ?? '')
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

export function normalizeAuditRecord(input, now = Date.now()) {
  const parsed = Date.parse(input?.at || '');
  return {
    at: Number.isFinite(parsed) ? new Date(parsed).toISOString() : new Date(now).toISOString(),
    actor: clean(input?.actor, MAX_ACTOR) || 'admin',
    action: clean(input?.action, MAX_ACTION),
    target: clean(input?.target, MAX_TARGET),
    result: input?.result === 'fail' ? 'fail' : 'ok',
    ip: clean(input?.ip, MAX_IP),
    detail: clean(input?.detail, MAX_DETAIL),
  };
}

export function formatAuditLine(input, now = Date.now()) {
  return JSON.stringify(normalizeAuditRecord(input, now));
}

// Parses a whole audit file, skipping lines that were cut short by a crash
// mid-write or edited by hand.
export function parseAuditLines(text) {
  const records = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line);
      if (parsed && typeof parsed === 'object' && parsed.action) {
        records.push(normalizeAuditRecord(parsed));
      }
    } catch {
      // A torn last line is expected after a hard kill; ignore it.
    }
  }
  return records;
}
