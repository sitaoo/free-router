// Reads what Google's API says about its own free tier.
//
// A 429 from Gemini means one of two very different things, and treating them
// alike is expensive in both directions:
//
//   1. the model has no free allowance at all  -> retrying is always futile
//   2. today's free allowance is used up       -> retrying tomorrow works
//
// The response tells them apart, but the pieces are split across two places.
// The free-form `message` carries the numbers:
//
//   * Quota exceeded for metric: <metric>, limit: 0, model: gemini-3.1-pro
//
// while `details[].QuotaFailure.violations[]` carries the window each number
// belongs to as `quotaId`, e.g. GenerateRequestsPerDayPerProjectPerModel-FreeTier.
// Neither half is sufficient on its own.

const QUOTA_LINE = /Quota exceeded for metric:\s*([^,]+),\s*limit:\s*(\d+)/gi;
const FREE_TIER_METRIC = /free_tier/i;
const REQUEST_METRIC = /_requests$/i;

function quotaWindow(quotaId) {
  if (/PerDay/i.test(quotaId)) return 'day';
  if (/PerMinute/i.test(quotaId)) return 'minute';
  return '';
}

function detailsOfType(payload, type) {
  const details = payload?.error?.details;
  if (!Array.isArray(details)) return [];
  return details.filter((detail) => String(detail?.['@type'] || '').endsWith(type));
}

function parseRetryDelayMs(payload) {
  for (const detail of detailsOfType(payload, 'RetryInfo')) {
    const seconds = Number(String(detail.retryDelay || '').replace(/s$/, ''));
    if (Number.isFinite(seconds) && seconds > 0) return Math.ceil(seconds * 1000);
  }
  const match = String(payload?.error?.message || '').match(/retry in ([\d.]+)s/i);
  const seconds = match ? Number(match[1]) : NaN;
  return Number.isFinite(seconds) && seconds > 0 ? Math.ceil(seconds * 1000) : 0;
}

// Pairs each `limit:` from the message with the `quotaId` describing its
// window. Both lists arrive grouped by metric and in the same order, but that
// is an observation rather than a promise, so a mismatched count drops the
// window instead of guessing wrong.
function pairLimitsWithWindows(payload) {
  const message = String(payload?.error?.message || '');
  const parsed = [];
  for (const match of message.matchAll(QUOTA_LINE)) {
    parsed.push({ metric: match[1].trim(), limit: Number(match[2]) });
  }
  if (!parsed.length) return [];

  const violationsByMetric = new Map();
  for (const detail of detailsOfType(payload, 'QuotaFailure')) {
    for (const violation of detail.violations || []) {
      const metric = String(violation.quotaMetric || '').trim();
      if (!violationsByMetric.has(metric)) violationsByMetric.set(metric, []);
      violationsByMetric.get(metric).push(String(violation.quotaId || ''));
    }
  }

  const byMetric = new Map();
  for (const entry of parsed) {
    if (!byMetric.has(entry.metric)) byMetric.set(entry.metric, []);
    byMetric.get(entry.metric).push(entry);
  }

  const limits = [];
  for (const [metric, entries] of byMetric) {
    const quotaIds = violationsByMetric.get(metric) || [];
    const aligned = quotaIds.length === entries.length;
    entries.forEach((entry, index) => {
      const quotaId = aligned ? quotaIds[index] : '';
      limits.push({
        metric,
        quotaId,
        window: quotaWindow(quotaId),
        limit: entry.limit,
        freeTier: FREE_TIER_METRIC.test(metric),
        requests: REQUEST_METRIC.test(metric),
      });
    });
  }
  return limits;
}

// `null` when the payload is not a Gemini quota rejection at all.
export function parseQuotaFailure(payload) {
  const limits = pairLimitsWithWindows(payload);
  if (!limits.length) return null;
  const freeTier = limits.filter((entry) => entry.freeTier);
  // Every free-tier allowance reported as zero means the model is not offered
  // on the free tier, rather than temporarily drained.
  const noFreeTier = freeTier.length > 0 && freeTier.every((entry) => entry.limit === 0);
  const dailyRequests = freeTier.find(
    (entry) => entry.requests && entry.window === 'day' && entry.limit > 0,
  );
  const exhausted = freeTier.filter((entry) => entry.limit > 0);
  return {
    limits,
    noFreeTier,
    // The real per-day request allowance, straight from the provider, so it
    // does not have to be guessed and written into config by hand.
    dailyRequestLimit: dailyRequests ? dailyRequests.limit : null,
    exhaustedWindow: exhausted.some((entry) => entry.window === 'day')
      ? 'day'
      : exhausted.length
        ? 'minute'
        : '',
    retryDelayMs: parseRetryDelayMs(payload),
  };
}

// Errors that mean "never route this model", separate from quota. Worth
// caching: a candidate comes from the provider's own catalog, so a refusal to
// serve it is a stable fact rather than a passing failure, and re-testing it
// every run costs a request each time for a known answer.
export function permanentRejection(status, payload) {
  const message = String(payload?.error?.message || '');
  if (status === 404) {
    return /no longer available/i.test(message)
      ? 'withdrawn upstream'
      : 'listed in the catalog but not served here';
  }
  if (status === 400 && /only supports .*Interactions API/i.test(message)) {
    return 'not a chat-completions model';
  }
  return '';
}

// Free-tier daily quotas reset at midnight US Pacific. Cooling down for a fixed
// interval instead would either retry all night for nothing or idle past the
// reset, so compute the actual wait.
export function msUntilQuotaReset(now = Date.now(), timeZone = 'America/Los_Angeles') {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
  const parts = {};
  for (const part of formatter.formatToParts(new Date(now))) parts[part.type] = part.value;
  const hour = Number(parts.hour === '24' ? '0' : parts.hour);
  const elapsed =
    hour * 3600000 + Number(parts.minute) * 60000 + Number(parts.second) * 1000;
  const remaining = 86400000 - elapsed;
  // Land just after the boundary rather than exactly on it.
  return Math.max(60000, remaining + 60000);
}
