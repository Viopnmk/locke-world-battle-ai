/**
 * 阵容推荐的数据面板：所有数字都从 src/data 现算，和「对战」页用的是同一套 analysis.ts。
 * 这里只做汇总与解释，不写死任何数值。
 */
import { bestHit, teamMetrics } from './analysis';
import { skillsOf } from './spirits';
import { memberSpirits, presetSpirit, resolveMemberSkill } from './team-presets';
import type { TeamPreset } from './team-presets';
import { matchup, multiplierLabel, TYPE_ORDER } from './typeChart';
import type { Spirit } from './types';

export interface TeamPlanMetrics {
  avgTotal: number;
  totalRange: { min: number; max: number };
  fastest: { name: string; spe: number } | null;
  slowest: { name: string; spe: number } | null;
  speedTiers: { fast: number; mid: number; slow: number };
  /** 物攻手 / 魔攻手（按攻击与特攻种族值取高者） */
  physical: { name: string; atk: number }[];
  special: { name: string; spa: number }[];
  balanced: string[];
  /** 最高单发威力（自己可学技能里威力最大的一个） */
  topPower: { name: string; skill: string; type: string; power: number; energy: number | null } | null;
  /** 每只精灵最高威力技能汇总，用来算团队的平均伤害档次 */
  avgTopPower: number;
  /** 全队能打出 ≥2 倍的防守属性数量 */
  coverageCount: number;
  coverageTypes: string[];
  sharedWeak: { type: string; count: number; members: string[]; maxMultiplier: number }[];
  sharedResist: { type: string; count: number; members: string[] }[];
  /** 对每个共同弱点，队里谁抗它（≤0.5 倍） */
  weakAnswers: { type: string; answers: string[] }[];
}

const round1 = (n: number) => Math.round(n * 10) / 10;

function topDamaging(spirit: Spirit) {
  // 「彗星」这类写着「使用后消耗全部生命」的技能不算单发威力：它是换命，不是炮。
  const dmg = skillsOf(spirit).filter(
    (s) => typeof s.power === 'number' && s.power > 0 && s.type && !/使用后消耗全部生命/.test(s.effect ?? ''),
  );
  return dmg.sort((a, b) => (b.power ?? 0) - (a.power ?? 0) || (a.energy ?? 99) - (b.energy ?? 99))[0] ?? null;
}

export function teamPlanMetrics(preset: TeamPreset): TeamPlanMetrics {
  const team = memberSpirits(preset);
  const totals = team.map((s) => s.stats.total ?? 0).filter((v) => v > 0);
  const avgTotal = totals.length ? round1(totals.reduce((a, b) => a + b, 0) / totals.length) : 0;

  const withSpeed = team
    .map((s) => ({ name: s.name, spe: s.stats.spe ?? 0 }))
    .sort((a, b) => b.spe - a.spe);
  const speedTiers = { fast: 0, mid: 0, slow: 0 };
  for (const s of withSpeed) {
    if (s.spe >= 120) speedTiers.fast += 1;
    else if (s.spe >= 100) speedTiers.mid += 1;
    else speedTiers.slow += 1;
  }

  const physical: { name: string; atk: number }[] = [];
  const special: { name: string; spa: number }[] = [];
  const balanced: string[] = [];
  for (const s of team) {
    const atk = s.stats.atk ?? 0;
    const spa = s.stats.spa ?? 0;
    if (atk >= spa + 15) physical.push({ name: s.name, atk });
    else if (spa >= atk + 15) special.push({ name: s.name, spa });
    else balanced.push(s.name);
  }
  physical.sort((a, b) => b.atk - a.atk);
  special.sort((a, b) => b.spa - a.spa);

  let topPower: TeamPlanMetrics['topPower'] = null;
  let powerSum = 0;
  let powerCount = 0;
  for (const s of team) {
    const best = topDamaging(s);
    if (!best) continue;
    powerSum += best.power ?? 0;
    powerCount += 1;
    if (!topPower || (best.power ?? 0) > topPower.power) {
      topPower = {
        name: s.name,
        skill: best.name,
        type: best.type,
        power: best.power ?? 0,
        energy: best.energy ?? null,
      };
    }
  }

  const coverageTypes = TYPE_ORDER.filter((t) =>
    team.some((s) => bestHit(s, [t]).multiplier >= 2),
  );

  // 共同弱点/抗性沿用对战页的同一套计算（敌方留空，只取我方内部的统计）
  const teamMetricsResult = teamMetrics(team, []);
  const sharedWeak = teamMetricsResult.sharedWeak.slice(0, 4);
  const sharedResist = teamMetricsResult.sharedResist.slice(0, 3);

  const weakAnswers = sharedWeak.map((w) => ({
    type: w.type,
    answers: team
      .filter((s) => matchup(w.type, s.type).multiplier <= 0.5)
      .map((s) => s.name),
  }));

  return {
    avgTotal,
    totalRange: {
      min: totals.length ? Math.min(...totals) : 0,
      max: totals.length ? Math.max(...totals) : 0,
    },
    fastest: withSpeed[0] ?? null,
    slowest: withSpeed[withSpeed.length - 1] ?? null,
    speedTiers,
    physical,
    special,
    balanced,
    topPower,
    avgTopPower: powerCount ? Math.round(powerSum / powerCount) : 0,
    coverageCount: coverageTypes.length,
    coverageTypes,
    sharedWeak,
    sharedResist,
    weakAnswers,
  };
}

/** 「A、B、C」 */
export function names(list: string[], limit = 3): string {
  if (!list.length) return '无';
  const shown = list.slice(0, limit).join('、');
  return list.length > limit ? `${shown} 等 ${list.length} 只` : shown;
}

/** 成员卡片右侧的「这只为什么在这队」三连：角色 + 特性 + 技能。 */
export function memberTraitLine(spiritId: string): string {
  const spirit = presetSpirit(spiritId);
  if (!spirit) return '数据缺失';
  return spirit.trait ? `「${spirit.trait.name}」${spirit.trait.effect}` : '图鉴未提供特性';
}

export function skillLabel(spiritId: string, skillName: string): string {
  const spirit = presetSpirit(spiritId);
  if (!spirit) return skillName;
  const sk = resolveMemberSkill(spirit, skillName);
  if (!sk) return skillName;
  const parts = [sk.type, sk.category];
  if (sk.power) parts.push(`威力${sk.power}`);
  if (sk.energy) parts.push(`能耗${sk.energy}`);
  return `${sk.name}（${parts.join('·')}）`;
}

export function weakTag(multiplier: number): string {
  return multiplierLabel(multiplier);
}

export { round1 };
