/**
 * 跨属性自由混搭阵容：全图鉴量化筛选。
 *
 *   npx esbuild scripts/screen-mixed.ts --bundle --platform=node --format=esm \
 *     --outfile=.cache/screen-mixed.mjs && node .cache/screen-mixed.mjs
 *
 * 只读 src/data/*.json：每只精灵的种族值、特性、学习面、18 系倍率。
 * 输出 .cache/mixed-screening.json（机器可读）与 .cache/mixed-screening.md（人读）。
 *
 * 思路：
 * 1) 给 662 只形态打「机制标签」——特性标签与技能标签分开算，标签只来自原文关键词；
 * 2) 六个流派各有硬约束（必须含的系、必须存在的机制、共同弱点上限、弱点全覆盖），
 *    在约束内用「贪心起手 + 爬山换人」最大化流派目标函数；
 * 3) 六套队伍按顺序挑，后挑的不能用前面已经用过的精灵（保证六套互不重复）；
 * 4) 报告里给出逐只原文证据，写文案时只照抄这些原文。
 */
import fs from 'node:fs';
import { bestHit } from '../src/lib/analysis';
import { skillsOf, spirits } from '../src/lib/spirits';
// Phase 8 起这 6 套混搭队已归档（#/teams 只显示 48 小时轮换的 3 套），脚本保留用于复算历史结果
import { MIXED_TEAM_PRESETS } from '../archive/team-presets-mixed';
import { matchup, TYPE_ORDER } from '../src/lib/typeChart';
import type { ResolvedSkill, Spirit } from '../src/lib/types';

const TI = new Map(TYPE_ORDER.map((t, i) => [t, i]));

interface Profile {
  spirit: Spirit;
  name: string;
  base: string; // 去掉（形态）
  types: string[];
  total: number;
  stats: { hp: number; atk: number; def: number; spa: number; spd: number; spe: number };
  coverage: number;
  defMul: number[];
  weak: string[];
  resist: string[];
  maxPower: number;
  maxPowerSkill: ResolvedSkill | null;
  heavy: ResolvedSkill[]; // 威力 >=150 且能耗 >=5 的技能
  traitTags: Set<string>;
  skillTags: Set<string>;
  tags: Set<string>;
  tagHits: string[];
  traitText: string;
  keySkills: ResolvedSkill[];
}

const MECH: { tag: string; label: string; test: (text: string) => boolean }[] = [
  { tag: 'steal', label: '偷能量', test: (t) => /偷取[^。；]{0,6}能量/.test(t) },
  { tag: 'tax', label: '抬能耗', test: (t) => /全技能能耗\+|失去能耗之差|敌方失去\d能量/.test(t) },
  { tag: 'leech', label: '吸血', test: (t) => /吸血\d*%?/.test(t) },
  { tag: 'burn', label: '灼烧', test: (t) => /灼烧/.test(t) },
  { tag: 'poison', label: '中毒', test: (t) => /中毒/.test(t) },
  { tag: 'freeze', label: '冻结', test: (t) => /冻结/.test(t) },
  { tag: 'switch', label: '换人惩罚', test: (t) => /敌方精灵离场后|本回合更换精灵|更换入场的精灵/.test(t) },
  { tag: 'comeback', label: '残血反打', test: (t) => /生命低于\d+%|受到致命伤害|力竭/.test(t) },
  { tag: 'sustain', label: '回复续航', test: (t) => /回复[^。；]{0,6}生命|回复等量生命|回复\d+%生命/.test(t) },
  { tag: 'charge', label: '蓄力', test: (t) => /蓄力/.test(t) },
];

const baseName = (name: string) => name.replace(/（[^）]*）/g, '');

