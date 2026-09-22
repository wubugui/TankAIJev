# 坦克大战 · NPC 测试台

一个 2v2 网页坦克大战，用来测试 **Jev**（TypeSafe 的 System One 决策模型）、**Laya**（开源、Jev 兼容的决策模型）等模型作为**队友**和**敌人**的表现。每辆坦克的控制者都可以单独选：Laya、Jev、规则 AI 任意组合，对局中也能随时切换。

**在线试玩：<https://wubugui.github.io/TankAIJev/>**

- 规则 AI、随机 AI 在浏览器里运行，打开网页就能玩，不需要任何配置
- 要用 Jev / Laya：在游戏的"AI 连接设置"里填你自己的 key 和 endpoint。它们只保存在你的浏览器里，不会上传到本站
- 纯 Node.js 22，无第三方依赖（Laya 适配器除外）

## 快速开始

**在线**：打开上面的网址 → 选控制者 → 开始对局。

**本地**（也是 Jev 的中转服务，见下文）：

```bash
git clone https://github.com/wubugui/TankAIJev.git
cd TankAIJev
npm start
```

打开 <http://localhost:3000>。

操作：
- **移动**：WASD / 方向键；**开火**：空格 / J
- **给 AI 队友下命令**：`1` 进攻、`2` 回防、`3` 跟我、`4` 自由（你操控 B1 时生效）
- `P` 暂停、`R` 重开、`Esc` 返回设置。切到别的标签页会自动暂停，避免空耗调用

胜利条件：打爆对方基地（10 血），或打光对方坦克（每辆 3 条命）。时间到先比基地血量，再比击杀数。地图关于中心 180° 对称；规则 AI 自己对打 800 局的结果是 404:395，双方公平。

## AI 连接设置

设置页里有一块"AI 连接设置"：

| 项 | 说明 |
|---|---|
| 中转服务地址 | 默认 `http://localhost:3000`（本机 `npm start`）；用 `npm start` 打开游戏时留空即可 |
| Jev API key | 你自己的 TypeSafe key。**必须经中转** |
| Jev 本浏览器花费上限 | 默认 $1；按 Jev 返回的 token 数记账，到上限就停止调用，可调高或清零 |
| Laya Endpoint / API key | 你自己的 Laya 服务，只填根地址即可（`https://host:8790`），会自动补 `/v1/systemone` |
| Laya 调用方式 | 经中转（默认，局域网 http 地址用这个），或浏览器直连 |

每项都有"测试连接"按钮。默认勾选"在本浏览器记住"（存 `localStorage`），不勾选则只存在当前标签页。"清除已保存的 key 和地址"可以一键删掉。

### 为什么需要中转

- **Jev 拒绝所有网页的跨域请求**。它的服务器对任何第三方来源的预检都返回 `Disallowed CORS origin`，包括 localhost，所以任何静态网页都没法在浏览器里直接调用 Jev。
- **https 页面不能访问 http 局域网地址**。GitHub Pages 是 https，浏览器会把对 `http://192.168.x.x` 的请求当作混合内容拦掉；而且 Laya 服务本身不一定支持 CORS。

中转服务接收页面发来的 `{ backend, url?, apiKey?, state, questions }`，转发给 Jev / Laya 再把结果返回。它**不保存、不记录任何 key**。有两种：

**1. 本机中转：`npm start`**（推荐，也能访问你的局域网 Laya）

- 监听 `127.0.0.1:3000`，只接受白名单里的网页来源：默认 `https://wubugui.github.io` 和本机页面，可用 `.env` 的 `CORS_ORIGINS` 改（逗号分隔）
- 只接受 `application/json` 请求：这样浏览器一定会先发跨域预检，别的网站就没法用"简单请求"偷偷驱动它
- 会回应 Chrome 的私有网络预检（`Access-Control-Allow-Private-Network`）。新版 Chrome 第一次从 GitHub Pages 访问 localhost 时，可能弹出"允许访问本地网络"的提示，点允许即可
- Jev 的目标地址固定为官方地址，页面改不了；Laya 地址必须以 `/v1/systemone`（或 `/alpha/decisions`）结尾
- 页面没填 key 时，会用 `.env` 里的 key，但**只对 `.env` 里配置的那个地址生效**；这时 Jev 花费还受 `.env` 的 `BUDGET_USD` 约束。页面填了 key 就用页面的

