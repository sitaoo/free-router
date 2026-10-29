# WebUI Optimizations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现三处 WebUI 优化：去掉概览配置文件卡片、澄清今日用量口径、渠道新增/编辑合并为统一弹窗。

**Architecture:** 纯前端改动（`app/ui.mjs` + `app/i18n.mjs`），复用现有 `GET /api/state` 与 `api/providers`/`api/keys` 后端；弹窗用原生 div overlay 无新依赖；每任务独立可测可回滚。

**Tech Stack:** Node >= 20；原生 DOM（无构建）；13 语言 i18n（`app/i18n.mjs` 的 `STRINGS`）；现有冒烟 `npm test`。

## Global Constraints

- `server.mjs` 不可直接 import（会启动），纯逻辑抽到 `app/` 下可单测模块。
- 合并前必须全过：`npm run check` + `npm test`（单测 + 冒烟），冒烟挂了先定性是回归还是预期行为变更。
- commit 信息英文祈使句，说明改了什么和为什么；docs 与代码同批次改。
- `*.md` 全篇流式长行（一段一行），禁止按宽度硬折行；表格、代码围栏、列表不动。
- 中英同步：`README.md` 与 `docs/zh-CN/README.md`、`docs/HOW_IT_WORKS.md` 与 `docs/zh-CN/HOW_IT_WORKS.md`（本次 UI 文案变更若涉及用户可见行为，需同步简要说明；详细口径进 HOW_IT_WORKS）。
- 宣称先核代码再写（版本号、默认值、周期天数一个不能编）；`USAGE_RETENTION_DAYS` 默认 7 天，`usage_blurb` 必须用 `state.usage.retentionDays` 实值而非硬编码。
- CSP `default-src 'none'`：弹窗不得引入外部资源，纯 DOM + 现有 CSS。

---

## File Structure

- Modify: `app/ui.mjs` — `renderStatus()`（删 1 行）、`renderUsage()`（改列 + 悬停）、`PAGE` 模板（加 `#provider-modal` 容器 + `.overlay/.modal` CSS）、`renderProviders()`（瘦身为入口）+ 新增 `openProviderModal/closeProviderModal`。
- Modify: `app/i18n.mjs` — `STRINGS.en` + `STRINGS.zh-CN` 先齐新增 key（`th_today_used/th_today_ok/th_today_fail/usage_tip_ok/usage_tip_fail/prov_modal_add/prov_modal_edit/prov_current_models/prov_add_models/prov_modal_close` + `usage_blurb` 加 `{n}` 窗口天数参），其余 11 语言同批直译。
- Test: `test/test-smoke.mjs` — 沿用现有 `usage.today/retentionDays` 与 `api/providers` 全链路断言，Task 2 补口径断言；无新测试文件。

---

### Task 1: 去掉概览“配置文件”卡片

**Files:**
- Modify: `app/ui.mjs:1512`（删除 1 行）
- Test: `npm run check` + `npm test` + 手动看概览

**Interfaces:**
- Consumes: `state.configFile/configFormat`（后端保留，仅前端不渲染）
- Produces: `renderStatus()` 输出 3~4 卡（无 config 卡）

- [ ] **Step 1: 写失败断言（静态）**

```bash
node -e "const s=require('fs').readFileSync('app/ui.mjs','utf8'); const m=s.match(/function renderStatus\(\).*?^}/ms); if(/t\('card_config'\)/.test(m[0])){console.log('FAIL: card_config still rendered');process.exit(1)} console.log('PASS')"
```

- [ ] **Step 2: 运行确认当前失败**

Run: 上述命令
Expected: FAIL with "card_config still rendered"

- [ ] **Step 3: 最小实现（删 1 行）**

```js
// app/ui.mjs renderStatus() 内删除下面这行，其余不动：
card(host, t('card_config'), state.configFile + ' (' + state.configFormat + ')');
```

- [ ] **Step 4: 运行验证通过**

Run: `node -e "同上"` + `npm run check`
Expected: PASS + check 全过

- [ ] **Step 5: Commit**

```bash
git add app/ui.mjs
git commit -m "Remove config card from status overview"
```

---

### Task 2: 今日用量口径澄清（今日为主 + 悬停看累计）

**Files:**
- Modify: `app/i18n.mjs`（`STRINGS.en` 约 `:72-74`、`STRINGS.zh-CN` 约 `:212-214`，其余 11 语言同 key 位置）
- Modify: `app/ui.mjs:1540-1563`（`renderUsage()`）
- Test: `test/test-smoke.mjs:1390-1495` 旁补口径断言（或独立 node 断言先行）

**Interfaces:**
- Consumes: `state.usage.models[].{key,today:{ok,fail,consumed},ok,fail,dailyLimit}` + `state.usage.{today,timezone,retentionDays}`（后端 `usageSummary()` 已有，无需改 `server.mjs`）
- Produces: 5 列 `模型｜今日消耗｜今日成功｜今日失败｜限额` + 悬停累计 + 新 blurb

