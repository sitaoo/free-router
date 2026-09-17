# Free Router

> [English](../../README.md) | 中文

<p align="center">
  <img src="../og.png" alt="Free Router 架构：任意 OpenAI 客户端 → 本地网关 → 可插拔 providers" width="100%">
</p>

本地 OpenAI 兼容网关。把任意客户端指向
`http://127.0.0.1:8787/v1` 并使用 `free-best`。它会对你配置的**任意
OpenAI 兼容 provider** 的当前免费模型做排名，遇到限流、宕机或空回复时
自动 Failover。缺 Key 的 provider 直接被跳过。

站点：[www222fff.github.io/free-router](https://www222fff.github.io/free-router/)

## 运行

Node.js 20+。把 `.env.example` 复制为 `.env`，填至少一个 provider 的 Key，
然后：

```bash
git clone https://github.com/www222fff/free-router.git
cd free-router
mkdir -p data && cp .env.example data/.env
./script/start.sh
```

`./script/stop.sh` 停止。Docker：`docker compose -f docker/compose.yaml up -d`。打开
<http://127.0.0.1:8787/> 登录（默认密码 `admin123`）、填 Key、看用量。
界面有状态、访问、渠道、路由、配额、设置几个标签页，几乎所有配置都能
在里面改，并跟随浏览器语言（内置 12 种语言）。

| 变量 | 获取位置 |
| --- | --- |
| `GEMINI_API_KEY` | [Google AI Studio](https://aistudio.google.com/apikey) |
| `OPENROUTER_API_KEY` | [openrouter.ai/keys](https://openrouter.ai/keys) |
| `TOKENROUTER_API_KEY` | TokenRouter |
| `BAI_API_KEY` | [chat.b.ai](https://chat.b.ai) |

一个 provider 需要多个 Key？设置 `OPENROUTER_API_KEYS`（或
`OPENROUTER_API_KEY_KEYS`），逗号分隔填多个值；也可以在 Web UI 里添加
命名 Key——请求会在它们之间自动轮换。

加新渠道：在 `config.json` 里加一段，或在 Web UI 里只填名字和 base URL
添加。详见[工作原理](HOW_IT_WORKS.md)。

## 局域网访问

首次启动前在 `data/.env` 里设置 `FREE_ROUTER_HOST=0.0.0.0`（会被迁移进
`data/config.local.json`，之后覆盖层说了算，所以 UI 里再改一定生效），并在
`docker/compose.yaml` 里放开端口。然后，先做这两件事再暴露：

1. 在 Web UI（访问 tab）创建一个网关 API Key——有了 Key 之后，`/v1/*`
   要求 `Authorization: Bearer <key>`。
2. 改掉管理密码（设置 tab）。

调用方式和普通 OpenAI 接口一样，只是多一个 Key：

```bash
curl -s http://<lan-ip>:8787/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer sk-fr-...' \
  -d '{"model": "free-best", "messages": [{"role": "user", "content": "hi"}]}'
```

## 配置分层

`app/config/config.json` 只放默认值，保持可合并。你的所有改动——Web UI
里改的、首次启动从 `.env` 播种的——都写进 gitignored 的
`data/config.local.json`，启动时覆盖默认值（对象按 key 合并，数组整体
替换）。`.env` 文件只在首次启动（还没有覆盖层时）读取播种，之后彻底
忽略，所以 UI 里改 host/端口/密码一定生效；显式进程环境变量永远最高。
Provider Key 也可以直接走环境变量，Key 可以完全不落文件。

```bash
./script/models.sh          # 当前 free-best 排序
./script/models.sh --usage  # 今日配额
```

## Star History

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/svg?repos=www222fff/free-router&type=Date&theme=dark" />
  <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/svg?repos=www222fff/free-router&type=Date" />
  <img alt="Star History Chart" src="https://api.star-history.com/svg?repos=www222fff/free-router&type=Date" />
</picture>
