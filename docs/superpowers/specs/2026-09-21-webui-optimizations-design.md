# WebUI 优化设计（概览卡片 / 今日用量 / 渠道弹窗）

- 日期：2026-09-21；范围：`app/ui.mjs` + `app/i18n.mjs` 纯前端小改，后端 API 不动；方案 A（复用现有 API）已确认。
- 目标：去掉无用信息、澄清今日用量口径、统一渠道新增/编辑为弹窗；保持 `GET /` + `GET /api/state` 入口、CSP `default-src 'none'`、无前端构建的约束不变。

## §1 首页概览去掉“配置文件”卡片

- 改动为 `app/ui.mjs:1512` 的 `renderStatus()` 中删除 `card(host, t('card_config'), state.configFile + ' (' + state.configFormat + ')')` 一行，后端 `api/state` 的 `configFile/configFormat/overlayFile` 字段保留不动（设置页与调试仍可用），仅概览不再渲染该卡片，剩余卡片为接口地址/网关鉴权/未配 Key/改密提示。
- `app/i18n.mjs` 中 13 语言的 `card_config` 文案全部保留不删，避免删除 key 引发回退异常，后续如需彻底清理再单批处理。
- 验证为手动查看概览卡片数 + `npm test` 全绿（`test-smoke.mjs:1541-1557` 的 `GET /` 快照不涉及该卡片，无需更新）。

## §2 今日用量：今日为主 + 悬停看累计

- 口径结论为 `server.mjs:839-878` 的 `usageSummary()` 中 `entry.today{ok,fail,consumed}` 为当天、`entry.ok/fail` 为近 `retentionDays`（默认 7 天）窗口累计，`usageTotals()` 定义见 `server.mjs:799-813`（`rateLimit/notFound/forbidden` 不计入 `consumed`），因此“今日为零但成功/失败有数”是现状语义不清而非统计错误。
- 改动为 `app/ui.mjs:1540-1563` 的 `renderUsage()` 表列由 `模型｜今日｜成功｜失败｜限额` 改为 `模型｜今日消耗｜今日成功｜今日失败｜限额`，取值依次为 `entry.key`、`entry.today.consumed`、`entry.today.ok`、`entry.today.fail`、`entry.dailyLimit`，零值沿用现有 `-` 占位逻辑，后端不动（`state.usage.retentionDays/today/timezone` 已有）。
- 累计数据不另起列，放入悬停 `title`：今日成功单元格 `title` 显示近 N 天累计成功（`entry.ok`），今日失败同理（`entry.fail`），`usage-blurb` 文案同步澄清口径并带出窗口天数，中文拟为 `用量为今日（{today} {tz}）；成功/失败为今日，悬停查看近{retentionDays}天累计；限流与 404 不计。`，其余 12 语言按现有句式直译。
- 新增 i18n key 为 `th_today_used/今日消耗`、`th_today_ok/今日成功`、`th_today_fail/今日失败`、`usage_tip_ok/usage_tip_fail`（tooltip 模板），`th_today` 保留避免旧缓存异常；测试在 `test-smoke.mjs:1390-1495` 现有 `usage.today/retentionDays` 断言基础上补一个口径断言（`today.ok` 进今日成功列、`ok` 只进 title），`GET /` 快照不受影响。

## §3 上游渠道：新增 + 编辑合并为统一弹窗（全量进弹窗）

- 现状为 `app/ui.mjs:818-1351` 无弹窗，只有顶部内联新增表单（`buildProviderForm():921-1147`：预设/名称/BaseURL/首 Key/拉取模型/catalog 勾选/免费模型手填/保存取消）与每行隐藏展开行（`buildProviderDetail():1149-1351` 挂在 `detailTr:899-906`：密钥列表 `1154-1185` + 新增 Key 行 `1187-1221` + 提示 `1223-1249` + 高级折叠 `1251-1349` 含 BaseURL 编辑 `1257-1282` 与免费模型 chips 增删 `1284-1348`），模型列表藏在展开行内不易发现。
- 改动为在 `PAGE` 模板内新增 `#provider-modal.overlay > .modal` 容器并复用现有 `.card/.row/table/chip` 样式，原生 div + `hidden` 切换实现 `openProviderModal(mode, provider?)` 与 `closeProviderModal()`，支持 ESC/点遮罩/右上 ×/取消关闭，无外部依赖以满足 CSP；`mode=create` 将 `buildProviderForm` 字段原样搬入弹窗并复用 `1110-1145` 的 `create` 保存逻辑，`mode=edit` 将 `buildProviderDetail` 全量搬入弹窗（含密钥列表与新增、BaseURL、高级折叠、当前模型 chips 可删、 preset/catalog 回填 `1078-1108` 与 `fetch-models` 拉取 `974-995` 组成的可新增模型勾选区、手填、全选/过滤）并复用 `1300-1344` 的 `update{freeModels}` 与 `2380` 的 `api/keys` 逻辑，标题显示 `新增渠道` 或 `编辑渠道：{name}`。
- `renderProviders():818-909` 同步瘦身：删除顶部内联表单挂载（`827-840`）与每行 `detailTr` 展开行（`899-906`），工具栏按钮改为 `新增渠道 → open('create')`，每行 `管理` 改为 `编辑 → open('edit', provider)`，`删除` 保留行内 `confirm` 逻辑（`881-893`）不变；保存成功沿用现有 `toast + load()` 刷新，失败沿用 `toast(err)` 且弹窗不关闭以便修正。
- 新增 i18n key 为 `prov_modal_add/prov_modal_edit/prov_current_models/prov_add_models/prov_modal_close`，中英先齐其余 11 语言直译；测试为现有 `api/providers` 全链路冒烟（`test-smoke.mjs:1559-1895`）必须全绿，另手动验证新增/编辑弹窗的模型列表显隐、保存落盘与删除确认，`GET /` 快照表头不变。

## 错误处理与回滚

- 三处改动均不改后端统计与落盘（`usageByDay`/`discovered-free-models.json`/`config.local.json`），失败面仅为前端渲染，保存失败弹窗保持打开并 `toast` 报错以便修正；任何一节上线异常可独立回滚对应函数（`renderStatus` 一行、`renderUsage` 一块、`renderProviders` 一块）而不影响其余两节。
- 输入校验沿用现有逻辑（空 Key 提示 `prov_empty`、空模型不提交、删除二次 `confirm`），不新增校验规则。

## 测试计划

- 必跑 `npm run check` + `npm test`（单测 + 冒烟），重点为 `usage.today/retentionDays` 口径断言新增、`api/providers` 全链路冒烟、`GET /` HTML 快照与 `<script> new Function()` 检查；手动覆盖概览卡片计数、今日用量列与悬停、渠道新增/编辑弹窗的模型显隐与保存。
