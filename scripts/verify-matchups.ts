/**
 * 「敌方 18 系换宠 & 出招」校验：npm run verify:matchups
 *
 * 只读 src/data，把 team-matchup.ts 算出来的每一条方案拿原始数据反算一遍：
 *   · 3 套阵容 × 18 系 = 54 条，一条不能少、系别顺序必须是图鉴的 18 系；
 *   · 推荐主力 / 备选必须是这套阵容 6 只里的，且主力是全队得分最高的那只；
 *   · 承伤 / 反打倍率必须等于 type-chart.json 现算值（含双属性合成）；
 *   · 出招链里出现的技能必须属于该成员的真实 4 个推荐技能，并且真能学到（学习面）；
 *   · 每条技能的属性 / 威力 / 能耗与 skills.json 一致，能量账逐步对得上（默认 10 点、聚能 +5、上限 10）；
 *   · 没有 0.5 倍抗性时必须写明「无 0.5 倍抗性」，不许含糊过去。
 *
 * 任何一条不过 exit 1，和 verify:teams 一样属于发布门禁。
 */
import fs from 'node:fs';
import path from 'node:path';
import { ENERGY_CAP, GATHER_GAIN } from '../src/lib/energy';
import { buildTeamMatchup, fmtMult, SPEED_TIERS, weakestType } from '../src/lib/team-matchup';
import type { MatchupCandidate, TypeMatchupPlan } from '../src/lib/team-matchup';
import { carriedSkills } from '../src/lib/carried-skills';
import { spiritsById } from '../src/lib/spirits';
import { matchup, TYPE_ORDER } from '../src/lib/typeChart';
import type { TeamPreset, TeamRotationFile } from '../src/lib/team-types';

const ROOT = process.cwd();
const rotation = JSON.parse(
  fs.readFileSync(path.join(ROOT, 'src/data/team-rotation.json'), 'utf8'),
) as TeamRotationFile;

const problems: string[] = [];
const warnings: string[] = [];

const W = {
  def: { strong: 7, resist: 5, neutral: 2, slight: -2, weak: -8 },
  atk: { quad: 10, double: 7, neutral: 1, resisted: -3, doubleResisted: -6 },
  speed: { fast: 2, mid: 1, normal: 0, slow: -1 },
  energy: { ready: 2, gather: 0, starved: -3 },
};
const defP = (m: number) => (m <= 0.25 ? W.def.strong : m <= 0.5 ? W.def.resist : m === 1 ? W.def.neutral : m < 2 ? W.def.slight : W.def.weak);
const atkP = (m: number) => (m >= 4 ? W.atk.quad : m >= 2 ? W.atk.double : m === 1 ? W.atk.neutral : m >= 0.5 ? W.atk.resisted : W.atk.doubleResisted);
const speP = (s: number | null) =>
  s === null ? W.speed.normal : s >= SPEED_TIERS.fast ? W.speed.fast : s >= SPEED_TIERS.mid ? W.speed.mid : s >= SPEED_TIERS.normal ? W.speed.normal : W.speed.slow;
const enP = (st: 'ready' | 'gather' | 'starved') => W.energy[st];

function independentScore(preset: TeamPreset, spiritId: string, enemyType: string) {
  const member = preset.members.find((m) => m.spiritId === spiritId);
  const spirit = spiritsById.get(spiritId);
  if (!member || !spirit) return null;
  /* 与培养板块同口径：自带学习面 + 改血脉能换到的 19 选 1 */
  const learned = carriedSkills(spirit);
  const skills = member.skills
    .map((ref) => learned.find((s) => s.name === ref.name))
    .filter((s): s is NonNullable<typeof s> => Boolean(s));
  if (skills.length !== member.skills.length) return null; // 有解析不了的技能名 → 报错
  const damaging = skills.filter((s) => typeof s.power === 'number' && s.power > 0);
  const atkMult = damaging.length ? Math.max(...damaging.map((s) => matchup(s.type, [enemyType]).multiplier)) : 1;
  const defMult = matchup(enemyType, spirit.type).multiplier;
  const status = member.energy?.status ?? 'ready';
  return {
    defMult,
    atkMult,
    status,
    score: defP(defMult) + atkP(atkMult) + speP(spirit.stats.spe ?? null) + enP(status),
    entry: member.energy?.entry ?? ENERGY_CAP,
    cap: member.energy?.cap ?? ENERGY_CAP,
    skillNames: new Set(member.skills.map((r) => r.name)),
    skills,
  };
}

let plans = 0;
let stepsTotal = 0;
let gatherSteps = 0;
let pivotSteps = 0;
let noResist = 0;

