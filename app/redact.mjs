const SECRET_NAME =
  /(?:API[_-]?KEY|SECRET|TOKEN|PASSWORD|PASSWD|PRIVATE[_-]?KEY|ACCESS[_-]?KEY|CREDENTIAL)$/i;
const SECRET_ASSIGNMENT =
  /^([A-Za-z_][A-Za-z0-9_]*(?:API[_-]?KEY|SECRET|TOKEN|PASSWORD|PASSWD|PRIVATE[_-]?KEY|ACCESS[_-]?KEY|CREDENTIAL)[A-Za-z0-9_]*)\s*=\s*.+$/gim;
const MIN_SECRET_LENGTH = 8;

function isSecretEnvName(name) {
  return SECRET_NAME.test(String(name || ''));
}

function proxyCredentials(value) {
  try {
    const parsed = new URL(value);
    const parts = [];
    if (parsed.password) {
      parts.push(value);
      parts.push(decodeURIComponent(parsed.password));
      if (parsed.username) parts.push(decodeURIComponent(parsed.username));
    }
    return parts;
  } catch {
    return [];
  }
}

export function secretValuesFromEnv(env = process.env) {
  const values = new Set();
  for (const [name, value] of Object.entries(env)) {
    if (typeof value !== 'string' || !value) continue;
    if (/^(HTTPS?|ALL)?_?PROXY$/i.test(name) || name.toLowerCase().endsWith('_proxy')) {
      for (const part of proxyCredentials(value)) {
        if (part.length >= MIN_SECRET_LENGTH) values.add(part);
      }
      continue;
    }
    if (!isSecretEnvName(name)) continue;
    if (value.length < MIN_SECRET_LENGTH) continue;
    values.add(value);
  }
  return [...values].sort((a, b) => b.length - a.length);
}

export function redactSecretText(text, secrets) {
  if (typeof text !== 'string' || !text) return { text, count: 0 };
  let count = 0;
  let next = text.replace(SECRET_ASSIGNMENT, (_match, name) => {
    count += 1;
    return `${name}=[REDACTED]`;
  });
  for (const secret of secrets) {
    if (!secret || next.indexOf(secret) === -1) continue;
    const pieces = next.split(secret);
    count += pieces.length - 1;
    next = pieces.join('[REDACTED]');
  }
  return { text: next, count };
}

export function redactSecretsDeep(value, secrets, stats = { count: 0 }) {
  if (typeof value === 'string') {
    const result = redactSecretText(value, secrets);
    stats.count += result.count;
    return result.text;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => redactSecretsDeep(entry, secrets, stats));
  }
  if (value && typeof value === 'object') {
    const copy = {};
    for (const [key, entry] of Object.entries(value)) {
      copy[key] = redactSecretsDeep(entry, secrets, stats);
    }
    return copy;
  }
  return value;
}

export function createSecretRedactor(env = process.env) {
  const secrets = secretValuesFromEnv(env);
  return {
    secrets,
    redact(payload) {
      const stats = { count: 0 };
      const value = redactSecretsDeep(payload, secrets, stats);
      return { value, count: stats.count };
    },
  };
}