- [ ] **Step 1: 写失败测试（i18n key + 口径）**

```js
// node assert (save as /tmp/check-usage.mjs, ESM import STRINGS):
import { STRINGS } from './app/i18n.mjs';
import assert from 'node:assert';
for (const k of ['th_today_used','th_today_ok','th_today_fail','usage_tip_ok','usage_tip_fail']) {
  assert.ok(STRINGS.en[k], 'missing en.' + k);
  assert.ok(STRINGS['zh-CN'][k], 'missing zh-CN.' + k);
}
assert.ok(STRINGS.en.usage_blurb.includes('{n}'), 'usage_blurb must take {n} retentionDays');
assert.ok(STRINGS['zh-CN'].usage_blurb.includes('{n}'), 'zh usage_blurb must take {n}');
console.log('PASS usage i18n');
```

- [ ] **Step 2: 运行确认失败**

Run: `node /tmp/check-usage.mjs`
Expected: FAIL with "missing en.th_today_used"

- [ ] **Step 3: 加 i18n key（en + zh-CN 先齐，其余 11 语言同批直译）**

```js
// en (app/i18n.mjs ~:72-74):
usage_blurb: "today's usage ({today} {tz}); ok/fail are today, hover for last {n} days total; rate limits and 404s are excluded.",
th_today_used: "used today", th_today_ok: "ok today", th_today_fail: "fail today",
usage_tip_ok: "last {n} days total ok: {v}", usage_tip_fail: "last {n} days total fail: {v}",
```

```js
// zh-CN (app/i18n.mjs ~:212-214):
usage_blurb: "用量为今日（{today} {tz}）；成功/失败为今日，悬停查看近{n}天累计；限流与 404 不计。",
th_today_used: "今日消耗", th_today_ok: "今日成功", th_today_fail: "今日失败",
usage_tip_ok: "近{n}天累计成功：{v}", usage_tip_fail: "近{n}天累计失败：{v}",
```

- [ ] **Step 4: 改 `renderUsage()` 列与悬停（`app/ui.mjs:1540-1563`）**

```js
function renderUsage() {
  const host = el('usage');
  host.textContent = '';
  const n = state.usage.retentionDays || 7;
  el('usage-blurb').textContent = t('usage_blurb', { today: state.usage.today, tz: state.usage.timezone, n });
  const models = (state.usage.models || []).slice(0, 12);
  if (!models.length) {
    const p = document.createElement('p');
    p.className = 'note';
    p.style.margin = '0';
    p.textContent = t('usage_empty');
    host.appendChild(p);
    return;
  }
  const tipOk = (entry) => td(entry.today ? (entry.today.ok || '-') : '-', 'num');
  host.appendChild(table(
    [{ label: t('th_model') }, { label: t('th_today_used'), num: true }, { label: t('th_today_ok'), num: true }, { label: t('th_today_fail'), num: true }, { label: t('th_limit'), num: true }],
    models.map((entry) => {
      const used = td(entry.today ? entry.today.consumed : '-', 'num');
      const ok = td(entry.today ? (entry.today.ok || '-') : '-', 'num');
      ok.title = t('usage_tip_ok', { n, v: entry.ok || 0 });
      const fail = td(entry.today ? (entry.today.fail || '-') : '-', 'num');
      fail.title = t('usage_tip_fail', { n, v: entry.fail || 0 });
      return [td(entry.key, 'mono'), used, ok, fail, td(entry.dailyLimit || '-', 'num')];
    }),
  ));
}
```

- [ ] **Step 5: 运行验证**

Run: `node /tmp/check-usage.mjs && npm run check`
Expected: PASS + check 全过；随后 `npm test` 全绿（`usage.today/retentionDays` 旧断言不受影响）

- [ ] **Step 6: Commit**

```bash
git add app/i18n.mjs app/ui.mjs
git commit -m "Clarify today usage columns with hover window totals"
```

---

### Task 3: 渠道弹窗外壳（容器 + CSS + 开关）

**Files:**
- Modify: `app/ui.mjs`（`PAGE` 模板 providers pane 后追加 modal 容器；`<style>` 区追加 overlay CSS；`<script>` 区新增 `openProviderModal/closeProviderModal` 空壳）
- Test: `npm run check` + `GET /` 含 `#provider-modal`

**Interfaces:**
- Consumes: 现有 `.card/.row/table/chip` 样式、`el/t` helpers
- Produces: `openProviderModal(mode, provider?)` + `closeProviderModal()` 可被 Task 4/5 调用；`#provider-modal[hidden]` 默认隐藏

- [ ] **Step 1: 写失败断言**

