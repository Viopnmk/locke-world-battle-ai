/**
 * 48 小时自动轮换阵容引擎
 *
 *   npm run rotate:teams            # 生成下一轮（3 套全新阵容）并写回 src/data
 *   npm run rotate:teams -- --if-due   # 定时任务用：没到 nextRotationAt 就什么都不做
 *   npm run rotate:teams -- --dry      # 只打印候选，不写文件
 *   npm run rotate:teams -- --refresh  # 只重写当前轮的战术手册（起手/4 技能/联动/5 阶段），阵容与时间不变
 *
 * 输入只有 src/data 里的真实数据：spirits.json（662 只形态）、skills.json（599 个技能）、
 * learnsets.json（可学记录）、type-chart.json（18 系倍率）。输出：
 *   src/data/team-rotation.json     当前这一轮的 3 套阵容（页面直接读它）
 *   src/data/rotation-history.json  每一轮的战术原型与 18 个 spiritId（下一轮据此去重）
 *
 * 文案口径：特性原文照抄、技能名称/属性/威力/能耗/效果全部来自图鉴，数字现算。
 * 不写图鉴里没有的机制，也不为了「不一样」而牺牲强度。
 */
import fs from 'node:fs';
import path from 'node:path';
import { bestHit } from '../src/lib/analysis';
import { equippableSkills } from '../src/lib/equip-rules';
import { meta, skillsOf, spirits } from '../src/lib/spirits';
import { matchup, TYPE_ORDER } from '../src/lib/typeChart';
import type {
  BattlePhase,
  ChainStep,
  LeadPlan,
  PresetMember,
  PresetSkillRef,
  SkillSynergy,
  RotationHistoryFile,
  RotationRoundMeta,
  TeamCategory,
  TeamPreset,
  TeamRotationFile,
} from '../src/lib/team-types';
import type { ResolvedSkill, Spirit } from '../src/lib/types';

/* ------------------------------------------------------------------ 基础工具 */

const ROOT = process.cwd();
const DATA_DIR = path.join(ROOT, 'src/data');
const ROTATION_PATH = path.join(DATA_DIR, 'team-rotation.json');
const HISTORY_PATH = path.join(DATA_DIR, 'rotation-history.json');
const INTERVAL_HOURS = 48;
const TZ_OFFSET_MINUTES = 8 * 60; // Asia/Shanghai

const round1 = (n: number) => Math.round(n * 10) / 10;
const mean = (arr: number[]) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0);
const shortName = (name: string) => name.replace(/（[^）]*）/g, '');
const baseName = (name: string) => name.replace(/（[^）]*）/g, '');
const TI = new Map(TYPE_ORDER.map((t, i) => [t, i]));

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function popcount(mask: number): number {
  let c = 0;
  let m = mask;
  while (m) {
    m &= m - 1;
    c += 1;
  }
  return c;
}

/** 北京时间 ISO 字符串：2026-11-19T11:40:00+08:00 */
function beijingIso(date: Date): string {
  const shifted = new Date(date.getTime() + TZ_OFFSET_MINUTES * 60 * 1000);
  const p = (n: number) => String(n).padStart(2, '0');
  return (
    `${shifted.getUTCFullYear()}-${p(shifted.getUTCMonth() + 1)}-${p(shifted.getUTCDate())}` +
    `T${p(shifted.getUTCHours())}:${p(shifted.getUTCMinutes())}:${p(shifted.getUTCSeconds())}+08:00`
  );
}

function isDamaging(sk: ResolvedSkill): boolean {
  return typeof sk.power === 'number' && sk.power > 0 && Boolean(sk.type);
}

/** 技能简写：名称（属性·类别·威力·能耗） */
function skillTag(sk: ResolvedSkill): string {
  const bits = [sk.type, sk.category];
  if (sk.power) bits.push(`威力${sk.power}`);
  if (typeof sk.energy === 'number') bits.push(`能耗${sk.energy}`);
  return `${sk.name}（${bits.join('·')}）`;
}

/** 技能效果原文摘要：优先在第一个句号/分号处截断，避免长句撑爆卡片 */
function effectBrief(text: string | null | undefined, max = 58): string {
  const t = (text ?? '').replace(/\s+/g, '');
  if (!t) return '';
  const cut = t.search(/[。；]/);
  if (cut > 0 && cut <= max) return t.slice(0, cut + 1);
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

/** 嵌在句子里用的效果文本：去掉句尾标点，避免出现「。。」「。，」 */
function effectCore(text: string | null | undefined, max = 58): string {
  return effectBrief(text, max).replace(/[。；]+$/, '');
}

/** 真正的蓄力技：效果以「蓄力，」开头；「无需蓄力 / 蓄力状态」这类描述不算 */
function isChargeSkill(sk: ResolvedSkill): boolean {
  const eff = sk.effect ?? '';
  return /蓄力/.test(eff) && !/无需蓄力|蓄力状态|蓄力时|蓄力中|任意方式蓄力/.test(eff);
}

/** 名字列表：「A、B、C」（数量超过 limit 时补「等 N 只」） */
function joinNames(list: string[], limit = 3): string {
  if (!list.length) return '无';
  const shown = list.slice(0, limit).join('、');
  return list.length > limit ? `${shown} 等 ${list.length} 只` : shown;
}

/** 属性列表：「A、B、C」（量词用「种」） */
function joinTypes(list: string[], limit = 5): string {
  if (!list.length) return '无';
  const shown = list.slice(0, limit).join('、');
  return list.length > limit ? `${shown} 等 ${list.length} 种` : shown;
}

/* ------------------------------------------------------------------ 机制标签 */

const MECH: { tag: string; label: string; test: RegExp }[] = [
  { tag: 'steal', label: '偷能量', test: /偷取[^。；]{0,6}能量/ },
  { tag: 'tax', label: '抬能耗', test: /全技能能耗\+|失去能耗之差|敌方失去\d+能量/ },
  { tag: 'leech', label: '吸血', test: /吸血/ },
  { tag: 'burn', label: '灼烧', test: /灼烧/ },
  { tag: 'poison', label: '中毒', test: /中毒/ },
  { tag: 'freeze', label: '冻结', test: /冻结/ },
  { tag: 'switch', label: '换人惩罚', test: /敌方精灵离场后|本回合更换精灵|更换入场的精灵/ },
  { tag: 'comeback', label: '残血反打', test: /生命低于\d+%|受到致命伤害|力竭/ },
  { tag: 'sustain', label: '回复续航', test: /回复[^。；]{0,6}生命|回复等量生命|回复\d+%生命/ },
  { tag: 'charge', label: '蓄力', test: /蓄力/ },
  { tag: 'weather', label: '天气', test: /天气/ },
  { tag: 'starmark', label: '星陨印记', test: /星陨/ },
  { tag: 'priority', label: '先手', test: /先手\+\d|迅捷/ },
];

const MECH_LABEL = new Map(MECH.map((m) => [m.tag, m.label]));
const CONTROL_TAGS = ['tax', 'steal', 'switch', 'burn', 'poison', 'freeze'];
const STATUS_TAGS = ['burn', 'poison', 'freeze'];

/* ------------------------------------------------------------------ 精灵画像 */

interface Profile {
  spirit: Spirit;
  id: string;
  name: string;
  base: string;
  types: string[];
  total: number;
  stats: { hp: number; atk: number; def: number; spa: number; spd: number; spe: number };
  bulk: number;
  mainAtk: number;
  mainIsPhysical: boolean;
  coverage: number;
  coverageTypes: string[];
  defMul: number[];
  weak: string[];
  resist: string[];
  maxPower: number;
  maxPowerSkill: ResolvedSkill | null;
  avgEnergy: number;
  traitText: string;
  traitTags: Set<string>;
  skillTags: Set<string>;
  tags: Set<string>;
  keySkills: ResolvedSkill[];
  prioritySkills: ResolvedSkill[];
  supportSkills: ResolvedSkill[];
}

function damagers(p: Spirit): ResolvedSkill[] {
  return skillsOf(p)
    .filter((s) => isDamaging(s) && !/使用后消耗全部生命/.test(s.effect ?? ''))
    .sort((a, b) => (b.power ?? 0) - (a.power ?? 0) || (a.energy ?? 99) - (b.energy ?? 99));
}

function buildProfile(spirit: Spirit): Profile {
  const skills = skillsOf(spirit);
  const dmg = damagers(spirit);
  const defMul = TYPE_ORDER.map((atk) => matchup(atk, spirit.type).multiplier);
  const weak = TYPE_ORDER.filter((_, i) => defMul[i] > 1);
  const resist = TYPE_ORDER.filter((_, i) => defMul[i] < 1);

  const coverage = TYPE_ORDER.reduce((mask, t, i) => {
    const hit = bestHit(spirit, [t]).multiplier >= 2;
    return hit ? mask | (1 << i) : mask;
  }, 0);

  const trait = spirit.trait;
  const traitText = trait ? `${trait.name}：${trait.effect}` : '';
  const traitTags = new Set<string>();
  const skillTags = new Set<string>();
  for (const rule of MECH) {
    if (traitText && rule.test.test(traitText)) traitTags.add(rule.tag);
  }
  for (const sk of skills) {
    const text = sk.effect ?? '';
    if (!text) continue;
    for (const rule of MECH) if (rule.test.test(text)) skillTags.add(rule.tag);
  }

  const tags = new Set<string>([...traitTags, ...skillTags]);
  if (dmg.some((s) => (s.power ?? 0) >= 150)) tags.add('nuke');
  if ((spirit.stats.spe ?? 0) >= 120) tags.add('fast');
  const bulk = (spirit.stats.hp ?? 0) + (spirit.stats.def ?? 0) + (spirit.stats.spd ?? 0);
  if (bulk >= 330) tags.add('bulk');

  const atk = spirit.stats.atk ?? 0;
  const spa = spirit.stats.spa ?? 0;
  const mainIsPhysical = atk >= spa;
  const keySkills = [...skills]
    .filter((s) => MECH.some((r) => r.test.test(s.effect ?? '')) || (s.power ?? 0) >= 130)
    .sort((a, b) => (b.power ?? 0) - (a.power ?? 0) || (a.energy ?? 99) - (b.energy ?? 99))
    .slice(0, 14);

  const prioritySkills = dmg
    .filter((s) => /先手\+\d|迅捷/.test(s.effect ?? ''))
    .sort((a, b) => (b.power ?? 0) - (a.power ?? 0));
  const supportSkills = skills
    .filter((s) => !isDamaging(s) && Boolean(s.effect))
    .sort((a, b) => (a.energy ?? 99) - (b.energy ?? 99));

  return {
    spirit,
    id: spirit.id,
    name: spirit.name,
    base: baseName(spirit.name),
    types: spirit.type,
    total: spirit.stats.total ?? 0,
    stats: {
      hp: spirit.stats.hp ?? 0,
      atk,
      def: spirit.stats.def ?? 0,
      spa,
      spd: spirit.stats.spd ?? 0,
      spe: spirit.stats.spe ?? 0,
    },
    bulk,
    mainAtk: Math.max(atk, spa),
    mainIsPhysical,
    coverage,
    coverageTypes: TYPE_ORDER.filter((_, i) => coverage & (1 << i)),
    defMul,
    weak,
    resist,
    maxPower: dmg[0]?.power ?? 0,
    maxPowerSkill: dmg[0] ?? null,
    avgEnergy: dmg.length ? mean(dmg.slice(0, 3).map((s) => s.energy ?? 0)) : 0,
    traitText,
    traitTags,
    skillTags,
    tags,
    keySkills,
    prioritySkills,
    supportSkills,
  };
}

const PROFILES = spirits
  .filter((s) => (s.stats.total ?? 0) > 0)
  .map(buildProfile);
const BY_ID = new Map(PROFILES.map((p) => [p.id, p]));

/** 全图鉴通用的技能石杂食者，属性面板好看但没有专属机制，筛选时排除 */
const GLOBAL_EXCLUDE = new Set(['学院呱呱']);

/* ------------------------------------------------------------------ 队伍评估 */

interface Eval {
  coverage: number;
  coverageTypes: string[];
  sharedWeak: { type: string; count: number; members: string[]; maxMul: number }[];
  sharedWeakCount: number;
  /** 单一属性最多能克制队里几只（5 只以上视为结构性问题） */
  worstWeakCount: number;
  sharedResist: { type: string; count: number }[];
  weakSpots: number;
  coveredSpots: number;
  allCovered: boolean;
  avgTotal: number;
  maxTotal: { name: string; total: number } | null;
  avgTopPower: number;
  fastest: { name: string; spe: number } | null;
  slowest: { name: string; spe: number } | null;
  fastCount: number;
  midCount: number;
  distinctTypes: number;
  avgBulk: number;
  avgTopEnergy: number;
  tagScore: number;
}

function controlScore(p: Profile): number {
  return CONTROL_TAGS.reduce((acc, t) => acc + (p.traitTags.has(t) ? 2 : 0) + (p.skillTags.has(t) ? 1 : 0), 0);
}

function supportScore(p: Profile): number {
  let s = 0;
  if (p.traitTags.has('sustain')) s += 2;
  if (p.traitTags.has('leech')) s += 2;
  if (p.skillTags.has('sustain')) s += 1;
  s += p.supportSkills.filter((sk) => /回复|减\u4f24|护盾|提升|清除|免疫/.test(sk.effect ?? '')).length * 0.4;
  return s;
}

function evaluate(team: Profile[], weight: (p: Profile) => number): Eval {
  let coverage = 0;
  let total = 0;
  let bulk = 0;
  let power = 0;
  let energy = 0;
  let powerCount = 0;
  let fastest: { name: string; spe: number } | null = null;
  let slowest: { name: string; spe: number } | null = null;
  let maxTotal: { name: string; total: number } | null = null;
  const typeSet = new Set<string>();
  let tagScore = 0;

  for (const p of team) {
    coverage |= p.coverage;
    total += p.total;
    bulk += p.bulk;
    if (p.maxPowerSkill) {
      power += p.maxPower;
      energy += p.maxPowerSkill.energy ?? 0;
      powerCount += 1;
    }
    if (!fastest || p.stats.spe > fastest.spe) fastest = { name: p.name, spe: p.stats.spe };
    if (!slowest || p.stats.spe < slowest.spe) slowest = { name: p.name, spe: p.stats.spe };
    if (!maxTotal || p.total > maxTotal.total) maxTotal = { name: p.name, total: p.total };
    for (const t of p.types) typeSet.add(t);
    tagScore += weight(p);
  }

  const sharedWeak: Eval['sharedWeak'] = [];
  for (let i = 0; i < TYPE_ORDER.length; i += 1) {
    const members = team.filter((p) => p.defMul[i] >= 2);
    if (members.length >= 2) {
      sharedWeak.push({
        type: TYPE_ORDER[i],
        count: members.length,
        members: members.map((p) => p.name),
        maxMul: Math.max(...members.map((p) => p.defMul[i])),
      });
    }
  }
  sharedWeak.sort((a, b) => b.count - a.count || b.maxMul - a.maxMul);

  const sharedResist: Eval['sharedResist'] = [];
  for (let i = 0; i < TYPE_ORDER.length; i += 1) {
    const count = team.filter((p) => p.defMul[i] <= 0.5).length;
    if (count >= 2) sharedResist.push({ type: TYPE_ORDER[i], count });
  }
  sharedResist.sort((a, b) => b.count - a.count);

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
    worstWeakCount: sharedWeak.length ? Math.max(...sharedWeak.map((w) => w.count)) : 0,
    sharedResist,
    weakSpots,
    coveredSpots,
    allCovered: weakSpots > 0 && coveredSpots === weakSpots,
    avgTotal: team.length ? round1(total / team.length) : 0,
    maxTotal,
    avgTopPower: powerCount ? Math.round(power / powerCount) : 0,
    fastest,
    slowest,
    fastCount: team.filter((p) => p.stats.spe >= 120).length,
    midCount: team.filter((p) => p.stats.spe >= 100 && p.stats.spe < 120).length,
    distinctTypes: typeSet.size,
    avgBulk: team.length ? Math.round(bulk / team.length) : 0,
    avgTopEnergy: powerCount ? round1(energy / powerCount) : 0,
    tagScore,
  };
}

