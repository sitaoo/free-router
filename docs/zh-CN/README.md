# Free Router

> [English](../../README.md) | 中文

<p align="center">
  <img src="../og.png" alt="Free Router 架构：任意 OpenAI 客户端 → 本地网关 → 可插拔 providers" width="100%">
</p>

把散落在各家的**免费大模型**，拼成一个**用不完、打不挂**的 OpenAI 接口。
任意客户端指向它，只调 `free-best`：模型限流、宕机、额度烧完，它自动换下一个顶上。

- **零依赖**：纯 Node 标准库，没有 `npm install`，没有供应链包袱。
- **开箱即用**：首次启动自己生成默认配置，打开浏览器就能配。
- **Key 自由**：同一渠道多 Key 自动轮换，401 只退役坏的那一把。
- **额度透明**：免费配额按天跟踪，烧完的模型自动让路，第二天回来。
- **局域网就绪**：一键开关 + 网关鉴权，手机、平板、家里其他机器都能用。
- **讲你的语言**：12 种界面语言，跟随浏览器自动切换。

## 60 秒上手

```bash
git clone https://github.com/www222fff/free-router.git
cd free-router
./ctl.sh start          # 只要 Node 20+，无其他依赖
```

打开 <http://127.0.0.1:8787/>，默认密码 `admin123` 登录。
去**渠道**页粘贴至少一个 Key，然后：

```bash
curl http://127.0.0.1:8787/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"model": "free-best", "messages": [{"role": "user", "content": "hi"}]}'
```

通了。
路由排序、配额、局域网、网关 Key，剩下的全在 UI 里点。
`./ctl.sh stop` 停止，`./ctl.sh status` 看状态。

## 它在背后做什么

- **每两天自动发现**：扫描各渠道目录，新出现的免费模型先做一套能力实测，够格才进榜。
- **每次请求现场排名**：配置顺序定起跑线，真实成功率、冷静期、日限额实时加权， pinned 模型永远先上。
- **0-100 打分尺度**：画像加成、稀缺让路、实时延迟微调排序，百分之几的流量探冷模型。详见[打分尺度与实时信号](HOW_IT_WORKS.md#打分尺度与实时信号)。
- **坏 Key 不连坐**：401 只退役当前 Key，限流只冷却当前 Key，从不给模型记黑账。
- **配置丢不了**：出厂默认和你的改动分文件存放，`git pull` 永远冲不掉设置。
- **跑在哪都行**：裸机前台、`systemd` 常驻、Docker 容器，数据全在 `data/` 这一个目录里。

## 进阶

```bash
./script/models.sh          # 当前 free-best 实时榜
./script/models.sh --usage  # 谁烧了多少配额
./ctl.sh docker --dev       # Docker 开发模式（代码热挂载）
```

- 局域网：设置 → **允许局域网访问**，按页面的地址列表连，记得先建网关 Key、改密码。
- 加新渠道：Web UI 里填名字和 base URL，或往 `app/config/config.json` 加一段。
- 原理与配置分层：[工作原理](HOW_IT_WORKS.md)。

## Key 去哪领

| 变量 | 获取位置 |
| --- | --- |
| `GEMINI_API_KEY` | [Google AI Studio](https://aistudio.google.com/apikey) |
| `OPENROUTER_API_KEY` | [openrouter.ai/keys](https://openrouter.ai/keys) |
| `TOKENROUTER_API_KEY` | TokenRouter |
| `BAI_API_KEY` | [chat.b.ai](https://chat.b.ai) |

命名规则：`FOO_API_KEY` + `FOO_BASE_URL`，任意兼容 OpenAI 的渠道照此即用，多 Key 逗号分隔。

## `.env`（可选）

UI 是正道，`.env` 只给两种人准备：首启播种和无 UI 的机器。
`mkdir -p data && cp .env.example data/.env`，填好首启自动迁入配置，之后不再看它。
显式环境变量永远最高，Key 也可以完全不落文件。