```bash
node -e "const s=require('fs').readFileSync('app/ui.mjs','utf8'); for(const k of ['provider-modal','openProviderModal','closeProviderModal']){if(!s.includes(k)){console.log('FAIL missing '+k);process.exit(1)}} console.log('PASS modal shell')"
```

- [ ] **Step 2: 运行确认失败**

Run: 上述命令
Expected: FAIL with "missing provider-modal"

- [ ] **Step 3: 加容器 + CSS（providers pane 之后、`data-pane="routes"` 之前）**

```html
<div id="provider-modal" class="overlay" hidden>
  <div class="modal" role="dialog" aria-modal="true">
    <div class="row" style="justify-content:space-between;align-items:center">
      <h3 id="provider-modal-title" style="margin:0"></h3>
      <button class="quiet" id="provider-modal-x">×</button>
    </div>
    <div id="provider-modal-body"></div>
  </div>
</div>
```

```css
.overlay { position: fixed; inset: 0; background: rgba(15,23,42,.45); display: flex; align-items: flex-start; justify-content: center; padding: 48px 16px; z-index: 50; }
.overlay[hidden] { display: none; }
.modal { background: #fff; border-radius: 12px; max-width: 720px; width: 100%; max-height: 85vh; overflow: auto; padding: 16px 18px; box-shadow: 0 12px 40px rgba(0,0,0,.25); }
```

```js
let modalReturnFocus = null;
function openProviderModal(mode, provider) {
  const overlay = el('provider-modal');
  modalReturnFocus = document.activeElement;
  el('provider-modal-title').textContent = mode === 'create' ? t('prov_modal_add') : t('prov_modal_edit', { p: provider ? provider.name : '' });
  el('provider-modal-body').textContent = '';
  overlay.hidden = false;
}
function closeProviderModal() {
  el('provider-modal').hidden = true;
  el('provider-modal-body').textContent = '';
  if (modalReturnFocus && modalReturnFocus.focus) modalReturnFocus.focus();
}
// bind once (bindOnce 内): el('provider-modal-x').onclick = closeProviderModal;
// overlay 点击遮罩关闭 + ESC 关闭：
 // el('provider-modal').addEventListener('mousedown', (e) => { if (e.target.id === 'provider-modal') closeProviderModal(); });
 // document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !el('provider-modal').hidden) closeProviderModal(); });
```

- [ ] **Step 4: 加 i18n（en + zh-CN，其余语言同批）**

```js
// en:
prov_modal_add: "Add provider", prov_modal_edit: "Edit provider: {p}", prov_modal_close: "Close",
// zh-CN:
prov_modal_add: "新增渠道", prov_modal_edit: "编辑渠道：{p}", prov_modal_close: "关闭",
```

- [ ] **Step 5: 运行验证**

Run: `node -e "同 Step1"` + `npm run check`
Expected: PASS + check 全过

- [ ] **Step 6: Commit**

```bash
git add app/i18n.mjs app/ui.mjs
git commit -m "Add provider modal shell with open-close helpers"
```

---

### Task 4: 新增渠道搬进弹窗

**Files:**
- Modify: `app/ui.mjs:818-840`（工具栏）+ `buildProviderForm():921-1147`（复用字段组装进 modal body）
- Test: `npm test`（`api/providers create` 链路）+ 手动新增

**Interfaces:**
- Consumes: Task 3 的 `openProviderModal('create')` + 现有 `PROVIDER_PRESETS:914-919`、`fetch-models:974-995`、`renderModelList:1043-1077`、`fillFromPreset:1078-1108`、`save:1110-1145`（`POST api/providers {action:'create',...}` + 可选 `POST api/keys`）
- Produces: 工具栏 `新增渠道` 打开弹窗完成创建；顶部内联表单删除

- [ ] **Step 1: 写失败断言**

```bash
node -e "const s=require('fs').readFileSync('app/ui.mjs','utf8'); if(!/openProviderModal\('create'\)/.test(s)){console.log('FAIL create not wired to modal');process.exit(1)} console.log('PASS')"
```

- [ ] **Step 2: 运行确认失败**

Run: 上述命令
Expected: FAIL with "create not wired to modal"

- [ ] **Step 3: 最小实现**

```js
// renderProviders() 工具栏改写（替换 824-840 的 addShow/form 逻辑）：
const addBtn = document.createElement('button');
addBtn.className = 'primary';
addBtn.textContent = t('prov_modal_add');
addBtn.onclick = () => {
  openProviderModal('create');
  const created = buildProviderForm();
  el('provider-modal-body').appendChild(created.form);
  created.cancel.onclick = () => closeProviderModal();
  const origSave = created.save.onclick;
  created.save.onclick = async (e) => { await origSave(e); if (!el('provider-modal-body').textContent) return; closeProviderModal(); await load(); };
};
toolbar.appendChild(addBtn);
host.appendChild(toolbar);
// 注意：buildProviderForm 内部保存成功后需 toast + load（沿用 1110-1145），失败 toast 且弹窗保持打开；不再把 form 挂到 host 下。
```

