#!/usr/bin/env node
// i18n: the paid-model warning must say exactly what the operator was told it
// says, every language must carry the new pool/model-table keys, and every key
// the UI references must exist in English.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { LANGS, STRINGS, missingKeys, translate } from '../app/i18n.mjs';

const NEW_KEYS = [
  'pool_priority', 'pool_blurb', 'pool_paid_title', 'pool_paid_note', 'pool_paid_empty',
  'paid_model_warning', 'unknown_model_warning',
  'st_free', 'st_unknown', 'st_blocked', 'st_not_selected', 'st_auto', 'st_allowlist', 'st_selected',
  'prov_models_manage', 'prov_modal_models', 'prov_default_limit', 'prov_default_limit_desc',
  'pm_on', 'pm_model', 'pm_label', 'pm_source', 'pm_state', 'pm_limit', 'pm_limit_ph', 'pm_locked_hint',
  'pt_paid', 'pt_blocked', 'prov_unknown_tag', 'disc_probing', 'disc_probe_pending', 'disc_note',
  'tab_logs', 'logs_title', 'logs_blurb', 'logs_refresh', 'logs_empty', 'logs_count',
  'logs_tries', 'logs_more', 'th_logs_time', 'th_logs_dialect', 'th_logs_requested',
  'th_logs_selected', 'th_logs_result', 'th_logs_duration', 'th_logs_first_token',
  'th_logs_attempts', 'log_ok', 'log_empty', 'log_interrupted', 'log_aborted',
  'log_blocked', 'log_failed', 'log_rejected',
];

// 1. The exact Chinese sentence the operator approved.
assert.equal(STRINGS['zh-CN'].paid_model_warning, '付费模型可能会消耗你的费用，请谨慎添加');
assert.ok(STRINGS.en.paid_model_warning.length > 0);

// 2. Every language has the new keys (runtime falls back to English for the
// older keys some locales never had; these must not rely on the fallback).
for (const [code] of LANGS) {
  const missing = NEW_KEYS.filter((key) => !(key in (STRINGS[code] || {})));
  assert.deepEqual(missing, [], `${code} is missing new keys: ${missing.join(', ')}`);
}

// 3. Every placeholder used by a new string is documented by the caller.
assert.match(STRINGS.en.st_blocked, /\{at\}/);
assert.match(STRINGS.en.disc_probing, /\{p\}/);
assert.match(STRINGS.en.disc_probe_pending, /\{n\}/);
assert.match(STRINGS.en.logs_count, /\{n\}/);
assert.match(STRINGS.en.logs_count, /\{cap\}/);
assert.match(STRINGS.en.logs_tries, /\{n\}/);
assert.match(STRINGS.en.logs_more, /\{n\}/);
assert.equal(STRINGS['zh-CN'].tab_logs, '日志');
assert.equal(STRINGS['zh-TW'].tab_logs, '日誌');
assert.equal(translate(STRINGS, 'zh-CN', 'st_blocked', { at: '10:00' }), '资金不足，10:00 前停用');
assert.equal(translate(STRINGS, 'xx', 'paid_model_warning'), STRINGS.en.paid_model_warning);

// 4. Dead route/quota keys are gone from the English source of truth.
for (const key of ['tab_routes', 'tab_quota', 'route_priority', 'route_label', 'routes_blurb', 'limits_title', 'limits_blurb', 'disc_provider']) {
  assert.equal(key in STRINGS.en, false, `${key} should be removed`);
}

// 5. Every literal key the page uses exists in English (dynamic keys end in _).
const page = fs.readFileSync(new URL('../app/ui.mjs', import.meta.url), 'utf8');
const used = new Set();
for (const match of page.matchAll(/\bt\('([a-z0-9_]+)'/g)) used.add(match[1]);
for (const match of page.matchAll(/data-i18n(?:-ph|-title)?="([a-z0-9_]+)"/g)) used.add(match[1]);
const unknown = [...used].filter((key) => !key.endsWith('_') && !(key in STRINGS.en)).sort();
assert.deepEqual(unknown, [], `UI references keys missing from en: ${unknown.join(', ')}`);

// 6. The main locales carry the pool wording, not the retired route wording.
for (const code of ['en', 'zh-CN', 'zh-TW', 'ja']) {
  assert.ok(STRINGS[code].pool_priority, `${code} pool_priority`);
  assert.equal(missingKeys(code).includes('paid_model_warning'), false, `${code} warning key`);
}

console.log('i18n unit tests passed');
