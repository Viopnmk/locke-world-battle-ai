# 洛克对战助手 · locke-world-battle-ai

《洛克王国：世界》(NRC) 的移动端图鉴与对战分析工具。React + TypeScript + Vite 纯静态站点，
**分析全部在浏览器本地完成**（离线、0 延迟、不发请求）；Cloudflare Worker 只是可选的大模型润色层。
手机浏览器（iPhone 优先）打开即用。

**所有精灵数据都来自 BWIKI（https://wiki.biligame.com/nrc/）**，由 `scripts/fetch-wiki.py` 抓取并生成
`src/data/*.json`；没有任何手写的数值、技能或克制关系。

- 线上站点：https://locke-world-battle-ai.pages.dev（中国大陆手机网络可直连，不依赖 \*.workers.dev）
- 可选的 AI Worker：https://locke-world-battle-ai-api.2310566637.workers.dev（打不开也不影响任何分析）
- 仓库内不含任何 API Key / Token：Worker 使用 Cloudflare Workers AI 绑定，免费额度内运行。

## 已实现

### Phase 1 · 图鉴与克制

- **精灵图鉴**：662 只形态，按名称 / 编号 / 属性搜索与筛选；详情页展示 Wiki 原值——编号、属性、
  特性名与效果、六项种族值、身高体重、蛋组、骑乘、精灵介绍、学习面（等级学习 / 技能石 / 血脉，
  含威力、能耗、效果文本），以及受击弱点与抵抗。
- **属性克制计算器**：18 系 × 单/双属性，给出倍率（×0.25 / ×0.5 / ×1 / ×2 / ×3）、来源说明、
  该组合在图鉴中的数量，并列出全部 18 系“怕什么”。

### Phase 2 · 强度分析与对位矩阵

- **精灵强度分析**（详情页）：全图鉴 662 只内的总种族值排名 / 百分位 / S–D 评级、六项单项百分位、
  自动定位标签、进攻覆盖（能打出 ≥2 倍的属性、打不出克制的属性）、技能池构成与能耗效率。
- **双方阵容分析**（`#/ai`）：我方 / 敌方各选 1–6 只（搜索 + 高种族值快捷选择），实时计算：
  - 逐格对位矩阵（我方打对方的最高倍率 + 对方反打倍率 + 速度差）
  - 我方共同弱点 / 共同抵抗 / 打击盲区
  - 平均种族值差、最快速度对比、首发打分排序
### Phase 3 · 本地战术引擎（默认主模式）

不联网、不排队：用内置 JSON 直接生成中文战术解读，页面上每个数字都能在数据里找到来源。

- **单只「本地战术解读」**（详情页）：S–D 评级与排名之后，给出【结论】【定位】【配招建议】【使用要点】
  【风险与短板】。配招按更高的一项攻击（物攻 / 魔攻）挑本系最高威力技能，再补一个能打穿主攻被抵抗属性的
  「补盲」技能和一个有实际效果的变化技能，全部取自该精灵真实学习面。
- **双方「本地实战分析」**（`#/ai`）：两边各 ≥1 只即自动生成，阵容一改立刻重算
  - 【首发推荐与理由】：对位综合分最高的首发、速度差、最想/最怕遇到的对手、备选首发
  - 【逐只敌方应对方案】：每只敌方的最佳我方答案、倍率、具体技能名 + 威力 + 属性、速度快慢、反打风险
  - 【联防与盲区预警】：共同弱点（并核对对方是否带该属性）、打击盲区、速度层级劣势、共同抵抗
- **云端大模型是可选层**：折叠在「可选：连接云端大模型」里，默认不加载、不发请求；连不上只会在这个
  折叠区里提示，页面其余部分照常可用。

### 防编造（anti-fabrication）

- 前端只把**精灵 ID**发给 Worker；种族值、技能、特性、属性倍率全部由 Worker 从同一份图鉴 JSON
  重新解析，不采信客户端自报数值。
- **默认路径根本不经过模型**：本地引擎（`src/lib/tactics.ts`）只引用图鉴 JSON 里的种族值、百分位、
  倍率、特性原文、技能名/威力/能耗，句子结构固定，没有可以编造数值的余地。
