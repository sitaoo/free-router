#!/usr/bin/env node
// Providers tab: the model table is the single place where free/paid
// membership and per-model daily limits are edited; discovery moved here.
import assert from 'node:assert/strict';
import { renderPage } from '../app/ui.mjs';

const page = renderPage();
const paneStart = page.indexOf('data-pane="providers"');
const paneEnd = page.indexOf('data-pane="settings"');
assert.ok(paneStart !== -1 && paneEnd !== -1, 'providers and settings panes must exist');
const providersPane = page.slice(paneStart, paneEnd);

// 1. Discovery lives in the Providers pane and no longer asks for a provider.
assert.match(providersPane, /id="disc-enabled"/, 'discovery toggle must be in Providers');
assert.match(providersPane, /id="disc-eval"/, 'evaluation toggle must be in Providers');
assert.match(providersPane, /id="disc-interval"/, 'discovery interval must be in Providers');
assert.match(providersPane, /id="disc-run"/, 'Run now must be in Providers');
assert.doesNotMatch(page, /disc-provider/, 'discovery no longer targets one provider');

// 2. Provider rows expose model counts (free/paid/blocked) and a Models entry.
assert.match(page, /pt_paid/, 'provider table must have a paid column');
assert.match(page, /pt_blocked/, 'provider table must have a blocked column');
assert.match(page, /poolCounts/, 'provider counts must come from live pool membership');
assert.match(page, /prov_models_manage/, 'each provider row must offer a Models entry');
assert.match(page, /function openProviderModels/, 'Models opens a dedicated model modal');

// 3. The model table merges catalog classes with explicit selections.
assert.match(page, /function buildModelTable/, 'one model table for free and paid rows');
assert.match(page, /provider\.catalogClasses/, 'unselected rows must use the catalog price class');
assert.match(page, /selectedModels/, 'selected models come from the editable provider state');
assert.match(page, /member\.source === 'auto'/, 'auto-detected free rows are locked on');
assert.match(page, /paid_model_warning/, 'paid rows must warn before joining the pool');
assert.match(page, /unknown_model_warning/, 'unknown-price rows must warn before joining the pool');
assert.match(page, /confirm\(modelWarning/, 'the warning must be a confirmation');

// 4. Daily limits moved here: per model and a provider-wide default.
assert.match(page, /function buildProviderDefaultLimit/, 'provider default limit row missing');
assert.match(page, /provider\.name \+ ':\*'/, 'provider default limit must use provider:*');
assert.match(page, /api\/limits/, 'limit edits go through /api/limits');
assert.match(page, /limitKey/, 'each model row must set its own provider:model limit');

// 5. Background probing keeps the tab live without a reload.
assert.match(page, /PROVIDERS_REFRESH_MS = 3000/, 'providers tab must poll while probing');
assert.match(page, /probePending/, 'polling must follow probe progress');
assert.match(page, /disc_probing/, 'probe progress must be visible');

// 6. Nothing references the deleted route map.
assert.doesNotMatch(page, /state\.routes/, 'UI must not read routes');
assert.doesNotMatch(page, /state\.route\b/, 'UI must not read the discovery route');

console.log('ui-providers unit tests passed');
