/**
 * 本地确定性分析：和 Worker 端 analysis.mjs 用同一套规则，
 * 数据来自 src/data/ 的 662 条图鉴记录。所有数字都能在界面上直接解释，
 * 不依赖网络，AI 只负责在這些数字之上写解释。
 */
import { skillsOf, spirits } from './spirits';
import type { ResolvedSkill, Spirit } from './types';
import { defenceProfile, matchup, TYPE_ORDER } from './typeChart';

export const STAT_KEYS = ['hp', 'atk', 'def', 'spa', 'spd', 'spe'] as const;
export type StatKey = (typeof STAT_KEYS)[number];

export const STAT_LABEL: Record<StatKey, string> = {
  hp: '生命',
  atk: '物攻',
  def: '物防',
  spa: '魔攻',
  spd: '魔防',
  spe: '速度',
};

export interface StatPoint {
  label: string;
  value: number;
  rank: number;
  percentile: number;
}

export interface TotalPoint {
  value: number;
  rank: number;
  population: number;
  percentile: number;
  tier: 'S' | 'A' | 'B' | 'C' | 'D';
}

const round1 = (n: number) => Math.round(n * 10) / 10;
const round2 = (n: number) => Math.round(n * 100) / 100;
const mean = (arr: number[]) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0);

/* ------------------------------------------------------------ 分布 */

const statDist: Record<StatKey, number[]> = {
  hp: [],
  atk: [],
  def: [],
  spa: [],
  spd: [],
  spe: [],
};
for (const s of spirits) {
  for (const k of STAT_KEYS) {
    const v = s.stats[k];
    if (typeof v === 'number') statDist[k].push(v);
  }
}
for (const k of STAT_KEYS) statDist[k].sort((a, b) => a - b);

const totalDist = spirits
  .map((s) => s.stats.total)
  .filter((v): v is number => typeof v === 'number')
  .sort((a, b) => a - b);

function rankIn(sorted: number[], value: number): number {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid] > value) hi = mid;
    else lo = mid + 1;
  }
  return sorted.length - lo + 1;
}

function percentileIn(sorted: number[], value: number): number {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid] <= value) lo = mid + 1;
    else hi = mid;
  }
  return round1((lo / sorted.length) * 100);
}

export function tierOf(percentile: number): TotalPoint['tier'] {
  if (percentile >= 95) return 'S';
  if (percentile >= 80) return 'A';
  if (percentile >= 55) return 'B';
  if (percentile >= 25) return 'C';
  return 'D';
}

export const TIER_LABEL: Record<TotalPoint['tier'], string> = {
  S: '顶级',
  A: '强势',
  B: '均衡',
  C: '偏弱',
  D: '冷门',
};

/* ------------------------------------------------------------ 单只强度 */

export interface SkillLite {
  name: string;
  type: string;
  category: string;
  power: number | null;
  energy: number | null;
  effect?: string;
}

export interface SpiritMetrics {
  id: string;
  name: string;
  dex: string;
  types: string[];
  total: TotalPoint;
  stats: Partial<Record<StatKey, StatPoint>>;
  roles: string[];
  weak: { type: string; multiplier: number }[];
  resist: { type: string; multiplier: number }[];
  offence: {
    typesWithDamagingSkill: number;
    strongAgainst: { type: string; multiplier: number }[];
    strongCount: number;
    noAnswer: string[];
  };
  skills: {
    total: number;
    damaging: number;
    support: number;
    byLearn: { level: number; stone: number; blood: number };
    byCategory: Record<string, number>;
    topPower: SkillLite[];
    efficient: (SkillLite & { ratio: number })[];
  };
}

export function damagingSkills(spirit: Spirit): ResolvedSkill[] {
  return skillsOf(spirit).filter((s) => typeof s.power === 'number' && s.power > 0 && s.type);
}