/* ------------------------------------------------------------------ 角色分工 */

const ROLE_ORDER = ['先手', '核心输出', '承伤', '控制', '辅助', '收割'] as const;
/** 卡片里的阅读顺序：谁先上场 → 谁控场 → 谁输出 → 谁续航 → 谁承伤 → 谁收尾 */
const CHAIN_ORDER = ['先手', '控制', '核心输出', '辅助', '承伤', '收割'] as const;
type RoleName = (typeof ROLE_ORDER)[number];

function roleFit(p: Profile, role: RoleName): number {
  switch (role) {
    case '先手':
      return Math.max(0, p.stats.spe - 100) / 3 + (p.prioritySkills.length ? 2 : 0);
    case '核心输出':
      return p.maxPower / 25 + p.mainAtk / 40;
    case '承伤':
      return Math.max(0, p.bulk - 260) / 12;
    case '控制':
      return controlScore(p) * 1.6;
    case '辅助':
      return supportScore(p) * 1.4;
    case '收割':
      // 收割要「跑得动」：速度 110 以上才谈得上收残，除非特性本身是残血反打
      return (
        (p.traitTags.has('comeback') ? 3 : 0) +
        (p.stats.spe >= 110
          ? (p.stats.spe - 105) / 6 + (p.maxPower >= 140 ? p.maxPower / 90 : 0)
          : 0)
      );
    default:
      return 0;
  }
}

/** 六个角色各派一只；先把最贴合的那只填给每个角色，保证每个标签都不是空话。 */
function assignRoles(team: Profile[]): Map<string, RoleName> {
  const assigned = new Map<string, RoleName>();
  const taken = new Set<string>();
  for (const role of ROLE_ORDER) {
    const best = [...team]
      .filter((p) => !taken.has(p.id))
      .map((p) => ({ p, fit: roleFit(p, role) }))
      .sort((a, b) => b.fit - a.fit || b.p.total - a.p.total)[0];
    // 贴合度太低就不硬派：宁可这个角色缺席（会被判为不合格），也不写一句空话
    if (!best || best.fit < 0.8) continue;
    assigned.set(best.p.id, role);
    taken.add(best.p.id);
  }
  return assigned;
}

/** 展示用的最优分工：6! = 720 种排法里取「贴合度总和」最高的一种，避免核心输出把唯一的坦克抢走 */
function bestAssignment(team: Profile[]): Map<string, RoleName> {
  const ids = team.map((p) => p.id);
  const fit = team.map((p) => ROLE_ORDER.map((role) => Math.max(0, roleFit(p, role))));
  let bestScore = -Infinity;
  let best: number[] | null = null;
  const order = [0, 1, 2, 3, 4, 5];
  const perm = (arr: number[], start: number) => {
    if (start === arr.length) {
      let score = 0;
      for (let i = 0; i < arr.length; i += 1) {
        const f = fit[i][arr[i]];
        // 贴合度为 0 的角色等于空话，重罚
        score += f > 0.8 ? f : -50;
      }
      if (score > bestScore) {
        bestScore = score;
        best = [...arr];
      }
      return;
    }
    for (let i = start; i < arr.length; i += 1) {
      [arr[start], arr[i]] = [arr[i], arr[start]];
      perm(arr, start + 1);
      [arr[start], arr[i]] = [arr[i], arr[start]];
    }
  };
  perm(order, 0);
  const assigned = new Map<string, RoleName>();
  if (!best) return assigned;
  for (let i = 0; i < ids.length; i += 1) assigned.set(ids[i], ROLE_ORDER[best[i]]);
  return assigned;
}

function missingRoles(team: Profile[]): number {
  const used = new Set(assignRoles(team).values());
  return ROLE_ORDER.filter((role) => !used.has(role)).length;
}

/* ------------------------------------------------------------------ 战术原型 */

interface Arch {
  id: string;
  label: string;
  short: string;
  category: TeamCategory;
  tagline: string;
  pool: (p: Profile) => boolean;
  weight: (p: Profile) => number;
  score: (e: Eval, team: Profile[]) => number;
  violations: (team: Profile[], e: Eval) => number;
  valid: (team: Profile[], e: Eval) => boolean;
  restarts?: number;
  /** 必须包含的成员（天气手等），由本轮种子决定 */
  preselect?: (rand: () => number) => Profile[];
  /** 本轮专属数据：天气名、纯属性系别 */
  monoType?: string;
  weather?: string;
  /** 至少几种属性 */
  minDistinctTypes?: number;
}

const traitWeight = (p: Profile, tags: string[], w: number) =>
  tags.reduce((acc, t) => acc + (p.traitTags.has(t) ? w : 0), 0);
const skillWeight = (p: Profile, tags: string[], w: number) =>
  tags.reduce((acc, t) => acc + (p.skillTags.has(t) ? w : 0), 0);

const roleArmor = (team: Profile[]) => (missingRoles(team) === 0 ? 0 : missingRoles(team));

const BASE_ARCHETYPES: Arch[] = [
  {
    id: 'rush',
    label: '高速爆发',
    short: '高速队',
    category: 'rush',
    tagline: '速度压制 · 先手爆发',
    pool: (p) => p.stats.spe >= 108 && p.maxPower >= 110,
    weight: (p) =>
      Math.max(0, p.stats.spe - 95) * 1.6 +
      p.maxPower * 0.55 +
      (p.prioritySkills.length ? 14 : 0) +
      p.total / 24,
    score: (e) =>
      e.fastCount * 12 +
      (e.fastest?.spe ?? 0) * 0.6 +
      e.coverage * 1.6 -
      e.sharedWeakCount * 7 +
      (e.coveredSpots / Math.max(1, e.weakSpots)) * 24 +
      e.avgTotal / 12,
    violations: (team, e) =>
      (team.filter((p) => p.stats.spe >= 120).length >= 3 ? 0 : 1) +
      (e.avgTopPower >= 125 ? 0 : 1) +
      (e.coverage >= 12 ? 0 : 1) +
      (e.sharedWeakCount <= 4 ? 0 : 1) +
      roleArmor(team),
    valid: (team, e) =>
      team.filter((p) => p.stats.spe >= 120).length >= 3 &&
      e.avgTopPower >= 125 &&
      e.coverage >= 12 &&
      e.sharedWeakCount <= 4 &&
      missingRoles(team) === 0,
    restarts: 10,
  },
  {
    id: 'nuke',
    label: '重炮强攻',
    short: '重炮队',
    category: 'nuke',
    tagline: '高威力单发 · 正面换血',
    pool: (p) => p.maxPower >= 150,
    weight: (p) => p.maxPower * 1.1 + p.mainAtk * 0.6 + p.total / 26 + Math.max(0, p.bulk - 280) / 16,
    score: (e) =>
      e.avgTopPower * 2.2 +
      e.avgTotal / 8 +
      e.coverage * 1.6 -
      e.sharedWeakCount * 7 +
      (e.coveredSpots / Math.max(1, e.weakSpots)) * 18,
    violations: (team, e) =>
      (team.filter((p) => p.maxPower >= 160).length >= 3 ? 0 : 1) +
      (e.avgTotal >= 550 ? 0 : 1) +
      (e.coverage >= 12 ? 0 : 1) +
      (e.avgTopPower >= 150 ? 0 : 1) +
      (e.sharedWeakCount <= 4 ? 0 : 1) +
      roleArmor(team),
    valid: (team, e) =>
      team.filter((p) => p.maxPower >= 160).length >= 3 &&
      e.avgTotal >= 550 &&
      e.coverage >= 12 &&
      e.avgTopPower >= 150 &&
      e.sharedWeakCount <= 4 &&
      missingRoles(team) === 0,
    restarts: 10,
  },
  {
    id: 'wall',
    label: '联防反击',
    short: '联防队',
    category: 'wall',
    tagline: '弱点互补 · 换人反击',
    pool: (p) => p.bulk >= 280,
    weight: (p) =>
      p.bulk / 10 +
      (p.traitTags.has('comeback') ? 22 : 0) +
      p.coverage * 2 +
      p.total / 28,
    score: (e) =>
      (e.coveredSpots / Math.max(1, e.weakSpots)) * 55 -
      e.sharedWeakCount * 9 +
      e.avgBulk / 6 +
      e.coverage * 2.2 +
      e.avgTotal / 14,
    violations: (team, e) =>
      (e.coveredSpots === e.weakSpots ? 0 : 1) +
      (e.sharedWeakCount <= 2 ? 0 : 1) +
      (e.coverage >= 13 ? 0 : 1) +
      (team.filter((p) => p.bulk >= 330).length >= 2 ? 0 : 1) +
      (team.filter((p) => p.traitTags.has('comeback')).length >= 1 ? 0 : 1) +
      roleArmor(team),
    valid: (team, e) =>
      e.coveredSpots === e.weakSpots &&
      e.sharedWeakCount <= 2 &&
      e.coverage >= 13 &&
      team.filter((p) => p.bulk >= 330).length >= 2 &&
      team.filter((p) => p.traitTags.has('comeback')).length >= 1 &&
      missingRoles(team) === 0,
    restarts: 12,
  },
  {
    id: 'cover18',
    label: '跨属性互补',
    short: '十八系互补队',
    category: 'mixed',
    tagline: '18 系打击面 · 弱点互接',
    pool: (p) => p.coverage >= 8,
    weight: (p) => p.coverage * 3 + p.total / 24 + p.maxPower * 0.2,
    score: (e) =>
      e.coverage * 16 -
      e.sharedWeakCount * 10 +
      (e.coveredSpots / Math.max(1, e.weakSpots)) * 30 +
      (e.allCovered ? 20 : 0) +
      e.distinctTypes * 3 +
      e.avgTotal / 20,
    violations: (team, e) =>
      (e.coverage >= 17 ? 0 : 1) +
      (e.sharedWeakCount <= 2 ? 0 : 1) +
      (e.coveredSpots === e.weakSpots ? 0 : 1) +
      (e.distinctTypes >= 6 ? 0 : 1) +
      roleArmor(team),
    valid: (team, e) =>
      e.coverage >= 17 &&
      e.sharedWeakCount <= 2 &&
      e.coveredSpots === e.weakSpots &&
      e.distinctTypes >= 6 &&
      missingRoles(team) === 0,
    restarts: 16,
    minDistinctTypes: 6,
  },
  {
    id: 'drain',
    label: '抽能压制',
    short: '抽能队',
    category: 'tax',
    tagline: '偷能量 · 抬能耗 · 重炮收场',
    pool: (p) =>
      p.traitTags.has('steal') ||
      p.traitTags.has('tax') ||
      p.skillTags.has('steal') ||
      p.skillTags.has('tax') ||
      p.maxPower >= 160,
    weight: (p) =>
      traitWeight(p, ['steal', 'tax'], 20) +
      skillWeight(p, ['steal', 'tax'], 5) +
      (p.maxPower >= 150 ? 10 : 0) +
      Math.max(0, p.bulk - 260) / 18 +
      p.total / 32,
    score: (e, team) =>
      e.tagScore * 1.3 +
      e.coverage * 2.4 -
      e.sharedWeakCount * 9 +
      (e.coveredSpots / Math.max(1, e.weakSpots)) * 20 +
      e.avgTopPower * 0.6 +
      team.filter((p) => p.maxPower >= 150).length * 6,
    violations: (team, e) =>
      (team.filter((p) => p.traitTags.has('tax') || p.traitTags.has('steal')).length >= 2 ? 0 : 1) +
      (team.filter((p) => p.maxPower >= 150).length >= 2 ? 0 : 1) +
      (e.coverage >= 13 ? 0 : 1) +
      (e.sharedWeakCount <= 3 ? 0 : 1) +
      roleArmor(team),
    valid: (team, e) =>
      team.filter((p) => p.traitTags.has('tax') || p.traitTags.has('steal')).length >= 2 &&
      team.filter((p) => p.maxPower >= 150).length >= 2 &&
      e.coverage >= 13 &&
      e.sharedWeakCount <= 3 &&
      missingRoles(team) === 0,
    restarts: 12,
  },
  {
    id: 'leech',
    label: '吸血续航',
    short: '吸血队',
    category: 'sustain',
    tagline: '伤害换血 · 越打越厚',
    pool: (p) =>
      p.traitTags.has('leech') ||
      p.traitTags.has('sustain') ||
      p.traitTags.has('comeback') ||
      p.skillTags.has('leech'),
    weight: (p) =>
      traitWeight(p, ['leech'], 22) +
      traitWeight(p, ['sustain', 'comeback'], 11) +
      skillWeight(p, ['leech'], 5) +
      Math.max(0, p.bulk - 280) / 14 +
      p.total / 30,
    score: (e, team) =>
      e.tagScore * 1.2 +
      e.avgBulk / 5 +
      e.coverage * 2.6 -
      e.sharedWeakCount * 8 +
      (e.coveredSpots / Math.max(1, e.weakSpots)) * 26 +
      team.filter((p) => p.traitTags.has('comeback')).length * 4,
    violations: (team, e) =>
      (team.filter((p) => p.traitTags.has('leech') || p.skillTags.has('leech')).length >= 3 ? 0 : 1) +
      (team.filter((p) => p.traitTags.has('comeback') || p.traitTags.has('sustain')).length >= 2 ? 0 : 1) +
      (e.coverage >= 12 ? 0 : 1) +
      (e.allCovered ? 0 : 1) +
      (e.sharedWeakCount <= 4 ? 0 : 1) +
      roleArmor(team),
    valid: (team, e) =>
      team.filter((p) => p.traitTags.has('leech') || p.skillTags.has('leech')).length >= 3 &&
      team.filter((p) => p.traitTags.has('comeback') || p.traitTags.has('sustain')).length >= 2 &&
      e.coverage >= 12 &&
      e.allCovered &&
      e.sharedWeakCount <= 4 &&
      missingRoles(team) === 0,
    restarts: 14,
  },
  {
    id: 'status',
    label: '状态折磨',
    short: '折磨队',
    category: 'status',
    tagline: '灼烧 / 中毒 / 冻结叠层',
    pool: (p) => STATUS_TAGS.some((t) => p.traitTags.has(t) || p.skillTags.has(t)),
    weight: (p) =>
      STATUS_TAGS.reduce(
        (acc, t) => acc + (p.traitTags.has(t) ? 18 : 0) + (p.skillTags.has(t) ? 4 : 0),
        0,
      ) +
      Math.max(0, p.bulk - 260) / 20 +
      p.total / 34,
    score: (e, team) =>
      e.tagScore * 0.9 +
      e.coverage * 2.4 -
      e.sharedWeakCount * 8 +
      (e.coveredSpots / Math.max(1, e.weakSpots)) * 22 +
      team.filter((p) => STATUS_TAGS.some((t) => p.traitTags.has(t))).length * 8,
    violations: (team, e) =>
      (team.filter((p) => STATUS_TAGS.some((t) => p.traitTags.has(t))).length >= 2 ? 0 : 1) +
      (team.filter((p) => STATUS_TAGS.some((t) => p.tags.has(t))).length >= 4 ? 0 : 1) +
      (e.coverage >= 12 ? 0 : 1) +
      (e.sharedWeakCount <= 3 ? 0 : 1) +
      roleArmor(team),
    valid: (team, e) =>
      team.filter((p) => STATUS_TAGS.some((t) => p.traitTags.has(t))).length >= 2 &&
      team.filter((p) => STATUS_TAGS.some((t) => p.tags.has(t))).length >= 4 &&
      e.coverage >= 12 &&
      e.sharedWeakCount <= 3 &&
      missingRoles(team) === 0,
    restarts: 12,
  },
  {
    id: 'punish',
    label: '换人惩罚',
    short: '追击队',
    category: 'punish',
    tagline: '追击换人 · 越换越亏',
    pool: (p) => p.traitTags.has('switch') || p.skillTags.has('switch'),
    weight: (p) =>
      (p.traitTags.has('switch') ? 26 : 0) +
      skillWeight(p, ['switch'], 6) +
      p.maxPower * 0.4 +
      Math.max(0, p.bulk - 280) / 20 +
      p.total / 34,
    score: (e, team) =>
      e.tagScore * 1.1 +
      e.coverage * 2.4 -
      e.sharedWeakCount * 8 +
      (e.coveredSpots / Math.max(1, e.weakSpots)) * 20 +
      team.filter((p) => p.maxPower >= 140).length * 5,
    violations: (team, e) =>
      (team.filter((p) => p.traitTags.has('switch')).length >= 2 ? 0 : 1) +
      (team.filter((p) => p.maxPower >= 140).length >= 2 ? 0 : 1) +
      (e.coverage >= 12 ? 0 : 1) +
      (e.sharedWeakCount <= 3 ? 0 : 1) +
      roleArmor(team),
    valid: (team, e) =>
      team.filter((p) => p.traitTags.has('switch')).length >= 2 &&
      team.filter((p) => p.maxPower >= 140).length >= 2 &&
      e.coverage >= 12 &&
      e.sharedWeakCount <= 3 &&
      missingRoles(team) === 0,
    restarts: 12,
  },
];