**2. Cloudflare Worker：[`relay/cloudflare-worker.js`](relay/cloudflare-worker.js)**（不想在本机跑 Node 时）

- Cloudflare 控制台 → Workers & Pages → 创建 Worker → 粘贴文件内容 → 部署，然后把 Worker 网址填进"中转服务地址"
- 可选环境变量 `CORS_ORIGINS`
- 只转发 Jev 和 **https** 的 Laya 地址（Worker 访问不到你的局域网），而且必须由页面带 key，不支持"服务端 key"，否则任何打开游戏的人都会花你的钱

### Laya 浏览器直连的条件

不经中转直接调用 Laya，服务必须同时满足：
1. 地址是 https，或者是 `localhost` / `127.0.0.1`；
2. 回应 CORS 预检：`OPTIONS` 返回 `Access-Control-Allow-Origin`（本站来源）、`Access-Control-Allow-Headers: Authorization, Content-Type`；
3. 如果是公网页面访问本机地址，还要回应 `Access-Control-Allow-Private-Network: true`。

不满足就用"经中转"。

## 控制者类型

| 类型 | 说明 |
|---|---|
| 人类玩家 | 键盘操作，只能放在 B1 |
| 规则 AI | 手写规则，作为**基准线**；和模型看到的选项完全相同 |
| 随机 AI | 从选项里随机选，作为下限 |
| 木桩 | 不动也不开火 |
| Laya / Jev | 按"AI 连接设置"调用 |
| Mock | 浏览器内随机返回 Jev 格式的答案，不联网，测试用 |

四辆坦克各有一个下拉框（设置页和对局中的右侧卡片都有），分三组：**决策模型**（Laya、Jev）、**基准**（规则 AI；B1 还可选人类玩家）、**测试用**（Mock、随机、木桩）。选了模型但还没配好的，下拉框和开局提示里会写明原因。

### 决策模式

- **战术层**（默认）：模型每隔 N 毫秒从 6~9 个战术里选一个，包括进攻基地、回防、追击某辆敌车、立即开火、闪避、撤退、跟随队友、原地坚守。走位、寻路、瞄准由程序完成。**所有 AI 共用同一个执行层**，差别只在"选什么"。
- **直接控制**：模型每一步从"上下左右移动 / 朝某方向开火 / 等待"这 9 个动作里选一个。每个选项都带程序算好的提示，例如"更靠近敌方基地"或"会打到自家基地"。这个模式对延迟和空间判断更敏感。

### 提示词风格

- **完整版**：说明更详细，约 1100 个输入 token，Jev 默认用它。
- **精简版**：约 750 个 token。**Laya 英文版每道题的题目加选项最多约 192 token、state 最多约 316 token**，完整版会被截断，所以 Laya 默认用精简版，并去掉 state 里的次要字段。
- 设置页可以强制所有后端用同一种风格，方便公平对比 Jev 和 Laya。

发给模型的内容全部是英文，因为 Jev 和 Laya 英文版都对英文最准；界面是中文。

### 提示词版本

设置页和 arena（`--prompt v1|v2|v3`）都可以切换：

- **v1**：初版。
- **v2**：加了角色分工（1 号车主攻、2 号车看家）、写死的优先级、队友当前计划、基地态势。**实测更差**：Jev 按写死的优先级照做，变成了规则 AI 的打法，把它原本最有效的"追杀坦克"丢了。保留下来作对照。
- **v3**（默认）：在 v1 基础上只补短板，不改变它的打法：
  - 状态里加入队友当前计划（`teammate.current_plan`）、基地态势（近 5 秒掉血、是否告急）和一个布尔值 `teammate_covering_base`（队友正在守家 / 正在追最靠近基地的敌车 / 人就在基地附近）；
  - 说明里只加一条协作规则："基地只需要一个守卫：`teammate_covering_base` 为 true 就别守家，去进攻或追击"。用布尔值而不是让模型从队友计划里自己推断——实测它推断不出来，两车 94% 的时间选一样的；
  - 追击选项里标出"这辆敌车离我方基地几格"；守家选项只陈述事实，不用 URGENT 之类的催促措辞（试过一版带 URGENT 的，Jev 66% 的时间都在守家）。

