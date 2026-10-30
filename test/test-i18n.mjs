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
  'logs_tries', 'logs_more', 'logs_answer', 'logs_copy_all', 'logs_export_jsonl',
  'logs_export_text', 'logs_copied', 'logs_copy_failed', 'logs_clear', 'logs_clear_confirm',
  'logs_cleared',
  'th_logs_time', 'th_logs_dialect', 'th_logs_requested', 'th_logs_selected',
  'th_logs_result', 'th_logs_duration', 'th_logs_first_token', 'th_logs_input_tokens',
  'th_logs_output_tokens', 'th_logs_speed', 'th_logs_attempts',
  'log_ok', 'log_empty', 'log_interrupted', 'log_aborted', 'log_blocked', 'log_failed',
  'log_rejected',
  'gw_th_expires', 'gw_th_used', 'gw_limit_ph', 'gw_expires_title', 'gw_limit_prompt',
  'gw_expires_prompt', 'gw_updated', 'gw_edit',
  'sess_list_t', 'sess_list_d', 'sess_revoke', 'sess_revoke_others', 'sess_others_confirm',
  'sess_current', 'sess_revoked', 'sess_none', 'sess_confirm', 'sess_confirm_self',
  'th_sess_id', 'th_sess_created', 'th_sess_expires', 'th_sess_ip', 'th_sess_client',
  'audit_t', 'audit_d', 'audit_refresh', 'audit_empty', 'audit_note',
  'th_audit_time', 'th_audit_actor', 'th_audit_action', 'th_audit_target', 'th_audit_result',
  'logs_search_ph', 'logs_all', 'logs_sort_time', 'logs_sort_duration', 'logs_prev',
  'logs_next', 'logs_page', 'logs_showing', 'logs_no_match', 'logs_fields',
  'logs_detail_hint', 'logs_filter_hint',
  'tun_request_log', 'tun_request_log_desc',
  'prov_filter_ph', 'prov_no_match',
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
for (const placeholder of ['{finish}', '{tools}', '{chars}']) {
  assert.ok(STRINGS.en.logs_answer.includes(placeholder), `logs_answer needs ${placeholder}`);
}
assert.equal('logs_copy_one' in STRINGS.en, false, 'the per-row Copy button is gone');
assert.equal(STRINGS['zh-CN'].logs_clear, '清除');
// Timings are shown in seconds, so the headers must say so in every language.
assert.equal(STRINGS['zh-CN'].th_logs_duration, '耗时 (s)');
assert.equal(STRINGS['zh-CN'].th_logs_first_token, '首字耗时 (s)');
assert.equal(STRINGS.en.th_logs_duration, 'Duration (s)');
assert.equal(STRINGS.en.th_logs_first_token, 'First token (s)');
assert.equal(STRINGS['zh-CN'].tab_logs, '日志');
// "chat" / "responses" are API dialects, not spoken ones: the column says API
// in every language so nobody reads 方言 / Dialekt as a human language.
for (const [code] of LANGS) {
  assert.equal(STRINGS[code].th_logs_dialect, 'API', `${code} th_logs_dialect`);
  assert.match(STRINGS[code].logs_blurb, /\bAPI\b/, `${code} logs_blurb should name the API column`);
}
// The Chinese blurb is read as a sentence, not a schema dump: no "dialect",
// no "top-level field names", and it names the two API values it counts.
assert.doesNotMatch(STRINGS['zh-CN'].logs_blurb, /方言|顶层字段名/);
assert.match(STRINGS['zh-CN'].logs_blurb, /API（chat \/ responses）/);
assert.match(STRINGS['zh-TW'].logs_blurb, /API（chat \/ responses）/);
assert.equal(STRINGS['zh-TW'].tab_logs, '日誌');
// Gateway key policy prompts name the key and keep their placeholders.
assert.match(STRINGS.en.gw_limit_prompt, /\{n\}/);
assert.match(STRINGS.en.gw_expires_prompt, /\{n\}/);
assert.match(STRINGS.en.gw_updated, /\{n\}/);
assert.equal(STRINGS['zh-CN'].gw_edit, '编辑');
assert.equal(STRINGS['zh-TW'].gw_edit, '編輯');
// Session manager strings: the revocation confirmation is a real warning in
// every language, and the counts keep their placeholder.
assert.match(STRINGS.en.sess_revoked, /\{n\}/);
assert.match(STRINGS.en.sess_confirm, /\{id\}/);
for (const [code] of LANGS) {
  assert.ok(STRINGS[code].sess_confirm_self.length > 20, `${code} sess_confirm_self`);
}
// The logs filter strings keep both page placeholders and both counts.
assert.match(STRINGS.en.logs_page, /\{p\}/);
assert.match(STRINGS.en.logs_page, /\{n\}/);
assert.match(STRINGS.en.logs_showing, /\{n\}/);
assert.match(STRINGS.en.logs_showing, /\{t\}/);
assert.equal(STRINGS['zh-CN'].logs_no_match, '没有符合筛选条件的请求。');
// The audit blurb promises what is never written; keep that promise in every
// language and keep both placeholders in the note.
assert.match(STRINGS.en.audit_note, /\{n\}/);
assert.match(STRINGS.en.audit_note, /\{p\}/);
for (const [code] of LANGS) {
  assert.match(STRINGS[code].audit_d, /key|ключ|キー|키|clave|clé|schlüssel|chave|chiavi|المفاتيح/i, `${code} audit_d`);
}
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

// 7. Every locale is complete: no key may silently fall back to English.
for (const [code] of LANGS) {
  const missing = missingKeys(code);
  assert.deepEqual(missing, [], `${code} still relies on the English fallback: ${missing.join(', ')}`);
}

// 8. Counts select a plural variant when the locale ships one; locales without
// one read their own base wording, never the English variant.
assert.equal(translate(STRINGS, 'en', 'gw_on', { n: 1 }), 'required (1 key)');
assert.equal(translate(STRINGS, 'en', 'gw_on', { n: 3 }), 'required (3 keys)');
assert.equal(translate(STRINGS, 'en', 'logs_tries', { n: 1 }), '1 attempt');
assert.equal(translate(STRINGS, 'ru', 'gw_on', { n: 1 }), 'требуется (1 ключ)');
assert.equal(translate(STRINGS, 'ru', 'gw_on', { n: 3 }), 'требуется (3 ключа)');
assert.equal(translate(STRINGS, 'ru', 'gw_on', { n: 7 }), 'требуется (7 ключей)');
// A locale without a variant keeps its own sentence, not the English one.
assert.equal(translate(STRINGS, 'de', 'prov_rot', { n: 1 }), STRINGS.de.prov_rot.replace('{n}', '1'));
assert.equal(translate(STRINGS, 'en', 'gw_on', { n: 'main' }), 'required (main keys)');

console.log('i18n unit tests passed');