/* ------------------------------------------------------------------ 天气 / 纯属性（每轮参数不同） */

const WEATHERS = ['雨天', '暴风雪', '沙暴', '雷鸣'] as const;
const WEATHER_TYPE: Record<string, string> = {
  雨天: '水',
  暴风雪: '冰',
  沙暴: '地',
  雷鸣: '电',
};

function weatherSetterSkills(p: Profile, weather: string): ResolvedSkill[] {
  return skillsOf(p.spirit).filter((sk) => (sk.effect ?? '').includes(`将天气改为${weather}`));
}

function weatherArchetype(weather: string, rand: () => number): Arch {
  const type = WEATHER_TYPE[weather];
  const setters = PROFILES.filter((p) => weatherSetterSkills(p, weather).length > 0);
  const synergy = (p: Profile) => (p.traitText ?? '').includes(weather);
  return {
    id: 'weather',
    label: `天气联动·${weather}`,
    short: `${weather}队`,
    category: 'weather',
    tagline: `${weather} · ${type}系联动`,
    weather,
    pool: (p) => weatherSetterSkills(p, weather).length > 0 || synergy(p) || p.types.includes(type),
    weight: (p) =>
      (weatherSetterSkills(p, weather).length ? 90 : 0) +
      (synergy(p) ? 40 : 0) +
      (p.types.includes(type) ? 14 : 0) +
      p.maxPower * 0.2 +
      p.total / 30,
    score: (e, team) =>
      team.filter((p) => synergy(p)).length * 14 +
      e.coverage * 2.4 -
      e.sharedWeakCount * 7 +
      (e.coveredSpots / Math.max(1, e.weakSpots)) * 18 +
      e.avgTotal / 18,
    violations: (team, e) =>
      (team.some((p) => weatherSetterSkills(p, weather).length > 0) ? 0 : 1) +
      (team.filter((p) => synergy(p)).length >= 2 ? 0 : 1) +
      (team.filter((p) => p.types.includes(type)).length >= 2 ? 0 : 1) +
      (e.coverage >= 12 ? 0 : 1) +
      (e.sharedWeakCount <= 3 ? 0 : 1) +
      roleArmor(team),
    valid: (team, e) =>
      team.some((p) => weatherSetterSkills(p, weather).length > 0) &&
      team.filter((p) => synergy(p)).length >= 2 &&
      team.filter((p) => p.types.includes(type)).length >= 2 &&
      e.coverage >= 12 &&
      e.sharedWeakCount <= 3 &&
      missingRoles(team) === 0,
    restarts: 12,
    minDistinctTypes: 4,
    preselect: () => {
      const ranked = setters
        .filter((p) => !GLOBAL_EXCLUDE.has(p.name))
        .map((p) => ({ p, w: p.total + p.maxPower + (synergy(p) ? 120 : 0) }))
        .sort((a, b) => b.w - a.w)
        .slice(0, 8);
      if (!ranked.length) return [];
      return [ranked[Math.floor(rand() * ranked.length)].p];
    },
  };
}

function monoArchetype(type: string): Arch {
  return {
    id: 'mono',
    label: `纯${type}系强攻`,
    short: `${type}系强攻队`,
    category: 'mono',
    tagline: `${type}系本系加成 · 单系压制`,
    monoType: type,
    pool: (p) => p.types.includes(type) && p.maxPower >= 120,
    weight: (p) => {
      const stab = skillsOf(p.spirit)
        .filter((sk) => sk.type === type && isDamaging(sk))
        .reduce((m, sk) => Math.max(m, sk.power ?? 0), 0);
      return stab * 0.8 + p.mainAtk * 0.3 + p.total / 26 + Math.max(0, p.bulk - 280) / 20;
    },
    score: (e, team) =>
      e.avgTopPower * 1.2 +
      e.coverage * 2.2 -
      e.sharedWeakCount * 6 +
      (e.coveredSpots / Math.max(1, e.weakSpots)) * 16 +
      e.avgTotal / 10 +
      team.filter((p) => p.types.length === 1).length * 3,
    violations: (team, e) =>
      (team.every((p) => p.types.includes(type)) ? 0 : 1) +
      (e.coverage >= 10 ? 0 : 1) +
      (e.avgTopPower >= 125 ? 0 : 1) +
      (e.coveredSpots >= Math.ceil(e.weakSpots * 0.45) ? 0 : 1) +
      roleArmor(team),
    valid: (team, e) =>
      team.every((p) => p.types.includes(type)) &&
      e.coverage >= 10 &&
      e.avgTopPower >= 125 &&
      e.coveredSpots >= Math.ceil(e.weakSpots * 0.45) &&
      missingRoles(team) === 0,
    restarts: 12,
    minDistinctTypes: 3,
  };
}

function monoCandidates(rand: () => number): string[] {
  const counts = new Map<string, number>();
  for (const p of PROFILES) {
    if (p.maxPower < 120) continue;
    for (const t of new Set(p.types)) counts.set(t, (counts.get(t) ?? 0) + 1);
  }
  const types = [...counts.entries()]
    .filter(([, n]) => n >= 12)
    .map(([t]) => t)
    .sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'));
  // 用种子洗一遍，让每轮的纯系不同
  for (let i = types.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rand() * (i + 1));
    [types[i], types[j]] = [types[j], types[i]];
  }
  return types;
}

/* ------------------------------------------------------------------ 搜索 */

interface Candidate {
  team: Profile[];
  e: Eval;
  score: number;
  bannedHits: number;
}

function shapeOk(team: Profile[], arch: Arch): boolean {
  if (team.length !== 6) return false;
  if (new Set(team.map((p) => p.base)).size !== 6) return false;
  if (arch.monoType) return team.every((p) => p.types.includes(arch.monoType));
  const allTypes = new Set(team.flatMap((p) => p.types));
  if (allTypes.size < (arch.minDistinctTypes ?? 5)) return false;
  const primary = new Map<string, number>();
  for (const p of team) primary.set(p.types[0], (primary.get(p.types[0]) ?? 0) + 1);
  if ([...primary.values()].some((n) => n >= 3)) return false;
  return true;
}

/** 全队质量底线：单一属性最多克制 4 只（纯属性队天然共享弱点，不适用） */
function weakStructureOk(e: Eval, arch: Arch): boolean {
  return Boolean(arch.monoType) || e.worstWeakCount <= 4;
}

function scoreOf(arch: Arch, team: Profile[], e: Eval, banned: Set<string>): number {
  const v = arch.violations(team, e);
  const shape = shapeOk(team, arch);
  const bannedHits = team.filter((p) => banned.has(p.base)).length;
  return (
    arch.score(e, team) -
    v * 400 -
    (shape ? 0 : 1e5) -
    (weakStructureOk(e, arch) ? 0 : 600) -
    bannedHits * 55
  );
}

function search(
  arch: Arch,
  banned: Set<string>,
  used: Set<string>,
  rand: () => number,
  allowBanned: boolean,
): Candidate[] {
  const candidatesPool = PROFILES.filter(
    (p) =>
      !used.has(p.base) &&
      !GLOBAL_EXCLUDE.has(p.name) &&
      arch.pool(p) &&
      (allowBanned || !banned.has(p.base)),
  );
  if (candidatesPool.length < 6) return [];

  const jitter = new Map<string, number>();
  for (const p of candidatesPool) jitter.set(p.id, 0.84 + rand() * 0.32);
  const weightOf = (p: Profile) => arch.weight(p) * (jitter.get(p.id) ?? 1);

  // 爬山阶段只看权重前 200 只，控制搜索时间；预选成员永远保留
  const rawPreselect = arch.preselect ? arch.preselect(rand) : [];
  const preselected = rawPreselect.filter(
    (p) =>
      !used.has(p.base) && !GLOBAL_EXCLUDE.has(p.name) && arch.pool(p) && (allowBanned || !banned.has(p.base)),
  );
  const topPool = [...candidatesPool].sort((a, b) => weightOf(b) - weightOf(a)).slice(0, 200);
  const hillPool = topPool.concat(preselected.filter((p) => !topPool.some((t) => t.id === p.id)));

  const results: Candidate[] = [];
  const seen = new Set<string>();
  const restarts = arch.restarts ?? 10;

  for (let r = 0; r < restarts; r += 1) {
    const team: Profile[] = [...preselected].slice(0, 2);
    const inTeam = new Set(team.map((p) => p.base));

    while (team.length < 6) {
      let best: Profile | null = null;
      let bestScore = -Infinity;
      let teamMask = 0;
      const teamTypes = new Set<string>();
      const teamRoles = new Set<RoleName>();
      const primaryCount = new Map<string, number>();
      for (const p of team) {
        teamMask |= p.coverage;
        for (const t of p.types) teamTypes.add(t);
        primaryCount.set(p.types[0], (primaryCount.get(p.types[0]) ?? 0) + 1);
        for (const role of ROLE_ORDER) if (roleFit(p, role) > 0.8) teamRoles.add(role);
      }
      for (const p of candidatesPool) {
        if (inTeam.has(p.base)) continue;
        const covers = popcount(teamMask | p.coverage) - popcount(teamMask);
        let newTypes = 0;
        for (const t of p.types) if (!teamTypes.has(t)) newTypes += 1;
        let newRoles = 0;
        for (const role of ROLE_ORDER) if (roleFit(p, role) > 0.8 && !teamRoles.has(role)) newRoles += 1;
        const primaryLimit = arch.monoType ? 99 : 2;
        const sameType = primaryCount.get(p.types[0]) ?? 0;
        const s =
          weightOf(p) +
          covers * 26 +
          newTypes * 10 +
          newRoles * 20 +
          (p.maxPower >= 140 ? 8 : 0) -
          (banned.has(p.base) ? 60 : 0) -
          (sameType >= primaryLimit ? 80 : 0) +
          ((jitter.get(p.id) ?? 1) - 1) * 24;
        if (s > bestScore) {
          bestScore = s;
          best = p;
        }
      }
      if (!best) break;
      team.push(best);
      inTeam.add(best.base);
    }
    if (team.length < 6) continue;

    let current = [...team];
    let e = evaluate(current, weightOf);
    let score = scoreOf(arch, current, e, banned);

    for (let pass = 0; pass < 5; pass += 1) {
      let improved = false;
      for (let slot = 0; slot < 6; slot += 1) {
        if (preselected.some((p) => p.base === current[slot].base)) continue;
        let bestSwap: Profile | null = null;
        let bestScore = score;
        let bestEval = e;
        for (const p of hillPool) {
          if (current.some((m) => m.base === p.base)) continue;
          const trial = current.map((m, i) => (i === slot ? p : m));
          if (!shapeOk(trial, arch)) continue;
          const te = evaluate(trial, weightOf);
          const s = scoreOf(arch, trial, te, banned);
          if (s > bestScore) {
            bestScore = s;
            bestSwap = p;
            bestEval = te;
          }
        }
        if (bestSwap) {
          current = current.map((m, i) => (i === slot ? bestSwap! : m));
          score = bestScore;
          e = bestEval;
          improved = true;
        }
      }
      if (!improved) break;
    }

    if (!shapeOk(current, arch)) continue;
    const key = current
      .map((p) => p.base)
      .sort()
      .join('|');
    if (seen.has(key)) continue;
    seen.add(key);
    results.push({
      team: current,
      e,
      score: Math.round(score * 10) / 10,
      bannedHits: current.filter((p) => banned.has(p.base)).length,
    });
  }

  results.sort((a, b) => b.score - a.score);
  return results;
}

/* ------------------------------------------------------------------ 文案生成 */

interface SkillPick {
  refs: PresetSkillRef[];
  primary: ResolvedSkill | null;
  /** 按推荐顺序排列的真实技能对象，供战术链引用 */
  chosen: ResolvedSkill[];
}

/** 每个角色在该队里的具体职责（角色徽章旁边那句） */
const DUTY_BY_ROLE: Record<RoleName, string> = {
  先手: '首发抢节奏',
  核心输出: '主力输出',
  控制: '控场干扰',
  辅助: '续航与增益',
  承伤: '属性联防盾',
  收割: '残局收割',
};

/** 第三格「机制位」按角色挑真实机制：只匹配技能原文，匹配不到就不硬塞 */
const ROLE_UTIL: Record<RoleName, { prefer: RegExp[]; label: string }> = {
  先手: { prefer: [/速度\+\d|迅捷/, /敌方获得速度-\d|减速/], label: '抢节奏' },
  核心输出: { prefer: [/物攻\+\d|魔攻\+\d|双攻\+\d|全技能威力\+\d|威力\+\d/], label: '开打前强化' },
  控制: {
    prefer: [/全技能能耗\+|失去\d+能量|偷取[^。；]{0,4}能量|印记|灼烧|中毒|冻结|眩晕|驱散|返场/],
    label: '压制',
  },
  辅助: {
    prefer: [
      /回复[^。；]{0,6}生命|回复\d+%生命|回复能量/,
      /护盾|免疫|清除|驱散/,
      /减伤/,
    ],
    label: '续航',
  },
  承伤: { prefer: [/减伤/, /物防\+\d|魔防\+\d|护盾|加固/], label: '减伤' },
  收割: { prefer: [/先手\+\d|迅捷/, /物攻\+\d|魔攻\+\d|全技能威力\+\d/], label: '收尾' },
};

function energyTag(sk: ResolvedSkill): string {
  return typeof sk.energy === 'number' ? `，能耗 ${sk.energy}` : '';
}

