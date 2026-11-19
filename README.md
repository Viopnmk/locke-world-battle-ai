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

### Phase 4 · 培养方案（`#/build`，底部页签「培养」）

给出这只精灵的性格、个体值、四个携带技能与改血脉建议，
全部由图鉴数据推演，页面不写死任何一只精灵的答案。

- **顶栏快捷位**：总种族值最高的 6 个形态（同名形态只取一个）+ 当前精灵 + 搜索（全图鉴 662 只）。
- **主卡**：左列形态标签 / 头像 / 名称 / 属性；右列 2×2 四个技能位，每位显示学习来源
  （升级 / 技能石 / 血脉）、能耗 `★ N`、威力或「状态」、属性图标与技能名。
- **性格**：从 Wiki 性格页的 30 种性格里选一主一备，显示 `+10% / -10%` 的两项与
  `*增益数值成长 1 星为 10%，成长 5 星为 20%`（百分比口径来自游戏内说明，Wiki 只列提升/降低项）。
- **个体值**：三项优先项（输出 → 生命/主攻/速度，耐久 → 生命/短板防御/主攻）。
- **改血脉**：列出这只精灵在 18 系别血脉 + 普通血脉下各能拿到的血脉技能（Wiki 模块原文），
  按流派挑最贴的一个，并给出 3 个备选；同时提示同族形态分支数量。
- **详细模式**：可切换「速攻爆发 / 耐久消耗」两套流派，重算技能分、性格与个体值，
  并逐条解释为什么是这个技能 / 性格 / 个体值 / 血脉（含真实种族值百分位、属性克制收益、特性协同）。
- 实现：`src/lib/build-guide.ts`（引擎）+ `src/pages/BuildPage.tsx`（界面）。
  `scripts/verify-build-guide.ts` 对 662 只形态 × 2 流派 = 1324 次调用做全量校验
  （0 报错、0 undefined/NaN、技能全部来自自身学习面）。

**数据**：`natures.json` 来自「性格」页的 `模块:Natures/data`（30 种性格与提升/降低项），
`bloodlines.json` 来自 `模块:Pets/data/Learnsets` 的 `blood_skills`（每个学习面 19 个系别血脉技能），
技能图标由 `模块:Pets/data/Skills` 的 `icon` 文件名经 `action=query&prop=imageinfo` 解析成真实上传地址。

### Phase 5 · 详细分析师点评（`#/ai`）

  把「对位矩阵」升级成能直接照着打的点评：先算每一发能打掉多少血，再按威胁排序讲清谁打谁、谁扛谁。

- **伤害与击杀估算**（`src/lib/damage.ts`，Worker 端 `worker/src/damage.mjs` 同规则）：
  `伤害% = 攻击 × 技能威力 ÷ 对方防御 ÷ 对方生命 × 本系1.25 × 属性倍率 × 校准系数 0.25`。
  攻击按技能类别取物攻/魔攻，防御取对方的物防/魔防，生命取对方 hp，全部是图鉴原值；
  系数 0.25 把 662 只形态全部对位（438,244 组）的「最高一击」中位数校准到约 60% 生命，
  于是 `≥100% = 1 击秒杀`、`≥50% = 1–2 击带走`、`<50% = 3 击以上` 三档才分得开。
  界面每处 % 都带小字说明：这是估算（Wiki 未公布完整伤害公式与等级/个体值常数），不是实测。
- **敌方威胁小结**：按「能带走我方几只 → 秒杀数 → 最高一击」排序，逐只写清最高一击打谁多少 %、代表招，
  以及能 1–2 击带走我方几只（其中 1 击秒杀几只）。
- **📝 分析师点评**：
  - **总体判断**：属性压制 35% / 伤害效率 30% / 速度控制 20% / 耐久总值 15% 四项加权成 0–100 的
    胜率倾向（50 = 持平），每项都给出换算依据；同时点出关键胜负手与短板。
  - **🌟 我方王牌**：对敌总威胁最高的一只，列出它能 1–2 击带走谁。
  - **⚠️ 最大威胁**：最危险的敌方一只，点名它能带走我方哪几只。
  - **🎯 应对建议**：逐只敌方给出应对者、反手技能与估算伤害、同时承受的伤害与选择理由。
  - **🚀 首发建议**：首发、全队速度排名、开局能威胁几只，以及抢不到先手时的处理。
  - 原「联防与盲区预警」与「对位数据」矩阵保留在下方，随时可核对。
- 云端模型（可选）同步拿到这套威胁/击杀数字，提示词新增规则：伤害 % 只能引用估算事实并说明是估算。

