/**
 * 阵容校验 CLI：npm run verify:teams
 *
 * 校验逻辑在 scripts/lib/team-audit.ts（生成器写盘前跑的是同一份），这里只负责
 * 读文件、打印结论、决定退出码。
 *
 * 强制项（任何一条不过就 exit 1）：
 *   · 能量：上场能量与特性复算一致、技能能耗与图鉴一致、4 招不超 10 点上限、
 *     首回合可用招 / 聚能回合 / 能量状态复算一致；空转特性必须写明「未触发」；
 *   · 特性与技能：每只 4 招全部真实可学，血脉技能 ≤ 1（equip-rules.ts 口径）；
 *   · 定位与 dex：6 个角色各一只、同队不能有同图鉴编号、3 套共 18 只互不重复；
 *   · 团队协同：联动只能引用该成员「推荐 4 招」里的技能，evidence 必须是原文子串，
 *     出现「抬费→增伤」这类伪因果直接判错；
 *   · 覆盖口径：summary / metrics 的覆盖数必须等于按「推荐 4 招」复算的结果，
 *     学习面覆盖单独写；入场能量合计与六项分析里的数字对得上；
 *   · 流程：生成器先校验后落盘（rotate-teams.ts），本脚本校验落盘后的文件。
 */
import fs from 'node:fs';
import path from 'node:path';
import { auditRotation } from './lib/team-audit';
import { ENERGY_RULES, GATHER_GAIN } from '../src/lib/energy';
import type { RotationHistoryFile, TeamRotationFile } from '../src/lib/team-types';

const ROOT = process.cwd();
const rotationPath = path.join(ROOT, 'src/data/team-rotation.json');
const historyPath = path.join(ROOT, 'src/data/rotation-history.json');

const rotation = JSON.parse(fs.readFileSync(rotationPath, 'utf8')) as TeamRotationFile;
const history = JSON.parse(fs.readFileSync(historyPath, 'utf8')) as RotationHistoryFile;

const { problems, warnings, stats } = auditRotation(rotation, history);

console.log(
  `第 ${rotation.round} 轮 · ${rotation.updatedAt} 更新 → ${rotation.nextRotationAt} 换下一轮（${rotation.intervalHours} 小时）`,
);
console.log(
  `阵容 ${stats.teams} 套 · 成员 ${stats.members} 只次 / ${stats.uniqueSpirits} 只不重复 / ${stats.uniqueDex} 个图鉴编号 · 技能引用 ${stats.skills} 条 · 联动 ${stats.synergies} 条 · 阶段 ${stats.phases} 个`,
);
console.log(`能量模型：上限 10 点 · 聚能 +${GATHER_GAIN}/回合 · 规则 ${ENERGY_RULES.length} 条（其中待验证 ${ENERGY_RULES.filter((r) => r.confidence === 'unverified').length} 条）`);
console.log(`特性：生效 ${stats.activeTraits} 只 / 空转 ${stats.idleTraits} 只`);
for (const team of rotation.teams) {
  const m = team.metrics;
  const e = team.energySummary;
  console.log(
    `  ${team.name}（${team.archetypeLabel}）｜覆盖 ${stats.coverage.find((c) => c.id === team.id)?.chosen ?? '—'}/18（学习面 ${
      stats.coverage.find((c) => c.id === team.id)?.learnset ?? '—'
    }/18）｜入场能量 ${e?.entryTotal ?? '—'}｜平均 ${e?.avgCost ?? '—'} 费｜即招 ${e?.readyCount ?? '—'}/6｜` +
      `平均种族值 ${m?.avgTotal ?? '—'}｜最快 ${m?.fastest ? `${m.fastest.name} ${m.fastest.spe}` : '—'}｜联动 ${team.synergies.length} 条`,
  );

  // 能量逐只明细（终端里能直接看到 上场 / 技能 / 回能 / 剩余）
  for (const member of team.members) {
    const en = member.energy;
    if (!en) continue;
    console.log(
      `    · ${member.role} ${en.entryLabel}｜上场 ${en.entry}/${en.cap}｜技能 ${en.costs.join('/')} 费｜` +
        `首回合 ${en.firstTurn ? `「${en.firstTurn.name}」剩 ${en.firstTurn.leftover}` : '无'}｜聚能 ${en.gatherTurns} 回合｜` +
        `回能 ${en.recoveries.join('、')}`,
    );
  }
}

for (const w of warnings) console.warn(`  ⚠ ${w}`);

if (problems.length) {
  console.error(`\n✗ ${problems.length} 个问题：`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log('\n✓ 能量、特性、血脉、同 dex、定位、联动证据与覆盖口径全部通过');