function buildProfile(spirit: Spirit): Profile {
  const skills = skillsOf(spirit);
  const damaging = skills.filter((s) => typeof s.power === 'number' && s.power > 0 && s.type);
  const defMul = TYPE_ORDER.map((atk) => matchup(atk, spirit.type).multiplier);
  const weak = TYPE_ORDER.filter((_, i) => defMul[i] > 1);
  const resist = TYPE_ORDER.filter((_, i) => defMul[i] < 1);

  // 与「阵容推荐」数据面板同一口径：取这只精灵对目标系别「倍率×威力」最高的那一招，
  // 而不是「只要有某个 2 倍技能就算」——否则 30 威力的寸拳会把 155 威力的普攻顶掉。
  const coverage = TYPE_ORDER.reduce((mask, t, i) => {
    const hit = bestHit(spirit, [t]).multiplier >= 2;
    return hit ? mask | (1 << i) : mask;
  }, 0);

  const sorted = [...damaging].sort((a, b) => (b.power ?? 0) - (a.power ?? 0) || (a.energy ?? 99) - (b.energy ?? 99));
  const heavy = damagedHeavy(damaging);

  const traitText = spirit.trait ? `${spirit.trait.name}：${spirit.trait.effect}` : '';
  const traitTags = new Set<string>();
  const skillTags = new Set<string>();
  const tagHits: string[] = [];

  for (const rule of MECH) {
    if (traitText && rule.test(traitText)) {
      traitTags.add(rule.tag);
      tagHits.push(`${rule.label}｜特性 ${traitText}`);
    }
  }
  for (const sk of skills) {
    const text = sk.effect ?? '';
    if (!text) continue;
    for (const rule of MECH) {
      if (rule.test(text)) {
        skillTags.add(rule.tag);
        if (tagHits.length < 30) tagHits.push(`${rule.label}｜技能「${sk.name}」：${text}`);
      }
    }
  }

  const tags = new Set([...traitTags, ...skillTags]);
  if (damaging.some((s) => (s.power ?? 0) >= 150)) tags.add('nuke');
  if ((spirit.stats.spe ?? 0) >= 120) tags.add('fast');
  const bulk = (spirit.stats.hp ?? 0) + (spirit.stats.def ?? 0) + (spirit.stats.spd ?? 0);
  if (bulk >= 330) tags.add('bulk');
  if (skills.filter((s) => !(typeof s.power === 'number' && s.power > 0)).length >= 8) tags.add('utility');

  const keySkills = [...skills]
    .filter((s) => {
      const effect = s.effect ?? '';
      return MECH.some((r) => r.test(effect)) || (s.power ?? 0) >= 130;
    })
    .sort((a, b) => (b.power ?? 0) - (a.power ?? 0) || (a.energy ?? 99) - (b.energy ?? 99))
    .slice(0, 12);

  return {
    spirit,
    name: spirit.name,
    base: baseName(spirit.name),
    types: spirit.type,
    total: spirit.stats.total ?? 0,
    stats: {
      hp: spirit.stats.hp ?? 0,
      atk: spirit.stats.atk ?? 0,
      def: spirit.stats.def ?? 0,
      spa: spirit.stats.spa ?? 0,
      spd: spirit.stats.spd ?? 0,
      spe: spirit.stats.spe ?? 0,
    },
    coverage,
    defMul,
    weak,
    resist,
    maxPower: sorted[0]?.power ?? 0,
    maxPowerSkill: sorted[0] ?? null,
    heavy,
    traitTags,
    skillTags,
    tags,
    tagHits,
    traitText,
    keySkills,
  };
}

function damagedHeavy(damaging: ResolvedSkill[]): ResolvedSkill[] {
  return damaging
    .filter((s) => (s.power ?? 0) >= 150 && (s.energy ?? 0) >= 5)
    .sort((a, b) => (b.power ?? 0) - (a.power ?? 0) || (b.energy ?? 0) - (a.energy ?? 0));
}

const PROFILES = spirits.map(buildProfile);
const BY_NAME = new Map(PROFILES.map((p) => [p.name, p]));

/* ------------------------------------------------------------------ 评估 */

interface TeamEval {
  coverage: number;
  coverageTypes: string[];
  sharedWeak: { type: string; count: number }[];
  sharedWeakCount: number;
  weakSpots: number;
  coveredSpots: number;
  allCovered: boolean;
  avgTotal: number;
  fastest: number;
  distinctTypes: number;
  distinctPrimary: number;
  roles: string[];
}

function popcount(mask: number): number {
  let c = 0;
  while (mask) {
    mask &= mask - 1;
    c += 1;
  }
  return c;
}

function roleOf(p: Profile): string[] {
  const roles: string[] = [];
  if (p.spe >= 120) roles.push('先手');
  if (p.maxPower >= 150 && Math.max(p.stats.atk, p.stats.spa) >= 120) roles.push('输出');
  if (p.traitTags.has('tax') || p.traitTags.has('steal') || p.traitTags.has('switch')) roles.push('控制');
  if (p.traitTags.has('sustain') || p.skillTags.has('sustain')) roles.push('辅助');
  if (p.stats.hp + p.stats.def + p.stats.spd >= 330) roles.push('承伤');
  if (p.traitTags.has('comeback') || p.skillTags.has('comeback')) roles.push('收割');
  if (!roles.length) roles.push('补位');
  return roles;
}