**校验**：`npm run verify:tactics` — 662 只形态两两对位 438,244 组 + 662 份单只解读 + 300 组随机阵容
（1v1–6v6 全覆盖）全部通过，0 报错、0 `NaN`/`undefined`，技能全部来自攻击方自己的学习面。

### Phase 6 · 阵容推荐（`#/teams`，底部页签「阵容」）

按「现在加个阵容推荐板块，比如：雨天队，雪天队」做的成型队伍页：7 套体系队 + 6 套跨属性自由混搭，
每一套的天气、异常、特性与技能都能在 `src/data/*.json` 里找到出处，卡片上的数字全部由前端现算。

- **7 套体系队**（`src/lib/team-presets.ts`）：雨天队、雪天队、沙暴队、雷鸣队（天气体系）、高速先手队（速攻压制）、
  灼烧队、中毒队（消耗联防）。分类筛选：全部 / 自由混搭 / 天气体系 / 速攻压制 / 消耗联防。
  每套都写了：一句话打法、**核心联动**（按出手顺序，谁开天气/叠异常、哪条特性在哪一步生效、接哪个真实技能）、
  **配队逻辑**（为什么是这 6 只）、**代价**（这套打法的真实弱点，照实写）。
- **卡片内容**：平均种族值（含区间）、最快速度、物攻/魔攻/均衡分工、能打出 ≥2 倍的属性覆盖、共同弱点与「队内谁能抗」、
  共同抗性、全队最高单发与六只最高威力技能的均值——都用 `analysis.ts` / `team-plan.ts` 从图鉴现算。
- **六人配置**：每只显示头像、属性、角色徽章（天气手 / 核心输出 / 联防位…）、一句话理由；
  展开「特性 × 技能」直接给图鉴原文的特性名+效果，以及 2–3 个真实可学技能（属性·类别·威力·能耗）和「为什么带它」。
  点名字直接跳到这只的 `#/build/<id>` 培养方案。
- **一键导入对战**：「导入我方去对战 →」/「设为敌方测试」把 6 只填进 `#/ai` 并立刻跑本地引擎；
  另一侧为空时先放同一套（镜像对位，卡片上有说明），换掉敌方就是真实对局。
- **云端解说带上下文**：导入预设后，`#/ai` 里展开「云端大模型」时会把这套预设的配队逻辑与特性×技能联动
  一起传给 Worker（`preset` 字段，Worker 端只做截断，不采信客户端数值），模型按这套机制解释。

**校验**：`npm run verify:teams` — 13 套 × 6 只 ×270 条技能引用全部比对 `spirits.json` / `learnsets.json`：
成员 ID 存在、特性非空、每个技能都在这只精灵自己的学习面（含技能石与血脉）、联动步骤都指向队内成员，
混搭队额外校验「6 只不同种族、至少 5 种属性、六只都出现在核心联动里」，
数据面板与云端事实块无 `undefined`/`NaN`。

### Phase 7 · 跨属性自由混搭阵容（`#/teams` 新增「自由混搭」分类）

在原 7 套体系队之外，用全图鉴量化筛选补了 6 套不依赖天气的混搭队（`src/lib/team-presets-mixed.ts`）：

- **先筛后排**（`scripts/screen-mixed.ts`，`npm run screen:mixed`）：读 `spirits.json` / `skills.json` / `learnsets.json` /
  `type-chart.json`，给 662 条形态打机制标签（偷能量、抬能耗、吸血、灼烧、中毒、冻结、换人惩罚、残血反打、回复、蓄力，
  全部由特性/技能原文的关键词生成），再按六个流派各自的硬约束做「必须含某系 + 贪心起手 + 爬山换人」搜索：
  - 抽能重炮：偷能量/抬能耗 + 高耗能重炮，覆盖 ≥13 系；
  - 吸血反打：≥3 只带吸血、≥2 只带残血/力竭机制，全部弱点被队友接住；
  - 火草灼烧：≥2 火、≥2 草、水与地各有非火位抵抗，灼烧引擎 ≥2；
  - 地武联防：≥2 地、≥2 武、覆盖 ≥14 系、每个弱点都有队友抵抗；
  - 控场折磨：≥2 抬能耗/换人惩罚位、≥2 异常位；
  - 十八系互补：18/18 属性 2 倍、共同弱点 ≤2、每个单体弱点都被队友抵抗。
  六套按顺序挑，后一套不使用前面已经用过的精灵；输出 `.cache/mixed-screening.json` 与可读的 `.md`（含逐只原文证据）。
