# Free Router 工作原理

> [English](../HOW_IT_WORKS.md) | 中文

技术参考。简短总览见 [README](README.md)。

## 环境要求

- Node.js 20+
- 至少一个渠道的 API Key——放 `.env`，或在 Web UI（渠道 tab）里粘贴，
会存进 gitignored 的 `config.local.json`

缺 Key 的 provider 直接从排名里跳过。

## 配置 API Key

Provider Key 放在 `config.local.json`（gitignored，永不入库）或环境变量里。首次启动时，`.env` 里找到的 Key 会自动导入 `config.local.json`。`config.json` 只放默认值、保持可合并；服务端启动时深度合并两者（对象按 key 递归，数组和标量以覆盖层为准）。复制示例文件，解开你有的 Key并填值：

```bash
mkdir -p data && cp .env.example data/.env
```

| 变量 | 是否必需 | 获取位置 |
| --- | --- | --- |
| `OPENROUTER_API_KEY` | 是，OpenRouter 兜底和模型发现都要它 | [openrouter.ai/keys](https://openrouter.ai/keys) |
| `TOKENROUTER_API_KEY` | 否 | 你的 TokenRouter 账号 |
| `BAI_API_KEY` | 否 | [chat.b.ai](https://chat.b.ai) API Key，一个 Key 通所有 B.AI 官方模型 |
| `GEMINI_API_KEY` | 否 | [Google AI Studio](https://aistudio.google.com/apikey)。免费层 Flash-Lite 是限配额的，不是无限的 |

之后加的 provider 叫 `foo`，默认读 `FOO_API_KEY` 和 `FOO_BASE_URL`，除非在配置里覆盖 `keyEnv` / `baseUrlEnv`。

查找顺序，第一个非空值获胜：

1. 进程环境变量（`export OPENROUTER_API_KEY=...`）
2. 项目目录的 `.env`
3. `~/.hermes/.env`，如果你本来就在那里存 Key

`.env` 是 gitignored 的。不要把 Key 写进 systemd unit、README 或配置里。

`.env.example` 列了可选设置：监听地址、上游 base URL、OpenRouter 的app 标题/referer。

## 运行

```bash
git clone https://github.com/sitaoo/free-router.git
cd free-router
mkdir -p data && cp .env.example data/.env
# 编辑 data/.env，填上你有的 Key
./script/start.sh
```

网关默认监听 `127.0.0.1:8787`。`./script/stop.sh` 停止。请用普通用户跑这两个脚本；如果以 root 启动，它们会 re-exec 到目录属主身份，拒绝保持 root。

`ALL_PROXY`（或 `HTTPS_PROXY`，只认 `socks5`/`socks5h`）指向 SOCKS 代理时，上游请求走 curl。默认先直连，只有直连 DNS 失败才走代理；列进 `socksFirstHosts` 的域名则直接走代理。代理桥按 curl 输出的节奏转发，SSE 回答会逐 token 到达客户端，而不是等整段传输结束才一次性吐出。

## Docker 运行

```bash
git clone https://github.com/sitaoo/free-router.git
cd free-router
mkdir -p data && cp .env.example data/.env
# 首启前编辑 data/.env。Docker 发布端口需要
# FREE_ROUTER_HOST=0.0.0.0，外加非默认的 FREE_ROUTER_WEBUI_PASSWORD
# 和 FREE_ROUTER_API_KEY；宽绑定缺这两项会拒绝启动。
docker compose -f docker/compose.yaml up -d
```

发布端口只能转发到监听 `0.0.0.0` 的进程，所以种子必须这样写；新容器若仍绑定默认的 `127.0.0.1`，宿主机本机也访问不到。这个绑定同时接受局域网连接，因此服务在管理密码仍是 `admin123` 或没有网关 Key 时会拒绝启动——种子里的密码和 Key 正好满足检查。用种子里的密码打开 `http://127.0.0.1:8787/`，客户端用种子里的网关 Key。只在本机用可把映射从 `8787:8787` 改成 `127.0.0.1:8787:8787`。首启 `.env` 种子会迁入 `data/config.local.json`，之后 `.env` 文件彻底忽略，UI 改的一定生效。Key 永远不会 bake 进镜像。发现状态跟着 `./data` volume 跨重建保留。

```bash
docker compose -f docker/compose.yaml ps
docker compose -f docker/compose.yaml logs -f
docker compose -f docker/compose.yaml down
```

要让代码改动生效，重建再重建容器：

```bash
docker compose -f docker/compose.yaml up -d --build
```

前台运行：

```bash
node app/server.mjs
```

看当前模型池（免费模型在前，就是网关尝试的顺序；`--paid` 连已选付费模型一起列）：

```bash
./script/models.sh
./script/models.sh --paid
./script/models.sh --ready-only
npm run models -- --json
```

看请求实际落到哪、今日配额还剩多少：

```bash
./script/models.sh --usage
```

## Web 界面

打开 <http://127.0.0.1:8787/> 并登录（默认密码 `admin123`，去设置 →管理里改）。界面有状态、访问、渠道、设置、日志五个标签页：状态页看实时模型池优先级，渠道页管 Key、每个渠道的模型表（免费/付费成员与每日限额）和发现（Discovery），日志页列出最近 500 次客户端调用——结果、耗时、实际使用的 `provider:model` 与 Key 标签，以及每次请求内所有上游尝试的摘要，页面可见时每 5 秒自动刷新。记录只有元数据，绝不保存提示词、回复、请求头或 Key 值，且只存在内存里，重启即清空。每个网关响应都带 `X-Free-Router-Request-Id`，可与日志行对应。跟随浏览器语言，每处修改都立即对运行中的进程生效——除了 host、端口和少数标了"需重启"的设置（Save 旁边有重启按钮，Docker 下 supervisor 会把服务拉起来）。顶栏的主题按钮在跟随系统、浅色、深色之间切换，选择记在这个浏览器的本地存储里。

```json
"webui": {
  "enabled": true,
  "envFile": ".env"
}
```

设 `enabled: false` 可整个拿掉 `/` 和 `/api/*`。

### 鉴权模型

有两道独立的门：

- **Web UI + 管理接口**（`/`、`/api/*`）：管理密码登录，发 `HttpOnly`
会话 cookie。会话 `webui.sessionTtlHours` 后过期（默认 24，`0` 表示永不过期，此时是浏览器会话 cookie）。改密码会吊销所有会话。
- **网关接口**（`/v1/*`）：存在至少一个 Key 时要求 bearer Key（访问
tab）。一个网关 Key 都没有时，`/v1` 保持开放，方便本地用。

鉴权之外，浏览器侧的滥用照样过滤：跨站请求按 `Sec-Fetch-Site` 拒绝；`Host` 指向公网域名的（DNS rebind）拒绝，loopback、局域网、`.local`放行。纯 `curl` 不带这两个头，照常用。

页面自带 `Content-Security-Policy`：`default-src 'none'`，放开内联脚本与样式、`connect-src 'self'`、`img-src 'self'`。其中 `img-src` 不是装饰：标签图标是页面自己声明的图片，没有显式 `img-src` 时会回落到 `default-src 'none'`，浏览器连请求都不发，标签栏就静默地什么都没有。图标分三种格式，因为各自的规格不同——`/favicon.svg` 给标签页，`/mask-icon.svg` 给 Safari 固定标签（Safari 只用 alpha 通道、颜色由 `color` 属性给，所以必须是 16×16 viewBox 下的单层纯黑透明图形），`/apple-touch-icon.png` 给 iOS 主屏（Apple 只文档化 PNG，且 iOS 自己加圆角遮罩，所以图形要满幅）。PNG 在进程内生成而不是入库，仓库里不留二进制文件。实现见 `app/icons.mjs`。

### 写 Key 接口为什么要小心

`script/start.sh` 用 `set -a` source env 文件，能往里面写任意变量就等于下次启动时代码执行。所以写入路径是受限的：

- Provider Key 按 **provider 名**寻址，绝不按原始变量名。服务端从合并
后的配置里解析 `keyEnv`，写不出任何已配置渠道 Key 变量之外的东西。
- 含换行或 NUL 的值直接拒绝，一行字串不出第二个赋值。
- env 文件原子写入，权限 `0600`，已存在的文件会被 chmod 压下来。
- Key 只返回掩码版，绝不返回全文（新建的网关 Key 只在创建那一刻显示
一次）。
- 改完 Key 重建脱敏器，所以 UI 里加的 Key 照样会从上游请求里剥掉。

## 局域网访问

1. 放宽绑定：`FREE_ROUTER_HOST=0.0.0.0` 并发布端口
（`docker/compose.yaml` 里 `8787:8787`），宿主机防火墙也要放行。
2. 去 Web UI 建一个网关 API Key（访问 tab），改掉管理密码（设置 tab）。
状态页在做完之前会直接链过去。
3. `/v1/*` 带 `Authorization: Bearer <key>` 调；局域网任意浏览器打开 UI
登录即可。

网关本身只讲 HTTP，没有 TLS：放开绑定后，往返这个端口的一切——管理密码、网关 Key、提示词、模型回复——都以明文穿过网络，同一网段的任何人都能抓包读到。机器有公网 IP 时不要这样暴露。远程访问的正确做法是在前面加一层 HTTPS 反向代理（Caddy、nginx），由代理终结 TLS，并让 `FREE_ROUTER_HOST` 留在 `127.0.0.1`，只让代理连进来。设置 tab 的“允许局域网访问”开关打开时，服务卡片会显示对应的红色警示。

管理密码存的是加盐 scrypt 哈希，不是明文。`FREE_ROUTER_WEBUI_PASSWORD` 可覆盖，用于锁死时的应急恢复。

## 网关 API Key

给调 `/v1/*` 的客户端用的命名凭证（`sk-fr-…`，只在创建时显示一次）。建第一个 Key 即启用鉴权；删光即关闭（访问标题行的开关零 Key 时拒绝打开）。`/v1/models`、`/v1/chat/completions` 和 `/v1/responses` 都校验；`/health` 保持开放，给容器探活用。

## Provider Key（多账号）

一个渠道可以配任意多个 Key。命名 Key 住 `config.local.json`（UI 管理，带备注）；环境变量 Key 来自 `<KEYENV>`、`<KEYENV>S` 或 `<KEYENV>_KEYS`（逗号分隔，自动命名，UI 里只读）。单次请求的有效顺序：文件 Key、单个变量、复数变量，按值去重。请求在它们之间轮换；`401` 只退役中招那把，限流和超时只冷却那把，换下一把不行才换下一个模型。

首次启动时，`.env` 里的 Key 会一次性导入 `config.local.json`（命名为`migrated-N`）并从 `.env` 里删掉，UI 里有条可关闭的横幅提示迁了几个。有覆盖层之后 `.env` 文件彻底忽略（显式进程环境变量除外）。`.env` 里的个人 `FREE_ROUTER_API_KEY` 会额外变成一个命名网关 Key（`script/models.sh`现在优先读环境变量，其次读覆盖层里的网关 Key，所以 `.env` 删了也能用）。

## 配置分层

`app/config/config.json` 只放默认值、和上游保持一致可合并；操作员的一切改动都写 gitignored 的 `data/config.local.json`，服务端启动时深度合并（对象按 key 递归，数组和标量以覆盖层为准），运行中**只写覆盖层文件**，base 文件永不落盘。所有运行时状态（覆盖层、发现状态、`.env` 种子、日志）都在 `data/` 下；老版本根目录的遗留文件启动时自动搬过去，日志在`data/logs/`。

几个推论，提前说清楚：

- `git pull` 永远冲不掉你的设置，你的设置也永远进不了提交。
- 渠道的**删除**记成墓碑（`_removedProviders`），上游加回来也不会复活
你删掉的东西；旧版本留下的路由墓碑由 schema 迁移清掉。
- 以后的结构性新增走加法式 schema 迁移（只补缺的骨架键，用户的值
一个不动），盖着 `_schemaVersion` 戳。
- 完整优先级（从高到低）：显式进程环境变量 →
`data/config.local.json`（UI 写入和首启播种）→ `.env` 文件（仅首启，有覆盖层后彻底忽略）→ `app/config/config.json` → 代码内置。`FREE_ROUTER_CONFIG` 换 base 文件，`FREE_ROUTER_DATA_DIR` 换数据目录；测试把两个都指到临时目录以保持隔离。

## 对接任意 OpenAI 兼容客户端

把客户端指向网关；开了网关鉴权就把任一网关 Key 当 bearer token 发（没开鉴权时 `local` 这类占位符就行）。上游 provider 的 Key 不出网关。从不开鉴权就别放开 localhost 绑定。

**curl**

```bash
curl -s http://127.0.0.1:8787/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer sk-fr-...' \
  -d '{
    "model": "free-best",
    "messages": [{"role": "user", "content": "Reply with exactly: router-ok"}]
  }'
```

**OpenAI SDK**

```python
from openai import OpenAI

client = OpenAI(base_url="http://127.0.0.1:8787/v1", api_key="sk-fr-...")
print(client.chat.completions.create(
    model="free-best",
    messages=[{"role": "user", "content": "Hello"}],
).choices[0].message.content)
```

**Hermes**

```yaml
model:
  default: free-best
  provider: custom
  base_url: http://127.0.0.1:8787/v1
custom_providers:
  - name: free-router
    base_url: http://127.0.0.1:8787/v1
    api_key: sk-fr-...
    api_mode: chat_completions
    discover_models: true
    models:
      - free-best
```

或者加一条 `model_aliases.free-best` 再 `/model free-best` 切换。

选中的上游从 `X-Free-Router-Provider` 和 `X-Free-Router-Model` 返回，外加 provider 自己的 `model` 字段。

两种方言在路上都被加固。出去的方向，上游请求按 Chat Completions 明示字段重建，客户端自己的记账字段（`features`、`variables`、`files`、`tool_ids`、`metadata`、`models` 等）不会发给会回 `400 Unknown name "features"` 的渠道（Gemini 的兼容层就是）。`stream_options` 只在渠道支持时才带；不支持的渠道设 `"streamOptions": false`，随包的 Gemini 配置已经这样写。回来的方向，流 chunk 不再原样透传，而是统一整形：补齐 `id`、`created`、`object`，`model` 用客户端请求的那个 id（不是渠道内部的），`reasoning` 和 `reasoning_content` 两个字段保持同步，成功流只以一个 `[DONE]` 收尾。流式工具调用会补上 `index`，带工具调用的那一轮以 `finish_reason: "tool_calls"` 结束，即使渠道报的是 `stop`（Gemini 的兼容层两样都占）：OpenAI 兼容客户端按 `index` 聚合工具调用、只在这个 finish reason 下执行，没修过的流到了客户端就是一条空回答。响应已提交后上游断掉，会发一条 SSE 错误帧加 `[DONE]`，而不是静默结束。每个请求还会在日志里留下方言和顶层字段名（从不记录字段内容）。

## Responses API

`POST /v1/responses` 开箱即用，走的是和 `/v1/chat/completions` 同一套模型池、Key 轮换、配额、冷静期和用量计数。网关背后的渠道几乎只会 Chat Completions，所以这里不是透传而是双向翻译：`input`、`instructions`、`tools`、`tool_choice`、`max_output_tokens`、`text.format`、`reasoning.effort` 翻成 chat 请求，chat 的答案（或它的 SSE 增量）再翻回 `response` 对象（或 `response.*` 事件流）。

```bash
curl -s http://127.0.0.1:8787/v1/responses \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer sk-fr-...' \
  -d '{"model": "free-best", "input": "Reply with exactly: router-ok"}'
```

```python
from openai import OpenAI

client = OpenAI(base_url="http://127.0.0.1:8787/v1", api_key="local")
print(client.responses.create(model="free-best", input="Hello").output_text)
```

翻译保留的东西：`instructions`（变成 system 消息）、字符串和条目数组两种 `input`、`input_image`、`function_call`/`function_call_output` 历史、function 工具、`text.format`（变成 `response_format`）、推理强度，以及流式。自定义（自由格式）工具会以"只收一个字符串的函数"发给上游，回来时还原成 `custom_tool_call`，Codex 这类客户端拿到的仍是原始工具输入。

无状态扇出做不到的，一律回 `400 invalid_request_error` 而不是悄悄忽略：`store: true`、`previous_response_id`、`conversation`、`background: true`、`prompt` 模板和 `item_reference` 条目。托管工具（`web_search`、`file_search` 等）要在渠道侧执行，直接丢弃不转发。

流式按标准事件序列发（`response.created` → `output_item.added` → `content_part.added` → `output_text.delta` … → `response.completed`，或 `response.incomplete`/`response.failed`），`sequence_number` 连续，最后补一个 `data: [DONE]` 给等它的 OpenAI SDK。

## 接口

```text
GET  /                       Web 界面（要登录）
POST /api/login              { "password": "..." } -> 会话 cookie
POST /api/logout             吊销当前会话
GET  /api/state              完整 UI 状态（要会话）
GET  /api/logs               最近的客户端调用，最新在前（要会话）
POST /api/keys               provider Key：{ "provider", "name"?, "key" }
POST /api/gateway-keys       网关 Key：{ "action": "create|delete|setRequireAuth", ... }
POST /api/providers          { "action": "create|update|delete", ... }
POST /api/limits             每日限额：{ "action": "set|delete", "key", "limit" }
POST /api/discovery          发现开关、间隔、置顶
POST /api/settings           调优参数、会话 TTL、迁移提示
POST /api/webui-password     { "password": "..." }（存哈希，吊销所有会话）
POST /api/server             { "host", "port" }（重启生效）
POST /api/restart            退出等 supervisor 重启（要会话）
GET  /health
GET  /v1/models              开了鉴权就要网关 Key
POST /v1/chat/completions    开了鉴权就要网关 Key
POST /v1/responses           同一套模型池，Responses 方言
```

`GET /health` 报 `package.json` 的 `version`（当前 `1.0.0`），发版用`v1.0.0` 这种 git tag。

`GET /v1/models` 依次返回 `free-best` 别名、池里全部免费文本模型、以及显式选中的付费模型。免费模型用裸 ID 列出（跨渠道去重）；当已选付费模型与某个免费条目同名时，它改以 `provider:model` 出现。点名免费模型会试当前提供同一 slug 的每家渠道；点名付费模型只用被选中的那一个 `provider:model`。

每个条目都带 OpenAI 标准的四个字段（`id`、`object`、`created`、`owned_by`），外加各家目录里真正公布的信息：`context_length`、`max_output_tokens`、`name`、`description`、`supported_parameters`、`input_modalities`、`output_modalities`、`pricing`、`expiration_date`、`provider`、`free`。元数据按模型跨渠道合并，因为各家口径不一样：Google 原生列表给 `inputTokenLimit`/`outputTokenLimit` 却没有发布日期，OpenRouter 有 `created` 和 `top_provider.max_completion_tokens`。一家没给的字段用另一家同一模型的补上；`pricing` 例外，价格是按渠道算的，绝不外借。真正不知道的保持 `0`（或干脆不出现），不编。

```bash
curl -s http://127.0.0.1:8787/health | jq
```

## 模型池

只有一个隐式模型池，没有需要维护的路由表。每个渠道贡献两类成员：

- **规则能证明的免费模型。** 公布价格的目录里，`pricing.prompt` 和 `pricing.completion` 都为 0 的聊天模型自动入池；没有价格的渠道用 `freeModels` 当白名单；探活给出正面结论也入池。负面结论（计费、没有免费额度、永久拒绝）则挡在自动路由之外。
- **操作员在「渠道 → 模型」里显式选中的模型。** 选中只代表"进池"，不代表免费：证据决定它标免费、付费还是价格未知；添加付费或未知价模型会先弹警示确认。

`free-best` 仍保留为「免费池、按分数排」的别名，也是请求省略 `model` 时的默认值。付费模型永不参与自动回退：只有请求点名时才使用，可以是裸 ID（同名免费模型排在前面），也可以是 `provider:model`。已知但未启用的模型返回 `404 model_not_enabled`，完全不认识的 ID 返回 `404 model_not_found`。

池成员跟着目录走：免费模型下架或变付费，下一次目录检查就离开池。被选中的模型即使探活判定为付费也仍然保留，负面结论只影响它的免费标签。没有可用 Key 的渠道在 UI 里可见，但不参与路由。只差 org 前缀或 `:free` 后缀的 ID 算同一个模型（比如 `gemini-3.8-flash` 和 `google/gemini-3.8-flash:free`）。

### 付费模型与资金不足

在「渠道 → 模型」勾选付费模型时会提示「付费模型可能会消耗你的费用，请谨慎添加」。加入后它出现在 `/v1/models`，并在状态页的付费池单列，标注为仅在点名时使用。

付费调用因资金不足被拒时，只把该 `provider:model` 停用 `cooldownMs.insufficientFunds`（默认 24 小时），渠道、它的 Key 和免费模型都不受影响。判定条件是：`402` 一律算；`400`/`403` 且错误文本提到资金、额度、余额或账单才算；`429` 永远不算。封锁期内点名该模型，网关不请求上游，直接返回 `402`，响应体带 `error.type = "insufficient_funds"`、`retry_after_seconds`，并附 `Retry-After` 头。封锁写进状态文件，重启不会忘，到期自动失效，不需要定时器。

## 加新渠道

OpenAI 兼容的 `/chat/completions` 端口加进来不用改代码。`providers.mjs`的注册表加载 `config.json` 里 `providers` 下的每一块。最省事的是 Web UI（渠道 tab → 添加渠道）：预设菜单会填好 Gemini、OpenRouter、TokenRouter、B.AI、HashNeuron、Groq、Cerebras、Mistral、Hugging Face 的地址和发现开关，其他服务选 Custom。预设只是快捷方式，Key 仍要自己贴。手改的话：

1. 加一个 provider 对象。有 `GET /models` 就 `"catalog": true`；返回体
带逐 token 价格才加 `"pricing": true`。服务端会按真正拉到的行重新判定，
所以标了 `pricing` 但目录里没有价格字段的渠道会自动转为探活。
2. 入池不用再写别的：带价格的目录自动贡献零价聊天模型；无价格目录在有
Key 后由后台探活补上。完全没有目录的渠道，把免费 ID 写进 `freeModels`（见下）。
3. 要启用付费或价格未知的模型，把它加进该渠道的 `selectedModels`
（「渠道 → 模型」会做这件事，并先给警示）。
4. 可选：`discovery.evaluation.pinnedModels` 里 `name:model` 置顶。
5. `.env` 或 `~/.hermes/.env` 里设 `<NAME>_API_KEY`；URL 不一样用
`<NAME>_BASE_URL` 覆盖。
6. 只有改了要重启的开关（`catalog`、`pricing`）才重启；Key、地址、
白名单、选中列表、`probeFreeTier` 都是即时生效。

```json
"newvendor": {
  "baseUrl": "https://api.example.com/v1",
  "freeModels": ["example-free"]
}
```

可选字段：`keyEnv`、`baseUrlEnv`、`headers`、`chatPath`、`modelsPath`、`discover: false`（把带价格目录的渠道排除在发现之外）、`probeFreeTier: true`（让无价格目录自己探出免费模型）、`streamOptions: false`（渠道的 OpenAI 兼容层不接受 `stream_options` 时）。创建表单和每个渠道的高级设置里都有同一个探活开关，切换后立即生效，不用重启。

`modelsUrl` + `modelsKeyHeader` 覆盖一种特殊情况：目录不在 chat 前缀下、走独立鉴权。Gemini 两样都要，因为只有它的原生列表里才有`supportedGenerationMethods`，而且它对 Bearer token 直接回 `401`。两种返回形状都认：OpenAI 的 `data[].id` 或 Google 的 `models[].name`。

### 每个渠道给发现贡献什么

`catalog` 和 `pricing` 是两个独立开关，因为"拉 `/models`"和"分得出免费还是收费"是两种能力：

| `kind` | 配置 | 免费模型从哪来 | 发现里的角色 |
|---|---|---|---|
| `catalog` | `catalog: true, pricing: true` | 零价格目录条目 | 又加又减 |
| `static+catalog` | `catalog: true, pricing: false` | `freeModels`，外加实际能免费服务的 | 只管减；`probeFreeTier` 开了也能加 |
| `static` | 都不设 | `freeModels` | 无 |

公布逐 token 价格的目录才能只靠列表加入未知模型。Gemini、TokenRouter、B.AI、HashNeuron 的 `/models` 没有 `pricing` 字段，免费收费混在一起，按列表自动加可能把流量引到计费模型上。它们改成探活（下面的 `probeFreeTier`），四家默认都开。它们的目录照样拉，用来拿掉已下线的 `freeModels` 条目，以及给探活提供候选。下架的模型一回来就自动恢复。

新增或修改渠道、保存 Key 都会在后台立即跑一批探活，不等待、不用重启；每批结果出来就进池。「渠道」页在 `probing` 为真或 `probePending` 大于 0 时自动轮询刷新。`discovery.evaluation.probeBatchSize`（默认 3）是每批模型数，`probeBatchDelayMs`（默认 2000）是批次间隔，`probeMaxPerProvider`（默认 100）限制单渠道每轮最多探多少。关掉 `evaluation.enabled` 就完全停止探活。

目录拉失败、返回空、或者渠道没 Key，都不改变现状：原来的价格语义和 `freeModels` 照旧生效。删条目必须看到一份**真正拉到的**目录，上游一抖不会清空模型池。

编辑弹窗里的 **获取模型** 按钮改成只报渠道名（`{ "action": "fetch-models", "provider": "name" }`），不再只发 Base URL。服务端用它已保存的 Key 和该渠道自己的鉴权头（`modelsKeyHeader`）去拉 `/models`，所以要求凭证的列表接口——HashNeuron 对匿名请求直接回 `401`——不会逼人重贴一个早就存过的 Key。表单里现填的 Key 会先试；它被 `401`/`403` 拒绝时再退回已保存的 Key，而不是整次拉取失败。显式传 `baseUrl` 仍然覆盖保存值，方便在保存前先试改过的地址。凭证被拒时错误信息会直接说明这一点，不再只显示 `catalog HTTP 401`。

模型 ID 按 slug 比对，所以 Gemini 的 `models/gemini-3.8-flash` 对上配置的 `gemini-3.8-flash` 不算下架。

`/health` 在 `discovery.addsFrom`、`discovery.availabilityOnly`、`discovery.unavailableModels` 里报这些；Web UI 在所属渠道旁边标下架模型。

## 免费模型发现

路由器每 `discovery.intervalMs`（当前每 2 天）扫一遍带价格目录和开了 `probeFreeTier` 的目录渠道，看有没有新的免费文本模型。「渠道 → 发现」里的 **立即运行** 会跳过这个间隔、在后台启动一轮，运维不用等定时器，也不用重启服务。每个新模型得一次缓存的混合评测：确定性推理/指令题、延迟、上下文长度、工具和结构化输出支持，分数决定它在池中的位置。

分数三部分封顶，单项带不动全局：

| 部分 | 上限 | 说明 |
|---|---|---|
| benchmark | 65 | 10 道确定性题，最难 3 道占 28 分 |
| metadata | 20 | 工具、结构化输出、上下文长度、模态、新鲜度 |
| latency | 6 | 一次冷采样，故意只做小权重平局裁决 |

分数缺失、还是 `pending`、或是老 benchmark 版本产的，都会重评。不然单次评测撞上 429 的模型会永远背着 `-1` 的 fallback 分垫底——它已经在跟踪名单里，再也不会被当新模型看。每轮最多评 `evaluation.maxPerRun` 个。没有配置锚点、没有 `baselineScores`、也还没评测分时，路由器改用随包携带的 SWE-bench Verified 先验（`app/data/swe-bench.json`，与上游发布的是同一份非官方快照），而不是直接给 `-1`。`/health` 每条用 `scoreSource` 报告分数来源：`baseline`、`evaluation`、`swe-bench` 或 `unranked`；Web UI 状态页的模型池表把来源放在评分格的提示里。

排名还会跟着真实流量走。单个模型在用量窗口攒够`evaluation.usageMinRequests` 次尝试后，成功率按`evaluation.usageWeight` 上下调分：100% 加满，80% 不动，60% 及以下扣满。置顶模型豁免。同一模型多家提供时按最好的一家排名，一家拉胯不连累模型。`./script/models.sh` 的 `score`、`source`、`rank+-` 三列分别看当前分数、来源和偏移，`/health` 里每条有`baseScore` 和 `scoreAdjustment`。

### 打分尺度与实时信号

所有基线信号都在 0-100 的明示尺度上：配置锚点（94 起，30 兜底，外加封顶的能力画像加成，排得靠后的强模型不会被埋没）、评测分（约 0-91）、手写 `baselineScores`（钳制进尺度）、用量浮动（±`usageWeight`）。置顶模型在尺度之上（有限值 150），不吃流量浮动。

失败先分类再记分：容量信号（`rateLimit`、`timeout`、`overloaded`）只进冷却；路由、账单、凭证故障（`notFound`、`forbidden`、`payment`、坏 Key的 `401`）只记录不打分。只有质量失败（空回复、坏回复、上游错误）才动分。连续超时会把该候选/Key 的冷却翻倍（`cooldownMs.timeout` 是第一次等待，`cooldownMs.timeoutMax` 封顶，默认一小时），出现任何其他结果就清零：老挂住的模型不会和偶尔失败一次的模型一样每 5 分钟被踩一遍。

每次请求还有两个实时信号参与排序：

- **稀缺**：5 分以内，剩余额度多的赢，聪明但稀缺的模型留到刀刃上用；不限额的排最前。
- **延迟**：滚动平均的「首个有效 token」时间 5 秒内 +2，30 秒内 0，以上 −2，攒够 5 个样本才生效。统计到第一个正文或工具调用增量为止，不等到回答结束，长回答不会被当成慢启动；小而封顶。

百分之几的请求（`routing.explorePercent`，默认 5）会绕去没跑过的模型，让冷模型有机会赚流量；置顶模型永远不让第一。外部榜单走`script/sync-scores.mjs` 写 `baselineScores`（40-80 先验带），带来源戳，详见 `./script/sync-scores.mjs --help`。

排序之前，`filterCandidates` 会先丢掉公开 `context_length` 明显装不下这次请求的模型。它从 messages 和 tools 的 JSON 估算输入 token（中日韩字符接近 1 token/字，拉丁文约 4 字符/token），再加上请求的 `max_tokens` / `max_completion_tokens` / `max_output_tokens`；只有已知窗口小于这个和时才跳过。窗口未知、大小无法估算、或请求里带内联媒体（按分辨率计费，不按字符数）都保留候选，所以估算最多多花一次上游尝试，不会误杀本来能用的模型。被跳过的候选会在日志里标 `request exceeds context window`。

### 问渠道什么免费

没价格的目录回答不了"哪个免费"，但可以直接问。`probeFreeTier: true`的渠道，每个没见过的聊天模型吃一次真实请求，回复即答案：

| 回复 | 含义 | 效果 |
|---|---|---|
| `200`，无计费字段 | 这把 Key 能 serve | 免费；带评测分进池 |
| `200`，`usage.cost` / `credits` 大于 0 | serve 了，但计费 | 不免费；不进自动路由 |
| `429`，免费配额全 `limit: 0` | 根本没有免费档 | 不免费 |
| `429`，有 `limit` 大于 `0` | 免费，但今天花完了 | 留下；数字变每日限额 |
| `404` | 不接，或下架了 | 不免费 |
| `400` "only supports Interactions API" | 不是聊天模型 | 从候选里去掉 |
| 超时、`5xx` | 说明不了问题 | 无 verdict，下轮再探 |

响应里的正数账单压过状态码和目录：请求确实跑了，但不是免费的，就不能进自动路由。被选中的付费模型不受负面结论影响，结论只改它的免费标签。仍然建议用无账单的 Key，因为不报 `cost` 的计费网关用这招看不出来。

每个 verdict 缓存进状态文件，一个模型一辈子只花一次探路钱，`evaluation.maxPerRun` 卡单轮上限。"不免费"的 verdict 过`discovery.verdictRetryMs`（默认等于发现间隔）过期，provider 抖一下不会永久退役模型；"免费"的不过期，反正正常流量天天 revisit，翻车了后来的拒绝会覆盖。

免费 verdict 不跟着发现条目一起丢。状态迁移或手改只留下了 verdict、丢了条目时，下一轮目录刷新会把模型补回池，不再花一次探路请求。

verdict 双向压过 `freeModels`，这就是意义所在：`config.json` 的白名单只是你对别人定价的猜，配额数字是 provider 亲口报的价。

发请求前先窄化候选。Google 原生列表用 `supportedGenerationMethods` 标能力，所以 embedding、视频、直播音频模型不用点名就掉了；图片、语音、音乐、转写、agent 专用模型和普通聊天模型共用 `generateContent`，所以`discovery.exclude.modelPatterns` 管它们，连同 `-latest` 这种别名（它和指向的 concrete 模型会 double-count 一份配额）。

### provider 上报的每日限额

`config.json` 的 `usage.dailyLimits` 只是起始猜测。provider 拒绝请求时报出真实配额，这个数就替换掉该模型的配置值。`/health` 标谁在生效：`reported` 是 provider 说的，`configured` 还是本地猜的。

同一个回复还驱动冷却。每日配额花完就等到 `usage.timezone` 的配额日切换，而不是固定间隔——半夜不会白重试，也不会 idle 过复位点。按分钟的限额用provider 让等的 `retryDelay`。

### 排除领域专用模型

窄领域调优的模型刷通用 benchmark 分很高，但当默认模型很烂。`discovery.exclude` 管这个：

- `modelPatterns`：模型 ID 的大小写不敏感正则。
- `textPatterns`：目录 `name` + `description` 的大小写不敏感正则。这个更
经久，因为厂商改名换后缀，描述里讲它是干嘛的可一直都在。

两条红线是故意的：`freeModels` 或 `selectedModels` 里写了的豁免，显式声明永远赢过滤器；排除只作用于自动发现的免费模型，不会把已选模型移出 `GET /v1/models`，精确 ID 照样可调，点名即 deliberate。

过滤建池和收集时都生效，所以新 pattern 重启即生效，不用等下一轮收集。`/health` 在 `discovery.excludedModels` 里列当前命中。

`evaluation.baselineScores` 直接覆盖分数（钳制在 0-100 内），按 `provider:model` 或裸模型ID 找。发现的和配置的都管，优先于评测分，适合埋掉那些自动打分虚高的模型。

自动发现的 catalog 模型变付费、下架、不再符合文本聊天，下一轮目录检查自动移出模型池。目录哪天又标免费就恢复。

`static` 渠道的候选，有 `freeModels` 又有 Key 就一直在；`static+catalog`的还得出现在拉到的目录里，不在的进 `discovery.unavailableModels` 报备。写进 `selectedModels` 的模型只要有可用 Key 就留在池里，不受目录影响。

发现和评测状态存 `discovered-free-models.json`，重启不丢，那文件是gitignored 的。

排期和探活配在 `config.json`：

```json
"discovery": {
  "enabled": true,
  "intervalMs": 172800000,
  "stateFile": "discovered-free-models.json",
  "exclude": {
    "modelPatterns": [],
    "textPatterns": [
      "\\b(finance|medicine|legal)[\\s-]*(focused|specific)\\b"
    ]
  },
  "evaluation": {
    "enabled": true,
    "maxTokens": 4000,
    "maxPerRun": 8,
    "usageWeight": 12,
    "usageMinRequests": 20,
    "probeBatchSize": 3,
    "probeBatchDelayMs": 2000,
    "probeMaxPerProvider": 100,
    "pinnedModels": [
      "gemini:gemini-3.8-flash",
      "gemini:gemini-3.7-flash",
      "tokenrouter:z-ai/glm-5.3-free",
      "bai:glm-5.3-flash"
    ]
  }
}
```

`/health` 报上次收集时间、见过的免费模型、分数、免费池与付费池、以及因为不免费被拿掉的模型。每个渠道 `freeModels`、`selectedModels` 里的位置当种子锚，从 94 起每位减 4，地板 30；置顶、baseline、评测和 SWE-bench 分排在它上面。

评测请求和普通请求一样计用量，因为烧的是同一份 provider 配额。

## 请求历史和每日配额

每次上游尝试都按天、按 `provider:model` 计数，一眼看出这周流量到底谁serve 了、谁快摸到免费日 cap。计数器和发现状态住同一个`discovered-free-models.json`，最多 1.5 秒回写一次，按`usage.retentionDays` 裁剪。

```bash
./script/models.sh            # 优先级表，带 today / 7d / fail 列
./script/models.sh --usage    # 按天、按模型的历史
```

```json
"usage": {
  "retentionDays": 7,
  "timezone": "America/Los_Angeles",
  "dailyLimits": {
    "gemini:gemini-3.8-flash": 20,
    "gemini:gemini-3.5-flash-lite": 200
  }
}
```

- `timezone` 决定哪天翻天。Gemini 免费档的日请求计数按太平洋午夜清，
所以主机在哪都建议留 `America/Los_Angeles`；不填就用主机本地日期。
Web UI 的时区是带搜索的下拉（输入框即过滤框），选项来自运行时自带的 IANA 列表加 `UTC`，所以界面不会给出服务端不认的值。保存时服务端会规范别名（`Asia/Kolkata` 存成 `Asia/Calcutta`、大小写无关），不认识的时区直接 400 而不是写进配置——否则只有重启后的日志里才会发现日界线一直是错的。改了要重启才生效，保存后的提示会说明。
- `dailyLimits` 按 `provider:model`、裸 `model`、`provider:*` 顺序匹配。
限额只做展示参考，到了也不停发，因为数字是手维护的。
- `today` 列和 `remainingToday` 只算烧配额的尝试；限流、404、403 是
provider 在跑模型前就拒了，不算。
- 失败桶有 `rateLimit`、`timeout`、`serverError`、`empty`、
`notFound`、`forbidden`、`aborted`、`other`——请求掉到低优先级模型的*原因* 看得见。

`GET /health` 的 `usage` 里是同一份数据，每条池条目自带 `usage` 块。

## systemd 用户服务

unit 默认仓库在 `~/free-router`，clone 到别处先改 `WorkingDirectory`和 `ExecStart` 再 enable。

```bash
mkdir -p ~/.config/systemd/user
cp script/free-router.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now free-router
journalctl --user -u free-router -f
```

不用 systemd 就 `./script/start.sh`。

## 路由行为

1. 按**模型**给免费池排名。置顶按配置顺序打头，其余跟 baseline、
发现分数和渠道种子顺序；同一 `provider:model` 各自成组排名。
2. 付费池只在请求点名已选中的付费模型时使用，永不进入自动回退或
探索抽签。
3. 每个模型，把当前提供它的免费渠道都试一遍。在
`freeModels`/`selectedModels` 里写了它的渠道先行，同 slug 别家跟上。目录 ID 先剥 org 前缀和 `:free` 尾巴再比对，所以 OpenRouter 后出的 Google/B.AI 同款免费版会紧跟原版试，而不是另起一行。
4. 一把可用 Key 都没有的渠道跳过。
5. catalog 渠道每 15 分钟刷新。
6. 每 `discovery.intervalMs` 收集新免费目录文本模型、评测，由分数决定
它在池中的位置。目录里撞见已知模型，挂到那条下当多渠道，不当新模型评。
7. 自动发现的目录模型变付费、下架、不再符合文本聊天，移出模型池。
8. 缺请求要的能力（工具、图片输入等）的模型去掉。
9. 剩下按统一顺序试；全冷却兜底只放行容量类失败，`payment`、
`notFound`、`forbidden` 永不重试，处于资金不足封锁期的条目也不放行。
10. 限流、超时、服务端错、空成功回复走 provider/model/Key 三级冷却；
`401` 只退役那把 Key。
11. 发上游前，把本地环境里 `*_API_KEY` / `*_TOKEN` / `*_SECRET` /
`*_PASSWORD` 的值（含 provider Key、网关 Key、管理密码）以及这些名字的 `NAME=...` 赋值行都脱敏。这拦不住 Hermes 在本地读 `.env`，只保证这些值不进 OpenRouter、TokenRouter、B.AI 的请求体。
12. 推理专用的流 chunk 先攒着，模型吐出正文或工具调用才往客户端发，空模型照样能被换掉。等待有上限 `streamCommitGraceMs`（默认 10 秒，`FREE_ROUTER_STREAM_COMMIT_GRACE_MS` 环境变量优先）：超时就把已攒的前缀先发出去、剩下实时透传，浏览器和代理永远不会卡在无头连接上。这个期限是定时器，一个 delta 之后长时间没动静也会按时提交，不用等上游下一次读。这样提交了却始终没有正文的流，客户端照旧拿到 200，但记账按 `empty` 算、永不记 `ok`。到 `firstByteTimeoutMs`（默认 60 秒，`FREE_ROUTER_FIRST_BYTE_TIMEOUT_MS` 优先，0 关闭）还没吐出一个正文字节的模型按卡死处理、不按慢处理：直接放弃这次尝试换下一个候选，等响应头和等第一个 chunk 都算在这个期限内。提交之后的流，只要 `streamKeepAliveMs`（默认 15 秒，`FREE_ROUTER_STREAM_KEEPALIVE_MS` 优先，0 关闭）内没有上游 chunk，就发一条 SSE `: keep-alive` 注释，长时间推理不会被当成卡住。
13. Gemini 工具调用续聊，把 OpenAI 客户端丢掉的
`extra_content.google.thought_signature` 贴回去。优先用上次 Gemini回包缓存的签名，不然用 Google 的 `skip_thought_signature_validator`哨兵，省一次烧配额的 400。还 400 就跳过同请求的剩下 Gemini 模型。

省略 `model` 或发 `free-best` 走免费池；点名免费模型 ID 会试当前提供同一模型的每家渠道；点名已启用的付费模型只用该选中项。`provider:model` 强制只用一家。