- 走可选云端模型时：Worker 用**服务器端数据**拼出【已核验事实】提示词，并明确禁止编造；事实里直接列出
  属性名称表、技能克制面。
- 回答生成后再做一次**自动校验**：数字是否都能在事实中找到、属性名是否真实、特性/技能名是否存在、
  换人建议是否用了阵容外的精灵。命中问题会自动要求模型重写一次；仍存在的问题会在界面显示
  “⚠ N 处未能在图鉴事实中溯源”，并列出具体条目。
- 所有确定性计算（排名、矩阵、共同弱点、速度差）不经过模型，随 AI 回答一起返回并单独展示。

## 目录

```
index.html
src/
  App.tsx                  三个页签（图鉴 / 克制 / AI）与 hash 路由
  styles.css               移动端样式（390px 无横向溢出、触控目标 ≥ 44px）
  components/
    SpiritList.tsx         列表与卡片
    SpiritDetail.tsx       详情页（种族值、特性、受击、技能、强度分析、AI 解析）
    TypeCalculator.tsx     属性克制计算器
    AiPanel.tsx            双方阵容选择、本地实战分析、可选的云端模型入口
    StrengthPanel.tsx      单只强度拆解 + 本地战术解读
    TeamAnalysis.tsx       对位数据表（平均种族值、最快速度、可折叠矩阵）
    LocalBriefView.tsx     本地引擎分解读的通用渲染（标题 + 短句 + 口径说明）
    SpiritPicker.tsx       全图鉴搜索 / 快捷选择器
    AiAnswer.tsx           云端模型分段回答 + 溯源徽章
  lib/
    types.ts               数据类型
    spirits.ts             索引、搜索、学习面解析
    typeChart.ts           倍率查询、防守画像、文案
    analysis.ts            确定性强度 / 阵容 / 对位计算（与 Worker 同规则）
    tactics.ts             本地战术引擎：由图鉴数据生成中文解读（无网络、无模型）
  services/ai-client.ts    Worker 端点、模型列表、analyze 调用
  data/                    fetch-wiki.py 生成的产物（见下）
worker/
  wrangler.toml            name = locke-world-battle-ai-api，[ai] binding = "AI"
  src/index.mjs            路由、CORS、限流、校验与响应组装
  src/data.mjs             直接 import src/data/*.json，服务器端唯一数据源
  src/analysis.mjs         确定性计算（与前端 analysis.ts 同规则）
  src/prompts.mjs          事实拼装、系统提示词、输出校验
  src/ai.mjs               模型清单、Workers AI 调用、错误翻译、分段解析
scripts/
  fetch-wiki.py            抓取 + 解析 + 生成 src/data/*.json
  lua_table.py             Wiki 数据模块的 Lua 表解析器
```

## Worker 接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/health` | 服务状态、provider、默认模型、模型数量、数据统计 |
| GET | `/models` | 本账号免费额度内**实测可用**的模型列表 |
| GET | `/spirit/:key` | 图鉴数据 + 确定性强度指标（可按 `?vs=名字` 加单打对位） |
| POST | `/analyze` | `{ mode: "spirit" \| "team" \| "battle", spiritId?, myTeam?, enemyTeam?, model? }` |

```bash
# 单只分析
curl -X POST https://locke-world-battle-ai-api.2310566637.workers.dev/analyze \
  -H 'content-type: application/json' \
  -d '{"mode":"spirit","spiritId":"迪莫","model":"@cf/zai-org/glm-4.7-flash"}'

# 双方阵容（1–6 只）
curl -X POST https://locke-world-battle-ai-api.2310566637.workers.dev/analyze \
  -H 'content-type: application/json' \
  -d '{"mode":"team","myTeam":["迪莫","喵喵","水蓝蓝"],"enemyTeam":["火花","雪影娃娃","机械方方"]}'
```

`/analyze` 返回：`answer`（headline / sections / 原文）、`deterministic`（服务器端算出的指标与矩阵）、
`verification`（溯源校验结果）、`usage`（tokens / neurons）、`elapsedMs`。

### 可用模型（2026-11-18 在本账号实测）