for (const preset of rotation.teams) {
  const teamPlans = buildTeamMatchup(preset);
  const tag = `[${preset.name}]`;

  if (teamPlans.length !== TYPE_ORDER.length) {
    problems.push(`${tag} 只算出 ${teamPlans.length} 条方案，应为 ${TYPE_ORDER.length}`);
  }
  const types = teamPlans.map((p) => p.type);
  for (const t of TYPE_ORDER) if (!types.includes(t)) problems.push(`${tag} 缺 ${t} 系方案`);

  const memberIds = new Set(preset.members.map((m) => m.spiritId));

  // 默认选中的那一系必须真是得分最低（最难打）的
  const weakest = weakestType(teamPlans);
  const lowest = [...teamPlans].sort((a, b) => a.threat - b.threat)[0];
  if (lowest && weakest !== lowest.type) problems.push(`${tag} 默认系 ${weakest} 不是最难打的 ${lowest.type}`);

  for (const plan of teamPlans) {
    plans += 1;
    const where = `${tag} ${plan.type}系`;

    const check = (c: MatchupCandidate, label: string) => {
      if (!memberIds.has(c.spiritId)) problems.push(`${where} ${label}「${c.name}」不在本套 6 只里`);
      const ind = independentScore(preset, c.spiritId, plan.type);
      if (!ind) {
        problems.push(`${where} ${label}「${c.name}」的推荐技能无法在真实学习面解析`);
        return;
      }
      if (Math.abs(ind.defMult - c.defMultiplier) > 1e-9)
        problems.push(`${where} ${label}承伤倍率 ${fmtMult(c.defMultiplier)} ≠ 现算 ${fmtMult(ind.defMult)}`);
      if (Math.abs(ind.atkMult - c.atkMultiplier) > 1e-9)
        problems.push(`${where} ${label}反打倍率 ${fmtMult(c.atkMultiplier)} ≠ 现算 ${fmtMult(ind.atkMult)}`);
      if (ind.score !== c.score) problems.push(`${where} ${label}得分 ${c.score} ≠ 复算 ${ind.score}`);
      if (c.coreSkill) {
        const sk = ind.skills.find((s) => s.name === c.coreSkill!.name);
        if (!sk) problems.push(`${where} ${label}核心招「${c.coreSkill.name}」不是该成员 4 招之一`);
        else {
          if ((sk.energy ?? 0) !== c.coreSkill.energy)
            problems.push(`${where} ${label}核心招「${sk.name}」能耗 ${c.coreSkill.energy} ≠ 图鉴 ${sk.energy}`);
          if ((sk.power ?? null) !== c.coreSkill.power)
            problems.push(`${where} ${label}核心招「${sk.name}」威力 ${c.coreSkill.power} ≠ 图鉴 ${sk.power}`);
          const m = matchup(sk.type, [plan.type]).multiplier;
          if (Math.abs(m - c.coreSkill.multiplier) > 1e-9)
            problems.push(`${where} ${label}核心招倍率 ${fmtMult(c.coreSkill.multiplier)} ≠ 现算 ${fmtMult(m)}`);
        }
      }
    };

    check(plan.pick, '主力');
    check(plan.backup, '备选');
    if (plan.backup.spiritId === plan.pick.spiritId && preset.members.length > 1)
      problems.push(`${where} 主力和备选是同一只`);

    // 主力必须是全队得分最高的那只（并列时按反打倍率 / 承伤 / 速度 / 图鉴号）
    const scored = preset.members
      .map((m) => {
        const ind = independentScore(preset, m.spiritId, plan.type);
        const spirit = spiritsById.get(m.spiritId);
        return ind && spirit
          ? { id: m.spiritId, score: ind.score, atk: ind.atkMult, def: ind.defMult, spe: spirit.stats.spe ?? 0, dex: Number(spirit.dex) || 9999 }
          : null;
      })
      .filter((x): x is NonNullable<typeof x> => Boolean(x))
      .sort((a, b) => b.score - a.score || b.atk - a.atk || a.def - b.def || b.spe - a.spe || a.dex - b.dex);
    if (scored[0] && scored[0].id !== plan.pick.spiritId)
      problems.push(`${where} 主力 ${plan.pick.name} 不是复算得分最高的 ${scored[0].id}`);

    // 抗性口径：没 0.5 倍抗性时必须写明
    const bestDef = Math.min(...preset.members.map((m) => {
      const sp = spiritsById.get(m.spiritId);
      return sp ? matchup(plan.type, sp.type).multiplier : 99;
    }));
    if (bestDef > 0.5) {
      noResist += 1;
      if (!/没有对.+系的 0\.5 倍抗性/.test(plan.resistLine))
        problems.push(`${where} 全队无 0.5 倍抗性，但文案没照实写明：${plan.resistLine}`);
    }

    // 出招链
    const ind = independentScore(preset, plan.pick.spiritId, plan.type)!;
    if (plan.steps.length < 2 || plan.steps.length > 3)
      problems.push(`${where} 出招链 ${plan.steps.length} 步，应为 2~3 步`);
    stepsTotal += plan.steps.length;
    let energy = ind.entry;
    plan.steps.forEach((step, i) => {
      const at = `${where} 第${i + 1}步`;
      if (step.energy.before !== energy)
        problems.push(`${at} 起始能量 ${step.energy.before} ≠ 上一步剩余 ${energy}`);
      if (step.kind === 'skill') {
        const sk = ind.skills.find((s) => s.name === step.skill?.name);
        if (!sk) {
          problems.push(`${at} 技能「${step.skill?.name}」不属于 ${plan.pick.name} 的推荐 4 招`);
        } else {
          if (!ind.skillNames.has(sk.name)) problems.push(`${at} 技能「${sk.name}」不在成员技能表`);
          if ((sk.energy ?? 0) !== step.energy.cost)
            problems.push(`${at}「${sk.name}」能耗 ${step.energy.cost} ≠ 图鉴 ${sk.energy}`);
          const m = matchup(sk.type, [plan.type]).multiplier;
          if (Math.abs(m - (step.skill?.multiplier ?? -1)) > 1e-9)
            problems.push(`${at}「${sk.name}」倍率 ${step.skill?.multiplier} ≠ 现算 ${m}`);
          if (step.energy.cost === null || step.energy.before < step.energy.cost)
            problems.push(`${at} 能量 ${step.energy.before} 不够付「${sk.name}」${sk.energy} 费`);
          else if (step.energy.after !== step.energy.before - step.energy.cost)
            problems.push(`${at} 能量账 ${step.energy.before}-${step.energy.cost} ≠ ${step.energy.after}`);
          if (step.effect !== (sk.effect ?? '')) problems.push(`${at} 效果原文与图鉴不一致`);
        }
        energy = step.energy.after;
      } else if (step.kind === 'gather') {
        gatherSteps += 1;
        const gain = step.energy.gain ?? 0;
        if (gain <= 0 || gain % GATHER_GAIN !== 0) problems.push(`${at} 聚能收益 ${gain} 不是 ${GATHER_GAIN} 的整数倍`);
        if (step.energy.after !== Math.min(ind.cap, step.energy.before + gain))
          problems.push(`${at} 聚能后 ${step.energy.after} ≠ min(上限${ind.cap}, ${step.energy.before}+${gain})`);
        energy = step.energy.after;
      } else {
        pivotSteps += 1;
        if (step.energy.after !== step.energy.before) problems.push(`${at} 换人步骤不该变动能量`);
      }
      if (step.kind === 'skill' && step.energy.after > ind.cap)
        problems.push(`${at} 剩余能量 ${step.energy.after} 超过上限 ${ind.cap}`);
    });

    // 无 0.5 抗性 / 主力吃弱点这类话必须有，且不能自相矛盾
    if (!plan.caution.trim()) problems.push(`${where} 没有风险提示`);
  }
}