export function spiritMetrics(spirit: Spirit): SpiritMetrics {
  const stats: Partial<Record<StatKey, StatPoint>> = {};
  for (const key of STAT_KEYS) {
    const v = spirit.stats[key];
    if (typeof v !== 'number') continue;
    stats[key] = {
      label: STAT_LABEL[key],
      value: v,
      rank: rankIn(statDist[key], v),
      percentile: percentileIn(statDist[key], v),
    };
  }

  const totalValue = spirit.stats.total;
  const totalPercentile = typeof totalValue === 'number' ? percentileIn(totalDist, totalValue) : 0;
  const total: TotalPoint = {
    value: typeof totalValue === 'number' ? totalValue : 0,
    rank: typeof totalValue === 'number' ? rankIn(totalDist, totalValue) : 0,
    population: spirits.length,
    percentile: totalPercentile,
    tier: tierOf(totalPercentile),
  };

  const profile = defenceProfile(spirit.type);
  const list = skillsOf(spirit);
  const dmg = list.filter((s) => typeof s.power === 'number' && s.power > 0 && s.type);
  const support = list.filter((s) => !(typeof s.power === 'number' && s.power > 0));

  const bestByType = new Map<string, ResolvedSkill>();
  for (const sk of dmg) {
    const cur = bestByType.get(sk.type);
    if (!cur || (sk.power ?? 0) > (cur.power ?? 0)) bestByType.set(sk.type, sk);
  }
  const offenceTypes = [...bestByType.keys()];
  const vsAll = TYPE_ORDER.map((t) => ({
    type: t,
    best: offenceTypes.length ? Math.max(...offenceTypes.map((at) => matchup(at, [t]).multiplier)) : 0,
  }));
  const strongAgainst = vsAll.filter((v) => v.best >= 2).map((v) => ({ type: v.type, multiplier: v.best }));
  const noAnswer = vsAll.filter((v) => v.best <= 1).map((v) => v.type);

  const byLearn = { level: 0, stone: 0, blood: 0 };
  for (const sk of list) {
    if (sk.learn === 0) byLearn.level += 1;
    else if (sk.learn === 1) byLearn.stone += 1;
    else if (sk.learn === 2) byLearn.blood += 1;
  }
  const byCategory: Record<string, number> = { 物理: 0, 魔法: 0, 变化: 0 };
  for (const sk of list) {
    if (byCategory[sk.category] !== undefined) byCategory[sk.category] += 1;
  }

  const topPower = [...dmg]
    .sort((a, b) => (b.power ?? 0) - (a.power ?? 0) || (a.energy ?? 99) - (b.energy ?? 99))
    .slice(0, 8)
    .map((sk) => ({
      name: sk.name,
      type: sk.type,
      category: sk.category,
      power: sk.power,
      energy: sk.energy,
      effect: sk.effect,
    }));

  const efficient = [...dmg]
    .filter((sk) => typeof sk.energy === 'number' && sk.energy > 0)
    .sort((a, b) => (b.power ?? 0) / (b.energy ?? 1) - (a.power ?? 0) / (a.energy ?? 1))
    .slice(0, 5)
    .map((sk) => ({
      name: sk.name,
      type: sk.type,
      category: sk.category,
      power: sk.power,
      energy: sk.energy,
      ratio: round2((sk.power ?? 0) / (sk.energy ?? 1)),
    }));

  const p = (k: StatKey) => stats[k]?.percentile ?? 0;
  const offencePeak = Math.max(p('atk'), p('spa'));
  const bulk = mean([p('hp'), p('def'), p('spd')]);
  const roles: string[] = [];
  if (p('spe') >= 85 && offencePeak >= 70) roles.push('高速输出');
  else if (offencePeak >= 85) roles.push('重炮输出');
  else if (offencePeak >= 60) roles.push('稳定输出');
  if (bulk >= 80) roles.push('耐久坦克');
  else if (bulk >= 65) roles.push('能抗能打');
  if (p('spe') >= 90) roles.push('先手压制');
  if (support.length >= 8) roles.push('功能辅助');
  if (!roles.length) roles.push('均衡替补');

  return {
    id: spirit.id,
    name: spirit.name,
    dex: spirit.dex,
    types: spirit.type,
    total,
    stats,
    roles,
    weak: profile.weak,
    resist: profile.resist,
    offence: {
      typesWithDamagingSkill: offenceTypes.length,
      strongAgainst,
      strongCount: strongAgainst.length,
      noAnswer,
    },
    skills: {
      total: list.length,
      damaging: dmg.length,
      support: support.length,
      byLearn,
      byCategory,
      topPower,
      efficient,
    },
  };
}