本地模拟（规则 AI 做对手）给出了一个重要参照：两辆车**都守家**只有 3% 胜率，**都进攻** 28%，**一攻一守** 63%。任何让模型扎堆守家的提示词都会输。

## 接口约定

所有模型后端都走同一个 HTTP 约定，也就是 Jev 的 `systemone` 接口：

```
POST <url>
{ "model": "...", "state": {...}, "questions": { "tactic": { "type": "choice", "instructions": "...", "criteria": { "attack_enemy_base": "...", ... } } } }
→ { "model": "...", "answers": { "tactic": { "choice": "...", "probabilities": {...}, "confidence": 0.8 } }, "usage": { "input_tokens": 900 } }
```

只取 `model / answers / usage`，另外读 `warnings`（显示在坦克卡片上）、`routing` 和服务端 `latency_ms`，其余字段忽略。错误格式兼容 Jev 的 `{"detail": ...}` 和 Laya 服务的 `{"error": {"message", "type"}}`。

### 本地服务的配置（`.env` 与 `config/backends.json`）

`.env`（参考 `.env.example`，已在 `.gitignore` 里）只在本机运行 `npm start` / arena 时使用：

```
LAYA_BASE_URL=http://192.168.x.x:8790   # 可选：局域网 Laya 服务根地址
LAYA_API_KEY=laya-...                   # 可选
LAYA_MODEL=laya                         # 可选：laya / laya-multilingual / laya-typed-decisions
JEV_API_KEY=...                         # 可选：页面没填 key 时用
BUDGET_USD=1                            # 用 .env 里的 Jev key 时的累计花费上限，账本在 data/usage.json
CORS_ORIGINS=https://wubugui.github.io  # 允许调用中转的网页来源
```

`config/backends.json` 定义 arena 和中转用的默认地址、模型、限流、超时、价格：

| 字段 | 含义 |
|---|---|
| `url` / `urlEnv` | 接口地址；`urlEnv` 指定的环境变量优先 |
| `baseUrlEnv` | 只给服务根地址的环境变量，接口路径沿用 `url` 里的 |
| `model` / `modelEnv` | 请求里的 `model` 字段 |
| `apiKeyEnv` | 存放密钥的环境变量名；`apiKeyRequired: true` 时没密钥就不调用 |
| `pricePerMTok` | 每百万输入 token 的价格 |
| `maxRps` / `timeoutMs` | 限流与超时 |
| `promptStyle` | `full` 或 `compact` |

## 关于 Laya 服务

针对局域网 Laya 服务（laya 0.3.4，Jev 兼容接口）的特点，做了这些处理：

| 服务特点 | 处理 |
|---|---|
| `warnings`：state 超长被截断时出现，服务不报错 | 计数并显示在坦克卡片上（"后端提示 N 次：…"），也写进决策日志 |
| 服务可能被关掉 | 该次请求报错，坦克沿用上一个战术，卡片显示错误 |
| 串行处理，问题越多越慢 | 超时 10 秒；每辆坦克同一时间只有一个未完成的请求。服务端优化后实测单题约 0.15–0.2 秒 |
| 概率分布比 Jev 平得多（7 个选项里最高常常只有 0.3） | 喊话门槛改为"概率 ≥ 0.4，或明显高于 `none`" |
| 把多条内容塞进一个 state 逐条提问会全错 | 每次请求只描述一辆坦克的局面，两道题（战术、喊话）问的是同一个局面 |

`model` 留空或传 `jev-*` 时服务按 state 语言自动选模型；本项目的提示词全是英文，默认用 `laya`。

### 没有 Laya 服务时：本地适配器

Laya 本身是一个库，没有 HTTP 服务。`laya-adapter/` 里提供两个适配服务，监听 `127.0.0.1:8790`，对外暴露和 Jev 一样的接口：

```bash
# Node 版（ONNX Runtime，纯 CPU，首次从 Hugging Face 下载约 1.7 GB 权重）
cd laya-adapter && npm install && npm start
# 或 Python 版（可用 GPU，需要 Python 3.10+）
pip install "laya>=0.3.3" && python laya-adapter/laya_server.py
```