- **6 套队伍**（15 种属性、36 只互不重复的精灵）：
  抽能重炮队（幻影荆棘 大捞一笔 + 巨灵石 石天平 + 地绡银龙 碎银 170）、
  吸血反打队（恶魔男爵 贪得无厌 + 深渊罗隐 盛宴 + 森巨人 盘根木）、
  火草灼烧队（燃薪虫 煤渣草 + 炮米花 爆裂玉米 + 贝古斯 贪心算法）、
  地武联防队（18/18 覆盖、25 个弱点全接住、平均种族值 749.5）、
  控场折磨队（雪影娃娃 捉迷藏 + 影狸 下黑手 + 满月砣 月相 + 小丑公爵 戏耍）、
  十八系互补队（18/18 覆盖、共同弱点只剩 火/冰 两个、16 个弱点全接住）。
- **结构完全一致**：数据面板（平均种族值/最快速度/物魔分工/18 系覆盖）、核心联动、配队逻辑与代价、
  六人分工与特性×技能详情、一键导入我方/设为敌方，全部沿用 Phase 6 的卡片。
- **两处引擎口径修正**：
  - `team-plan.ts` 的「全队最高单发」不再把「彗星」这类**使用后消耗全部生命**的技能算成炮（它是换命）；
  - 均衡队（六只物魔攻都差 <15）在数据面板显示 `0 · 0 · 6`，校验脚本按「每只都归类了」判定，不再误报。

**校验**：`npm run verify:teams` + `npm run verify:tactics` + `npm run build` 全部通过（13 套 / 78 只次 / 270 条技能引用；
战术引擎 438,244 组对位 + 662 份单只解读 + 300 组随机阵容 0 报错）。

### Phase 8 · 48 小时自动轮换阵容（`#/teams` 只显示当前这一轮的 3 套）

用户要求「把之前的阵容删了，每 48 小时自动更新一次，每次生成全新的 3 套推荐阵容」。
原来的 13 套静态阵容已归档到 `archive/`（不参与构建），页面上只出现当前轮次的 3 套。

> 注：Phase 6 的 7 套体系队、Phase 7 的 6 套混搭队是当时的静态内容，现已下线；
> 原文仍可在 `archive/team-presets-legacy.ts.txt` 与 `archive/team-presets-mixed.ts` 里查阅。

- **引擎**（`scripts/rotate-teams.ts`，`npm run rotate:teams`）：只读 `spirits.json` / `skills.json` / `learnsets.json` /
  `type-chart.json`，在全图鉴 662 条形态上做「战术原型约束 + 贪心起手 + 爬山换人」搜索。
  - 10 种战术原型：高速爆发 / 重炮强攻 / 联防反击 / 跨属性互补 / 抽能压制 / 吸血续航 / 状态折磨 / 天气联动 / 纯属性强攻 / 换人惩罚；
  - 每轮按轮次种子挑 3 种互不相同的原型，并排除上一轮用过的原型；
  - 硬约束：6 只不同种族、18 系打击面、共同弱点条数上限、每个弱点是否有队友以 ≤0.5 倍接住、
    六种分工（先手 / 核心输出 / 控制 / 辅助 / 承伤 / 收割）都有人贴得上；
  - 上一轮的 18 只精灵先被排除，凑不出合格阵容时才放宽（并在卡片的「弱点」里写明重叠几只）；
  - 候选之间有质量下限：只在「与最优分差 3% 以内」的候选里按种子挑，保证每轮不同但不牺牲强度。
- **产物**：
  - `src/data/team-rotation.json`：`round` / `updatedAt`（北京时间 +08:00）/ `nextRotationAt`（+48h）/ `intervalHours` /
    3 套完整阵容（含成员、角色、技能、核心联动、配队逻辑、优势、弱点）；
  - `src/data/rotation-history.json`：每一轮的原型与 18 个 `spiritId`（下一轮据此去重）。
- **页面**：`#/teams` 只读 `team-rotation.json`（baked 进静态包，不依赖用户打开网页触发），顶部显示
  「第 X 轮推荐 · 北京时间 … 更新 · 48 小时自动轮换 · 下次更新 …（倒计时）」，下面是「全部 3 套 + 每种打法」快捷筛选；
  卡片新增「优势与弱点」（全部现算：平均种族值、最快速度、18 系覆盖、共同弱点、弱点接住数）。
- **文案口径**：特性名与效果、技能名/属性/威力/能耗/效果全部来自图鉴原文；数字（平均种族值、覆盖、共同弱点、
  武器威力）全部现算；特性依赖天气而本队没有开天气手段时，联动里会照实标注。