/* ------------------------------------------------------------ 对位 */

export interface Hit {
  multiplier: number;
  skill: ResolvedSkill | null;
  /** 没有输出技能时，退回本系属性 */
  fallbackType?: string;
}

export function bestHit(spirit: Spirit, targetTypes: string[]): Hit {
  const dmg = damagingSkills(spirit);
  let best: { mult: number; score: number; skill: ResolvedSkill | null; fallbackType?: string } | null = null;
  for (const sk of dmg) {
    const mult = matchup(sk.type, targetTypes).multiplier;
    const score = mult * (sk.power ?? 0);
    if (!best || score > best.score || (score === best.score && (sk.power ?? 0) > (best.skill?.power ?? 0))) {
      best = { mult, score, skill: sk };
    }
  }
  if (!best) {
    for (const t of spirit.type) {
      const mult = matchup(t, targetTypes).multiplier;
      if (!best || mult > best.mult) best = { mult, score: mult * 60, skill: null, fallbackType: t };
    }
  }
  if (!best) best = { mult: 1, score: 60, skill: null, fallbackType: spirit.type[0] };
  return { multiplier: best.mult, skill: best.skill, fallbackType: best.fallbackType };
}

export interface MatrixCell {
  myId: string;
  myName: string;
  enemyId: string;
  enemyName: string;
  attack: { multiplier: number; skill: ResolvedSkill | null; skillType: string };
  threat: { multiplier: number; skill: ResolvedSkill | null; skillType: string };
  speedEdge: number;
}

export interface TeamMetrics {
  matrix: MatrixCell[][];
  sharedWeak: { type: string; count: number; members: string[]; maxMultiplier: number }[];
  sharedResist: { type: string; count: number; members: string[] }[];
  coverageGaps: { enemy: string; enemyTypes: string[]; bestMultiplier: number; bestBy: string | null }[];
  speed: {
    myFastest: { name: string; spe: number } | null;
    enemyFastest: { name: string; spe: number } | null;
    myLeadCount: number;
    myFasterCount: number;
  };
  totals: { myAvg: number; enemyAvg: number; diff: number };
  lead: { name: string; id: string; attack: number; threat: number; speedEdge: number; score: number } | null;
  ranked: { name: string; id: string; attack: number; threat: number; speedEdge: number; score: number }[];
}