| 模型 ID | 说明 |
| --- | --- |
| `@cf/zai-org/glm-4.7-flash` | 默认。中文严谨、最贴图鉴数据（关闭 thinking） |
| `@cf/openai/gpt-oss-20b` | 响应快、表达更活泼（`reasoning_effort: low`） |
| `@cf/meta/llama-4-scout-17b-16e-instruct` | 综合均衡 |
| `@cf/mistralai/mistral-small-3.1-24b-instruct` | 结构清晰 |
| `@cf/meta/llama-3.2-3b-instruct` | 极快兜底 |
| `@cf/deepseek-ai/deepseek-r1-distill-qwen-32b` | 慢思考，最细但耗时耗额度 |

免费额度：Workers AI 每天 10,000 neurons（单次 3v3 约 20–60，6v6 约 100–120）。
不升级计划、不启用付费模型；`/models` 与前端下拉框都不含付费模型。

### 可选：外部 OpenAI 兼容网关

以后若想换外部模型，在 Worker 侧配置 secrets 即可，前端不用改：

```bash
cd worker
npx wrangler secret put OPENAI_BASE_URL   # 例如 https://api.openai.com/v1
npx wrangler secret put OPENAI_API_KEY
npx wrangler secret put OPENAI_MODEL     # 例如 gpt-4o-mini
```

配置后 `/health` 的 `provider` 会变成 `openai-compatible`，优先走外部网关。

## 数据

| 文件 | 内容 |
| --- | --- |
| `src/data/spirits.json` | 662 只形态的图鉴字段 |
| `src/data/learnsets.json` | 332 份学习面（同进化系共用），条目为 `[技能 id, 来源码, 等级?]` |
| `src/data/skills.json` | 595 个技能：名称、属性、类别、威力、能耗、效果 |
| `src/data/type-chart.json` | 18 系单属性 + 87 个双属性受击倍率、状态免疫 |
| `src/data/meta.json` | 抓取时间、来源、字段清单、覆盖统计、未公开字段 |

来源：

- `https://wiki.biligame.com/nrc/精灵列表`（渲染表格，页面自称 662 种形态）
- MediaWiki API 的 Lua 数据模块：`模块:Pets/data/{Catalog,Skills,Learnsets,Types}`、
  `模块:精灵图鉴/S5/数据/*`（当前赛季分片）、`模块:Pets/Theme`、`模块:TypeData`
- `https://wiki.biligame.com/nrc/克制计算器`

Wiki 未公开的字段（技能命中率等）保持空白；技能 PP 在本作中不存在（以能耗计）。
双属性倍率中 Wiki 未发布而图鉴里出现的组合（目前只有「毒|幻」），
按 Wiki 已发布的 86 个组合全部验证成立的规则计算（单属性倍率相乘、上限 ×3），
并在数据里以 `derivedPairs` 单独标注。

### 重新抓取

```bash
python3 scripts/fetch-wiki.py --offline  # 只用缓存重新生成
python3 scripts/fetch-wiki.py            # 联网抓取（缓存到 .cache/wiki/）
```

脚本自带校验：行数必须与页面标注一致、属性和技能必须都在克制表/技能表内、
双属性规则必须能复现 Wiki 已发布值，否则拒绝生成。

## 开发与构建

```bash
npm install
npm run dev        # 本地开发
npm run build      # tsc + vite build → dist/
```

### Worker

```bash
export CLOUDFLARE_API_TOKEN=...     # 只在 shell 环境变量里，不写进仓库
export CLOUDFLARE_ACCOUNT_ID=...
cd worker
npx wrangler deploy                 # 部署 locke-world-battle-ai-api
npx wrangler dev                     # 本地调试（需 --remote 才有 AI 绑定）
```

### 部署前端

```bash
npm run build
npx wrangler pages deploy dist --project-name=locke-world-battle-ai --branch=main
```

`VITE_AI_ENDPOINT` 可不配置：代码内默认指向线上 Worker，本地调试时可用环境变量覆盖。
Worker 的 CORS 允许 `https://locke-world-battle-ai.pages.dev`、预览域名与 `http://localhost:*`。

## 说明

非官方粉丝工具，数据版权归 BWIKI 与游戏方所有。