**校验**：`npm run verify:teams` — 3 套 / 18 只 / 54 条技能引用 / 18 步联动逐条比对图鉴；
另查「3 套原型互不相同、18 只互不重复、角色六项齐全、nextRotationAt = updatedAt + 48h、history 与当前轮一致、
与上一轮重叠必须为 0（或写进弱点）」，以及数据面板与云端事实块无 `undefined`/`NaN`。

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
  App.tsx                  五个页签（图鉴 / 克制 / 培养 / 阵容 / 对战）与 hash 路由
  styles.css               移动端样式（390px 无横向溢出、触控目标 ≥ 44px）
  pages/BuildPage.tsx      培养方案页（顶栏快捷位、四技能卡、性格/个体值/血脉、详细模式）
  pages/TeamsPage.tsx      阵容推荐页（轮换状态条 + 3 套打法筛选、核心联动、配队逻辑、优势与弱点、六人配置、对抗数据、一键导入对战）
  components/
    SpiritList.tsx         列表与卡片
    SpiritDetail.tsx       详情页（种族值、特性、受击、技能、强度分析、AI 解析）
    TypeCalculator.tsx     属性克制计算器
    AiPanel.tsx            双方阵容选择、本地实战分析、可选的云端模型入口
    AnalystView.tsx        敌方威胁小结 + 📝 分析师点评（四项加权、王牌、最大威胁、应对、首发）
    StrengthPanel.tsx      单只强度拆解 + 本地战术解读
    TeamAnalysis.tsx       对位数据表（平均种族值、最快速度、可折叠矩阵）
    LocalBriefView.tsx     本地引擎分解读的通用渲染（标题 + 短句 + 口径说明）
    SpiritPicker.tsx       全图鉴搜索 / 快捷选择器
    AiAnswer.tsx           云端模型分段回答 + 溯源徽章
  lib/
    damage.ts              伤害估算（%HP、击杀分档、口径说明，Worker 端同规则）
    types.ts               数据类型
    spirits.ts             索引、搜索、学习面解析
    typeChart.ts           倍率查询、防守画像、文案
    analysis.ts            确定性强度 / 阵容 / 对位计算（与 Worker 同规则）
    tactics.ts             本地战术引擎：由图鉴数据生成中文解读（无网络、无模型）
    build-guide.ts         培养方案引擎：四技能 / 性格 / 个体值 / 改血脉（全部由图鉴真数据推演）
    team-types.ts          阵容推荐的数据结构（TeamPreset / 轮换文件 / 历史）
    team-presets.ts        读 src/data/team-rotation.json：当前这一轮的 3 套队伍 + 解析与云端事实块
    team-plan.ts           阵容数据面板：平均种族值/速度分层/物魔分工/覆盖面/共同弱点与抗性
  services/ai-client.ts    Worker 端点、模型列表、analyze 调用
  data/                    fetch-wiki.py 生成的产物（见下）+ team-rotation.json / rotation-history.json
archive/                   已下线的 13 套静态阵容（不参与构建，留档备查）
worker/
  wrangler.toml            name = locke-world-battle-ai-api，[ai] binding = "AI"
  src/index.mjs            路由、CORS、限流、校验与响应组装
  src/data.mjs             直接 import src/data/*.json，服务器端唯一数据源
  src/analysis.mjs         确定性计算（与前端 analysis.ts 同规则）
  src/damage.mjs           伤害估算与威胁/击杀摘要（与前端 damage.ts 同规则）
  src/prompts.mjs          事实拼装、系统提示词、输出校验
  src/ai.mjs               模型清单、Workers AI 调用、错误翻译、分段解析
scripts/
  fetch-wiki.py            抓取 + 解析 + 生成 src/data/*.json（含性格、血脉技能、技能图标）
  lua_table.py             Wiki 数据模块的 Lua 表解析器
  verify-build-guide.ts    培养方案全量校验（662 形态 × 2 流派）
  rotate-teams.ts          48 小时轮换引擎：10 种战术原型 + 全图鉴约束搜索 → team-rotation.json / rotation-history.json
  verify-teams.ts          当前轮 3 套阵容校验（成员/特性/技能/角色/元数据/去重/文案/数据面板）
  run-rotation-job.sh      定时任务：rotate → verify → build → deploy → commit & push
  screen-mixed.ts          历史：跨属性混搭队的量化筛选（读 archive/ 里的旧六套复算）
  verify-tactics.ts        伤害估算与分析师点评全量校验（全量对位 + 300 组随机阵容）
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