function evaluate(team: Profile[], weightTags: (p: Profile) => number): TeamEval & { tagScore: number } {
  let coverage = 0;
  let total = 0;
  let fastest = 0;
  const typeSet = new Set<string>();
  const primary = new Set<string>();
  const roles = new Set<string>();
  let tagScore = 0;
  for (const p of team) {
    coverage |= p.coverage;
    total += p.total;
    fastest = Math.max(fastest, p.stats.spe);
    for (const t of p.types) typeSet.add(t);
    primary.add(p.types[0]);
    for (const r of roleOf(p)) roles.add(r);
    tagScore += weightTags(p);
  }
  const sharedWeak: TeamEval['sharedWeak'] = [];
  for (let i = 0; i < TYPE_ORDER.length; i += 1) {
    let count = 0;
    for (const p of team) if (p.defMul[i] >= 2) count += 1;
    if (count >= 2) sharedWeak.push({ type: TYPE_ORDER[i], count });
  }
  let weakSpots = 0;
  let coveredSpots = 0;
  for (const p of team) {
    for (const w of p.weak) {
      weakSpots += 1;
      const i = TI.get(w)!;
      if (team.some((other) => other !== p && other.defMul[i] <= 0.5)) coveredSpots += 1;
    }
  }
  return {
    coverage: popcount(coverage),
    coverageTypes: TYPE_ORDER.filter((_, i) => coverage & (1 << i)),
    sharedWeak,
    sharedWeakCount: sharedWeak.length,
    weakSpots,
    coveredSpots,
    allCovered: weakSpots > 0 && coveredSpots === weakSpots,
    avgTotal: Math.round((total / team.length) * 10) / 10,
    fastest,
    distinctTypes: typeSet.size,
    distinctPrimary: primary.size,
    roles: [...roles],
    tagScore,
  };
}

/* ------------------------------------------------------------------ 搜索 */

