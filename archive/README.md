# archive/ — 已下线的静态阵容（不参与构建）

`#/teams` 从 Phase 8 起只显示「48 小时自动轮换」生成的 3 套阵容
（`src/data/team-rotation.json`，由 `scripts/rotate-teams.ts` 生成）。
这里存档的是旧的 13 套静态阵容，留着做参照，不参与 `tsc -b` / `vite build`，也不会被打进页面。

| 文件 | 内容 | 说明 |
| --- | --- | --- |
| `team-presets-mixed.ts` | 6 套跨属性自由混搭队 | Phase 7 由 `scripts/screen-mixed.ts` 量化筛选后人工核对原文定稿；`screen-mixed.ts` 仍会读它来复算历史结果 |
| `team-presets-legacy.ts.txt` | 原 `src/lib/team-presets.ts` 全文（7 套体系队） | 纯文本存档：雨天 / 雪天 / 沙暴 / 雷鸣 / 灼烧 / 高速先手 / 中毒，逐条特性×技能联动可查 |

要看原来的 7 套体系队，也可以直接翻 git 历史：`git show 04d3542:src/lib/team-presets.ts`。