export function teamMetrics(mine: Spirit[], theirs: Spirit[]): TeamMetrics {
  const matrix: MatrixCell[][] = mine.map((my) =>
    theirs.map((en) => {
      const atk = bestHit(my, en.type);
      const threat = bestHit(en, my.type);
      return {
        myId: my.id,
        myName: my.name,
        enemyId: en.id,
        enemyName: en.name,
        attack: { multiplier: atk.multiplier, skill: atk.skill, skillType: atk.skill?.type ?? atk.fallbackType ?? my.type[0] },
        threat: {
          multiplier: threat.multiplier,
          skill: threat.skill,
          skillType: threat.skill?.type ?? threat.fallbackType ?? en.type[0],
        },
        speedEdge: (my.stats.spe ?? 0) - (en.stats.spe ?? 0),
      };
    }),
  );

  const sharedWeak: TeamMetrics['sharedWeak'] = [];
  const sharedResist: TeamMetrics['sharedResist'] = [];
  for (const atkType of TYPE_ORDER) {
    const hitMembers = mine.filter((m) => matchup(atkType, m.type).multiplier >= 2);
    if (hitMembers.length >= 2) {
      sharedWeak.push({
        type: atkType,
        count: hitMembers.length,
        members: hitMembers.map((m) => m.name),
        maxMultiplier: Math.max(...hitMembers.map((m) => matchup(atkType, m.type).multiplier)),
      });
    }
    const resistMembers = mine.filter((m) => matchup(atkType, m.type).multiplier <= 0.5);
    if (resistMembers.length >= 2) {
      sharedResist.push({ type: atkType, count: resistMembers.length, members: resistMembers.map((m) => m.name) });
    }
  }
  sharedWeak.sort((a, b) => b.count - a.count || b.maxMultiplier - a.maxMultiplier);
  sharedResist.sort((a, b) => b.count - a.count);

  const coverageGaps: TeamMetrics['coverageGaps'] = [];
  if (theirs.length && mine.length) {
    for (const en of theirs) {
      const answers = mine
        .map((m) => ({ name: m.name, mult: bestHit(m, en.type).multiplier }))
        .sort((a, b) => b.mult - a.mult);
      if (!answers.length || answers[0].mult < 2) {
        coverageGaps.push({
          enemy: en.name,
          enemyTypes: en.type,
          bestMultiplier: answers[0]?.mult ?? 0,
          bestBy: answers[0]?.name ?? null,
        });
      }
    }
  }

  const myFastest = mine.length ? mine.reduce((a, b) => ((a.stats.spe ?? 0) >= (b.stats.spe ?? 0) ? a : b)) : null;
  const enemyFastest = theirs.length ? theirs.reduce((a, b) => ((a.stats.spe ?? 0) >= (b.stats.spe ?? 0) ? a : b)) : null;
  const speed = {
    myFastest: myFastest ? { name: myFastest.name, spe: myFastest.stats.spe ?? 0 } : null,
    enemyFastest: enemyFastest ? { name: enemyFastest.name, spe: enemyFastest.stats.spe ?? 0 } : null,
    myLeadCount: theirs.length ? mine.filter((m) => (m.stats.spe ?? 0) > (enemyFastest?.stats.spe ?? 0)).length : 0,
    myFasterCount: theirs.length ? mine.filter((m) => theirs.every((e) => (m.stats.spe ?? 0) > (e.stats.spe ?? 0))).length : 0,
  };

  const totals = {
    myAvg: mine.length ? round1(mean(mine.map((m) => m.stats.total ?? 0))) : 0,
    enemyAvg: theirs.length ? round1(mean(theirs.map((m) => m.stats.total ?? 0))) : 0,
    diff: 0,
  };
  totals.diff = round1(totals.myAvg - totals.enemyAvg);

  const ranked = mine
    .map((m) => {
      const atk = theirs.length ? round2(mean(theirs.map((e) => bestHit(m, e.type).multiplier))) : 0;
      const threat = theirs.length ? round2(mean(theirs.map((e) => bestHit(e, m.type).multiplier))) : 0;
      const spd = theirs.length ? round1(mean(theirs.map((e) => (m.stats.spe ?? 0) - (e.stats.spe ?? 0)))) : 0;
      const score = round2(atk - threat + (spd > 0 ? 0.3 : spd < 0 ? -0.3 : 0));
      return { name: m.name, id: m.id, attack: atk, threat, speedEdge: spd, score };
    })
    .sort((a, b) => b.score - a.score);

  return { matrix, sharedWeak, sharedResist, coverageGaps, speed, totals, lead: ranked[0] ?? null, ranked };
}

export interface DuelMetrics {
  attack: Hit;
  threat: Hit;
  speedEdge: number;
}

export function duelMetrics(mine: Spirit, theirs: Spirit): DuelMetrics {
  return {
    attack: bestHit(mine, theirs.type),
    threat: bestHit(theirs, mine.type),
    speedEdge: (mine.stats.spe ?? 0) - (theirs.stats.spe ?? 0),
  };
}