function mulberry32(seed: number) {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Spec {
  id: string;
  goal: string;
  pool: Profile[];
  weightTags: (p: Profile) => number;
  baseScore: (e: TeamEval & { tagScore: number }, team: Profile[]) => number;
  /** 返回违反的硬约束条数（0 = 满足），用来给爬山算法一个可走的坡度 */
  violations: (team: Profile[], e: TeamEval & { tagScore: number }) => number;
  valid: (team: Profile[], e: TeamEval & { tagScore: number }) => boolean;
  mustTypes?: string[];
  restarts?: number;
  /** 额外排除的精灵名（例如全图鉴通用的技能石杂食者） */
  exclude?: string[];
}

function shapeOk(team: Profile[]): boolean {
  if (team.length !== 6) return false;
  if (new Set(team.map((p) => p.base)).size !== team.length) return false;
  const primary = new Map<string, number>();
  const allTypes = new Set<string>();
  for (const p of team) {
    for (const t of p.types) allTypes.add(t);
    primary.set(p.types[0], (primary.get(p.types[0]) ?? 0) + 1);
  }
  if (allTypes.size < 5) return false;
  if ([...primary.values()].some((n) => n >= 3)) return false;
  return true;
}


function scoreOf(spec: Spec, e: ReturnType<typeof evaluate>, team: Profile[]): number {
  const shape = shapeOk(team);
  const v = spec.violations(team, e);
  return spec.baseScore(e, team) - v * 400 - (shape ? 0 : 1e5);
}

const GLOBAL_EXCLUDE = ['学院呱呱'];

function search(spec: Spec, used: Set<string>) {
  const rand = mulberry32(spec.id.length * 7919 + 13);
  const pool = spec.pool.filter(
    (p) =>
      p.total > 0 &&
      !used.has(p.base) &&
      !GLOBAL_EXCLUDE.includes(p.name) &&
      !(spec.exclude ?? []).includes(p.name),
  );
  const must = (spec.mustTypes ?? []).map((t) =>
    pool.filter((p) => p.types.includes(t)).sort((a, b) => spec.weightTags(b) - spec.weightTags(a) || b.total - a.total),
  );
  const results: { team: Profile[]; score: number; e: ReturnType<typeof evaluate>; validTeam: boolean }[] = [];
  const seen = new Set<string>();

  for (let r = 0; r < (spec.restarts ?? 40); r += 1) {
    const team: Profile[] = [];
    for (const cands of must) {
      const slice = cands.slice(0, Math.max(2, Math.min(10, cands.length)));
      const pick = slice[Math.floor(rand() * slice.length)];
      if (pick && !team.some((m) => m.base === pick.base)) team.push(pick);
    }
    while (team.length < 6) {
      let best: Profile | null = null;
      let bestScore = -Infinity;
      for (const p of pool) {
        if (team.some((m) => m.base === p.base)) continue;
        const trial = [...team, p];
        const e = evaluate(trial, spec.weightTags);
        const s = scoreOf(spec, e, trial);
        if (s > bestScore) {
          bestScore = s;
          best = p;
        }
      }
      if (!best) break;
      team.push(best);
    }
    if (team.length < 6) continue;

    let e = evaluate(team, spec.weightTags);
    let score = scoreOf(spec, e, team);
    for (let pass = 0; pass < 8; pass += 1) {
      let improved = false;
      for (let slot = 0; slot < 6; slot += 1) {
        let bestSwap: Profile | null = null;
        let bestScore = score;
        let bestEval = e;
        for (const p of pool) {
          if (team.some((m) => m.base === p.base)) continue;
          const trial = team.map((m, i) => (i === slot ? p : m));
          if (!shapeOk(trial)) continue;
          const te = evaluate(trial, spec.weightTags);
          const s = scoreOf(spec, te, trial);
          if (s > bestScore) {
            bestScore = s;
            bestSwap = p;
            bestEval = te;
          }
        }
        if (bestSwap) {
          team[slot] = bestSwap;
          score = bestScore;
          e = bestEval;
          improved = true;
        }
      }
      if (!improved) break;
    }
    const key = team.map((p) => p.base).sort().join('|');
    if (seen.has(key)) continue;
    seen.add(key);
    results.push({ team: [...team], score, e, validTeam: shapeOk(team) && spec.valid(team, e) });
  }
  results.sort((a, b) => b.score - a.score);
  const validOnes = results.filter((r) => r.validTeam);
  return (validOnes.length ? validOnes : results).slice(0, 8);
}

/* ------------------------------------------------------------------ 规格 */

const traitWeight = (p: Profile, tags: string[], w: number) => tags.reduce((acc, t) => acc + (p.traitTags.has(t) ? w : 0), 0);
const skillWeight = (p: Profile, tags: string[], w: number) => tags.reduce((acc, t) => acc + (p.skillTags.has(t) ? w : 0), 0);

const fireCount = (team: Profile[]) => team.filter((p) => p.types.includes('火')).length;
const grassCount = (team: Profile[]) => team.filter((p) => p.types.includes('草')).length;

const specs: Spec[] = [
  {
    id: 'cover18',
    goal: '18 系广域互补：全队 18 系都能打出 2 倍，共同弱点 <=2，且每只的每个弱点都有队友抵抗',
    pool: PROFILES.filter((p) => p.coverage >= 8),
    weightTags: (p) => p.coverage * 3 + p.total / 25,
    baseScore: (e) =>
      e.coverage * 14 -
      e.sharedWeakCount * 26 +
      (e.coveredSpots / Math.max(1, e.weakSpots)) * 50 +
      (e.allCovered ? 45 : 0) +
      e.distinctTypes * 2 +
      e.roles.length * 3 +
      e.avgTotal / 25,
    valid: (team, e) => e.coverage >= 17 && e.sharedWeakCount <= 2 && e.coveredSpots === e.weakSpots,
    violations: (team, e) =>
      (e.coverage >= 17 ? 0 : 1) + (e.sharedWeakCount <= 2 ? 0 : 1) + (e.coveredSpots === e.weakSpots ? 0 : 1),
    exclude: ['学院呱呱'],
    restarts: 60,
  },
  {
    id: 'firegrass',
    goal: '火草 / 灼烧联防：草系用 水·地 抵抗接住火系的弱点，火系用 冰·虫 抵抗接住草系的弱点，灼烧叠层',
    pool: PROFILES.filter(
      (p) =>
        p.types.includes('火') ||
        p.types.includes('草') ||
        (p.types.includes('水') && (p.traitTags.has('sustain') || p.skillTags.has('sustain'))) ||
        (p.traitTags.has('burn') && p.total > 400),
    ),
    weightTags: (p) =>
      (p.types.includes('火') ? 10 : 0) +
      (p.types.includes('草') ? 10 : 0) +
      traitWeight(p, ['burn', 'sustain'], 14) +
      skillWeight(p, ['burn'], 3) +
      (p.tags.has('bulk') ? 4 : 0) +
      p.total / 35,
    baseScore: (e) =>
      e.tagScore * 1.2 +
      e.coverage * 2.6 -
      e.sharedWeakCount * 2 +
      (e.coveredSpots / Math.max(1, e.weakSpots)) * 30 +
      (e.allCovered ? 12 : 0) +
      e.roles.length * 4 +
      e.avgTotal / 16,
    valid: (team, e) =>
      fireCount(team) >= 2 &&
      grassCount(team) >= 2 &&
      team.some((p) => !p.types.includes('火') && p.defMul[TI.get('水')!] <= 0.5) &&
      team.some((p) => !p.types.includes('火') && p.defMul[TI.get('地')!] <= 0.5) &&
      team.filter((p) => p.traitTags.has('burn') || p.skillTags.has('burn')).length >= 2 &&
      e.coverage >= 13,
    violations: (team, e) =>
      (fireCount(team) >= 2 ? 0 : 1) +
      (grassCount(team) >= 2 ? 0 : 1) +
      (team.some((p) => !p.types.includes('火') && p.defMul[TI.get('水')!] <= 0.5) ? 0 : 1) +
      (team.some((p) => !p.types.includes('火') && p.defMul[TI.get('地')!] <= 0.5) ? 0 : 1) +
      (team.filter((p) => p.traitTags.has('burn') || p.skillTags.has('burn')).length >= 2 ? 0 : 1) +
      (e.coverage >= 13 ? 0 : 1),
    restarts: 50,
  },
  {
    id: 'groundfight',
    goal: '地武强攻联防：地系与武系互为肉盾，机械/恶/翼位补上 冰·水·草 与 翼·萌·幻 的弱点',
    pool: PROFILES.filter(
      (p) =>
        p.types.includes('地') ||
        p.types.includes('武') ||
        p.types.includes('机械') ||
        p.types.includes('恶') ||
        p.types.includes('翼'),
    ),
    weightTags: (p) =>
      (p.types.includes('地') ? 12 : 0) +
      (p.types.includes('武') ? 12 : 0) +
      (p.types.includes('机械') || p.types.includes('恶') || p.types.includes('翼') ? 8 : 0) +
      traitWeight(p, ['sustain', 'comeback', 'leech'], 8) +
      (p.stats.hp + p.stats.def + p.stats.spd >= 330 ? 10 : 0) +
      (p.maxPower >= 150 ? 8 : 0) +
      p.total / 30,
    baseScore: (e) =>
      e.tagScore +
      e.coverage * 4 -
      e.sharedWeakCount * 2.5 +
      (e.coveredSpots / Math.max(1, e.weakSpots)) * 40 +
      e.roles.length * 4 +
      e.avgTotal / 14,
    valid: (team, e) =>
      team.filter((p) => p.types.includes('地')).length >= 2 &&
      team.filter((p) => p.types.includes('武')).length >= 2 &&
      e.coverage >= 14 &&
      e.coveredSpots === e.weakSpots,
    violations: (team, e) =>
      (team.filter((p) => p.types.includes('地')).length >= 2 ? 0 : 1) +
      (team.filter((p) => p.types.includes('武')).length >= 2 ? 0 : 1) +
      (e.coverage >= 14 ? 0 : 1) +
      (e.coveredSpots === e.weakSpots ? 0 : 1),
    restarts: 50,
  },
  {
    id: 'drain',
    goal: '偷能量 / 高耗能压制：用 勾魂 类偷能量与抬能耗把对手抽干，再让高能耗重炮收场',
    pool: PROFILES.filter(
      (p) =>
        p.traitTags.has('steal') ||
        p.traitTags.has('tax') ||
        p.skillTags.has('steal') ||
        p.heavy.length > 0,
    ),
    weightTags: (p) =>
      traitWeight(p, ['steal', 'tax'], 18) +
      skillWeight(p, ['steal', 'tax'], 5) +
      (p.heavy.length ? Math.min(3, p.heavy.length) * 9 : 0) +
      (p.tags.has('nuke') ? 4 : 0) +
      p.total / 40,
    baseScore: (e, team) =>
      e.tagScore * 1.6 +
      e.coverage * 2.4 -
      e.sharedWeakCount * 3 +
      (e.coveredSpots / Math.max(1, e.weakSpots)) * 26 +
      e.roles.length * 4 +
      e.avgTotal / 16,
    valid: (team, e) =>
      team.filter((p) => p.traitTags.has('tax') || p.traitTags.has('steal')).length >= 2 &&
      team.filter((p) => p.heavy.length > 0).length >= 2 &&
      e.coverage >= 13 &&
      e.sharedWeakCount <= 3,
    violations: (team, e) =>
      (team.filter((p) => p.traitTags.has('tax') || p.traitTags.has('steal')).length >= 2 ? 0 : 1) +
      (team.filter((p) => p.heavy.length > 0).length >= 2 ? 0 : 1) +
      (e.coverage >= 13 ? 0 : 1) +
      (e.sharedWeakCount <= 3 ? 0 : 1),
    restarts: 50,
  },
  {
    id: 'leech',
    goal: '吸血续航 / 残血反打：吸血把伤害换成血，低血量触发吸血与反打倍率，中速耐久位滚雪球',
    pool: PROFILES.filter(
      (p) =>
        p.traitTags.has('leech') ||
        p.traitTags.has('comeback') ||
        p.skillTags.has('leech') ||
        p.traitTags.has('sustain'),
    ),
    weightTags: (p) =>
      traitWeight(p, ['leech'], 20) +
      traitWeight(p, ['comeback', 'sustain'], 10) +
      skillWeight(p, ['leech'], 4) +
      (p.stats.hp + p.stats.def + p.stats.spd >= 330 ? 8 : 0) +
      p.total / 35,
    baseScore: (e) =>
      e.tagScore * 1.4 +
      e.coverage * 3 -
      e.sharedWeakCount * 3 +
      (e.coveredSpots / Math.max(1, e.weakSpots)) * 30 +
      e.roles.length * 5 +
      e.avgTotal / 14,
    valid: (team, e) =>
      team.filter((p) => p.traitTags.has('leech') || p.skillTags.has('leech')).length >= 3 &&
      team.filter((p) => p.traitTags.has('comeback') || p.skillTags.has('comeback')).length >= 2 &&
      e.coverage >= 12 &&
      e.allCovered,
    violations: (team, e) =>
      (team.filter((p) => p.traitTags.has('leech') || p.skillTags.has('leech')).length >= 3 ? 0 : 1) +
      (team.filter((p) => p.traitTags.has('comeback') || p.skillTags.has('comeback')).length >= 2 ? 0 : 1) +
      (e.coverage >= 12 ? 0 : 1) +
      (e.allCovered ? 0 : 1),
    restarts: 50,
  },
  {
    id: 'grind',
    goal: '恶心消耗 / 控场折磨：抬能耗 + 换人惩罚 + 异常层数 + 回复，把对局拖成对手付不起的消耗战',
    pool: PROFILES.filter(
      (p) =>
        p.traitTags.has('tax') ||
        p.traitTags.has('switch') ||
        p.traitTags.has('burn') ||
        p.traitTags.has('poison') ||
        p.traitTags.has('freeze') ||
        p.traitTags.has('sustain') ||
        p.skillTags.has('switch'),
    ),
    weightTags: (p) =>
      traitWeight(p, ['tax', 'switch'], 18) +
      traitWeight(p, ['poison', 'burn', 'freeze'], 10) +
      traitWeight(p, ['sustain'], 8) +
      skillWeight(p, ['switch', 'tax'], 4) +
      (p.stats.hp + p.stats.def + p.stats.spd >= 330 ? 8 : 0) +
      p.total / 40,
    baseScore: (e) =>
      e.tagScore * 1.5 +
      e.coverage * 2.2 -
      e.sharedWeakCount * 4 +
      (e.coveredSpots / Math.max(1, e.weakSpots)) * 30 +
      e.roles.length * 5 +
      e.avgTotal / 16,
    valid: (team, e) =>
      team.filter((p) => p.traitTags.has('tax') || p.traitTags.has('switch')).length >= 2 &&
      team.filter(
        (p) => p.traitTags.has('poison') || p.traitTags.has('burn') || p.traitTags.has('freeze') || p.skillTags.has('poison'),
      ).length >= 2 &&
      e.coverage >= 12 &&
      e.sharedWeakCount <= 3,
    violations: (team, e) =>
      (team.filter((p) => p.traitTags.has('tax') || p.traitTags.has('switch')).length >= 2 ? 0 : 1) +
      (team.filter(
        (p) => p.traitTags.has('poison') || p.traitTags.has('burn') || p.traitTags.has('freeze') || p.skillTags.has('poison'),
      ).length >= 2
        ? 0
        : 1) +
      (e.coverage >= 12 ? 0 : 1) +
      (e.sharedWeakCount <= 3 ? 0 : 1),
    restarts: 50,
  },
];

/* ------------------------------------------------------------------ 定稿六套 */

/** 把最终发布的六套阵容按同一套评估函数复算一遍，确认筛选结果与上线内容一致。 */
const BY_ID = new Map(PROFILES.map((p) => [p.spirit.id, p]));
const noWeight = () => 0;
const finalTeams = MIXED_TEAM_PRESETS.map((preset) => {
  const team = preset.members.map((m) => {
    const p = BY_ID.get(m.spiritId);
    if (!p) throw new Error(`${preset.name}: ${m.spiritId} 不存在`);
    return p;
  });
  return { preset, team, e: evaluate(team, noWeight) };
});

console.log('\n=== 最终发布的六套混搭队');
for (const { preset, e } of finalTeams) {
  console.log(
    `${preset.name}｜平均 ${e.avgTotal}｜最快 ${e.fastest}｜覆盖 ${e.coverage}/18｜共同弱点 ${e.sharedWeakCount}（${e.sharedWeak.map((w) => w.type + '×' + w.count).join('、') || '无'}）｜弱点接住 ${e.coveredSpots}/${e.weakSpots}${e.allCovered ? '（全覆盖）' : ''}｜属性 ${e.distinctTypes} 种`,
  );
}

/* ------------------------------------------------------------------ 挑选与输出 */

const used = new Set<string>();
const chosen: { spec: Spec; team: Profile[]; e: ReturnType<typeof evaluate>; score: number; candidates: { team: Profile[]; e: ReturnType<typeof evaluate>; score: number }[] }[] = [];

for (const spec of specs) {
  const ranked = search(spec, used);
  console.log(`\n=== ${spec.id} · ${spec.goal}`);
  ranked.slice(0, 5).forEach((entry, rank) => {
    console.log(
      `${rank + 1}. score ${entry.score.toFixed(1)}｜覆盖 ${entry.e.coverage}/18｜共同弱点 ${entry.e.sharedWeakCount}｜弱点接住 ${entry.e.coveredSpots}/${entry.e.weakSpots}${entry.e.allCovered ? '（全覆盖）' : ''}｜平均 ${entry.e.avgTotal}｜最快 ${entry.e.fastest}`,
    );
    console.log('   ' + entry.team.map((p) => `${p.name}(${p.types.join('/')} ${p.total})`).join(' / '));
  });
  // 流派候选池前 18 名（按流派权重），写文案时从这里挑人
  const shortlist = spec.pool
    .filter((p) => !used.has(p.base) && !GLOBAL_EXCLUDE.includes(p.name))
    .sort((a, b) => spec.weightTags(b) - spec.weightTags(a) || b.total - a.total)
    .slice(0, 18);
  console.log('   候选池前 8：' + shortlist.slice(0, 8).map((p) => `${p.name}(${p.total})`).join('、'));

  const pick = ranked[0];
  if (!pick || !pick.validTeam) {
    if (pick) {
      console.log('   !! 无满足约束的候选；最接近的一队（违反 ' + pick.e.sharedWeakCount + ' 项共同弱点）：' + pick.team.map((p) => p.name).join('/'));
    } else {
      console.log('   !! 无满足约束的候选');
    }
    continue;
  }
  for (const p of pick.team) used.add(p.base);
  chosen.push({ spec, team: pick.team, e: pick.e, score: pick.score, candidates: ranked });
  (spec as unknown as { shortlist?: Profile[] }).shortlist = shortlist;
}

const report = {
  generatedAt: new Date().toISOString(),
  spiritCount: spirits.length,
  typeOrder: TYPE_ORDER,
  chosen: chosen.map(({ spec, team, e, score, candidates }) => ({
    id: spec.id,
    goal: spec.goal,
    score: Math.round(score * 10) / 10,
    eval: e,
    members: team.map(serialize),
    candidates: candidates.slice(0, 4).map((c) => ({
      score: Math.round(c.score * 10) / 10,
      coverage: c.e.coverage,
      sharedWeakCount: c.e.sharedWeakCount,
      coveredSpots: c.e.coveredSpots,
      weakSpots: c.e.weakSpots,
      avgTotal: c.e.avgTotal,
      members: c.team.map((p) => ({
        id: p.spirit.id,
        name: p.name,
        types: p.types,
        total: p.total,
        spe: p.stats.spe,
        trait: p.traitText,
        tags: [...p.traitTags].map((t) => `特性:${t}`).concat([...p.skillTags].map((t) => `技能:${t}`)),
      })),
    })),
  })),
};

function serialize(p: Profile) {
  return {
    id: p.spirit.id,
    name: p.name,
    types: p.types,
    total: p.total,
    stats: p.spirit.stats,
    trait: p.spirit.trait,
    traitTags: [...p.traitTags],
    skillTags: [...p.skillTags],
    roles: roleOf(p),
    weak: p.weak,
    resist: p.resist,
    coverageTypes: TYPE_ORDER.filter((_, i) => p.coverage & (1 << i)),
    maxPower: p.maxPowerSkill
      ? { name: p.maxPowerSkill.name, type: p.maxPowerSkill.type, power: p.maxPowerSkill.power, energy: p.maxPowerSkill.energy, effect: p.maxPowerSkill.effect }
      : null,
    heavy: p.heavy.slice(0, 4).map((s) => ({ name: s.name, type: s.type, power: s.power, energy: s.energy, effect: s.effect })),
    keySkills: p.keySkills.map((s) => ({
      name: s.name,
      type: s.type,
      category: s.category,
      power: s.power,
      energy: s.energy,
      effect: s.effect,
    })),
  };
}

/* markdown */
const md: string[] = [];
md.push('# 跨属性自由混搭阵容 · 全图鉴量化筛选');
md.push('');
md.push(`精灵形态 ${spirits.length} 只 · 18 系 · 机制标签由特性/技能原文关键词生成`);
md.push('');
md.push('> 挑选顺序：广域互补 → 火草 → 地武 → 偷能量 → 吸血 → 消耗；已入选的精灵不会在后续队伍里重复出现。');
md.push('');
for (const { spec, team, e, score, candidates } of chosen) {
  const shortlist = (spec as unknown as { shortlist?: Profile[] }).shortlist ?? [];
  md.push(`# ${spec.id}｜${spec.goal}`);
  md.push('');
  md.push(
    `**入选队** score ${score.toFixed(1)}｜覆盖 ${e.coverage}/18（${e.coverageTypes.join('、')}）｜共同弱点 ${e.sharedWeakCount}${e.sharedWeak.length ? `（${e.sharedWeak.map((w) => `${w.type}×${w.count}`).join('、')}）` : ''}｜弱点被队友接住 ${e.coveredSpots}/${e.weakSpots}${e.allCovered ? '（全覆盖 ✓）' : ''}｜平均 ${e.avgTotal}｜最快 ${e.fastest}｜属性 ${e.distinctTypes} 种｜分工 ${e.roles.join('/')}`,
  );
  md.push('');
  md.push('| 精灵 | 属性 | 总/速 | 特性 | 角色 | 机制标签 |');
  md.push('| --- | --- | --- | --- | --- | --- |');
  for (const p of team) {
    md.push(
      `| ${p.name} | ${p.types.join('/')} | ${p.total}/${p.stats.spe} | ${p.traitText} | ${roleOf(p).join('/')} | 特性:${[...p.traitTags].join(',') || '—'} 技能:${[...p.skillTags].join(',') || '—'} |`,
    );
  }
  md.push('');
  for (const p of team) {
    md.push(`### ${p.name}（${p.types.join('/')}）总数 ${p.total}｜速度 ${p.stats.spe}｜物攻 ${p.stats.atk}／魔攻 ${p.stats.spa}｜物防 ${p.stats.def}／魔防 ${p.stats.spd}／生命 ${p.stats.hp}`);
    md.push(`- 特性：${p.traitText || '无'}`);
    md.push(`- 弱点 ${p.weak.join('、') || '无'}｜抗性 ${p.resist.join('、') || '无'}｜能打出 2 倍的属性：${TYPE_ORDER.filter((_, i) => p.coverage & (1 << i)).join('、')}`);
    if (p.maxPowerSkill) md.push(`- 最高单发：${p.maxPowerSkill.name}（${p.maxPowerSkill.type}·${p.maxPowerSkill.category}·威力${p.maxPowerSkill.power}·能耗${p.maxPowerSkill.energy}）：${p.maxPowerSkill.effect}`);
    for (const s of p.heavy) if (s.name !== p.maxPowerSkill?.name) md.push(`- 高能耗重炮：${s.name}（${s.type}·威力${s.power}·能耗${s.energy}）：${s.effect}`);
    md.push(`- 学习面里符合机制的技能：`);
    for (const s of p.keySkills) md.push(`  - ${s.name}（${s.type}·${s.category}·威力${s.power ?? '—'}·能耗${s.energy ?? '—'}）：${s.effect}`);
    for (const hit of p.tagHits) if (hit.startsWith('特性')) md.push(`- ${hit}`);
    md.push('');
  }
  md.push('**该流派候选池前 18（按流派权重）**：');
  for (const p of shortlist) {
    md.push(`- ${p.name}（${p.types.join('/')} 总${p.total} 速${p.stats.spe}）｜${p.traitText}｜特性标签 ${[...p.traitTags].join(',') || '—'}`);
  }
  md.push('');
  md.push('**其他候选**：');
  for (const c of candidates.slice(1, 4)) {
    md.push(
      `- score ${c.score.toFixed(1)}｜覆盖 ${c.e.coverage}｜共同弱点 ${c.e.sharedWeakCount}｜接住 ${c.e.coveredSpots}/${c.e.weakSpots}｜${c.team.map((p) => `${p.name}(${p.types.join('/')})`).join('、')}`,
    );
  }
  md.push('');
  md.push('---');
  md.push('');
}

md.push('# 最终发布的六套混搭队（按同一评估函数复算）', '');
for (const { preset, team, e } of finalTeams) {
  md.push(
    `## ${preset.name}（${preset.id}）`,
    '',
    `- 覆盖 **${e.coverage}/18**（${e.coverageTypes.join('、')}）｜共同弱点 **${e.sharedWeakCount}**${e.sharedWeak.length ? `（${e.sharedWeak.map((w) => `${w.type}×${w.count}`).join('、')}）` : ''}｜弱点被队友接住 **${e.coveredSpots}/${e.weakSpots}**${e.allCovered ? '（全覆盖 ✓）' : ''}`,
    `- 平均种族值 ${e.avgTotal}｜最快速度 ${e.fastest}｜属性 ${e.distinctTypes} 种｜角色维度 ${e.roles.join('/')}`,
    `- 成员：${team.map((p) => `${p.name}（${p.types.join('/')}）`).join('、')}`,
    '',
  );
}

const finalOut = finalTeams.map(({ preset, team, e }) => ({
  id: preset.id,
  name: preset.name,
  eval: e,
  members: team.map(serialize),
}));

fs.mkdirSync('.cache', { recursive: true });
fs.writeFileSync('.cache/mixed-screening.json', JSON.stringify({ ...report, finalTeams: finalOut }, null, 1));
fs.writeFileSync('.cache/mixed-screening.md', md.join('\n'));
console.log('\nwrote .cache/mixed-screening.json / .cache/mixed-screening.md');