/** 输出技能的推荐理由：全部是这只精灵自己的数值 */
function damageWhy(p: Profile, sk: ResolvedSkill, main: boolean): string {
  const stab = p.types.includes(sk.type) ? '本系' : '';
  const charge = isChargeSkill(sk) ? '，蓄力技' : '';
  const hits = TYPE_ORDER.filter((t) => matchup(sk.type, [t]).multiplier >= 2);
  if (main) {
    return `${stab}${sk.category}最高威力 ${sk.power}${energyTag(sk)}${charge}${hits.length ? `，对${joinNames(hits.slice(0, 3))}系打出 ×2` : ''}`;
  }
  return hits.length
    ? `另一属性补盲：对${joinNames(hits.slice(0, 3))}系打出 ×2${energyTag(sk)}`
    : `第二个属性输出（对 18 系没有 ×2）${energyTag(sk)}`;
}

function utilWhy(sk: ResolvedSkill, role: RoleName): string {
  const eff = sk.effect ?? '';
  const label = /敌方[^。；]{0,8}回复/.test(eff)
    ? '反制'
    : /回复/.test(eff)
      ? '续航'
      : /护盾|免疫|清除|驱散/.test(eff)
        ? '解场'
        : /减伤/.test(eff)
          ? '保命'
          : ROLE_UTIL[role].label;
  return `${label}：${effectCore(eff, 52)}${energyTag(sk)}`;
}

/**
 * 每只精灵推荐 4 个真实技能：主攻 → 补盲 → 机制（按角色）→ 防守/第二个补盲。
 * 四个位置都从学习面里挑，不写图鉴没有的技能，也不编数值。
 */
function pickSkillsFor(p: Profile, role: RoleName): SkillPick {
  /* 血脉互斥（硬规则）：一只精灵只有一个血脉，学习面的 19 个血脉技能同一套配招只能带 1 个。
     equippableSkills 先把它收敛成最多 1 个，下面无论怎么挑都不会出现第二个血脉技能。 */
  const all = equippableSkills(p.spirit, skillsOf(p.spirit));
  const dmg = all
    .filter((s) => isDamaging(s) && !/使用后消耗全部生命/.test(s.effect ?? ''))
    .sort((a, b) => (b.power ?? 0) - (a.power ?? 0) || (a.energy ?? 99) - (b.energy ?? 99));
  const stab = dmg.filter((sk) => p.types.includes(sk.type));
  const mainCat = p.mainIsPhysical ? '物理' : '魔法';
  const primary =
    stab.find((sk) => sk.category === mainCat) ??
    stab[0] ??
    dmg.find((sk) => sk.category === mainCat) ??
    dmg[0] ??
    null;

  const chosen: ResolvedSkill[] = [];
  const refs: PresetSkillRef[] = [];
  const used = new Set<string>();
  const bloodUsed = () => chosen.some((sk) => sk.learn === 2);
  const add = (sk: ResolvedSkill, slot: string, why: string) => {
    if (used.has(sk.name)) return;
    if (sk.learn === 2 && bloodUsed()) return; // 硬门禁：第二个血脉技能直接拒绝
    used.add(sk.name);
    chosen.push(sk);
    refs.push({ name: sk.name, why, slot });
  };

  if (primary) add(primary, '主攻', damageWhy(p, primary, true));

  // 第二格：补打击面 —— 找能对主招打不动/打不痛的防守属性打出 2 倍的技能
  if (primary) {
    const primaryType = primary.type;
    const weakAgainst = TYPE_ORDER.filter((t) => matchup(primaryType, [t]).multiplier <= 1);
    const scored = dmg
      .filter((sk) => sk.name !== primary.name && sk.type !== primaryType)
      .map((sk) => ({
        sk,
        hits: weakAgainst.filter((t) => matchup(sk.type, [t]).multiplier >= 2),
      }))
      .filter((x) => x.hits.length > 0)
      // 补盲要能打：命中面 × 20 + 威力 × 0.6，避免为了多一个 ×2 带 20 威力的技能
      .sort(
        (a, b) =>
          (b.hits.length * 20 + (b.sk.power ?? 0) * 0.6) -
          (a.hits.length * 20 + (a.sk.power ?? 0) * 0.6),
      );
    const secondary = scored[0]?.sk ?? null;
    if (secondary) add(secondary, '补盲', damageWhy(p, secondary, false));
  }

  // 第三格：角色机制位（先手要速度、输出要强化、控制要压制、承伤要减伤…）
  const byPref = (res: RegExp[]) => {
    for (const re of res) {
      const hit = all
        .filter((sk) => {
          if (used.has(sk.name)) return false;
          const eff = sk.effect ?? '';
          // 辅助位不推荐「连对手一起回复」的技能，除非它没有别的续航手段
          if (role === '辅助' && /自己和敌方|敌方[^。；]{0,8}回复/.test(eff)) return false;
          return re.test(eff);
        })
        .sort((a, b) => (a.energy ?? 99) - (b.energy ?? 99) || (b.power ?? 0) - (a.power ?? 0))[0];
      if (hit) return hit;
    }
    return null;
  };
  const mechanic = byPref(ROLE_UTIL[role].prefer);
  if (mechanic) add(mechanic, '机制', utilWhy(mechanic, role));

  // 第四格：没有减伤就补一个减伤，否则补第二个属性输出 / 先手技
  if (!chosen.some((sk) => /减伤/.test(sk.effect ?? ''))) {
    const guard = all
      .filter((sk) => !used.has(sk.name) && /减伤\d+%/.test(sk.effect ?? ''))
      .sort((a, b) => {
        const ra = Number(/减伤(\d+)%/.exec(a.effect ?? '')?.[1] ?? 0);
        const rb = Number(/减伤(\d+)%/.exec(b.effect ?? '')?.[1] ?? 0);
        return rb - ra || (a.energy ?? 99) - (b.energy ?? 99);
      })[0];
    if (guard) add(guard, '防守', `保命位：${effectCore(guard.effect, 52)}${energyTag(guard)}`);
  }
  if (refs.length < 4) {
    const altDmg =
      dmg.find((sk) => {
        if (used.has(sk.name) || sk.type === primary?.type) return false;
        return TYPE_ORDER.some((t) => matchup(sk.type, [t]).multiplier >= 2);
      }) ?? dmg.find((sk) => !used.has(sk.name) && sk.type !== primary?.type);
    if (altDmg) add(altDmg, '补盲', damageWhy(p, altDmg, false));
  }
  if (refs.length < 4) {
    const priority = byPref([/先手\+\d|迅捷/]);
    if (priority) add(priority, '机制', utilWhy(priority, role));
  }
  // 兜底：保证 4 个真实技能（每只都从自己的学习面里取，绝不留空位；血脉技能仍受 ≤1 限制）
  while (refs.length < 4) {
    const extra = [...all]
      .filter((sk) => !used.has(sk.name) && !(sk.learn === 2 && bloodUsed()))
      .sort((a, b) => (isDamaging(a) ? 1 : 0) - (isDamaging(b) ? 1 : 0) || (a.energy ?? 99) - (b.energy ?? 99))[0];
    if (!extra) break;
    add(extra, '机制', `可学技能：${effectCore(extra.effect) || skCategory(extra)}${energyTag(extra)}`);
  }

  return { refs: refs.slice(0, 4), primary, chosen: chosen.slice(0, 4) };
}

function skCategory(sk: ResolvedSkill): string {
  return `${sk.type}·${sk.category}${sk.power ? `·威力${sk.power}` : ''}`;
}

function noteForRole(
  p: Profile,
  role: RoleName,
  primary: ResolvedSkill | null,
  control: { label: string; skillName?: string } | null,
  utility: ResolvedSkill | null,
): string {
  const spe = p.stats.spe;
  switch (role) {
    case '先手':
      return `速度 ${spe}，队里第一个上场；主招 ${primary ? `${primary.name}（威力${primary.power}）` : '无伤害技能'}。`;
    case '核心输出':
      return `${p.mainIsPhysical ? '物攻' : '魔攻'} ${p.mainAtk}，主招 ${primary ? `${primary.name}（威力 ${primary.power}）` : '—'}，最高威力 ${p.maxPower}（${p.maxPowerSkill?.name ?? '—'}），总种族值 ${p.total}。`;
    case '承伤':
      return p.bulk < 290
        ? `生命 ${p.stats.hp}／物防 ${p.stats.def}／魔防 ${p.stats.spd}，承伤位；对上克制招也撑不住，只能先手换掉。`
        : `生命 ${p.stats.hp}／物防 ${p.stats.def}／魔防 ${p.stats.spd}，负责吃一轮伤害再换人。`;
    case '控制':
      if (utility && /全技能能耗\+|失去\d+能量|偷取[^。；]{0,4}能量|印记|灼烧|中毒|冻结|眩晕|驱散|返场/.test(utility.effect ?? '')) {
        return `用「${utility.name}」形成压制：${effectCore(utility.effect, 54)}。`;
      }
      if (control?.label === '特性' && p.traitTags.size) {
        return `特性「${p.spirit.trait?.name ?? '—'}」：${effectCore(p.spirit.trait?.effect, 54)}。`;
      }
      return control?.skillName
        ? `用「${control.skillName}」形成压制：${effectCore(
            p.keySkills.find((sk) => sk.name === control.skillName)?.effect,
            54,
          )}。`
        : `特性「${p.spirit.trait?.name ?? '—'}」：${effectCore(p.spirit.trait?.effect, 54)}。`;
    case '辅助': {
      if (utility) return `辅助位，推荐「${utility.name}」：${effectCore(utility.effect, 54)}。`;
      const supportTrait = p.traitTags.has('sustain') || p.traitTags.has('leech') ||
        /回复|减伤|护盾|提升|清除|免疫|治疗/.test(p.spirit.trait?.effect ?? '');
      if (supportTrait) return `辅助位，特性「${p.spirit.trait?.name ?? '—'}」：${effectCore(p.spirit.trait?.effect, 54)}。`;
      const sk =
        p.supportSkills.find((x) => /回复[^。；]{0,6}生命|护盾|免疫|清除/.test(x.effect ?? '')) ??
        p.supportSkills.find((x) => /提升|威力\+|双攻\+/.test(x.effect ?? '')) ??
        p.supportSkills.find((x) => /减伤/.test(x.effect ?? '')) ??
        p.supportSkills[0];
      return sk
        ? `辅助位，可学「${sk.name}」：${effectCore(sk.effect, 54)}。`
        : `辅助位，特性「${p.spirit.trait?.name ?? '—'}」：${effectCore(p.spirit.trait?.effect, 54)}。`;
    }
    case '收割':
      return p.traitTags.has('comeback')
        ? `速度 ${spe}；特性「${p.spirit.trait?.name}」：${effectBrief(p.spirit.trait?.effect)}`
        : `速度 ${spe}，主招 ${primary ? `${primary.name}（威力 ${primary.power}）` : '—'}，负责收残。`;
    default:
      return '';
  }
}

function chainText(p: Profile, primary: ResolvedSkill | null, teamHasWeather: boolean): string {
  const trait = p.spirit.trait;
  const traitPart = trait ? `「${trait.name}」${trait.effect}` : '图鉴未提供特性。';
  const skillPart = primary ? `关键技能${skillTag(primary)}：${effectBrief(primary.effect, 70) || '图鉴未提供效果文本。'}` : '';
  // 特性依赖天气、但本队没有开天气的手段时，照实提醒，不假装联动成立
  const weatherNote =
    !teamHasWeather && /天气为|天气时|晴天|雨天|暴风雪|沙暴|雷鸣/.test(trait?.effect ?? '')
      ? '（本队没有开天气的技能，这条只在天气自然出现时生效。）'
      : '';
  return `${traitPart}${skillPart}${weatherNote}`;
}

/* ------------------------------------------------------------------ 战术手册 */

const mulLabel = (mul: number) => `×${mul}`;

/** 某只精灵的 ×2 以上弱点属性 */
function weakTypesOf(p: Profile): string[] {
  return p.weak;
}

/** 特性在本队里的用法：原文照抄，再补一句队内能接上的条件 */
function traitSynergyFor(p: Profile, team: Profile[], arch: Arch): string {
  const trait = p.spirit.trait;
  if (!trait) return '图鉴未提供特性，这一只主要靠技能位发挥。';
  const eff = trait.effect ?? '';
  const base = `「${trait.name}」${effectCore(eff, 54)}`;
  const extra: string[] = [];
  if (/天气/.test(eff)) {
    const setter = team.find(
      (o) => o.id !== p.id && skillsOf(o.spirit).some((sk) => /将天气改为/.test(sk.effect ?? '')),
    );
    if (setter) extra.push(`${shortName(setter.name)} 负责开天气，这条只在天气回合内生效`);
    else if (arch.weather) extra.push('本队没有开天气的技能，只在天气自然出现时生效');
  }
  if (p.traitTags.has('tax') || p.traitTags.has('steal')) extra.push('对手每回合都在多付能量，适合先耗再打');
  if (p.traitTags.has('comeback')) extra.push('队伍换掉的人越多，它入场时越强');
  if (p.traitTags.has('leech') || p.traitTags.has('sustain')) extra.push('伤害直接换血，前排不用带治疗位');
  if (p.traitTags.has('switch')) extra.push('对手换人时反而更亏');
  if (p.traitTags.has('charge')) {
    const fuel = skillsOf(p.spirit).find(isChargeSkill);
    if (/可以使用任一携带技能/.test(eff)) {
      extra.push('蓄力那回合可以改打别的技能，不会空过');
    } else if (fuel) {
      extra.push(`队里「${fuel.name}」是蓄力技，正好喂给这条特性`);
    } else {
      extra.push('蓄力技就是它的燃料');
    }
  } else if (/应对成功/.test(eff)) {
    const guard = team.find(
      (o) => o.id !== p.id && skillsOf(o.spirit).some((sk) => /减伤\d+%/.test(sk.effect ?? '')),
    );
    if (guard) extra.push(`${shortName(guard.name)} 带「防御」，它应对成功就能点亮这条`);
  }
  return extra.length ? `${base}；${extra.slice(0, 2).join('；')}。` : `${base}。`;
}

