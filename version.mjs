// Bitcoin Core-style client version.
//
// Four integers pack into one CLIENT_VERSION, the same way bitcoind does:
//
//   major * 1_000_000 + minor * 10_000 + revision * 100 + build
//
// A release displays as major.minor.revision (build omitted when 0).
// A release candidate sets IS_RELEASE false and BUILD to the rc number,
// so 1.0.0 with build 1 is tagged v1.0rc1, matching Bitcoin's v23.0rc1.
//
// Bump major for incompatible changes, minor for features, revision for
// fixes. Do not retag; cut the next number.

export const CLIENT_NAME = 'FreeRouter';
export const CLIENT_VERSION_MAJOR = 1;
export const CLIENT_VERSION_MINOR = 0;
export const CLIENT_VERSION_REVISION = 0;
export const CLIENT_VERSION_BUILD = 0;
export const CLIENT_VERSION_IS_RELEASE = true;
export const COPYRIGHT_YEAR = 2026;

export const CLIENT_VERSION =
  1_000_000 * CLIENT_VERSION_MAJOR +
  10_000 * CLIENT_VERSION_MINOR +
  100 * CLIENT_VERSION_REVISION +
  CLIENT_VERSION_BUILD;

export function formatVersion(nVersion = CLIENT_VERSION) {
  const major = Math.floor(nVersion / 1_000_000);
  const minor = Math.floor(nVersion / 10_000) % 100;
  const revision = Math.floor(nVersion / 100) % 100;
  const build = nVersion % 100;
  if (build === 0) return `${major}.${minor}.${revision}`;
  return `${major}.${minor}.${revision}.${build}`;
}

export function formatTag({
  major = CLIENT_VERSION_MAJOR,
  minor = CLIENT_VERSION_MINOR,
  revision = CLIENT_VERSION_REVISION,
  build = CLIENT_VERSION_BUILD,
  release = CLIENT_VERSION_IS_RELEASE,
} = {}) {
  const base = revision === 0 ? `${major}.${minor}` : `${major}.${minor}.${revision}`;
  if (!release && build > 0) return `v${base}rc${build}`;
  return `v${base}`;
}

export function formatFullVersion() {
  return formatVersion();
}

// BIP 14 user-agent, e.g. /FreeRouter:1.0.0/
export function formatSubVersion(name = CLIENT_NAME, nClientVersion = CLIENT_VERSION, comments = []) {
  let extra = '';
  if (comments.length) extra = `(${comments.join('; ')})`;
  return `/${name}:${formatVersion(nClientVersion)}${extra}/`;
}

export function versionInfo() {
  return {
    major: CLIENT_VERSION_MAJOR,
    minor: CLIENT_VERSION_MINOR,
    revision: CLIENT_VERSION_REVISION,
    build: CLIENT_VERSION_BUILD,
    packed: CLIENT_VERSION,
    release: CLIENT_VERSION_IS_RELEASE,
    display: formatFullVersion(),
    tag: formatTag(),
    subversion: formatSubVersion(),
  };
}