然后在"AI 连接设置"里把 Laya endpoint 填成 `http://127.0.0.1:8790`。`npm run fake`（在 `laya-adapter` 目录下）不加载模型，只返回随机结果，用来确认适配器本身能通。

## 成本控制

- **本浏览器上限**：在"AI 连接设置"里设，默认 $1。先按保守估算预留，返回后按实际 `input_tokens` 记账，到上限就不再发请求。
- **本地服务上限**：用 `.env` 里的 Jev key 时，另受 `BUDGET_USD` 约束（账本 `data/usage.json`，重启不清零，网页服务和 arena 共用）。
- **实测花费**：每次决策约 900~1100 个输入 token，约 $0.00004~0.00005。一个 Jev 队友每 400 毫秒决策一次，大约每分钟 $0.007；一局 3 分钟约 $0.02。
- **限流**：Jev 最多 12 次/秒（官方限制是 1200 次/分钟）。
- **自动暂停**：页面切到后台时游戏自动暂停。

## 批量对战（arena）

不开浏览器，自动打多局，比较不同后端（读 `.env` 的配置）：

```bash
npm run arena -- --blue jev,jev --red rule,rule --matches 3 --swap
npm run arena -- --blue laya,laya --red rule,rule --matches 5 --swap
```

- `--swap`：每局再交换颜色打一次，抵消出生点带来的偏差
- 默认**锁步**：等决策返回再推进游戏，只比较决策质量；加 `--realtime` 则按真实时间推进，模型延迟会影响战局
- 其他参数：`--mode direct`、`--interval 400`、`--seconds 180`、`--prompt v1`
- `--stagger`：远程 AI 同队两车错开半个决策周期。实验选项，默认关：模拟里固定策略对规则 AI 的胜率一致下降 5~10 个点
- 结果保存在 `data/arena-*.json`

## 决策日志

本地服务每次中转都会追加一行到 `data/logs/decisions-日期.jsonl`：状态、选项、答案、延迟、token 数，以及用的是页面的 key 还是服务端的 key（不记录 key 本身）。`DECISION_LOG=0` 关闭。

## 部署

`main` 分支的 `public/` 目录就是整个网页。推送到 `main` 后，GitHub Actions（[`.github/workflows/pages.yml`](.github/workflows/pages.yml)）会先跑测试，再把 `public/` 发布到 `gh-pages` 分支，GitHub Pages 从 `gh-pages` 分支提供网页。

## 目录

```
public/              网页（游戏逻辑与浏览器/Node 共用）
  js/game.js         规则：移动、子弹、砖墙、胜负
  js/nav.js          寻路、射线
  js/observe.js      把局面整理成给模型的 state + 选项（完整版/精简版，v1/v2/v3）
  js/executor.js     执行层：战术 → 每帧的移动/开火
  js/policies.js     规则 AI、随机 AI
  js/agents.js       控制器（人类 / 本地 AI / 远程后端）
  js/connection.js   AI 连接：玩家的 key/endpoint、直连或经中转、本浏览器花费账本
  js/mock.js         离线随机后端
  js/match.js        一局比赛
  js/main.js         界面
server/              本地服务：静态文件 + 中转 + 预算账本
relay/               Cloudflare Worker 版中转
config/backends.json 中转和 arena 的默认后端配置
laya-adapter/        Laya → Jev 兼容接口（Node / Python）
tools/arena.js       批量对战
test/                npm test
```

## 测试

```bash
npm test
```

共 43 个测试：
- 游戏规则：砖/钢墙、友军伤害、复活、胜负；地图对称，规则 AI 对打时双方公平
- AI：规则 AI 强于随机 AI；执行层不会打自家基地；精简版提示词不超出 Laya 的长度预算；v2/v3 提示词；远程出错时的兜底
- 浏览器连接模块：地址补全、混合内容判断、设置存取、Jev 花费上限、Laya 直连/经中转、错误格式
- 本地中转：跨域白名单与私有网络预检、只收 JSON、Jev 地址不可改、`.env` 的 key 只用于 `.env` 的地址、服务端预算、日志不含 key
- Cloudflare Worker：跨域、只转发 https 的 Laya、必须带页面 key
- 账本：网页服务和 arena 同时运行时不会互相覆盖