/** 起手第一只：谁首发、为什么、开场打哪两招、什么时候该换 */
function buildLead(
  team: Profile[],
  roles: Map<string, RoleName>,
  picks: Map<string, SkillPick>,
): LeadPlan {
  const lead = team.find((p) => roles.get(p.id) === '先手') ?? [...team].sort((a, b) => b.stats.spe - a.stats.spe)[0];
  const pick = picks.get(lead.id)!;
  const secondFastest = [...team]
    .filter((p) => p.id !== lead.id)
    .sort((a, b) => b.stats.spe - a.stats.spe)[0];
  const priority = pick.chosen.find((sk) => /先手\+\d|迅捷/.test(sk.effect ?? ''));
  const boost = pick.chosen.find(
    (sk) =>
      !isDamaging(sk) && /速度\+\d|全技能威力\+\d|双攻\+\d|魔攻\+\d|物攻\+\d/.test(sk.effect ?? ''),
  );
  const weaknesses = weakTypesOf(lead);
  const covered = weaknesses.filter((t) => team.some((o) => o.id !== lead.id && o.defMul[TI.get(t)!] <= 0.5));

  const whyParts: string[] = [];
  whyParts.push(
    `速度 ${lead.stats.spe}，全队第一${
      secondFastest ? `（第二 ${shortName(secondFastest.name)} ${secondFastest.stats.spe}）` : ''
    }`,
  );
  if (priority) whyParts.push(`「${priority.name}」带先手（${effectCore(priority.effect, 24)}）`);
  if (boost) whyParts.push(`开场可先「${boost.name}」（能耗 ${boost.energy ?? '—'}）把状态叠起来`);
  whyParts.push(
    weaknesses.length
      ? `本身 ${weaknesses.length} 个 ×2 弱点（${joinTypes(weaknesses)}），其中 ${covered.length} 个有队友以 ≤0.5 倍接住`
      : '没有 ×2 弱点，可以放心站场抢第一波节奏',
  );

  const openerSkill = boost ?? priority ?? pick.primary;
  const secondSkill =
    openerSkill === pick.primary
      ? pick.chosen.find((sk) => sk !== openerSkill && isDamaging(sk)) ?? null
      : pick.primary;
  const refFor = (sk: ResolvedSkill): PresetSkillRef => {
    const found = pick.refs.find((r) => r.name === sk.name);
    return {
      name: sk.name,
      slot: found?.slot ?? '起手',
      why: `${sk.type}·${sk.category}${sk.power ? `·威力 ${sk.power}` : ''}${energyTag(sk)}：${effectBrief(sk.effect, 46)}`,
    };
  };
  const openers: PresetSkillRef[] = [];
  if (openerSkill) openers.push(refFor(openerSkill));
  if (secondSkill) openers.push(refFor(secondSkill));

  const worst = [...weaknesses].sort((a, b) => lead.defMul[TI.get(b)!] - lead.defMul[TI.get(a)!])[0];
  const answer = worst
    ? [...team]
        .filter((p) => p.id !== lead.id && p.defMul[TI.get(worst)!] <= 0.5)
        .sort((a, b) => a.defMul[TI.get(worst)!] - b.defMul[TI.get(worst)!])[0]
    : null;
  const caution = worst
    ? `对面用 ${worst}系打过来是 ${mulLabel(lead.defMul[TI.get(worst)!])}，${
        answer ? `直接换 ${shortName(answer.name)}（${mulLabel(answer.defMul[TI.get(worst)!])}）上场接，别让首发硬吃` : '队里没人抗，首发只能打完一轮就换'
      }。`
    : '首发没有 ×2 弱点，唯一的风险是被对面先手秒掉，注意留一只换人盾。';

  return {
    spiritId: lead.id,
    why: `${whyParts.join('；')}。`,
    openers,
    caution,
  };
}

/** 找某只精灵推荐的输出技能（按推荐顺序） */
function pickedDamagers(id: string, picks: Map<string, SkillPick>): ResolvedSkill[] {
  return (picks.get(id)?.chosen ?? []).filter((sk) => isDamaging(sk));
}

/** 核心技能联动：只写队里真实存在的「特性 × 技能」「技能 × 技能」关系 */
function buildSynergies(
  team: Profile[],
  picks: Map<string, SkillPick>,
  e: Eval,
  arch: Arch,
  teamHasWeather: boolean,
): SkillSynergy[] {
  const out: SkillSynergy[] = [];
  const memberName = (id: string) => shortName(BY_ID.get(id)?.name ?? id);

  /* 1) 属性联防：共同弱点 + 队友 ≤0.5 倍接住 */
  const worst = e.sharedWeak[0];
  if (worst && worst.count >= 2) {
    const i = TI.get(worst.type)!;
    const answer = [...team]
      .filter((p) => p.defMul[i] <= 0.5)
      .sort((a, b) => a.defMul[i] - b.defMul[i])[0];
    if (answer) {
      const atk = pickedDamagers(answer.id, picks).find(
        (sk) => matchup(sk.type, [worst.type]).multiplier >= 2,
      );
      out.push({
        title: `${worst.type}系联防 → ${memberName(answer.id)} 接`,
        text:
          `${worst.type}系一招能同时打中 ${joinNames(worst.members.map(shortName), 2)}（最高 ${mulLabel(worst.maxMul)}）；` +
          `${memberName(answer.id)}（${answer.types.join('/')}）对它是 ${mulLabel(answer.defMul[i])}，换它上场就是止损点` +
          (atk
            ? `，它的「${atk.name}」（${atk.type}·威力 ${atk.power}）还能对${worst.type}系打出 ${mulLabel(
                matchup(atk.type, [worst.type]).multiplier,
              )}。`
            : '。'),
        spiritIds: [answer.id],
        skills: atk ? [{ spiritId: answer.id, name: atk.name }] : [],
      });
    }
  }

  /* 2) 状态接力：先挂状态，再吃「若敌方有 X」的加成 */
  for (const state of ['冻结', '灼烧', '中毒']) {
    const givers: { p: Profile; sk: ResolvedSkill }[] = [];
    for (const p of team) {
      for (const sk of picks.get(p.id)?.chosen ?? []) {
        if (new RegExp(`获得[^。；]{0,6}${state}`).test(sk.effect ?? '')) givers.push({ p, sk });
      }
    }
    if (!givers.length) continue;
    for (const p of team) {
      for (const sk of picks.get(p.id)?.chosen ?? []) {
        const eff = sk.effect ?? '';
        if (!new RegExp(`若敌方有${state}|${state}翻倍|敌方有[^。；]{0,4}${state}`).test(eff)) continue;
        const giver = givers.find((g) => g.p.id !== p.id) ?? givers[0];
        const plus = /威力\+(\d+)/.exec(eff)?.[1];
        out.push({
          title: `${giver.sk.name} 挂${state} → ${sk.name}`,
        text:
            `${memberName(giver.p.id)} 先用「${giver.sk.name}」（${giver.sk.type}·能耗 ${giver.sk.energy ?? '—'}）：${effectCore(
              giver.sk.effect,
              48,
            )}；${memberName(p.id)} 的「${sk.name}」（${sk.type}·威力 ${sk.power}）原文写着「${effectCore(eff, 56)}」${
              plus && sk.power ? `，也就是这一发按 ${sk.power} + ${plus}（${sk.power + Number(plus)}）算` : ''
            }。`,
          spiritIds: [giver.p.id, p.id],
          skills: [
            { spiritId: giver.p.id, name: giver.sk.name },
            { spiritId: p.id, name: sk.name },
          ],
        });
        break;
      }
      if (out.some((s) => s.title.includes(state))) break;
    }
  }

  /* 3) 能量压制：让对手多付费 / 直接抽走能量，再叠一个低耗高威力输出 */
  const taxTrait = team.find((p) => p.traitTags.has('tax'));
  if (taxTrait) {
    const cheap = team
      .filter((p) => p.id !== taxTrait.id)
      .map((p) => ({ p, sk: pickedDamagers(p.id, picks).find((sk) => (sk.energy ?? 99) <= 3 && (sk.power ?? 0) >= 90) }))
      .filter((x): x is { p: Profile; sk: ResolvedSkill } => Boolean(x.sk))
      .sort((a, b) => (b.sk.power ?? 0) - (a.sk.power ?? 0))[0];
    out.push({
      title: `${taxTrait.spirit.trait?.name ?? '能耗压制'} → ${cheap ? cheap.sk.name : '拖到没能量'}`,
      text:
        `${memberName(taxTrait.id)} 的「${taxTrait.spirit.trait?.name}」：${effectCore(taxTrait.spirit.trait?.effect, 56)}；` +
        (cheap
          ? `${memberName(cheap.p.id)} 的「${cheap.sk.name}」（${cheap.sk.type}·威力 ${cheap.sk.power}·能耗 ${cheap.sk.energy}）是全队最便宜的高威力输出——对手每回合都在多付能量，这一发等于白拿伤害。`
          : '对手每回合都在多付能量，耗到它的高耗技能打不出来为止。'),
      spiritIds: [taxTrait.id, ...(cheap ? [cheap.p.id] : [])],
      skills: cheap ? [{ spiritId: cheap.p.id, name: cheap.sk.name }] : [],
    });
  }
  const stealTrait = team.find((p) => /使用([^。；]{1,3})系技能后，敌方失去\d+能量/.test(p.spirit.trait?.effect ?? ''));
  if (stealTrait) {
    const eff = stealTrait.spirit.trait?.effect ?? '';
    const need = /使用([^。；]{1,3})系技能后/.exec(eff)?.[1];
    const lose = /敌方失去(\d+)能量/.exec(eff)?.[1];
    const trigger =
      (picks.get(stealTrait.id)?.chosen ?? []).find((sk) => sk.type === need) ?? null;
    out.push({
      title: `${stealTrait.spirit.trait?.name ?? '抽能'} → ${trigger ? trigger.name : '恶系技能'}`,
      text:
        `${memberName(stealTrait.id)} 的「${stealTrait.spirit.trait?.name}」：${effectCore(eff, 58)}；` +
        (trigger
          ? `它带的「${trigger.name}」（${trigger.type}·威力 ${trigger.power ?? '—'}·能耗 ${trigger.energy ?? '—'}）正好是${need}系，1 次出手除了伤害，还让对手失去 ${lose ?? '—'} 能量。`
          : `只要用${need}系技能就能触发，1 次出手换对手 ${lose ?? '—'} 能量。`),
      spiritIds: [stealTrait.id],
      skills: trigger ? [{ spiritId: stealTrait.id, name: trigger.name }] : [],
    });
  }

  /* 4) 蓄力联动：蓄力技喂养「每次进入蓄力」的特性，蓄力回合还能改打别的招 */
  const chargeTrait = team.find((p) => p.traitTags.has('charge'));
  if (chargeTrait) {
    const pick = picks.get(chargeTrait.id)!;
    const chargeSkills = pick.chosen.filter(isChargeSkill);
    const anySkill = pick.chosen.find((sk) => !isChargeSkill(sk) && isDamaging(sk));
    const eff = chargeTrait.spirit.trait?.effect ?? '';
    const per = /能耗永久-(\d+)/.exec(eff)?.[1];
    const canUseAny = /可以使用任一携带技能/.test(eff);
    const rider = canUseAny && anySkill ? anySkill : null;
    if (chargeSkills.length || canUseAny) {
      out.push({
        title: `${chargeTrait.spirit.trait?.name ?? '蓄力'} × ${chargeSkills[0]?.name ?? rider?.name ?? '蓄力'}`,
        text:
          `${memberName(chargeTrait.id)} 的「${chargeTrait.spirit.trait?.name}」：${effectCore(eff, 56)}；` +
          (chargeSkills.length && per
            ? chargeSkills.length > 1
              ? `它带的「${chargeSkills.map((s) => s.name).join('」「')}」都是蓄力技，每蓄一次全技能能耗永久 -${per}，${chargeSkills.length} 次就是 -${Number(per) * chargeSkills.length}。`
              : `它带的「${chargeSkills[0].name}」是蓄力技，每蓄一次全技能能耗永久 -${per}。`
            : '') +
          (rider
            ? `蓄力那回合不会空过：可以改打「${rider.name}」（${rider.type}·威力 ${rider.power}）补盲，双防同时 +100%。`
            : ''),
        spiritIds: [chargeTrait.id],
        skills: [
          ...(chargeSkills[0] ? [{ spiritId: chargeTrait.id, name: chargeSkills[0].name }] : []),
          ...(rider ? [{ spiritId: chargeTrait.id, name: rider.name }] : []),
        ],
      });
    }
  }

  /* 5) 残血反打：队伍里主动换掉的人越多，收割位越强 */
  const comeback = team.find((p) => p.traitTags.has('comeback'));
  if (comeback) {
    const eff = comeback.spirit.trait?.effect ?? '';
    const per = /\+(\d+)%/.exec(eff)?.[1];
    const sacker = team.find((p) => p.id !== comeback.id && p.stats.spe < comeback.stats.spe) ?? null;
    out.push({
      title: `${comeback.spirit.trait?.name ?? '残血反打'} → ${shortName(comeback.name)}`,
      text:
        `${memberName(comeback.id)} 的「${comeback.spirit.trait?.name}」：${effectBrief(eff, 58)}；` +
        (sacker
          ? `队里 ${memberName(sacker.id)} 速度 ${sacker.stats.spe}，先上去换掉一只，${memberName(comeback.id)} 入场时就是 +${per ?? '—'}% 双攻起步。`
          : '前面的队友每换掉一只，它入场就多叠一层。'),
      spiritIds: [comeback.id, ...(sacker ? [sacker.id] : [])],
      skills: [],
    });
  }

  /* 6) 天气联动：开天气的人 + 特性写明天气生效的人 */
  if (arch.weather && teamHasWeather) {
    const setter = team.find((p) => weatherSetterSkills(p, arch.weather!).length > 0);
    const skill = setter ? weatherSetterSkills(setter.spirit, arch.weather!)[0] : null;
    const users = team.filter((p) => p.traitText.includes(arch.weather!));
    if (setter && skill && users.length) {
      out.push({
        title: `${skill.name} → ${users.map((p) => p.spirit.trait?.name).join('、')}`,
        text: `${memberName(setter.id)} 的「${skill.name}」（${skill.type}·能耗 ${skill.energy ?? '—'}）把天气改成${arch.weather}：${effectBrief(
          skill.effect,
          40,
        )}；${users
          .map((p) => `${memberName(p.id)} 的「${p.spirit.trait?.name}」`)
          .join('、')}都写明要在${arch.weather}下才生效。`,
        spiritIds: [setter.id, ...users.map((p) => p.id)],
        skills: [{ spiritId: setter.id, name: skill.name }],
      });
    }
  }

  /* 7) 换人惩罚：把对手送回去，特性立刻生效 */
  const switchTrait = team.find((p) => p.traitTags.has('switch'));
  if (switchTrait) {
    const force = team
      .map((p) => ({
        p,
        sk: (picks.get(p.id)?.chosen ?? []).find((sk) => /敌方精灵返场|紧急脱离|应对状态：回合结束使敌方/.test(sk.effect ?? '')),
      }))
      .find((x) => x.sk);
    out.push({
      title: `${switchTrait.spirit.trait?.name ?? '换人惩罚'}${force ? ` × ${force.sk!.name}` : ''}`,
      text:
        `${memberName(switchTrait.id)} 的「${switchTrait.spirit.trait?.name}」：${effectBrief(switchTrait.spirit.trait?.effect, 56)}；` +
        (force
          ? `${memberName(force.p.id)} 的「${force.sk!.name}」写明「${effectBrief(force.sk!.effect, 44)}」，把对手送回去正好喂到这条特性。`
          : '逼对手留在场上吃完输出，换人反而更亏。'),
      spiritIds: [switchTrait.id, ...(force ? [force.p.id] : [])],
      skills: force ? [{ spiritId: force.p.id, name: force.sk!.name }] : [],
    });
  }

  /* 8) 迸发联动：特性写「迸发延长」，技能写「迸发」 */
  const burstTrait = team.find((p) => /迸发/.test(p.spirit.trait?.effect ?? ''));
  if (burstTrait) {
    const burstSkill = (picks.get(burstTrait.id)?.chosen ?? []).find((sk) => /迸发/.test(sk.effect ?? ''));
    if (burstSkill) {
      out.push({
        title: `${burstTrait.spirit.trait?.name ?? '迸发'} × ${burstSkill.name}`,
        text:
          `${memberName(burstTrait.id)} 的「${burstTrait.spirit.trait?.name}」：${effectCore(
            burstTrait.spirit.trait?.effect,
            54,
          )}；它带的「${burstSkill.name}」（${burstSkill.type}·能耗 ${burstSkill.energy ?? '—'}）写明「${effectCore(
            burstSkill.effect,
            40,
          )}」，这层迸发会被特性多留一段时间。`,
        spiritIds: [burstTrait.id],
        skills: [{ spiritId: burstTrait.id, name: burstSkill.name }],
      });
    }
  }

  /* 8.5) 属性施法联动：「使用X系技能后」的特性 + 同系技能 */
  for (const p of team) {
    const eff = p.spirit.trait?.effect ?? '';
    const m = /使用([^。；]{1,3})系技能后/.exec(eff);
    if (!m || /失去\d+能量/.test(eff)) continue;
    const need = m[1];
    const sk = (picks.get(p.id)?.chosen ?? []).find((s) => s.type === need);
    if (!sk) continue;
    out.push({
      title: `${p.spirit.trait?.name ?? '施法联动'} → ${sk.name}`,
      text:
        `${memberName(p.id)} 的「${p.spirit.trait?.name}」：${effectCore(eff, 58)}；它带的「${sk.name}」（${sk.type}·威力 ${
          sk.power ?? '—'
        }·能耗 ${sk.energy ?? '—'}）正好是${need}系，每用一次就触发一次，越打越强。`,
      spiritIds: [p.id],
      skills: [{ spiritId: p.id, name: sk.name }],
    });
    break;
  }

  /* 8.6) 防守技能联动：特性按「每使用 N 次防御技能」叠威力 */
  for (const p of team) {
    const eff = p.spirit.trait?.effect ?? '';
    const per = /每使用(\d+)次防御技能[^。；]{0,16}威力\+(\d+)%/.exec(eff);
    if (!per) continue;
    const guards = team.filter((o) =>
      (picks.get(o.id)?.chosen ?? []).some((sk) => /减伤\d+%/.test(sk.effect ?? '')),
    );
    if (guards.length < 2) continue;
    const need = Number(per[1]);
    const step = Number(per[2]);
    const total = Math.round((guards.length / need) * step);
    out.push({
      title: `${p.spirit.trait?.name ?? '防守联动'} → ${guards.length} 只减伤`,
      text:
        `${memberName(p.id)} 的「${p.spirit.trait?.name}」：${effectCore(eff, 58)}；推荐的 6 只里有 ${guards.length} 只带减伤技能（${joinNames(
          guards.map((g) => shortName(g.name)),
        )}），各用一次就是 +${total}%（原文：每 ${need} 次 +${step}%）。`,
      spiritIds: [...new Set([p.id, ...guards.map((g) => g.id)])],
      skills: [],
    });
    break;
  }

  /* 9) 打击面互补：主攻打不动的属性，交给队友的另一属性技能 */
  const heavy = [...team].sort((a, b) => b.maxPower * b.mainAtk - a.maxPower * a.mainAtk)[0];
  const heavyPick = picks.get(heavy.id)!;
  const heavyPrimary = heavyPick.primary;
  if (heavyPrimary) {
    const hole = TYPE_ORDER.map((t) => ({ t, mul: matchup(heavyPrimary.type, [t]).multiplier }))
      .filter((x) => x.mul <= 1)
      .map((x) => {
        const answer = team
          .filter((p) => p.id !== heavy.id)
          .map((p) => ({ p, sk: pickedDamagers(p.id, picks).find((sk) => matchup(sk.type, [x.t]).multiplier >= 2) }))
          .find((y) => y.sk);
        return answer ? { ...x, answer } : null;
      })
      .find(Boolean);
    if (hole && hole.answer) {
      out.push({
        title: `${heavyPrimary.name} 只有 ×1 → ${hole.answer.sk!.name}`,
        text:
          `${memberName(heavy.id)} 的主招「${heavyPrimary.name}」（${heavyPrimary.type}·威力 ${heavyPrimary.power}）对 ${hole.t}系只有 ${mulLabel(
            hole.mul,
          )}；${memberName(hole.answer.p.id)} 的「${hole.answer.sk!.name}」（${hole.answer.sk!.type}·威力 ${
            hole.answer.sk!.power
          }）对 ${hole.t}系是 ${mulLabel(matchup(hole.answer.sk!.type, [hole.t]).multiplier)}——遇到 ${hole.t}系就换人，不要用主招硬顶。`,
        spiritIds: [heavy.id, hole.answer.p.id],
        skills: [
          { spiritId: heavy.id, name: heavyPrimary.name },
          { spiritId: hole.answer.p.id, name: hole.answer.sk!.name },
        ],
      });
    }
  }

  // 每个标题只留一次；最多 4 条，至少 2 条
  const seen = new Set<string>();
  const unique = out.filter((s) => {
    if (seen.has(s.title)) return false;
    seen.add(s.title);
    return Boolean(s.text);
  });
  return unique.slice(0, 4);
}

