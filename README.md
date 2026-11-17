# 洛克对战助手 · locke-world-battle-ai

《洛克王国：世界》(NRC) 的移动端图鉴与对战分析工具。React + TypeScript + Vite，纯静态站点，
手机浏览器（iPhone 优先）打开即用。

**所有精灵数据都来自 BWIKI（https://wiki.biligame.com/nrc/）**，由 `scripts/fetch-wiki.py` 抓取并生成为
`src/data/*.json`；没有任何手写的数值、技能或克制关系。

## 已实现（Phase 1）

- **精灵图鉴**：662 只形态，按名称 / 编号 / 属性搜索与筛选；详情页展示 Wiki 原值——编号、属性、
  特性名与效果、六项种族值（含总种族值进度条）、身高体重、蛋组、骑乘、精灵介绍、学习面
  （等级学习 / 技能石 / 血脉，含威力、能耗、效果文本），以及该属性组合的受击弱点与抵抗。
- **属性克制计算器**：选择进攻属性 + 1~2 个防守属性，给出倍率（×0.25 / ×0.5 / ×1 / ×2 / ×3）、
  结论、单属性与双属性来源说明、该组合在图鉴中的数量，并列出全部 18 系“怕什么”。
- **AI 对战分析入口（Phase 2 预留）**：`src/services/ai-client.ts` 定义了 Cloudflare Workers AI
  的调用约定（`VITE_AI_ENDPOINT` / `VITE_AI_MODEL`）、提示词构造，以及未接模型时的本地速算兜底。
  仓库内不含任何 API Key / Token。

## 目录

```
index.html
src/
  App.tsx                  三个页签（图鉴 / 克制 / AI）与搜索、筛选状态
  styles.css               移动端样式（390px 无横向溢出、触控目标 ≥ 44px）
  components/
    SpiritList.tsx         列表与卡片
    SpiritDetail.tsx       详情页（种族值、特性、受击、技能、基础信息）
    TypeCalculator.tsx     属性克制计算器
    AiPanel.tsx            AI 入口与本地速算展示
  lib/
    types.ts               数据类型
    spirits.ts             索引、搜索、学习面解析
    typeChart.ts           倍率查询、防守画像、文案
  services/ai-client.ts    Phase 2 模型适配层
  data/                    fetch-wiki.py 生成的产物（见下）
scripts/
  fetch-wiki.py            抓取 + 解析 + 生成 src/data/*.json
  lua_table.py             Wiki 数据模块的 Lua 表解析器
```

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

**没有编造任何数值**：Wiki 未公开的字段（技能命中率等）保持空白；技能 PP 在本作中不存在（以能耗计），
因此不写入。双属性倍率中 Wiki 未发布而又出现在图鉴里的组合（目前只有「毒|幻」），
按 Wiki 已发布的 86 个组合全部验证成立的规则计算（单属性倍率相乘、上限 ×3），
并在数据里以 `derivedPairs` 单独标注，界面上也会说明。

### 重新抓取

```bash
python3 scripts/fetch-wiki.py            # 联网抓取（缓存到 .cache/wiki/）
python3 scripts/fetch-wiki.py --offline  # 只用缓存重新生成
```

脚本自带校验：行数必须与页面标注一致、属性必须都在克制表内、双属性规则必须能复现 Wiki 已发布值，
否则拒绝生成。

## 开发与构建

```bash
npm install
npm run dev        # 本地开发
npm run build      # tsc + vite build → dist/
npm run preview    # 预览 dist/
```

## 部署

纯静态产物，`dist/` 可直接上传到 Cloudflare Pages / GitHub Pages。如需接 AI 模型，
在构建环境设置 `VITE_AI_ENDPOINT`（Worker 地址）与 `VITE_AI_MODEL`，
密钥保存在 Worker 一侧，前端不持有任何凭据。

## 说明

非官方粉丝工具，数据版权归 BWIKI 与游戏方所有。