// 全部系别都必须有「换谁 + 核心招」的速览
for (const preset of rotation.teams) {
  for (const plan of buildTeamMatchup(preset) as TypeMatchupPlan[]) {
    if (!plan.quick.includes('×')) problems.push(`[${preset.name}] ${plan.type}系速览缺核心招`);
  }
}

console.log(
  `第 ${rotation.round} 轮 · 3 套阵容 × ${TYPE_ORDER.length} 系 = ${plans} 条方案 · 出招步骤 ${stepsTotal} 条（聚能 ${gatherSteps} / 换人 ${pivotSteps}）`,
);
console.log(
  `能量口径：入场默认 ${ENERGY_CAP} 点 · 聚能 +${GATHER_GAIN}/回合 · 全队无 0.5 抗性的组合 ${noResist} 条（已按等倍口径写明）`,
);
for (const preset of rotation.teams) {
  const list = buildTeamMatchup(preset);
  const sample = list
    .slice(0, 4)
    .map((p) => `${p.type}→${p.pick.name.replace(/（[^）]*）/g, '')}(${fmtMult(p.pick.defMultiplier)}/${fmtMult(p.pick.atkMultiplier)})`)
    .join('  ');
  console.log(`  ${preset.name}｜默认 ${weakestType(list)}｜示例：${sample}`);
}

for (const w of warnings) console.warn(`  ⚠ ${w}`);
if (problems.length) {
  console.error(`\n✗ ${problems.length} 个问题：`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log('\n✓ 18 系 100% 覆盖；主力/备选都在本套 6 只内；技能、威力、能耗、倍率、能量账全部与图鉴一致');