/** 完整战术配合链：开局 → 第一阶段 → 中期 → 后期 → 逆风局 */
function buildBattlePlan(
  team: Profile[],
  roles: Map<string, RoleName>,
  picks: Map<string, SkillPick>,
  leadPlan: LeadPlan,
  synergies: SkillSynergy[],
  e: Eval,
): BattlePhase[] {
  const byId = (id: string) => team.find((p) => p.id === id) ?? team[0];
  const nameOf = (p: Profile) => shortName(p.name);
  const pickOf = (p: Profile) => picks.get(p.id)!;
  const lead = byId(leadPlan.spiritId);
  const leadPick = pickOf(lead);
  const open1 = leadPlan.openers[0] ? leadPick.chosen.find((sk) => sk.name === leadPlan.openers[0].name) : null;
  const open2 = leadPlan.openers[1] ? leadPick.chosen.find((sk) => sk.name === leadPlan.openers[1].name) : null;
  const core = team.find((p) => roles.get(p.id) === '核心输出') ?? [...team].sort((a, b) => b.maxPower - a.maxPower)[0];
  const corePick = pickOf(core);
  const tank = team.find((p) => roles.get(p.id) === '承伤') ?? [...team].sort((a, b) => b.bulk - a.bulk)[0];
  const closer = team.find((p) => roles.get(p.id) === '收割') ?? [...team].sort((a, b) => b.stats.spe - a.stats.spe)[0];
  const closerPick = pickOf(closer);
  const closerFinisher =
    [...closerPick.chosen].filter((sk) => isDamaging(sk)).sort((a, b) => (b.power ?? 0) - (a.power ?? 0))[0] ?? null;
  const closerPriority = closerPick.chosen.find((sk) => /先手\+\d|迅捷/.test(sk.effect ?? ''));
  const taxTrait = team.find((p) => p.traitTags.has('tax'));
  const leadWorst = [...lead.weak].sort((a, b) => lead.defMul[TI.get(b)!] - lead.defMul[TI.get(a)!])[0];
  const answerFor = (type: string) =>
    [...team]
      .filter((p) => p.defMul[TI.get(type)!] <= 0.5)
      .sort((a, b) => a.defMul[TI.get(type)!] - b.defMul[TI.get(type)!])[0];

  /* 1. 开局 */
  const openingText =
    `首发 ${nameOf(lead)}（速度 ${lead.stats.spe}，${lead.types.join('/')}）。` +
    (open1
      ? `第一手「${open1.name}」（${open1.type}·${open1.category}${open1.power ? `·威力 ${open1.power}` : ''}${isChargeSkill(open1) ? '·蓄力' : ''}${energyTag(open1)}）：${effectCore(
          open1.effect,
          42,
        )}。`
      : '') +
    (open2 && open2 !== open1
      ? `第二手「${open2.name}」（${open2.type}·${open2.category}${open2.power ? `·威力 ${open2.power}` : ''}${energyTag(open2)}）。`
      : '') +
    leadPlan.caution;

  /* 2. 第一阶段：用前 2–3 回合建立优势 */
  const coverageSkill =
    leadPick.chosen.find((sk) => sk !== leadPick.primary && isDamaging(sk)) ??
    corePick.chosen.find((sk) => sk !== corePick.primary && isDamaging(sk)) ??
    null;
  const coverageOwner = coverageSkill && leadPick.chosen.includes(coverageSkill) ? lead : core;
  const advantageText =
    `前 2–3 回合只做一件事：把对手逼到换人。${nameOf(lead)} 抢到先手后先${open1 ? `用「${open1.name}」` : '出手'}` +
    (coverageSkill
      ? `，再切「${coverageSkill.name}」（${coverageSkill.type}·威力 ${coverageSkill.power ?? '—'}${energyTag(
          coverageSkill,
        )}）打主招打不动的属性；`
      : '，把主招留给对手换上来的那只；') +
    `主攻 ${nameOf(core)} 的「${corePick.primary?.name ?? '—'}」（威力 ${corePick.primary?.power ?? '—'}）不要浪费在已经残血的那只身上。` +
    (taxTrait
      ? `对手每回合还被 ${nameOf(taxTrait)} 的「${taxTrait.spirit.trait?.name}」多收能量，拖到第 3 回合它的高耗技能就打不出来。`
      : '');

  /* 3. 中期：换人 + 联动 */
  const switchRows = e.sharedWeak.slice(0, 2).map((w) => {
    const ans = answerFor(w.type);
    return ans
      ? `${w.type}系（对 ${joinNames(w.members.map(shortName), 2)}是 ${mulLabel(w.maxMul)}）换 ${nameOf(ans)}（${mulLabel(
          ans.defMul[TI.get(w.type)!],
        )}）`
      : `${w.type}系队里没人抗，只能先手换血`;
  });
  const leadRow =
    leadWorst && !e.sharedWeak.slice(0, 2).some((w) => w.type === leadWorst)
      ? `首发 ${nameOf(lead)} 遇到 ${leadWorst}系（${mulLabel(lead.defMul[TI.get(leadWorst)!])}）时${
          answerFor(leadWorst) ? `换 ${nameOf(answerFor(leadWorst)!)} 接` : '直接撤'
        }`
      : '';
  const midText =
    (switchRows.length ? `中期的换人只有两条线：${switchRows.join('；')}。` : '') +
    (leadRow ? `${leadRow}。` : '') +
    (synergies.length ? `换人不是单纯避伤害，而是接上「${synergies[0].title}」这条联动。` : '') +
    `每次换人前先看对手能量：${taxTrait ? `对手被「${taxTrait.spirit.trait?.name}」压着、` : ''}高耗技能打不出来时再上 ${nameOf(core)}。`;

  /* 4. 后期：收割 */
  const lateText =
    `剩 1–2 只时把 ${nameOf(closer)} 留到最后（速度 ${closer.stats.spe}）` +
    (closerPriority
      ? `，「${closerPriority.name}」带先手，残血对手先手也跑不掉；`
      : closer.stats.spe < 100
        ? `，它比对面慢，收尾前必须先把对面的先手位换掉；`
        : '；') +
    (closerFinisher
      ? `终结技「${closerFinisher.name}」（${closerFinisher.type}·威力 ${closerFinisher.power}${energyTag(
          closerFinisher,
        )}）${effectCore(closerFinisher.effect, 40)}。`
      : '') +
    (closer.traitTags.has('comeback')
      ? `到这一步「${closer.spirit.trait?.name}」已经按力竭数量叠满，越低血越难处理。`
      : '');

  /* 5. 逆风局 */
  const threat = e.sharedWeak[0]?.type ?? leadWorst ?? null;
  const answer = threat ? answerFor(threat) : null;
  const hitsThreat = (p: Profile) =>
    p.id !== lead.id && pickedDamagers(p.id, picks).some((sk) => matchup(sk.type, [threat!]).multiplier >= 2);
  const counter = threat
    ? team.find((p) => p.id !== tank.id && hitsThreat(p)) ??
      team.find((p) => p.id !== lead.id && pickedDamagers(p.id, picks).some((sk) => matchup(sk.type, [threat!]).multiplier >= 2)) ??
      null
    : null;
  const counterSkill = counter
    ? pickedDamagers(counter.id, picks).find((sk) => matchup(sk.type, [threat!]).multiplier >= 2) ?? null
    : null;
  const comebackText =
    (leadWorst
      ? `首发被克：${nameOf(lead)} 怕 ${leadWorst}系（${mulLabel(lead.defMul[TI.get(leadWorst)!])}），对面若${leadWorst}系开场，${
          answerFor(leadWorst) ? `直接上 ${nameOf(answerFor(leadWorst)!)}（${mulLabel(answerFor(leadWorst)!.defMul[TI.get(leadWorst)!])}）而不是硬吃` : '别硬留场'
        }。`
      : '首发没有 ×2 弱点，逆风主要来自被先手压速。') +
    `${nameOf(tank)} 生命 ${tank.stats.hp}／物防 ${tank.stats.def}／魔防 ${tank.stats.spd}，承伤位，用来吃一轮爆发把节奏换回来。` +
    (counter && counterSkill
      ? `反制位 ${nameOf(counter)}：对手把 ${threat}系打出来时，它的「${counterSkill.name}」能反打 ${mulLabel(
          matchup(counterSkill.type, [threat!]).multiplier,
        )}，等对面 ${threat}系站场再上。`
      : `止损思路：先保 ${nameOf(tank)} 不掉，再用 ${nameOf(closer)} 的先手/终结技换回来。`);

  const refs = (spirits: Profile[], skills: { spiritId: string; name: string }[]) => ({
    spiritIds: [...new Set(spirits.map((p) => p.id))],
    skills,
  });

  return [
    {
      key: 'opening',
      label: '开局',
      title: `${nameOf(lead)} 首发`,
      text: openingText,
      ...refs(
        [lead],
        [open1, open2]
          .filter((sk): sk is ResolvedSkill => Boolean(sk))
          .map((sk) => ({ spiritId: lead.id, name: sk.name })),
      ),
    },
    {
      key: 'advantage',
      label: '第一阶段',
      title: '把节奏压在自己这边',
      text: advantageText,
      ...refs(
        [lead, core, ...(coverageOwner ? [coverageOwner] : []), ...(taxTrait ? [taxTrait] : [])],
        [
          ...(open1 ? [{ spiritId: lead.id, name: open1.name }] : []),
          ...(coverageSkill && coverageOwner
            ? [{ spiritId: coverageOwner.id, name: coverageSkill.name }]
            : []),
          ...(corePick.primary ? [{ spiritId: core.id, name: corePick.primary.name }] : []),
        ],
      ),
    },
    {
      key: 'mid',
      label: '中期',
      title: '换人联防与联动',
      text: midText,
      ...refs(
        [lead, core, ...(answer ? [answer] : [])],
        [],
      ),
    },
    {
      key: 'late',
      label: '后期',
      title: `${nameOf(closer)} 收割`,
      text: lateText,
      ...refs(
        [closer],
        [closerFinisher, closerPriority]
          .filter((sk): sk is ResolvedSkill => Boolean(sk))
          .map((sk) => ({ spiritId: closer.id, name: sk!.name })),
      ),
    },
    {
      key: 'comeback',
      label: '逆风局',
      title: '首发劣势与止损',
      text: comebackText,
      ...refs(
        [lead, tank, ...(counter ? [counter] : [])],
        counterSkill && counter ? [{ spiritId: counter.id, name: counterSkill.name }] : [],
      ),
    },
  ];
}

