// Timezone vocabulary shared by the settings API and the web UI picker.
//
// The list comes from the runtime's own IANA table rather than a checked-in
// copy: it can never offer a zone `Intl` rejects, and it moves with the tzdata
// the process actually has. Everything here is pure so it can be unit-tested
// without starting the server.

// Zone ids are the one place a typo silently changes behaviour: an invalid
// `usage.timezone` only shows up in the log after a restart, by which point
// the day boundary has been quietly wrong. Canonicalise on save instead.
export function normalizeTimeZone(value) {
  const text = String(value ?? '').trim();
  if (!text) return '';
  try {
    // ISO 8601 uses "Z" for UTC; Intl does not, so accept it as an alias.
    const candidate = text === 'Z' ? 'UTC' : text;
    return new Intl.DateTimeFormat('en-US', { timeZone: candidate }).resolvedOptions().timeZone || null;
  } catch {
    return null;
  }
}

// The picker's option list. UTC leads because it is what an operator picks
// when they want no DST surprises, and `supportedValuesOf` leaves it out (it
// is a link to "local time", not a geographic zone) while still accepting it.
export function listTimeZones() {
  let zones = [];
  try {
    zones = Intl.supportedValuesOf('timeZone');
  } catch {
    zones = ['UTC'];
  }
  const unique = new Set(zones.filter((zone) => typeof zone === 'string' && zone && !/\s/.test(zone)));
  unique.delete('UTC');
  return ['UTC', ...[...unique].sort()];
}

// "GMT+8" is what actually tells an operator where they are; the IANA id
// alone does not. Computed at call time because it follows DST, and empty for
// zones this runtime does not know.
export function timeZoneOffsetLabel(timeZone) {
  const zone = normalizeTimeZone(timeZone);
  if (!zone) return '';
  if (zone === 'UTC') return 'UTC';
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      timeZoneName: 'shortOffset',
    }).formatToParts(new Date());
    return parts.find((part) => part.type === 'timeZoneName')?.value || '';
  } catch {
    return '';
  }
}
