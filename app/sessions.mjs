// Admin login sessions: a token stays the secret, the management API only
// ever exposes a short hash of it, so listing sessions cannot leak a usable
// cookie. Pure helpers so the rules are unit-testable without a server.
import crypto from 'node:crypto';

const SESSION_ID_LENGTH = 12;
const CLIENT_MAX = 120;

// Stable per-token identifier: same token, same id, but not reversible and
// useless as a credential.
export function sessionId(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex').slice(0, SESSION_ID_LENGTH);
}

// User agents are attacker-controlled text: collapse whitespace, drop control
// characters and cap the length before it reaches a table or the state file.
export function normalizeClient(userAgent) {
  const text = String(userAgent || '')
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > CLIENT_MAX ? `${text.slice(0, CLIENT_MAX - 1)}…` : text;
}

function iso(value) {
  const time = Number(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}

// Active sessions, newest first. Expired entries are skipped (the caller
// prunes them) and the current token is marked rather than hidden.
export function listSessions(sessions, { now = Date.now(), currentToken = '' } = {}) {
  const rows = [];
  for (const [token, entry] of sessions) {
    if (!entry || typeof entry !== 'object') continue;
    if (!(entry.expiresAt > now)) continue;
    rows.push({
      id: sessionId(token),
      createdAt: iso(entry.createdAt),
      expiresAt: Number.isFinite(entry.expiresAt) ? iso(entry.expiresAt) : null,
      ip: String(entry.ip || ''),
      client: normalizeClient(entry.userAgent),
      current: token === currentToken,
    });
  }
  rows.sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)));
  return rows;
}

// Removes the session with this id, or every session except the caller's
// when `others` is set. Returns how many were removed.
export function revokeSessions(sessions, { id = '', currentToken = '', others = false } = {}) {
  let removed = 0;
  for (const token of [...sessions.keys()]) {
    if (others ? token === currentToken : sessionId(token) !== id) continue;
    sessions.delete(token);
    removed += 1;
  }
  return removed;
}

// Drops expired sessions so the map cannot grow with dead logins.
export function pruneExpiredSessions(sessions, now = Date.now()) {
  let removed = 0;
  for (const [token, entry] of sessions) {
    if (entry && entry.expiresAt > now) continue;
    sessions.delete(token);
    removed += 1;
  }
  return removed;
}