/** 一个队伍的完整文案：每个数字都是现算的，每句机制都能在图鉴原文里找到 */
function buildTeam(
  arch: Arch,
  cand: Candidate,
  round: number,
  banned: Set<string>,
): { preset: TeamPreset; e: Eval } {
  const team = cand.team;
  const e = cand.e;
  const roles = bestAssignment(team);
  const ordered = [...team].sort(
    (a, b) => CHAIN_ORDER.indexOf(roles.get(a.id) ?? '收割') - CHAIN_ORDER.indexOf(roles.get(b.id) ?? '收割'),
  );

  // 文案里的「核心 / 先手 / 承伤 / 收割」必须和卡片上那个角色徽章是同一个人
  const byRole = (role: RoleName) => team.find((p) => roles.get(p.id) === role) ?? null;
  const heaviest = [...team].sort((a, b) => b.maxPower * b.mainAtk - a.maxPower * a.mainAtk)[0];
  const core = byRole('核心输出') ?? heaviest;
  const lead = byRole('先手') ?? [...team].sort((a, b) => b.stats.spe - a.stats.spe)[0];
  const tank = byRole('承伤') ?? [...team].sort((a, b) => b.bulk - a.bulk)[0];
  const closer = byRole('收割') ?? core;

  // 队名里的属性前缀只在「至少 3 只带这个系」时才用，避免一两只就挂上整套名字
  const domType = (() => {
    const counts = new Map<string, number>();
    for (const p of team) for (const t of new Set(p.types)) counts.set(t, (counts.get(t) ?? 0) + 1);
    const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
    return sorted.length && sorted[0][1] >= 3 ? sorted[0][0] : null;
  })();

  const name =
    arch.weather
      ? `${arch.weather}队`
      : arch.monoType
        ? `${arch.monoType}系强攻队`
        : arch.id === 'cover18'
          ? '十八系互补队'
          : domType
            ? `${domType}系${arch.short}`
            : arch.short;

  const skillPicks = new Map<string, SkillPick>();
  for (const p of ordered) skillPicks.set(p.id, pickSkillsFor(p, roles.get(p.id) ?? '收割'));

  const members: PresetMember[] = ordered.map((p) => {
    const role = roles.get(p.id) ?? '收割';
    const pick = skillPicks.get(p.id)!;
    const controlTag = CONTROL_TAGS.find((t) => p.traitTags.has(t));
    const controlSkill =
      p.keySkills.find((sk) =>
        CONTROL_TAGS.some((tag) => MECH.find((m) => m.tag === tag)!.test.test(sk.effect ?? '')),
      ) ??
      skillsOf(p.spirit).find((sk) =>
        CONTROL_TAGS.some((tag) => MECH.find((m) => m.tag === tag)!.test.test(sk.effect ?? '')),
      );
    const control = controlTag
      ? { label: '特性', skillName: p.spirit.trait?.name }
      : controlSkill
        ? { label: MECH_LABEL.get('tax') ?? '控制', skillName: controlSkill.name }
        : null;
    return {
      spiritId: p.id,
      role,
      duty: DUTY_BY_ROLE[role],
      note: noteForRole(p, role, pick.primary, control, pick.chosen[2] ?? null),
      skills: pick.refs,
      traitSynergy: traitSynergyFor(p, team, arch),
    };
  });

  // 同一种族的两只可能带着同一特性与同一主招：重复时换第二个技能，六步读下来才不重复
  const teamHasWeather = team.some((p) =>
    skillsOf(p.spirit).some((sk) => /将天气改为/.test(sk.effect ?? '')),
  );
  const chainSeen = new Set<string>();
  const chain: ChainStep[] = ordered.map((p) => {
    const pick = skillPicks.get(p.id)!;
    let skill = pick.primary;
    if (skill && chainSeen.has(skill.name)) {
      const alt = pick.refs.find((r) => !chainSeen.has(r.name));
      const altSkill = alt ? skillsOf(p.spirit).find((sk) => sk.name === alt.name) ?? null : null;
      if (altSkill) skill = altSkill;
    }
    if (skill) chainSeen.add(skill.name);
    return { spiritId: p.id, skillName: skill?.name, text: chainText(p, skill, teamHasWeather) };
  });

  const weatherSetter = arch.weather
    ? team.find((p) => weatherSetterSkills(p, arch.weather!).length > 0)
    : null;
  const weatherSkill = weatherSetter && arch.weather ? weatherSetterSkills(weatherSetter.spirit, arch.weather)[0] : null;
  const synergyMembers = arch.weather ? team.filter((p) => p.traitText.includes(arch.weather!)) : [];

  const statusCarriers = team.filter((p) => STATUS_TAGS.some((t) => p.traitTags.has(t)));
  const controlCarriers = team.filter((p) => p.traitTags.has('tax') || p.traitTags.has('steal'));
  const controlAny = team.filter((p) => controlScore(p) >= 2);
  const supportCarriers = team.filter((p) => supportScore(p) >= 1.6);
  const comebackCarriers = team.filter((p) => p.traitTags.has('comeback'));
  const switchCarriers = team.filter((p) => p.traitTags.has('switch'));
  const heavyCarriers = team.filter((p) => p.maxPower >= 150);

  const highlight: string = (() => {
    switch (arch.id) {
      case 'rush':
        return `全队 ${
          e.fastCount >= 4 ? `${e.fastCount} 只速度 ≥120` : `有 ${e.fastCount} 只速度 ≥120`
        }（最快 ${shortName(e.fastest?.name ?? '')} ${e.fastest?.spe}），先把出手顺序压在自己这边。`;
      case 'nuke':
        return `六只最高单发平均 ${e.avgTopPower}，${shortName(heaviest.name)}的「${heaviest.maxPowerSkill?.name}」是全队最重的一发（威力 ${heaviest.maxPower}）。`;
      case 'wall':
        return `六只合计 ${e.weakSpots} 个弱点，其中 ${e.coveredSpots} 个有队友以 ≤0.5 倍接住${e.allCovered ? '（全覆盖）' : ''}。`;
      case 'cover18':
        return `18 系里能打出 ≥2 倍伤害的有 ${e.coverage} 种，共同弱点 ${e.sharedWeakCount} 个（${e.sharedWeak.map((w) => `${w.type}×${w.count}`).join('、') || '无'}）。`;
      case 'drain':
        return controlCarriers.length
          ? `队里 ${controlCarriers.length} 只的特性直接抬能耗/偷能量（${joinNames(
              controlCarriers.map((p) => `${shortName(p.name)}「${p.spirit.trait?.name ?? ''}」`),
            )}），对手每次出手都更贵。`
          : `队里 ${controlAny.length} 只通过技能抬能耗或偷能量，压住对手的费用。`;
      case 'leech':
        return `队里 ${team.filter((p) => p.traitTags.has('leech') || p.traitTags.has('sustain')).length} 只能把伤害换成血量，${comebackCarriers.length} 只带残血反打。`;
      case 'status':
        return `队里 ${statusCarriers.length} 只的特性直接挂灼烧/中毒/冻结层数（${joinNames(
          statusCarriers.map((p) => `${shortName(p.name)}「${p.spirit.trait?.name ?? ''}」`),
        )}）。`;
      case 'weather':
        return weatherSetter && arch.weather
          ? `${arch.weather}由 ${shortName(weatherSetter.name)} 的「${weatherSkill?.name ?? '—'}」开出（${effectBrief(weatherSkill?.effect, 30)}），${synergyMembers.length} 只的特性明确写着${arch.weather}生效。`
          : `${arch.weather ?? ''}联动。`;
      case 'mono':
        return `六只都带${arch.monoType}系，本系加成一致，能打出 ≥2 倍的属性 ${e.coverage} 种。`;
      case 'punish':
        return `队里 ${switchCarriers.length} 只带换人惩罚（${joinNames(switchCarriers.map((p) => shortName(p.name)))}），对手换人反而更亏。`;
      default:
        return '';
    }
  })();

  const summary =
    `第 ${round} 轮「${arch.label}」：6 只平均种族值 ${e.avgTotal}（最高 ${shortName(e.maxTotal?.name ?? '')} ${e.maxTotal?.total}），` +
    `速度最快 ${shortName(e.fastest?.name ?? '')} ${e.fastest?.spe}，能打出 ≥2 倍伤害的属性 ${e.coverage}/18。${highlight}`;

  /* ---------------------------------------------------------- 配队逻辑 */
  const leadName = shortName(lead.name);
  const coreName = shortName(core.name);
  const tankName = shortName(tank.name);
  const leadSkill = skillPicks.get(lead.id)!.primary;
  const coreSkill = core.maxPowerSkill;

  const plan: string[] = [
    `起手：${leadName}（速度 ${lead.stats.spe}，${roles.get(lead.id) ?? '先手'}）先上场，主招「${leadSkill?.name ?? '—'}」（威力 ${leadSkill?.power ?? '—'}）。`,
    `核心：${coreName}${core.mainIsPhysical ? '物攻' : '魔攻'} ${core.mainAtk}，主招「${skillPicks.get(core.id)!.primary?.name ?? '—'}」（${skillPicks.get(core.id)!.primary?.type ?? core.types[0]}·威力 ${
      skillPicks.get(core.id)!.primary?.power ?? '—'
    }·能耗 ${skillPicks.get(core.id)!.primary?.energy ?? '—'}）${
      coreSkill && coreSkill.name !== skillPicks.get(core.id)!.primary?.name
        ? `，最高威力「${coreSkill.name}」${core.maxPower}`
        : ''
    }。`,
  ];

  const answersOf = (type: string) =>
    team.filter((p) => matchup(type, p.types).multiplier <= 0.5).map((p) => shortName(p.name));

  if (arch.weather && weatherSetter && arch.weather) {
    const rounds = /持续(\d+)回合/.exec(weatherSkill?.effect ?? '')?.[1];
    plan.push(
      `天气：${shortName(weatherSetter.name)}的「${weatherSkill?.name ?? '—'}」把天气改成${arch.weather}（${rounds ? `${rounds} 回合` : '回合数见技能原文'}）；${joinNames(
        synergyMembers.map((p) => `${shortName(p.name)}「${p.spirit.trait?.name ?? ''}」`),
      )}的特性都写着${arch.weather}在场才生效。`,
    );
    plan.push(
      `轮换：天气断档时用${tankName}（生命 ${tank.stats.hp}／物防 ${tank.stats.def}）顶住一回合，等下一次开天气；${coreName}的两回合留给${shortName(closer.name)}收尾。`,
    );
  } else if (arch.id === 'drain') {
    const carriers = controlCarriers.length ? controlCarriers : controlAny;
    plan.push(
      `抽能：${joinNames(carriers.map((p) => `${shortName(p.name)}「${p.spirit.trait?.name ?? ''}」`))}让对手付更贵的费用；${
        heavyCarriers.length ? joinNames(heavyCarriers.map((p) => shortName(p.name))) : coreName
      }用威力 ≥150 的技能收场。`,
    );
    plan.push(
      `承伤：${tankName}生命 ${tank.stats.hp}／物防 ${tank.stats.def}／魔防 ${tank.stats.spd}，顶住一次爆发再换人。`,
    );
  } else if (arch.id === 'status') {
    plan.push(
      `叠层：${joinNames(statusCarriers.map((p) => `${shortName(p.name)}「${p.spirit.trait?.name ?? ''}」`))}的特性直接挂层数，${
        supportCarriers.length ? `${shortName(supportCarriers[0].name)}负责续航` : '靠换人拖回合'
      }。`,
    );
    plan.push(
      `收场：${coreName}的「${coreSkill?.name ?? '—'}」（威力 ${core.maxPower}）在层数叠满后收割；${tankName}物防 ${tank.stats.def}／魔防 ${tank.stats.spd} 用来吃伤害。`,
    );
  } else if (arch.id === 'leech') {
    const drainMembers = team.filter((p) => p.traitTags.has('leech') || p.traitTags.has('sustain'));
    plan.push(
      `续航：${joinNames(drainMembers.map((p) => `${shortName(p.name)}「${p.spirit.trait?.name ?? ''}」`))}，伤害直接换回血量，前排不用带治疗位。`,
    );
    plan.push(
      `反打：${comebackCarriers.length ? joinNames(comebackCarriers.map((p) => `${shortName(p.name)}「${p.spirit.trait?.name ?? ''}」`)) : `${coreName}的「${coreSkill?.name ?? '—'}」`}，血量被压低后才开始赚。`,
    );
  } else if (arch.id === 'wall') {
    plan.push(
      `联防：${joinTypes(
        e.sharedWeak.map((w) => `${w.type}×${w.count}`),
      )} 是共同弱点，${e.sharedWeak
        .map((w) => {
          const answers = answersOf(w.type);
          return answers.length ? `${w.type}系交给${joinNames(answers, 2)}` : `${w.type}系队里没人抗`;
        })
        .join('；')}。`,
    );
    plan.push(
      `反击：${tankName}生命 ${tank.stats.hp}／物防 ${tank.stats.def} 先吃伤害；${coreName}用「${coreSkill?.name ?? '—'}」（威力 ${core.maxPower}）打回来。`,
    );
  } else if (arch.id === 'mono') {
    plan.push(
      `统一属性：六只都带${arch.monoType}系，本系加成写在每一只的主招上；${joinTypes(
        e.sharedWeak.map((w) => `${w.type}×${w.count}`),
      )} 是共同弱点。`,
    );
    plan.push(
      `分工：${coreName}打正面，${leadName}抢先手，${tankName}用生命 ${tank.stats.hp}／物防 ${tank.stats.def} 顶住对拼。`,
    );
  } else if (arch.id === 'punish') {
    plan.push(
      `追击：${joinNames(switchCarriers.map((p) => `${shortName(p.name)}「${p.spirit.trait?.name ?? ''}」`))}的特性在对手换人时生效，逼对方留在场上吃完输出。`,
    );
    plan.push(
      `收场：${coreName}的「${coreSkill?.name ?? '—'}」（威力 ${core.maxPower}）负责终结；${tankName}生命 ${tank.stats.hp} 顶住反扑。`,
    );
  } else if (arch.id === 'nuke') {
    plan.push(
      `重炮：六只里 ${heavyCarriers.length} 只最高单发 ≥150，最重的是${shortName(heaviest.name)}的「${heaviest.maxPowerSkill?.name ?? '—'}」威力 ${heaviest.maxPower}。`,
    );
    plan.push(
      `换血：${tankName}（生命 ${tank.stats.hp}／物防 ${tank.stats.def}）吃一轮伤害，${coreName}用「${coreSkill?.name ?? '—'}」两回合完成击杀。`,
    );
  } else {
    plan.push(
      `覆盖：18 系里能打出 2 倍的有 ${e.coverage} 种（${joinTypes(e.coverageTypes)}）；共同弱点 ${joinTypes(
        e.sharedWeak.map((w) => `${w.type}×${w.count}`),
      )}${
        e.sharedWeak.length && e.sharedWeak.every((w) => answersOf(w.type).length)
          ? '，每一个都有队友以 ≤0.5 倍接住'
          : ''
      }。`,
    );
    plan.push(
      `分工：${coreName}主输出、${leadName}抢速度、${tankName}承伤。`,
    );
  }

  /* ---------------------------------------------------------- 优势 / 弱点 */
  const pros: string[] = [
    `面板：平均种族值 ${e.avgTotal}（最高 ${shortName(e.maxTotal?.name ?? '')} ${e.maxTotal?.total}），速度最快 ${
      e.fastest?.spe ?? '—'
    }${e.fastCount >= 2 ? `，${e.fastCount} 只速度 ≥120` : e.fastCount === 1 ? '，只有 1 只速度 ≥120' : '，全队没有 120 以上的速度'}。`,
    `打击面：18 系里能打出 ≥2 倍的有 ${e.coverage} 种（${joinTypes(e.coverageTypes)}）；六只最高单发平均 ${e.avgTopPower}。`,
    e.sharedResist.length
      ? `防御：${joinNames(
          e.sharedResist.slice(0, 3).map((r) => `${r.type}系被 ${r.count} 只抵抗`),
        )}；${e.weakSpots} 个弱点里 ${e.coveredSpots} 个有队友以 ≤0.5 倍接住${e.allCovered ? '（全覆盖）' : ''}。`
      : `防御：没有两个成员共抗同一属性，属性结构分散，不容易被一套打击面通吃。`,
  ];

  const riskParts: string[] = [];
  if (e.sharedWeak.length) {
    const worst = e.sharedWeak[0];
    const answers = team.filter((p) => matchup(worst.type, p.types).multiplier <= 0.5).map((p) => shortName(p.name));
    riskParts.push(
      `共同弱点：${worst.type}系一招能克制 ${worst.count} 只（${joinNames(worst.members.map(shortName))}，最高 ×${worst.maxMul}），${
        answers.length ? `队里 ${joinNames(answers, 2)} 能抗（≤0.5 倍）` : '队里没人抗'
      }。`,
    );
    if (e.sharedWeak.length > 1) {
      riskParts.push(
        `其余共同弱点：${e.sharedWeak
          .slice(1, 3)
          .map((w) => `${w.type}×${w.count}`)
          .join('、')}。`,
      );
    }
  } else {
    riskParts.push('没有属性可以同时克制 2 只以上，弱点不共振。');
  }
  if (e.weakSpots && e.coveredSpots < e.weakSpots * 0.6) {
    riskParts.push(
      `漏洞：全队 ${e.weakSpots} 个弱点里只有 ${e.coveredSpots} 个有队友以 ≤0.5 倍接住，剩下的只能硬吃或靠先手避开。`,
    );
  }
  if (e.slowest && e.slowest.spe < 90) {
    riskParts.push(`速度短板：${shortName(e.slowest.name)} 只有 ${e.slowest.spe}，对上 130+ 的先手队会一直后手。`);
  }
  if (e.avgTopEnergy >= 6) {
    riskParts.push(`能耗偏高：六只主招平均能耗 ${e.avgTopEnergy}，能量打空后只能靠变化技能过渡。`);
  }
  if (arch.weather && arch.weather) {
    riskParts.push(`天气依赖：${arch.weather}只由一只开，天气一断特性加成就同时消失，开天气那回合也等于让出一次出手。`);
  }
  if (banned.size && cand.bannedHits > 0) {
    riskParts.push(`本轮与前一轮重叠 ${cand.bannedHits} 只：为了让强度不掉，保留了上一轮已经验证过的成员。`);
  }

  const leadPlan = buildLead(team, roles, skillPicks);
  const synergies = buildSynergies(team, skillPicks, e, arch, teamHasWeather);
  const battlePlan = buildBattlePlan(team, roles, skillPicks, leadPlan, synergies, e);

  const preset: TeamPreset = {
    id: `r${round}-${arch.id}`,
    name,
    sub: `${arch.tagline} · ${shortName(heaviest.name)}领衔`,
    category: arch.category,
    archetype: arch.id,
    archetypeLabel: arch.label,
    tags: [
      `第 ${round} 轮`,
      arch.label,
      `速度 ${e.fastest?.spe ?? '—'}`,
      `覆盖 ${e.coverage}/18`,
      `共同弱点 ${e.sharedWeakCount}`,
    ],
    summary,
    pros,
    plan,
    risk: riskParts.join(' '),
    chain,
    members,
    lead: leadPlan,
    synergies,
    battlePlan,
  };
  return { preset, e };
}