- [ ] **Step 4: 运行验证**

Run: `npm run check && npm test`
Expected: 全绿（`api/providers create/duplicate/delete/fetch-models` 断言在 `test-smoke.mjs:1559-1895` 通过）

- [ ] **Step 5: Commit**

```bash
git add app/ui.mjs
git commit -m "Move provider creation into modal dialog"
```

---

### Task 5: 编辑渠道搬进弹窗（含当前 + 可新增模型）并删内联展开

**Files:**
- Modify: `app/ui.mjs:857-909`（删 `detailTr:899-906`，`管理` 改为弹窗编辑）+ `buildProviderDetail():1149-1351`（复用并在 modal 内分段标题）+ `app/i18n.mjs`（`prov_current_models/prov_add_models`）
- Test: `npm test` 全绿 + 手动编辑验证

**Interfaces:**
- Consumes: Task 3 的 `openProviderModal('edit', provider)` + `buildProviderDetail` 全段（密钥列表 `1154-1185` + 新增 Key `1187-1221` + 提示 `1223-1249` + BaseURL `1257-1282` + 免费模型 chips `1284-1348` + 单模型增删 `1300-1344` 走 `POST api/providers {action:'update'}`）
- Produces: 每行 `编辑` 打开弹窗显示当前模型 + 可新增模型；行内展开行彻底删除

- [ ] **Step 1: 写失败断言**

```bash
node -e "const s=require('fs').readFileSync('app/ui.mjs','utf8'); if(/detailTr/.test(s)){console.log('FAIL detailTr still exists');process.exit(1)} if(!/openProviderModal\('edit'/.test(s)){console.log('FAIL edit not wired');process.exit(1)} console.log('PASS')"
```

- [ ] **Step 2: 运行确认失败**

Run: 上述命令
Expected: FAIL with "detailTr still exists"

- [ ] **Step 3: 加 i18n（en + zh-CN，其余语言同批）**

```js
// en:
prov_current_models: "Current models", prov_add_models: "Add models",
// zh-CN:
prov_current_models: "当前模型", prov_add_models: "新增模型",
```

- [ ] **Step 4: 最小实现（行内瘦身 + 弹窗组装）**

```js
// renderProviders() 行循环内替换 899-906：
manage.textContent = t('prov_manage'); // 文案可改为 t('prov_modal_edit') 或保留“管理”，推荐沿用 prov_manage 避免新增 key
manage.onclick = () => {
  openProviderModal('edit', provider);
  const body = el('provider-modal-body');
  const curTitle = document.createElement('h4');
  curTitle.textContent = t('prov_current_models');
  body.appendChild(curTitle);
  body.appendChild(buildProviderDetail(provider));
  const addTitle = document.createElement('h4');
  addTitle.textContent = t('prov_add_models');
  body.appendChild(addTitle);
  body.appendChild(buildModelPicker(provider)); // buildModelPicker = 从 buildProviderForm 抽出的 catalog/fetch/勾选/手填段（974-1108），保存走 update{freeModels:[...]}
};
// 删除 detailTr/detailTd 6 行；删除按钮逻辑（881-893）原样保留。
```

- [ ] **Step 5: 运行验证（门禁 + 手动）**

Run: `npm run check && npm test`
Expected: 全绿；手动：编辑弹窗显示当前模型 chips 可删、可新增勾选 + 手填、保存落盘 `config.local.json`、删除二次确认、ESC/遮罩/× 关闭；`GET /` 快照表头不变。

- [ ] **Step 6: Commit**

```bash
git add app/i18n.mjs app/ui.mjs
git commit -m "Move provider editing with model lists into modal"
```

---

## Self-Review

- Spec 覆盖：§1 对应 Task 1（删卡片，i18n key 保留）；§2 对应 Task 2（5 列 + 悬停 + blurb 带 `{n}` 实值）；§3 对应 Task 3/4/5（外壳 → 新增 → 编辑 + 删内联），无遗漏。
- 占位扫描：无 TBD/TODO；无“适当处理”类空话，每步均有可执行命令与代码块；无跨任务未定义引用（`openProviderModal/closeProviderModal/buildModelPicker` 均在本计划内定义，`buildModelPicker` 明确为从 `buildProviderForm:974-1108` 抽出的纯复用段）。
- 类型一致：`entry.today.{ok,fail,consumed}`、`entry.{ok,fail}`、`state.usage.retentionDays` 与 `server.mjs:839-878` 一致；`t(key, {n,v})` 与 `i18n.mjs:50-52` 插值一致；API 载荷 `POST api/providers {action, name, baseUrl, freeModels}` 与 `server.mjs:2714` 一致。