/* ------------------------------------------------------------------ 主流程 */

interface Args {
  round: number | null;
  ifDue: boolean;
  dry: boolean;
  now: Date;
  seed: number | null;
  refresh: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { round: null, ifDue: false, dry: false, now: new Date(), seed: null, refresh: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--if-due') args.ifDue = true;
    else if (a === '--refresh') args.refresh = true;
    else if (a === '--dry') args.dry = true;
    else if (a === '--round') args.round = Number(argv[++i]);
    else if (a === '--now') args.now = new Date(argv[++i]);
    else if (a === '--seed') args.seed = Number(argv[++i]);
  }
  return args;
}

function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ 重写战术手册（不改阵容、不改时间） */

/** 从当前阵容反推战术原型：天气队从前场技能取天气，纯属性队取共同属性 */
function archOfPreset(preset: TeamPreset, team: Profile[]): Arch | null {
  if (preset.archetype === 'weather') {
    let weather: string | null = null;
    for (const p of team) {
      for (const sk of skillsOf(p.spirit)) {
        const hit = /将天气改为(雨天|暴风雪|沙暴|雷鸣)/.exec(sk.effect ?? '');
        if (hit) {
          weather = hit[1];
          break;
        }
      }
      if (weather) break;
    }
    return weather ? weatherArchetype(weather, () => 0.5) : null;
  }
  if (preset.archetype === 'mono') {
    const counts = new Map<string, number>();
    for (const p of team) for (const t of new Set(p.types)) counts.set(t, (counts.get(t) ?? 0) + 1);
    const type = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
    return type ? monoArchetype(type) : null;
  }
  return BASE_ARCHETYPES.find((a) => a.id === preset.archetype) ?? null;
}

/**
 * npm run rotate:teams -- --refresh
 * 只重算文案与战术手册（起手、4 技能、联动、5 阶段），阵容与 nextRotationAt 保持原样。
 */
function refreshCurrent(rotation: TeamRotationFile, history: RotationHistoryFile): boolean {
  const previous = history.rounds.filter((r) => r.round < rotation.round).sort((a, b) => b.round - a.round)[0];
  const banned = new Set(
    (previous?.spiritIds ?? []).map((id) => BY_ID.get(id)?.base ?? '').filter(Boolean),
  );
  const rebuilt: TeamPreset[] = [];

  for (const preset of rotation.teams) {
    const team = preset.members
      .map((m) => BY_ID.get(m.spiritId))
      .filter((p): p is Profile => Boolean(p));
    if (team.length !== 6) {
      console.error(`[refresh] ${preset.name} 只找到 ${team.length} 只精灵，中止。`);
      return false;
    }
    const arch = archOfPreset(preset, team);
    if (!arch) {
      console.error(`[refresh] ${preset.name} 的战术原型 ${preset.archetype} 无法还原，中止。`);
      return false;
    }
    const e = evaluate(team, arch.weight);
    const next = buildTeam(
      arch,
      {
        team,
        e,
        score: 0,
        bannedHits: team.filter((p) => banned.has(p.base)).length,
      },
      rotation.round,
      banned,
    ).preset;
    const before = preset.members.map((m) => m.spiritId).sort().join(',');
    const after = next.members.map((m) => m.spiritId).sort().join(',');
    if (before !== after) {
      console.error(`[refresh] ${preset.name} 重算后成员变了（${before} → ${after}），中止以免换掉用户正在看的阵容。`);
      return false;
    }
    rebuilt.push(next);
    console.log(`· ${next.name}：${next.members.length} 只 / ${next.members.reduce((n, m) => n + m.skills.length, 0)} 个技能 / ${next.synergies.length} 条联动 / ${next.battlePlan.length} 个阶段`);
  }

  const dayKey = rotation.updatedAt.slice(0, 10);
  const today = beijingIso(new Date()).slice(0, 10);
  if (dayKey !== today) {
    console.log(`[refresh] 注意：当前轮更新于 ${rotation.updatedAt}，只重写文案，不改时间。`);
  }

  const file: TeamRotationFile = { ...rotation, teams: rebuilt };
  fs.writeFileSync(ROTATION_PATH, `${JSON.stringify(file, null, 1)}\n`);
  const rounds = history.rounds.map((r) =>
    r.round === rotation.round
      ? {
          ...r,
          teams: rebuilt.map((t) => ({
            id: t.id,
            name: t.name,
            category: t.category,
            archetype: t.archetype,
            archetypeLabel: t.archetypeLabel,
            spiritIds: t.members.map((m) => m.spiritId),
            spiritNames: t.members.map((m) => BY_ID.get(m.spiritId)?.name ?? m.spiritId),
          })),
          spiritIds: rebuilt.flatMap((t) => t.members.map((m) => m.spiritId)),
        }
      : r,
  );
  fs.writeFileSync(HISTORY_PATH, `${JSON.stringify({ rounds }, null, 1)}\n`);
  console.log(`\n已重写第 ${rotation.round} 轮的战术手册（阵容与 nextRotationAt=${rotation.nextRotationAt} 未变）。`);
  return true;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const rotation = readJson<TeamRotationFile>(ROTATION_PATH);
  const history = readJson<RotationHistoryFile>(HISTORY_PATH) ?? { rounds: [] };

  if (args.refresh) {
    if (!rotation) {
      console.error('[refresh] 没有读到 team-rotation.json，无法重写。');
      process.exit(1);
    }
    const ok = refreshCurrent(rotation, history);
    if (!ok) process.exit(1);
    return;
  }

  if (args.ifDue && rotation) {
    const due = new Date(rotation.nextRotationAt).getTime();
    if (args.now.getTime() < due) {
      console.log(
        `还没到轮换时间：第 ${rotation.round} 轮，下次 ${rotation.nextRotationAt}（北京时间）。本次不生成。`,
      );
      return;
    }
  }

  const last = history.rounds[history.rounds.length - 1];
  const round = args.round ?? (rotation?.round ?? last?.round ?? 0) + 1;
  const seed = args.seed ?? round * 1000003 + 17;
  const rand = mulberry32(seed);

  const banned = new Set((last?.spiritIds ?? []).map((id) => BY_ID.get(id)?.base ?? '').filter(Boolean));
  const prevArchetypes = new Set((last?.archetypes ?? []).map((a) => a.id));

  // 本轮战术原型池：先去掉上一轮用过的，再按种子打乱
  const pool: Arch[] = [...BASE_ARCHETYPES];
  const weatherChoices = [...WEATHERS];
  pool.push(weatherArchetype(weatherChoices[Math.floor(rand() * weatherChoices.length)], rand));
  const monoTypes = monoCandidates(rand);
  if (monoTypes.length) pool.push(monoArchetype(monoTypes[0]));

  const shuffled = [...pool].sort(() => rand() - 0.5);
  const ordered = [...shuffled.filter((a) => !prevArchetypes.has(a.id)), ...shuffled.filter((a) => prevArchetypes.has(a.id))];

  const used = new Set<string>();
  const chosen: { arch: Arch; cand: Candidate }[] = [];
  const rejected: string[] = [];

  for (const arch of ordered) {
    if (chosen.length >= 3) break;
    // 严格排除上一轮的 18 只；每组候选跑 3 次（种子不同），凑够再挑
    let strict = true;
    let results: Candidate[] = [];
    for (let attempt = 0; attempt < 3 && !results.length; attempt += 1) {
      results = search(arch, banned, used, rand, false).filter(
        (r) => arch.valid(r.team, r.e) && weakStructureOk(r.e, arch),
      );
    }
    if (!results.length) {
      strict = false;
      for (let attempt = 0; attempt < 3 && !results.length; attempt += 1) {
        results = search(arch, banned, used, rand, true).filter(
          (r) => arch.valid(r.team, r.e) && weakStructureOk(r.e, arch),
        );
      }
    }
    if (!results.length) {
      // 诊断：把最接近的一组打出来，方便调约束
      const probe = search(arch, banned, used, rand, true).sort((a, b) => a.score - b.score)[0];
      if (probe) {
        const v = arch.violations(probe.team, probe.e);
        rejected.push(
          `${arch.label}（无合格组合；最接近：${probe.team.map((p) => p.name).join('/')} 违反 ${v} 项｜覆盖 ${probe.e.coverage}｜共同弱点 ${probe.e.sharedWeakCount}｜接住 ${probe.e.coveredSpots}/${probe.e.weakSpots}｜角色缺 ${missingRoles(probe.team)}｜厚血 ${probe.team.filter((p) => p.bulk >= 330).length}｜反打 ${probe.team.filter((p) => p.traitTags.has('comeback')).length}｜同一系最多打 ${probe.e.worstWeakCount} 只）`,
        );
      } else {
        rejected.push(`${arch.label}（候选池不足）`);
      }
      continue;
    }
    // 质量下限：只在最优秀的前几个候选里按种子挑一个，保证「新」但不牺牲强度
    const best = results[0].score;
    const eligible = results.filter((r) => r.score >= best - Math.abs(best) * 0.03).slice(0, 3);
    const pick = eligible[Math.floor(rand() * eligible.length)] ?? results[0];
    for (const p of pick.team) used.add(p.base);
    chosen.push({ arch, cand: pick });
    console.log(
      `· ${arch.label}：${pick.team.map((p) => p.name).join(' / ')}｜score ${pick.score}｜覆盖 ${pick.e.coverage}/18｜共同弱点 ${pick.e.sharedWeakCount}${strict ? '' : '（放宽了上一轮去重）'}`,
    );
  }

  if (chosen.length < 3) {
    console.error(`只组出 ${chosen.length} 套，放弃写入。被拒绝的原型：${rejected.join('、') || '无'}`);
    process.exit(1);
  }

  const teams = chosen.map(({ arch, cand }) => buildTeam(arch, cand, round, banned));
  const updatedAt = beijingIso(args.now);
  const nextRotationAt = beijingIso(new Date(args.now.getTime() + INTERVAL_HOURS * 3600 * 1000));

  const file: TeamRotationFile = {
    round,
    updatedAt,
    nextRotationAt,
    intervalHours: INTERVAL_HOURS,
    generatedBy: 'scripts/rotate-teams.ts',
    dataset: { spiritCount: spirits.length, fetchedAt: meta.fetchedAt },
    previous: last
      ? { round: last.round, updatedAt: last.updatedAt, archetypes: last.archetypes }
      : null,
    archetypes: chosen.map(({ arch }) => ({ id: arch.id, label: arch.label })),
    teams: teams.map((t) => t.preset),
  };

  const metaRound: RotationRoundMeta = {
    round,
    updatedAt,
    nextRotationAt,
    archetypes: file.archetypes,
    teams: teams.map((t) => ({
      id: t.preset.id,
      name: t.preset.name,
      category: t.preset.category,
      archetype: t.preset.archetype,
      archetypeLabel: t.preset.archetypeLabel,
      spiritIds: t.preset.members.map((m) => m.spiritId),
      spiritNames: t.preset.members.map((m) => BY_ID.get(m.spiritId)?.name ?? m.spiritId),
    })),
    spiritIds: teams.flatMap((t) => t.preset.members.map((m) => m.spiritId)),
  };

  console.log('\n=== 第 ' + round + ' 轮');
  for (const { preset, e } of teams) {
    console.log(
      `${preset.name}（${preset.archetypeLabel}）｜平均 ${e.avgTotal}｜最快 ${e.fastest?.spe}｜覆盖 ${e.coverage}/18｜共同弱点 ${e.sharedWeakCount}｜弱点接住 ${e.coveredSpots}/${e.weakSpots}`,
    );
    console.log(
      '   ' +
        preset.members
          .map((m) => {
            const sp = BY_ID.get(m.spiritId);
            return `${sp?.name}(${sp?.types.join('/')})·${m.role}`;
          })
          .join(' / '),
    );
  }
  console.log(`更新时间 ${updatedAt}｜下次 ${nextRotationAt}`);
  if (rejected.length) console.log(`跳过：${rejected.join('、')}`);

  if (args.dry) {
    console.log('\n--dry：没有写文件。');
    return;
  }

  fs.writeFileSync(ROTATION_PATH, `${JSON.stringify(file, null, 1)}\n`);
  const rounds = [...history.rounds.filter((r) => r.round !== round), metaRound].sort((a, b) => a.round - b.round);
  fs.writeFileSync(HISTORY_PATH, `${JSON.stringify({ rounds }, null, 1)}\n`);
  console.log(`\n写入 ${path.relative(ROOT, ROTATION_PATH)} 与 ${path.relative(ROOT, HISTORY_PATH)}`);
}

main();
