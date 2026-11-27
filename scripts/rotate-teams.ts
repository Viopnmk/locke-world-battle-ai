/**
 * 48 小时自动轮换阵容引擎（v2：能量优先 / 证据优先）
 *
 *   npm run rotate:teams                 # 生成下一轮 3 套阵容
 *   npm run rotate:teams -- --if-due     # 定时任务：没到 nextRotationAt 就不做
 *   npm run rotate:teams -- --dry        # 只打印，不写盘
 *   npm run rotate:teams -- --refresh    # 阵容不变，按当前数据重写全部文案（同样先校验后落盘）
 *   npm run rotate:teams -- --round=3    # 指定轮次（默认当前 + 1）
 *
 * 与 v1 的区别（对应审计报告的问题）：
 *   · 新增能量模型（src/lib/energy.ts）：上场能量 / 技能能耗 / 回能 分开算，
 *     10 点上限逐只校验，0 能量特性和突破上限特性分别处理；
 *   · 组队按 dex 去重（同图鉴编号的两个形态不能同队），默认排除 68 只首领形态；
 *   · 配招先点特性再挑招：特性要迸发/回能/0 费/某系技能，就从学习面里把触发源选进来；
 *   · 联动只从「原文能对上」的模板生成，每条带 evidence 与 confidence，
 *     拉不上关系的（例如抬费特性扯伤害）直接不生成；
 *   · 打击面一律按「推荐 4 招」算，另附「全学习面」作参考，两个口径不混写；
 *   · 先跑 scripts/lib/team-audit.ts 全量校验，通过才备份 + 临时文件 + 原子 rename 落盘。
 *
 * 三种战术方向固定（每 48 小时在同一方向内重新搜人）：
 *   1. 高爆发输出（burst / nuke）
 *   2. 均衡攻防（balance / mixed）
 *   3. 能量经济与持续作战（energy / sustain）
 */
import fs from 'node:fs';
import path from 'node:path';
import { equippableSkills } from '../src/lib/equip-rules';
import { ENERGY_CAP, ENERGY_RULES, GATHER_GAIN, entryEnergy, memberEnergy, skillEnergyEffect, teamEnergy, teamEnergyLine, traitEnergyFacts } from '../src/lib/energy';
import { meta, skillsOf, spirits, spiritsById } from '../src/lib/spirits';
import { teamConflicts, traitActivation, traitNeeds } from '../src/lib/trait-rules';
import { matchup, TYPE_ORDER } from '../src/lib/typeChart';
import { auditRotation } from './lib/team-audit';
import type {
  AnalysisBlock,
  BattlePhase,
  ChainStep,
  Confidence,
  LeadPlan,
  MemberEnergyData,
  PresetMember,
  PresetSkillRef,
  RotationHistoryFile,
  TeamAnalysis,
  TeamCategory,
  TeamPreset,
  TeamRotationFile,
} from '../src/lib/team-types';
import type { ResolvedSkill, Spirit } from '../src/lib/types';

/* ------------------------------------------------------------------ 基础 */

const ROOT = process.cwd();
const DATA_DIR = path.join(ROOT, 'src/data');
const ROTATION_PATH = path.join(DATA_DIR, 'team-rotation.json');
const HISTORY_PATH = path.join(DATA_DIR, 'rotation-history.json');
const BACKUP_DIR = path.join(DATA_DIR, '.backup');
const INTERVAL_HOURS = 48;
const TZ_OFFSET_MINUTES = 8 * 60;

const round1 = (n: number) => Math.round(n * 10) / 10;
const mean = (arr: number[]) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0);
const shortName = (name: string) => name.replace(/（[^）]*）/g, '');
const cost = (sk: ResolvedSkill) => (typeof sk.energy === 'number' ? sk.energy : 0);
const isDmg = (sk: ResolvedSkill) => (sk.power ?? 0) > 0;

function beijingIso(date: Date): string {
  const shifted = new Date(date.getTime() + TZ_OFFSET_MINUTES * 60 * 1000);
  const p = (n: number) => String(n).padStart(2, '0');
  return (
    `${shifted.getUTCFullYear()}-${p(shifted.getUTCMonth() + 1)}-${p(shifted.getUTCDate())}` +
    `T${p(shifted.getUTCHours())}:${p(shifted.getUTCMinutes())}:${p(shifted.getUTCSeconds())}+08:00`
  );
}

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

function effectPhrase(sk: ResolvedSkill, max = 40): string {
  const t = (sk.effect ?? '').replace(/\s+/g, '');
  const cut = t.search(/[。；]/);
  const head = cut > 0 ? t.slice(0, cut) : t;
  return head.length > max ? `${head.slice(0, max)}…` : head;
}

function skillTag(sk: ResolvedSkill): string {
  const bits = [sk.type, sk.category];
  if (sk.power) bits.push(`威力${sk.power}`);
  bits.push(`${cost(sk)}费`);
  return `${sk.name}（${bits.join('·')}）`;
}

/* ------------------------------------------------------------------ 战术方向 */

type Role = '先手' | '核心输出' | '控制' | '辅助' | '承伤' | '收割';
const ROLES: Role[] = ['先手', '核心输出', '控制', '辅助', '承伤', '收割'];

interface Archetype {
  id: string;
  label: string;
  category: TeamCategory;
  sub: string;
  /** 组队权重 */
  w: { coverage: number; answers: number; traits: number; energy: number; speed: number; total: number; power: number };
  /** 角色优先级：先手 → … */
  roleBias: Record<Role, number>;
}

const ARCHETYPES: Archetype[] = [
  {
    id: 'burst',
    label: '高爆发输出',
    category: 'nuke',
    sub: '先手压血 · 单发最痛 · 高费换高伤',
    w: { coverage: 3.0, answers: 1.6, traits: 6, energy: 1.4, speed: 3.2, total: 0.02, power: 0.06 },
    roleBias: { 先手: 1.2, 核心输出: 1.4, 控制: 0.6, 辅助: 0.7, 承伤: 0.8, 收割: 1.1 },
  },
  {
    id: 'balance',
    label: '均衡攻防',
    category: 'mixed',
    sub: '联防接住 · 能打能抗 · 不靠单点',
    w: { coverage: 2.9, answers: 3.2, traits: 6, energy: 2.2, speed: 1.4, total: 0.035, power: 0.03 },
    roleBias: { 先手: 1.0, 核心输出: 1.1, 控制: 1.0, 辅助: 1.1, 承伤: 1.3, 收割: 1.0 },
  },
  {
    id: 'energy',
    label: '能量经济与持续作战',
    category: 'sustain',
    sub: '低耗续航 · 抽能压制 · 把 10 点用满',
    w: { coverage: 2.8, answers: 2.4, traits: 6, energy: 4.4, speed: 1.0, total: 0.02, power: 0.02 },
    roleBias: { 先手: 1.0, 核心输出: 0.9, 控制: 1.4, 辅助: 1.4, 承伤: 1.2, 收割: 0.9 },
  },
];

/* ------------------------------------------------------------------ 画像 */

interface Profile {
  spirit: Spirit;
  id: string;
  dex: string;
  name: string;
  types: string[];
  total: number;
  hp: number;
  atk: number;
  spa: number;
  def: number;
  spd: number;
  spe: number;
  bulk: number;
  mainAtk: number;
  physical: boolean;
  entry: number;
  cap: number;
  overCap: boolean;
  pool: ResolvedSkill[];
  dmg: ResolvedSkill[];
  defense: ResolvedSkill[];
  support: ResolvedSkill[];
  control: ResolvedSkill[];
  speedUp: ResolvedSkill[];
  boost: ResolvedSkill[];
  sweeper: ResolvedSkill[];
  learnCoverage: string[];
  weak: string[];
  resist: string[];
  needs: ReturnType<typeof traitNeeds>;
  traitText: string;
  /** 负面前提：入场掉半血、力竭给对手加成、入场 0 能量 */
  drawback: boolean;
}

const stabOf = (p: Profile, sk: ResolvedSkill) => (p.types.includes(sk.type) ? 1.25 : 1);
const effPower = (p: Profile, sk: ResolvedSkill) => {
  if (!isDmg(sk)) return 0;
  const atk = sk.category === '魔法' ? p.spa : p.atk;
  return (sk.power ?? 0) * stabOf(p, sk) * (atk / 100);
};

function buildProfile(spirit: Spirit): Profile {
  const e = entryEnergy(spirit);
  const pool = equippableSkills(spirit, skillsOf(spirit));
  const dmg = pool.filter(isDmg);
  const hp = spirit.stats.hp ?? 0;
  const atk = spirit.stats.atk ?? 0;
  const spa = spirit.stats.spa ?? 0;
  const def = spirit.stats.def ?? 0;
  const spd = spirit.stats.spd ?? 0;
  const spe = spirit.stats.spe ?? 0;
  const physical = atk >= spa;
  const learnCoverage = TYPE_ORDER.filter((t) => dmg.some((sk) => matchup(sk.type, [t]).multiplier >= 2));
  const defMul = (atkType: string) => matchup(atkType, spirit.type).multiplier;
  const support = pool.filter((sk) => /回复\d+能量|为场下|己方精灵|全技能威力|减伤\d+%|回复\d+%生命/.test(sk.effect ?? ''));
  const control = pool.filter((sk) => /能耗\+\d|失去\d+能量|偷取\d+能量|冻结|中毒|灼烧|速度-\d|先手-1/.test(sk.effect ?? ''));
  const speedUp = pool.filter((sk) => /速度\+\d|先手\+\d|迅捷/.test(sk.effect ?? ''));
  const boost = pool.filter((sk) => /物攻\+|魔攻\+|全技能威力\+|技能威力\+\d|连击数\+/.test(sk.effect ?? ''));
  const sweeper = pool.filter((sk) => isDmg(sk) && /先手\+\d|若敌方能量|若敌方本回合更换精灵|若自己生命高于|若使用本技能击败/.test(sk.effect ?? ''));

  return {
    spirit,
    id: spirit.id,
    dex: spirit.dex,
    name: spirit.name,
    types: spirit.type,
    total: spirit.stats.total ?? 0,
    hp,
    atk,
    spa,
    def,
    spd,
    spe,
    bulk: hp + def + spd,
    mainAtk: Math.max(atk, spa),
    physical,
    entry: e.base + e.stealOnEntry,
    cap: e.cap,
    overCap: e.overCap,
    pool,
    dmg,
    defense: pool.filter((sk) => /减伤\d+%/.test(sk.effect ?? '')).sort((a, b) => (Number(/减伤(\d+)%/.exec(b.effect)?.[1] ?? 0)) - Number(/减伤(\d+)%/.exec(a.effect)?.[1] ?? 0)),
    support,
    control,
    speedUp,
    boost,
    sweeper,
    learnCoverage,
    weak: TYPE_ORDER.filter((t) => defMul(t) >= 2),
    resist: TYPE_ORDER.filter((t) => defMul(t) <= 0.5),
    needs: traitNeeds(spirit.trait?.effect),
    traitText: spirit.trait ? `${spirit.trait.name}：${spirit.trait.effect}` : '',
    drawback: /失去自己一半的当前生命|自己力竭时，敌方|初始能量为0/.test(spirit.trait?.effect ?? ''),
  };
}

const EXCLUDE_NAMES = new Set(['学院呱呱']);
/** 68 只首领形态：无法确认是否可上场 PvP，默认不选（报告与页面都写明） */
const POOL: Profile[] = (() => {
  const raw = spirits
    .filter((s) => (s.stats.total ?? 0) > 0)
    .filter((s) => !/lord/.test(s.form))
    .filter((s) => !EXCLUDE_NAMES.has(s.name))
    .map(buildProfile)
    .filter((p) => p.pool.length >= 4 && p.dmg.length >= 2)
    .filter((p) => p.total >= 460);
  // 同 dex 只留最强形态：这样组队天然满足「同图鉴编号不能同队」
  const best = new Map<string, Profile>();
  for (const p of raw) {
    const cur = best.get(p.dex);
    if (!cur || p.total > cur.total || (p.total === cur.total && p.pool.length > cur.pool.length)) best.set(p.dex, p);
  }
  return [...best.values()].sort((a, b) => b.total - a.total);
})();

const BY_ID = new Map(POOL.map((p) => [p.id, p]));

/* ------------------------------------------------------------------ 配招 */

interface SkillPick {
  chosen: ResolvedSkill[];
  notes: Map<string, { slot: string; why: string }>;
}

function roleUtility(sk: ResolvedSkill, role: Role): number {
  const t = sk.effect ?? '';
  let s = 0;
  if (role === '先手') {
    if (/速度\+\d/.test(t)) s += 40;
    if (/先手\+\d|迅捷/.test(t)) s += 45;
    if (/减伤\d+%/.test(t)) s += 10;
  } else if (role === '控制') {
    if (/全技能能耗\+\d|能耗\+\d/.test(t)) s += 40;
    if (/失去\d+能量|偷取\d+能量/.test(t)) s += 45;
    if (/冻结|中毒|灼烧|萌化/.test(t)) s += 25;
    if (/速度-\d|先手-1/.test(t)) s += 20;
  } else if (role === '辅助') {
    if (/为场下|己方精灵|全队/.test(t)) s += 45;
    if (/回复\d+能量/.test(t)) s += 35;
    if (/回复\d+%生命/.test(t)) s += 20;
    if (/全技能威力\+|物攻\+|魔攻\+/.test(t)) s += 15;
    if (/减伤\d+%/.test(t)) s += 15;
  } else if (role === '承伤') {
    if (/减伤\d+%/.test(t)) s += 50;
    if (/应对攻击/.test(t)) s += 15;
    if (/回复\d+%生命/.test(t)) s += 10;
  } else if (role === '核心输出') {
    if (/物攻\+|魔攻\+/.test(t)) s += 35;
    if (/技能威力\+\d|全技能威力\+/.test(t)) s += 30;
    if (/连击数\+\d/.test(t)) s += 15;
  } else if (role === '收割') {
    if (/先手\+\d/.test(t)) s += 40;
    if (/若敌方能量|若敌方本回合更换精灵|若使用本技能击败/.test(t)) s += 30;
    if (/速度\+\d/.test(t)) s += 15;
  }
  // 能耗越低越好（同分时排序用）
  return s - cost(sk) * 2;
}

/** 特性需要的触发技：从学习面里挑最便宜的能满足的那一个 */
function triggerPicks(p: Profile): { need: string; skill: ResolvedSkill }[] {
  const out: { need: string; skill: ResolvedSkill }[] = [];
  for (const need of p.needs) {
    if (!need.matchSkill) continue;
    const fit = p.pool
      .filter((sk) => need.matchSkill!(sk))
      .filter((sk) => cost(sk) <= Math.max(p.entry, 2))
      .sort((a, b) => cost(a) - cost(b) || effPower(p, b) - effPower(p, a))[0];
    if (fit) out.push({ need: need.label, skill: fit });
  }
  return out;
}

/**
 * 给一只精灵选 4 招：
 *   1) 主攻（本系/非本系取有效威力最高，且尽量入场就付得起）
 *   2) 特性触发技（迸发 / 回能 / 0 费 / 某系技能…）
 *   3) 补盲（覆盖团队还没打到的属性）
 *   4) 角色功能技（先手提速 / 控制抽能 / 辅助回能 / 承伤减伤 / 强化 / 收割）
 */
function chooseSkills(p: Profile, role: Role, covered: Set<string>, allowBurst: boolean, costCeiling = ENERGY_CAP): SkillPick {
  // 硬约束：单招能耗不能超过 10 点上限，除非这只精灵有「突破上限」特性
  const pool = p.pool.filter((sk) => cost(sk) <= (p.overCap ? 30 : ENERGY_CAP));
  const chosen: ResolvedSkill[] = [];
  const notes = new Map<string, { slot: string; why: string }>();
  const take = (sk: ResolvedSkill, slot: string, why: string) => {
    if (chosen.length >= 4 || chosen.some((c) => c.name === sk.name)) return false;
    if (chosen.filter((c) => c.learn === 2).length + (sk.learn === 2 ? 1 : 0) > 1) return false;
    chosen.push(sk);
    notes.set(sk.name, { slot, why });
    return true;
  };

  const affordable = p.dmg.filter((sk) => cost(sk) <= Math.max(p.entry, 1));
  const budget = Math.min(allowBurst ? ENERGY_CAP : Math.max(p.entry, 2), costCeiling);

  // 1) 主攻
  const mainPool = (affordable.length ? affordable : p.dmg).filter((sk) => cost(sk) <= budget);
  const main = [...mainPool].sort((a, b) => effPower(p, b) - effPower(p, a) || cost(a) - cost(b))[0] ?? p.dmg[0];
  if (main) {
    const hits = TYPE_ORDER.filter((t) => matchup(main.type, [t]).multiplier >= 2).slice(0, 3);
    take(
      main,
      '主攻',
      `${main.type}系·${main.category}，威力 ${main.power}、${cost(main)} 费，本系加成后有效威力 ${Math.round(effPower(p, main))}${hits.length ? `，对 ${hits.join('、')} 打出 ×2` : '，属性上打不出 ×2，靠威力硬吃'}`,
    );
  }

  // 2) 特性触发技（一条特性最多两格）
  let triggers = 0;
  for (const { need, skill } of triggerPicks(p)) {
    if (triggers >= 2) break;
    if (take(skill, '机制', `点亮特性：${need}；${skill.type}·${skill.category}，${cost(skill)} 费，${effectPhrase(skill)}`)) triggers += 1;
  }

  // 3) 补盲
  const coverageRank = (sk: ResolvedSkill) => {
    const fresh = TYPE_ORDER.filter((t) => matchup(sk.type, [t]).multiplier >= 2 && !covered.has(t)).length;
    return fresh * 120 + effPower(p, sk) / 6 - cost(sk) * 3;
  };
  const blind = p.dmg
    .filter((sk) => !chosen.some((c) => c.name === sk.name))
    .filter((sk) => cost(sk) <= budget)
    .sort((a, b) => coverageRank(b) - coverageRank(a))[0];
  if (blind) {
    const fresh = TYPE_ORDER.filter((t) => matchup(blind.type, [t]).multiplier >= 2 && !covered.has(t));
    take(
      blind,
      '补盲',
      `${blind.type}系·威力 ${blind.power}·${cost(blind)} 费，补上 ${fresh.slice(0, 4).join('、') || '同系叠加'} 的 ×2 打击面`,
    );
  }

  // 4) 角色功能技
  const rolePool = [...pool]
    .filter((sk) => !chosen.some((c) => c.name === sk.name))
    .sort((a, b) => roleUtility(b, role) - roleUtility(a, role) || cost(a) - cost(b));
  const util = rolePool.find((sk) => roleUtility(sk, role) > 0);
  if (util) {
    take(util, '功能', `${role}位：${util.type}·${util.category}，${cost(util)} 费，${effectPhrase(util)}`);
  }

  // 5) 补满：先补覆盖再补最便宜的可用招
  while (chosen.length < 4) {
    const rest = pool.filter((sk) => !chosen.some((c) => c.name === sk.name));
    if (!rest.length) break;
    const next =
      [...rest].sort((a, b) => coverageRank(b) - coverageRank(a) || effPower(p, b) - effPower(p, a) || cost(a) - cost(b))[0] ??
      rest[0];
    take(next, '补位', `${next.type}·${next.category}，${cost(next)} 费，${effectPhrase(next)}`);
  }

  // 6) 兜底：若 4 招里没有任何入场可用的输出（0 能量特性），换一个 0 费/低费招进来
  if (chosen.length === 4 && !chosen.some((sk) => isDmg(sk) && cost(sk) <= Math.max(p.entry, 0))) {
    const cheap = pool
      .filter((sk) => isDmg(sk) && cost(sk) <= Math.max(p.entry, 1))
      .sort((a, b) => cost(a) - cost(b) || effPower(p, b) - effPower(p, a))[0];
    if (cheap && !chosen.some((c) => c.name === cheap.name)) {
      const drop = chosen.findIndex((sk) => !isDmg(sk)) >= 0 ? chosen.findIndex((sk) => !isDmg(sk)) : 3;
      chosen.splice(drop, 1);
      take(cheap, '低耗', `入场 ${p.entry} 点就能打：${cheap.type}·威力 ${cheap.power}·${cost(cheap)} 费`);
    }
  }

  return { chosen, notes };
}

/* ------------------------------------------------------------------ 评分 */

interface MemberSet {
  profile: Profile;
  role: Role;
  chosen: ResolvedSkill[];
  notes: Map<string, { slot: string; why: string }>;
}

function coverageOfSets(sets: MemberSet[], useLearnset = false): Set<string> {
  const out = new Set<string>();
  for (const m of sets) {
    const list = useLearnset ? m.profile.dmg : m.chosen.filter(isDmg);
    for (const sk of list) {
      for (const t of TYPE_ORDER) if (matchup(sk.type, [t]).multiplier >= 2) out.add(t);
    }
  }
  return out;
}

function answerScore(sets: MemberSet[]): { score: number; weak: { type: string; count: number; answers: string[] }[] } {
  const weak: { type: string; count: number; answers: string[] }[] = [];
  let score = 0;
  for (const t of TYPE_ORDER) {
    const hit = sets.filter((m) => matchup(t, m.profile.types).multiplier >= 2);
    if (!hit.length) continue;
    const answers = sets.filter((m) => matchup(t, m.profile.types).multiplier <= 0.5).map((m) => m.profile.name);
    weak.push({ type: t, count: hit.length, answers });
    score += hit.length * (answers.length ? 1.6 : -2.4);
  }
  return { score, weak };
}

function scoreTeam(sets: MemberSet[], arch: Archetype): number {
  const cov = coverageOfSets(sets).size;
  const { score: ans } = answerScore(sets);
  const energySets = sets.map((m) => ({ spirit: m.profile.spirit, chosen: m.chosen }));
  const eng = teamEnergy(energySets);
  const traits = sets.map((m) => traitActivation(m.profile.spirit, m.chosen, energySets.map((e) => ({ spirit: e.spirit, chosen: e.chosen }))));
  const active = traits.filter((t) => t.status !== 'idle').length;
  const idle = traits.filter((t) => t.status === 'idle').length;
  const fast = sets.filter((m) => m.profile.spe >= 120).length;
  const avgTotal = mean(sets.map((m) => m.profile.total));
  const maxPower = Math.max(...sets.flatMap((m) => m.chosen.filter(isDmg).map((sk) => sk.power ?? 0)));
  const lowCost = sets.filter((m) => eng.members.find((x) => x.spiritId === m.profile.id)?.status === 'ready').length;
  const zeroCost = sets.filter((m) => m.chosen.some((sk) => cost(sk) === 0)).length;
  const w = arch.w;
  // 10 费大招在均衡/经济队里是负分：一发就把能量打空
  const burstTax = arch.id === 'burst' ? 0 : Math.max(0, eng.maxCost - 7) * 2.2;
  const drawbackTax = sets.filter((m) => m.profile.drawback).length * 10;
  const conflictTax = teamConflicts(energySets).length * 14;
  // 能量经济方向：优先带「入场垫能 / 离场回能 / 每回合回能 / 抽能」这类能量特性的精灵
  const energyTraitCount = sets.filter((m) => {
    const facts = traitEnergyFacts(m.profile.spirit.trait?.effect);
    return Boolean(facts && ['zero-type-skill', 'zero-respond', 'leave-refill', 'turn-end-recover', 'drain-turn-end', 'steal-on-entry', 'overcap-gift'].includes(facts.rule.id));
  }).length;

  return (
    cov * w.coverage +
    ans * w.answers +
    active * w.traits -
    idle * 7 +
    lowCost * w.energy -
    eng.gatherCount * 1.6 -
    avgTotal * w.total +
    fast * w.speed +
    maxPower * w.power +
    zeroCost * (arch.id === 'energy' ? 3 : 0.4) -
    eng.avgCost * (arch.id === 'energy' ? 9 : 0.4) -
    burstTax -
    drawbackTax -
    conflictTax +
    energyTraitCount * (arch.id === 'energy' ? 5 : 0.5)
  );
}

/** 6! = 720 种角色分配里选贴合度最高的一种，避免「承伤位只有 85 血」这类错位 */
function assignRoles(sets: MemberSet[], arch: Archetype): MemberSet[] {
  const n = sets.length;
  let best = sets;
  let bestScore = -Infinity;
  const perm: number[] = [];
  const used = new Array(n).fill(false);
  const walk = () => {
    if (perm.length === n) {
      let score = 0;
      for (let i = 0; i < n; i += 1) score += roleFit(sets[i].profile, ROLES[perm[i]], arch);
      const roleOf = (role: Role) => sets[perm.indexOf(ROLES.indexOf(role))]?.profile;
      const tank = roleOf('承伤');
      const leadP = roleOf('先手');
      const fastest = [...sets].sort((a, b) => b.profile.spe - a.profile.spe)[0].profile;
      if (tank && tank.bulk < 360) score -= (360 - tank.bulk) * 3;
      if (tank && tank.drawback) score -= 1e6;
      if (leadP) score -= Math.max(0, fastest.spe - leadP.spe) * 4;
      if (score > bestScore) {
        bestScore = score;
        best = sets.map((m, i) => ({ ...m, role: ROLES[perm[i]] }));
      }
      return;
    }
    for (let r = 0; r < n; r += 1) {
      if (used[r]) continue;
      used[r] = true;
      perm.push(r);
      walk();
      perm.pop();
      used[r] = false;
    }
  };
  walk();
  return best;
}

/** 角色定下来之后，按角色重挑 4 招（承伤位优先减伤，控制位优先抽能…） */
function rechooseByRole(sets: MemberSet[], arch: Archetype): MemberSet[] {
  const ceiling = arch.id === 'energy' ? 5 : ENERGY_CAP;
  let covered = coverageOfSets(sets);
  let out = sets.map((m) => {
    const pick = chooseSkills(m.profile, m.role, covered, arch.id === 'burst', ceiling);
    return { profile: m.profile, role: m.role, chosen: pick.chosen, notes: pick.notes };
  });
  covered = coverageOfSets(out);
  out = out.map((m) => {
    const pick = chooseSkills(m.profile, m.role, covered, arch.id === 'burst', ceiling);
    return { profile: m.profile, role: m.role, chosen: pick.chosen, notes: pick.notes };
  });
  return out;
}

/* ------------------------------------------------------------------ 组队 */

function initialSets(team: Profile[], arch: Archetype): MemberSet[] {
  const covered = new Set<string>();
  const sets: MemberSet[] = [];
  team.forEach((p, i) => {
    const role = ROLES[i];
    const pick = chooseSkills(p, role, covered, arch.id === 'burst');
    for (const sk of pick.chosen) {
      if (!isDmg(sk)) continue;
      for (const t of TYPE_ORDER) if (matchup(sk.type, [t]).multiplier >= 2) covered.add(t);
    }
    sets.push({ profile: p, role, chosen: pick.chosen, notes: pick.notes });
  });
  return sets;
}

function finalizeSets(team: Profile[], arch: Archetype): MemberSet[] {
  // 第一遍定初稿，第二遍用全队覆盖反过来补缺口
  let sets = initialSets(team, arch);
  const covered = coverageOfSets(sets);
  sets = sets.map((m, i) => {
    const role = ROLES[i];
    const gaps = new Set(TYPE_ORDER.filter((t) => !covered.has(t)));
    const pick = chooseSkills(m.profile, role, new Set([...covered].filter((t) => t !== '')), arch.id === 'burst');
    // 若该精灵有招能补全队缺口，且换掉的不是主攻，则换
    const gapSkill = m.profile.dmg
      .filter((sk) => !pick.chosen.some((c) => c.name === sk.name))
      .filter((sk) => cost(sk) <= Math.max(m.profile.entry, 2))
      .filter((sk) => TYPE_ORDER.some((t) => gaps.has(t) && matchup(sk.type, [t]).multiplier >= 2))
      .sort((a, b) => effPower(m.profile, b) - effPower(m.profile, a))[0];
    if (gapSkill && pick.chosen.length === 4) {
      const drop = pick.chosen.findIndex((sk, idx) => idx > 0 && !isDmg(sk));
      const victim = drop >= 0 ? drop : 3;
      const removed = pick.chosen[victim];
      pick.chosen.splice(victim, 1);
      pick.chosen.push(gapSkill);
      pick.notes.delete(removed.name);
      pick.notes.set(gapSkill.name, {
        slot: '补盲',
        why: `${gapSkill.type}系·威力 ${gapSkill.power}·${cost(gapSkill)} 费，补全队缺口 ${TYPE_ORDER.filter((t) => gaps.has(t) && matchup(gapSkill.type, [t]).multiplier >= 2).join('、')}`,
      });
    }
    return { profile: m.profile, role, chosen: pick.chosen, notes: pick.notes };
  });
  return sets;
}

function roleFit(p: Profile, role: Role, arch: Archetype): number {
  // 承伤位不能是「入场掉半血 / 力竭资敌 / 初始 0 能量」这类有负面前提的精灵
  if (role === '承伤' && p.drawback) return -1e9;
  const bestDmg = [...p.dmg].sort((a, b) => effPower(p, b) - effPower(p, a))[0];
  const cheapDmg = p.dmg.filter((sk) => cost(sk) <= Math.max(p.entry, 2));
  const base =
    role === '先手'
      ? p.spe * 1.1 + (p.speedUp.length ? 12 : 0) + (cheapDmg.length ? 8 : 0)
      : role === '核心输出'
        ? p.mainAtk * 0.9 + (bestDmg ? effPower(p, bestDmg) / 12 : 0) + p.total * 0.02
        : role === '控制'
          ? p.control.length * 9 + p.spe * 0.3
          : role === '辅助'
            ? p.support.length * 8 + p.bulk * 0.08 + (p.speedUp.length ? 6 : 0)
            : role === '承伤'
              ? p.hp * 0.45 + p.def * 0.45 + p.spd * 0.35 + p.defense.length * 8 - (p.drawback ? 45 : 0)
              : p.spe * 0.8 + p.sweeper.length * 10 + (bestDmg ? (bestDmg.power ?? 0) * 0.1 : 0);
  return base * (arch.roleBias[role] ?? 1);
}

function teamOf(sets: MemberSet[]): Profile[] {
  return sets.map((s) => s.profile);
}

function pickRoleCandidate(
  role: Role,
  arch: Archetype,
  base: Profile[],
  pool: Profile[],
  usedIds: Set<string>,
  bannedIds: Set<string>,
): Profile | null {
  const slotIndex = ROLES.indexOf(role);
  const candidates = pool
    .filter((p) => !usedIds.has(p.id) && !bannedIds.has(p.id) && !base.some((b) => b.dex === p.dex))
    .filter((p) => (role === '承伤' ? p.bulk >= 360 && p.hp >= 90 && !p.drawback : true))
    .filter((p) => (role === '先手' ? p.spe >= 105 : true))
    .filter((p) => (role === '核心输出' ? p.mainAtk >= 100 : true))
    .sort((a, b) => roleFit(b, role, arch) - roleFit(a, role, arch))
    .slice(0, 30);

  let best: Profile | null = null;
  let bestScore = -Infinity;
  for (const cand of candidates) {
    const team = [...base];
    team[slotIndex] = cand;
    const filled = team.filter(Boolean) as Profile[];
    if (filled.length < slotIndex + 1) continue;
    const sets = initialSets(filled, arch);
    const score = scoreTeam(sets, arch) + roleFit(cand, role, arch) * 0.15;
    if (score > bestScore) {
      bestScore = score;
      best = cand;
    }
  }
  return best;
}

function buildTeam(arch: Archetype, bannedIds: Set<string>, seed: number): MemberSet[] {
  const used = new Set<string>();
  const team: Profile[] = [];
  const rand = mulberry32(seed);

  for (const role of ROLES) {
    const chosen = pickRoleCandidate(role, arch, team, POOL, used, bannedIds);
    if (!chosen) break;
    team.push(chosen);
    used.add(chosen.id);
  }
  // 池子足够大时不应该凑不满；万一凑不满，允许放宽上一轮去重
  if (team.length < 6) {
    for (const role of ROLES) {
      if (team.length >= 6) break;
      const chosen = pickRoleCandidate(role, arch, team, POOL, used, new Set());
      if (!chosen) continue;
      team.push(chosen);
      used.add(chosen.id);
    }
  }

  let sets = finalizeSets(team, arch);
  let bestScore = scoreTeam(sets, arch);

  // 局部爬山：每个位置换一个更合适的，最多 3 轮
  for (let pass = 0; pass < 3; pass += 1) {
    let improved = false;
    for (let i = 0; i < sets.length; i += 1) {
      const role = ROLES[i];
      const others = sets.filter((_, j) => j !== i);
      const othersIds = new Set(others.map((m) => m.profile.id));
      const othersDex = new Set(others.map((m) => m.profile.dex));
      const alternates = POOL.filter((p) => !othersIds.has(p.id) && !othersDex.has(p.dex) && !bannedIds.has(p.id))
        .sort((a, b) => roleFit(b, role, arch) - roleFit(a, role, arch) + (rand() - 0.5) * 0.001)
        .slice(0, 30);
      for (const alt of alternates) {
        if (alt.id === sets[i].profile.id) continue;
        const trialTeam = [...others.map((m) => m.profile)];
        trialTeam.splice(i, 0, alt);
        const trial = finalizeSets(trialTeam, arch);
        const trialScore = scoreTeam(trial, arch);
        if (trialScore > bestScore + 0.01) {
          sets = trial;
          bestScore = trialScore;
          improved = true;
          break;
        }
      }
    }
    if (!improved) break;
  }

  sets = assignRoles(sets, arch);
  sets = rechooseByRole(sets, arch);
  sets = assignRoles(sets, arch);
  return sets;
}

/* ------------------------------------------------------------------ 文案 */

function metricsFor(sets: MemberSet[], eng: ReturnType<typeof teamEnergy>) {
  const cov = [...coverageOfSets(sets)];
  const learn = [...coverageOfSets(sets, true)];
  const { weak } = answerScore(sets);
  const fastest = [...sets].sort((a, b) => b.profile.spe - a.profile.spe)[0]?.profile ?? null;
  return {
    avgTotal: round1(mean(sets.map((m) => m.profile.total))),
    fastest: fastest ? { name: fastest.name, spe: fastest.spe } : null,
    coverageChosen: cov.length,
    coverageTypes: cov,
    coverageLearnset: learn.length,
    sharedWeak: weak.filter((w) => w.count >= 2).slice(0, 4),
    entryTotal: eng.entryTotal,
    avgCost: eng.avgCost,
    readyCount: eng.readyCount,
  };
}

function energyData(member: MemberSet): MemberEnergyData {
  const e = memberEnergy(member.profile.spirit, member.chosen);
  return {
    entry: e.usable,
    cap: e.entry.cap,
    entryLabel: e.entry.label,
    entryDetail: e.entry.detail,
    costs: e.costs.map((c) => c.energy),
    maxCost: e.maxCost,
    avgCost: e.avgCost,
    firstTurn: e.firstTurn ? { name: e.firstTurn.name, cost: e.firstTurn.cost, leftover: e.firstTurn.leftover } : null,
    gatherTurns: e.gatherTurnsForMax,
    recoveries: e.recoveries,
    status: e.status,
    caution: e.caution,
    confidence: e.entry.confidence,
  };
}

function dutyFor(m: MemberSet): string {
  const p = m.profile;
  switch (m.role) {
    case '先手':
      return `首发抢节奏（速 ${p.spe}）`;
    case '核心输出':
      return `队内最高有效威力（${p.physical ? '物攻' : '魔攻'} ${p.mainAtk}）`;
    case '控制':
      return `抽能/抬费/挂状态（${p.control.length} 个手段）`;
    case '辅助':
      return `回能/减伤/提速（${p.support.length} 个辅助技）`;
    case '承伤':
      return `吃一轮伤害（生命 ${p.hp}／物防 ${p.def}）`;
    default:
      return `残局收人头（速 ${p.spe}）`;
  }
}

function noteFor(m: MemberSet): string {
  const p = m.profile;
  const main = [...m.chosen].filter(isDmg).sort((a, b) => effPower(p, b) - effPower(p, a))[0];
  const e = memberEnergy(p.spirit, m.chosen);
  const bits = [`速 ${p.spe}／总 ${p.total}`];
  if (main) bits.push(`主招「${main.name}」威力 ${main.power}、${cost(main)} 费`);
  bits.push(`上场 ${e.usable} 点${e.firstTurn ? `，首回合可打「${e.firstTurn.name}」剩 ${e.firstTurn.leftover}` : '，首回合打不出招'}`);
  return `${bits.join('；')}。`;
}

function buildSummary(arch: Archetype, sets: MemberSet[], metrics: ReturnType<typeof metricsFor>, eng: ReturnType<typeof teamEnergy>): string {
  const top = [...sets].sort((a, b) => b.profile.total - a.profile.total)[0];
  return (
    `第 ${'ROUND'} 轮「${arch.label}」：6 只平均种族值 ${metrics.avgTotal}（最高 ${shortName(top.profile.name)} ${top.profile.total}），` +
    `最快 ${metrics.fastest ? `${shortName(metrics.fastest.name)} 速 ${metrics.fastest.spe}` : '—'}；` +
    `按推荐 4 招能打出 ≥2 倍伤害的属性 ${metrics.coverageChosen}/18（全学习面 ${metrics.coverageLearnset}/18，只作参考）。` +
    `6 只入场能量合计 ${eng.entryTotal} 点、4 招平均能耗 ${eng.avgCost}，入场即可出招 ${eng.readyCount}/6。`
  );
}

function buildPros(sets: MemberSet[], metrics: ReturnType<typeof metricsFor>, eng: ReturnType<typeof teamEnergy>): string[] {
  const fastest = metrics.fastest;
  const fast = sets.filter((m) => m.profile.spe >= 120).length;
  const missing = TYPE_ORDER.filter((t) => !metrics.coverageTypes.includes(t));
  const weakLines = metrics.sharedWeak.map((w) => `${w.type}×${w.count}${w.answers.length ? `（${w.answers.slice(0, 2).join('、')} 能接）` : '（没人接）'}`);
  const resistTypes = new Set<string>();
  for (const m of sets) for (const t of m.profile.resist) resistTypes.add(t);
  return [
    `面板：平均种族值 ${metrics.avgTotal}，最快 ${fastest ? `${shortName(fastest.name)} ${fastest.spe}` : '—'}，速度 ≥120 的 ${fast} 只。`,
    `打击面（推荐 4 招）：18 系里打得出 ≥2 倍的有 ${metrics.coverageChosen} 种${missing.length ? `，缺口 ${missing.join('、')}` : '，全系覆盖'}；全学习面 ${metrics.coverageLearnset} 种。`,
    `防御：${resistTypes.size} 种属性被至少一只以 ≤0.5 倍接住${weakLines.length ? `；共同弱点 ${weakLines.join('、')}` : '；没有两只共用同一个 ×2 弱点'}。`,
    `能量：入场合计 ${eng.entryTotal} 点，入场即出招 ${eng.readyCount}/6${eng.gatherCount ? `，需要先聚能 ${eng.gatherCount} 只` : '，全员入场即可出招'}；最高单招 ${eng.maxCost} 费，不超 10 点上限。`,
  ];
}

function buildRisk(sets: MemberSet[], metrics: ReturnType<typeof metricsFor>, eng: ReturnType<typeof teamEnergy>, arch: Archetype): string {
  const lines: string[] = [];
  const worst = metrics.sharedWeak[0];
  if (worst) {
    lines.push(
      `共同弱点：${worst.type}系一招能克制 ${worst.count} 只（${worst.answers.length ? `${worst.answers.join('、')} 能以 ≤0.5 倍接住` : '队里没人接得住'}）` +
        (metrics.sharedWeak.length > 1 ? `；其余共同弱点 ${metrics.sharedWeak.slice(1).map((w) => `${w.type}×${w.count}`).join('、')}` : ''),
    );
  }
  const slow = [...sets].sort((a, b) => a.profile.spe - b.profile.spe)[0];
  if (slow && slow.profile.spe < 90) lines.push(`速度短板：${shortName(slow.profile.name)} 只有 ${slow.profile.spe}，对上 120+ 的先手队会一直后手。`);
  const starved = sets.filter((m) => energyData(m).status !== 'ready');
  if (starved.length) {
    lines.push(`能量风险：${starved.map((m) => `${shortName(m.profile.name)}（${energyData(m).caution}）`).join('；')}`);
  } else {
    lines.push(`能量风险：4 招都在入场能量以内，但默认没有每回合回能，连打高费招仍要聚能（+${GATHER_GAIN}/回合）。`);
  }
  const idle = sets.filter((m) => traitActivation(m.profile.spirit, m.chosen, sets.map((s) => ({ spirit: s.profile.spirit, chosen: s.chosen }))).status === 'idle');
  if (idle.length) lines.push(`特性空转：${idle.map((m) => shortName(m.profile.name)).join('、')} 的特性在本套 4 招里没有触发源，已按「未触发」标注。`);
  if (arch.id === 'burst') lines.push('爆发方向代价：为了单发威力，部分招吃到 4~6 费，连招要提前算聚能。');
  if (arch.id === 'energy') lines.push('经济方向代价：单发威力不是最高，遇到高耐久坦克要靠抽能与磨血，不会两回合结束。');
  return lines.join(' ');
}

function buildLead(sets: MemberSet[]): LeadPlan {
  const lead = sets.find((m) => m.role === '先手') ?? [...sets].sort((a, b) => b.profile.spe - a.profile.spe)[0];
  const p = lead.profile;
  const e = memberEnergy(p.spirit, lead.chosen);
  const speedOrder = [...sets].sort((a, b) => b.profile.spe - a.profile.spe);
  const rank = speedOrder.findIndex((m) => m.profile.id === p.id) + 1;
  const usableTo = Math.max(e.usable, 0);
  const affordable = [...lead.chosen].filter(isDmg).filter((sk) => cost(sk) <= usableTo);
  const cheapBudget = affordable.filter((sk) => cost(sk) <= 5);
  const cheap = (cheapBudget.length ? cheapBudget : affordable).sort((a, b) => effPower(p, b) - effPower(p, a));
  const util =
    lead.chosen.find((sk) => !isDmg(sk) && cost(sk) <= usableTo) ??
    lead.chosen.find((sk) => cost(sk) <= usableTo);
  const openers: PresetSkillRef[] = [];
  const push = (sk: ResolvedSkill | undefined, slot: string) => {
    if (!sk || openers.some((o) => o.name === sk.name) || openers.length >= 2) return;
    openers.push({ name: sk.name, slot, energy: cost(sk), why: `${sk.type}·${sk.category}，${cost(sk)} 费，${effectPhrase(sk)}` });
  };
  push(util, '机制');
  push(cheap[0], '主攻');
  push(cheap[1], '主攻');
  if (!openers.length) push(lead.chosen[0], '主攻');

  const weakHere = p.weak;
  const weakCovered = weakHere.filter((t) => sets.some((m) => matchup(t, m.profile.types).multiplier <= 0.5));
  const cautionBits = [
    weakHere.length
      ? `本身 ${weakHere.length} 个 ×2 弱点（${weakHere.join('、')}）${weakCovered.length ? `，其中 ${weakCovered.join('、')} 有队友以 ≤0.5 倍接住` : '，队里没人抗'}`
      : '没有被 ×2 克制的属性',
    e.firstTurn ? `入场 ${e.usable} 点，第一回合能打「${e.firstTurn.name}」（${e.firstTurn.cost} 费）` : `入场 ${e.usable} 点，第一回合打不出输出，只能先聚能`,
  ];
  return {
    spiritId: p.id,
    why: `速度 ${p.spe}，队内第 ${rank}；${lead.chosen.some((sk) => /速度\+|先手\+|迅捷/.test(sk.effect ?? '')) ? `4 招里有提速/先手技「${lead.chosen.find((sk) => /速度\+|先手\+|迅捷/.test(sk.effect ?? ''))!.name}」` : '4 招都是直接出手的招'}，${p.resist.length ? `对 ${p.resist.slice(0, 3).join('、')} 有抗性` : '没有抗性'}`,
    openers,
    caution: cautionBits.join('；') + '。',
  };
}

interface SynergyDraft {
  title: string;
  text: string;
  spiritIds: string[];
  skills: { spiritId: string; name: string }[];
  confidence: Confidence;
  evidence?: string;
}

function buildSynergies(sets: MemberSet[], metrics: ReturnType<typeof metricsFor>): SynergyDraft[] {
  const out: SynergyDraft[] = [];
  const energySets = sets.map((s) => ({ spirit: s.profile.spirit, chosen: s.chosen }));
  const byTrait = (re: RegExp) => sets.filter((m) => re.test(m.profile.spirit.trait?.effect ?? ''));

  // 1) 抽能 / 抬费类特性 × 4 招里的触发技
  const darkTax = byTrait(/自己使用恶系技能后，敌方失去\d+能量/);
  for (const m of darkTax) {
    const trigger = m.chosen.filter((sk) => sk.type === '恶').sort((a, b) => cost(a) - cost(b))[0];
    if (!trigger) continue;
    const eff = skillEnergyEffect(trigger);
    out.push({
      title: `${shortName(m.profile.name)}「${m.profile.spirit.trait?.name}」× 「${trigger.name}」抽能`,
      text: `${shortName(m.profile.name)} 每一次打恶系技能，敌方就少 2 点能量；4 招里的「${trigger.name}」是 ${cost(trigger)} 费的恶系${trigger.category}（${effectPhrase(trigger)}），出手的同时就在压对手的 10 点上限——对手 3 费招本来能连打 3 次（9 点），被抽 1 次后只剩 2 次。`,
      spiritIds: [m.profile.id],
      skills: [{ spiritId: m.profile.id, name: trigger.name }],
      confidence: 'verified',
      evidence: m.profile.spirit.trait?.effect,
    });
    if (eff.selfFixed) break;
  }

  // 2) 回能技能喂「每回复1能量」类特性
  for (const m of byTrait(/每回复1能量/)) {
    const feeder = m.chosen
      .map((sk) => ({ sk, eff: skillEnergyEffect(sk) }))
      .filter((x) => x.eff.selfFixed > 0)
      .sort((a, b) => cost(a.sk) - cost(b.sk))[0];
    if (!feeder) continue;
    const per = Number(/每回复1能量[^。；]{0,12}\+(\d+)%/.exec(m.profile.spirit.trait?.effect ?? '')?.[1] ?? 0);
    out.push({
      title: `「${feeder.sk.name}」回能 → ${shortName(m.profile.name)} 特性成长`,
      text: `「${feeder.sk.name}」${cost(feeder.sk)} 费、${effectPhrase(feeder.sk)}，一次回 ${feeder.eff.selfFixed} 点能量；${shortName(m.profile.name)} 的特性是每回复 1 点能量${per ? ` +${per}% 双攻` : '叠一层'}，这一招等于同时补能量和补伤害。`,
      spiritIds: [m.profile.id],
      skills: [{ spiritId: m.profile.id, name: feeder.sk.name }],
      confidence: 'verified',
      evidence: m.profile.spirit.trait?.effect,
    });
  }

  // 3) 迸发 / 蓄力 / 0 费 三类「特性要什么、4 招给什么」
  for (const m of byTrait(/迸发/)) {
    const sk = m.chosen.find((s) => /迸发/.test(s.effect ?? ''));
    if (!sk) continue;
    out.push({
      title: `${shortName(m.profile.name)} 的迸发延长 × 「${sk.name}」`,
      text: `特性「${m.profile.spirit.trait?.name}」让迸发效果多持续 1 回合；4 招里的「${sk.name}」（${cost(sk)} 费）带迸发：${effectPhrase(sk)}，入场首次行动就能吃到延长。`,
      spiritIds: [m.profile.id],
      skills: [{ spiritId: m.profile.id, name: sk.name }],
      confidence: 'verified',
      evidence: m.profile.spirit.trait?.effect,
    });
  }
  for (const m of byTrait(/蓄力状态/)) {
    const sk = m.chosen.find((s) => /蓄力/.test(s.effect ?? '') && !/无需蓄力/.test(s.effect ?? ''));
    if (!sk) continue;
    out.push({
      title: `蓄力链：${shortName(m.profile.name)} 特性 × 「${sk.name}」`,
      text: `「${sk.name}」是蓄力技（${cost(sk)} 费，${effectPhrase(sk)}），每次进入蓄力都触发特性「${m.profile.spirit.trait?.name}」；蓄力那一回合不能攻击，所以它更适合中盘上场而不是残局。`,
      spiritIds: [m.profile.id],
      skills: [{ spiritId: m.profile.id, name: sk.name }],
      confidence: 'verified',
      evidence: m.profile.spirit.trait?.effect,
    });
  }
  for (const m of byTrait(/能耗为0的技能/)) {
    const sk = m.chosen.find((s) => cost(s) === 0);
    if (!sk) continue;
    out.push({
      title: `0 费技能 × ${shortName(m.profile.name)} 特性`,
      text: `「${sk.name}」是 0 费技能（${effectPhrase(sk)}），同时吃到特性「${m.profile.spirit.trait?.name}」的加成；0 费也意味着被抽能压到 0 点时它仍能出手。`,
      spiritIds: [m.profile.id],
      skills: [{ spiritId: m.profile.id, name: sk.name }],
      confidence: 'verified',
      evidence: m.profile.spirit.trait?.effect,
    });
  }

  // 4) 抬费特性：只讲「对手多付」，不讲伤害
  for (const m of byTrait(/在场时，敌方全技能能耗\+\d/)) {
    const cheap = [...m.chosen].filter(isDmg).sort((a, b) => cost(a) - cost(b))[0];
    if (!cheap) continue;
    const plus = Number(/敌方全技能能耗\+(\d)/.exec(m.profile.spirit.trait?.effect ?? '')?.[1] ?? 1);
    out.push({
      title: `${shortName(m.profile.name)} 抬费 → 对手 10 点打不满`,
      text: `「${m.profile.spirit.trait?.name}」在场时敌方全技能能耗 +${plus}：对手的 3 费招变成 ${3 + plus} 费，10 点能量从「打 3 次」降到「打 2 次」。它自己带的是 ${cost(cheap)} 费的「${cheap.name}」，节奏差就是这样拉开的——这条只影响对手的费用，不会直接提高我方伤害。`,
      spiritIds: [m.profile.id],
      skills: [{ spiritId: m.profile.id, name: cheap.name }],
      confidence: 'verified',
      evidence: m.profile.spirit.trait?.effect,
    });
  }

  // 5) 入场 0 能量 × 队友同系技能垫能
  for (const m of byTrait(/初始能量为0/)) {
    const facts = traitEnergyFacts(m.profile.spirit.trait?.effect);
    if (!facts || facts.rule.id !== 'zero-type-skill' || !facts.type) continue;
    const ally = sets
      .filter((x) => x.profile.id !== m.profile.id)
      .map((x) => ({ m: x, sk: x.chosen.find((sk) => sk.type === facts.type) }))
      .filter((x) => x.sk)[0];
    if (!ally) continue;
    out.push({
      title: `${shortName(ally.m.profile.name)} 的${facts.type}系技能 → 给 ${shortName(m.profile.name)} 垫能量`,
      text: `${shortName(m.profile.name)} 入场时 0 能量，靠「入场前队友每用 1 次${facts.type}系技能回 ${facts.amount} 点」起跳；${shortName(ally.m.profile.name)} 的「${ally.sk!.name}」（${cost(ally.sk!)} 费）正是${facts.type}系，打两次它入场就有 ${facts.amount * 2} 点。`,
      spiritIds: [m.profile.id, ally.m.profile.id],
      skills: [
        { spiritId: m.profile.id, name: m.chosen[0].name },
        { spiritId: ally.m.profile.id, name: ally.sk!.name },
      ],
      confidence: 'inferred',
    });
  }

  // 6) 逼退 / 换人惩罚
  for (const m of byTrait(/敌方精灵离场后|更换入场的精灵/)) {
    const pusher = sets.find((x) => x.profile.id !== m.profile.id && x.chosen.some((sk) => /使敌方[^。；]{0,6}(返场|脱离)/.test(sk.effect ?? '')));
    if (!pusher) continue;
    const sk = pusher.chosen.find((s) => /使敌方[^。；]{0,6}(返场|脱离)/.test(s.effect ?? ''))!;
    out.push({
      title: `${shortName(pusher.profile.name)} 逼退 → ${shortName(m.profile.name)} 换人惩罚`,
      text: `「${sk.name}」（${cost(sk)} 费，${effectPhrase(sk)}）把对手赶下场，正好触发 ${shortName(m.profile.name)} 的特性「${m.profile.spirit.trait?.name}」：对方换上来的一只要吃这个效果。`,
      spiritIds: [pusher.profile.id, m.profile.id],
      skills: [{ spiritId: pusher.profile.id, name: sk.name }],
      confidence: 'verified',
      evidence: m.profile.spirit.trait?.effect,
    });
  }

  // 6.5) 能量账：10 点能连打几招（纯算术）
  const avgCost = mean(sets.flatMap((m) => m.chosen.map(cost)));
  if (avgCost > 0) {
    const shots = Math.floor(ENERGY_CAP / avgCost);
    const oppShots = Math.floor(ENERGY_CAP / 3.5);
    const cheapest = sets
      .flatMap((m) => m.chosen.map((sk) => ({ m, sk })))
      .sort((a, b) => cost(a.sk) - cost(b.sk))[0];
    if (cheapest) {
      out.push({
        title: `能量账：10 点能连打 ${shots} 招`,
        text: `全队 4 招平均 ${round1(avgCost)} 费，10 点能量够连打 ${shots} 招（不聚能）；按对手常见的 3~4 费招算，对方同样 10 点只能打 ${oppShots} 招。` +
          `最便宜的「${cheapest.sk.name}」只要 ${cost(cheapest.sk)} 费（${shortName(cheapest.m.profile.name)}），被抽到 0 能量时也先用它把节奏接上。`,
        spiritIds: [cheapest.m.profile.id],
        skills: [{ spiritId: cheapest.m.profile.id, name: cheapest.sk.name }],
        confidence: 'inferred',
      });
    }
  }

  // 7) 属性联防（现算，永远成立）
  const weakest = [...metrics.sharedWeak].sort((a, b) => b.count - a.count)[0];
  if (weakest) {
    const breaker = sets.filter((m) => matchup(weakest.type, m.profile.types).multiplier >= 2).map((m) => shortName(m.profile.name));
    const wall = sets
      .filter((m) => matchup(weakest.type, m.profile.types).multiplier <= 0.5)
      .map((m) => ({ m, sk: [...m.chosen].filter(isDmg).sort((a, b) => effPower(m.profile, b) - effPower(m.profile, a))[0] }))[0];
    if (wall?.sk) {
      const mult = matchup(wall.sk.type, [weakest.type]).multiplier;
      out.push({
        title: `${weakest.type}系联防 → ${shortName(wall.m.profile.name)} 接`,
        text: `${weakest.type}系一招能同时打中 ${breaker.join('、')}（${weakest.count} 只）；${shortName(wall.m.profile.name)}（${wall.m.profile.types.join('/')}）对它是 ×${matchup(weakest.type, wall.m.profile.types).multiplier}，换它上场就是止损点${mult >= 2 ? `，它的「${wall.sk.name}」（${wall.sk.type}·威力 ${wall.sk.power}）还能反打 ×${mult}` : `，但它没有能反打 ${weakest.type} 系的招`}。`,
        spiritIds: [wall.m.profile.id],
        skills: [{ spiritId: wall.m.profile.id, name: wall.sk.name }],
        confidence: 'inferred',
      });
    }
  }

  // 8) 打击面互补（现算）
  const complement = sets
    .map((m) => ({ m, types: TYPE_ORDER.filter((t) => m.chosen.filter(isDmg).some((sk) => matchup(sk.type, [t]).multiplier >= 2)) }))
    .sort((a, b) => b.types.length - a.types.length)[0];
  if (complement) {
    out.push({
      title: `打击面互补：${shortName(complement.m.profile.name)} 补 ${complement.types.slice(0, 3).join('、')}`,
      text: `${shortName(complement.m.profile.name)} 的 4 招能打到 ${complement.types.length} 种属性（${complement.types.join('、')}），是全队 4 招覆盖最宽的一只；打这些属性时优先让它上，别用其他成员的 ×1 招硬顶。`,
      spiritIds: [complement.m.profile.id],
      skills: complement.m.chosen.filter(isDmg).slice(0, 2).map((sk) => ({ spiritId: complement.m.profile.id, name: sk.name })),
      confidence: 'inferred',
    });
  }

  return out.slice(0, 5);
}

function buildChain(sets: MemberSet[]): ChainStep[] {
  const teamSets = sets.map((s) => ({ spirit: s.profile.spirit, chosen: s.chosen }));
  return sets.map((m) => {
    const act = traitActivation(m.profile.spirit, m.chosen, teamSets);
    const main = [...m.chosen].filter(isDmg).sort((a, b) => effPower(m.profile, b) - effPower(m.profile, a))[0];
    const e = memberEnergy(m.profile.spirit, m.chosen);
    const head = m.profile.spirit.trait
      ? `「${m.profile.spirit.trait.name}」${m.profile.spirit.trait.effect}`
      : '图鉴未提供特性';
    const use =
      act.status === 'idle'
        ? `本套未触发：${act.reason}${act.suggestion ? `，换成「${act.suggestion.name}」（${act.suggestion.energy} 费）可点亮` : ''}`
        : `本套用法：${act.reason}`;
    return {
      spiritId: m.profile.id,
      skillName: main?.name,
      text: `${head}｜${use}｜能量：上场 ${e.usable} 点，4 招 ${e.costs.map((c) => `${c.energy}`).join('/')} 费，${e.caution}`,
    };
  });
}

function buildBattlePlan(
  sets: MemberSet[],
  metrics: ReturnType<typeof metricsFor>,
  eng: ReturnType<typeof teamEnergy>,
  lead: LeadPlan,
  arch: Archetype,
): BattlePhase[] {
  const byRole = (role: Role) => sets.find((m) => m.role === role) ?? sets[0];
  const leadSet = byRole('先手');
  const coreSet = byRole('核心输出');
  const tankSet = byRole('承伤');
  const cleanSet = byRole('收割');
  const coreMain = [...coreSet.chosen].filter(isDmg).sort((a, b) => effPower(coreSet.profile, b) - effPower(coreSet.profile, a))[0];
  const leadEnergy = energyData(leadSet);
  const weakest = metrics.sharedWeak[0];
  const wall = weakest
    ? sets
        .filter((m) => matchup(weakest.type, m.profile.types).multiplier <= 0.5)
        .sort((a, b) => b.profile.hp + b.profile.def - (a.profile.hp + a.profile.def))[0]
    : undefined;
  const fastest = [...sets].sort((a, b) => b.profile.spe - a.profile.spe)[0];

  return [
    {
      key: 'opening',
      label: '开局',
      title: `${shortName(leadSet.profile.name)} 首发`,
      text:
        `首发 ${shortName(leadSet.profile.name)}（速度 ${leadSet.profile.spe}，${leadSet.profile.types.join('/')}，上场 ${leadEnergy.entry} 点）。` +
        `第一手「${lead.openers[0]?.name ?? leadSet.chosen[0].name}」（${lead.openers[0]?.energy ?? cost(leadSet.chosen[0])} 费），` +
        `第二手「${lead.openers[1]?.name ?? leadSet.chosen[1]?.name ?? coreMain?.name}」` +
        `${leadEnergy.firstTurn ? `，打完还剩 ${leadEnergy.firstTurn.leftover} 点` : '；打不出输出时先聚能 +5'}。` +
        `对面若用 ${leadSet.profile.weak.slice(0, 2).join('、') || '本系'} 打过来是 ×2，按下面的联防位换人。`,
      spiritIds: [leadSet.profile.id],
      skills: lead.openers.map((o) => ({ spiritId: leadSet.profile.id, name: o.name })),
    },
    {
      key: 'advantage',
      label: '第一阶段',
      title: `${shortName(coreSet.profile.name)} 接手输出`,
      text:
        `顺风时不换人：${shortName(coreSet.profile.name)}（${coreSet.profile.types.join('/')}）用「${coreMain?.name}」` +
        `（${coreMain?.type}·威力 ${coreMain?.power}·${coreMain ? cost(coreMain) : 0} 费）继续压，` +
        `按 4 招覆盖优先打 ${metrics.coverageTypes.slice(0, 4).join('、')} 系；` +
        `它的上场能量是 ${energyData(coreSet).entry} 点，${energyData(coreSet).firstTurn ? `首回合可打「${energyData(coreSet).firstTurn?.name}」` : '首回合需要聚能'}，` +
        `全队最高 ${eng.maxCost} 费，别把大招留到能量见底才想起来用。`,
      spiritIds: [coreSet.profile.id],
      skills: coreMain ? [{ spiritId: coreSet.profile.id, name: coreMain.name }] : [],
    },
    {
      key: 'mid',
      label: '中期',
      title: weakest ? `${weakest.type}系来球 → ${shortName((wall ?? tankSet).profile.name)} 接` : '按属性换人，不硬顶',
      text:
        (weakest
          ? `${weakest.type}系能同时打中 ${weakest.count} 只，换 ${shortName((wall ?? tankSet).profile.name)}（${(wall ?? tankSet).profile.types.join('/')}，×${matchup(weakest.type, (wall ?? tankSet).profile.types).multiplier}）接；`
          : `队里没有两只共用 ×2 弱点，遇到克制就换抗性位；`) +
        `遇到速度更快的对手（队内最快 ${shortName(fastest.profile.name)} 速 ${fastest.profile.spe}），先把减伤/提速技开出来再对拼；` +
        `换人只花一回合、不额外扣能量（待实测），但换入的当回合不能出招，所以尽量在对手能量见底时换。`,
      spiritIds: [(wall ?? tankSet).profile.id],
      skills: (wall ?? tankSet).chosen.filter((sk) => sk.category === '防御').slice(0, 1).map((sk) => ({ spiritId: (wall ?? tankSet).profile.id, name: sk.name })),
    },
    {
      key: 'late',
      label: '后期',
      title: `${shortName(cleanSet.profile.name)} 收尾`,
      text:
        `${shortName(cleanSet.profile.name)}（速度 ${cleanSet.profile.spe}）留到最后，用「${
          [...cleanSet.chosen].filter(isDmg).sort((a, b) => cost(a) - cost(b))[0]?.name ?? cleanSet.chosen[0].name
        }」这类低费招收人头；` +
        `全队 4 招平均 ${eng.avgCost} 费，残局只剩 ${energyData(cleanSet).entry} 点时优先打 0~2 费的招，` +
        `要 ${eng.maxCost} 费的大招就先聚能一回合（+${GATHER_GAIN}），别让精灵停在 0 能量被对手白打一轮。`,
      spiritIds: [cleanSet.profile.id],
      skills: [...cleanSet.chosen].filter(isDmg).sort((a, b) => cost(a) - cost(b)).slice(0, 1).map((sk) => ({ spiritId: cleanSet.profile.id, name: sk.name })),
    },
    {
      key: 'comeback',
      label: '逆风局',
      title: `${shortName(tankSet.profile.name)} 承伤翻盘`,
      text:
        `逆风先把 ${shortName(tankSet.profile.name)}（生命 ${tankSet.profile.hp}／物防 ${tankSet.profile.def}／魔防 ${tankSet.profile.spd}）顶上去吃一轮，` +
        `它带上场 ${energyData(tankSet).entry} 点、4 招 ${energyData(tankSet).costs.join('/')} 费，${energyData(tankSet).caution}` +
        `；反打靠 ${arch.id === 'energy' ? '抽能与磨血：把对手能量压到 0，它的高费招就出不来' : '先手位与收割位的 ×2 克制招'}，` +
        `不要在这个阶段换上新精灵送能量。`,
      spiritIds: [tankSet.profile.id],
      skills: tankSet.chosen.filter((sk) => sk.category === '防御' || cost(sk) <= 2).slice(0, 1).map((sk) => ({ spiritId: tankSet.profile.id, name: sk.name })),
    },
  ];
}

function block(key: AnalysisBlock['key'], title: string, text: string, bullets: string[], spiritIds: string[]): AnalysisBlock {
  return { key, title, text, bullets, spiritIds };
}

function buildAnalysis(
  sets: MemberSet[],
  metrics: ReturnType<typeof metricsFor>,
  eng: ReturnType<typeof teamEnergy>,
  lead: LeadPlan,
  arch: Archetype,
): TeamAnalysis {
  const byRole = (role: Role) => sets.find((m) => m.role === role) ?? sets[0];
  const coreSet = byRole('核心输出');
  const tankSet = byRole('承伤');
  const controlSet = byRole('控制');
  const supportSet = byRole('辅助');
  const cleanSet = byRole('收割');
  const leadSet = byRole('先手');
  const coreMain = [...coreSet.chosen].filter(isDmg).sort((a, b) => effPower(coreSet.profile, b) - effPower(coreSet.profile, a))[0];
  const supportSkills = (m: MemberSet) => m.chosen.filter((sk) => /回复\d+能量|为场下|己方精灵|全技能威力|减伤\d+%|回复\d+%生命|速度\+|先手\+/.test(sk.effect ?? ''));
  const controlSkills = (m: MemberSet) => m.chosen.filter((sk) => /能耗\+\d|失去\d+能量|偷取\d+能量|冻结|中毒|灼烧|速度-\d|先手-1/.test(sk.effect ?? ''));
  const counterSkills = (m: MemberSet) => m.chosen.filter((sk) => /应对/.test(sk.effect ?? ''));
  const zeroCostOwner = sets.filter((m) => m.chosen.some((sk) => cost(sk) === 0));
  const quick = sets.filter((m) => m.chosen.some((sk) => /迅捷/.test(sk.effect ?? '')));
  const healer = sets.filter((m) => m.chosen.some((sk) => /回复\d+%生命/.test(sk.effect ?? '')));

  const core: AnalysisBlock = block(
    'core',
    '核心输出与辅助配合',
    `${shortName(coreSet.profile.name)}（${coreSet.profile.mainAtk} ${coreSet.profile.physical ? '物攻' : '魔攻'}）是本套核心输出：` +
      `「${coreMain?.name}」${coreMain?.type}·威力 ${coreMain?.power}·${coreMain ? cost(coreMain) : 0} 费，` +
      `上场 ${energyData(coreSet).entry} 点${energyData(coreSet).firstTurn ? `，首回合就能打「${energyData(coreSet).firstTurn?.name}」` : '，需要先聚能'}。` +
      `辅助位是 ${shortName(supportSet.profile.name)}：${supportSkills(supportSet).map((sk) => `「${sk.name}」（${cost(sk)} 费，${effectPhrase(sk, 18)}）`).join('、') || '4 招没有纯辅助技，靠属性与承伤位分工'}` +
      (controlSkills(controlSet).length ? `；控制位 ${shortName(controlSet.profile.name)} 用 ${controlSkills(controlSet).map((sk) => `「${sk.name}」`).join('、')} 拖住对手节奏。` : '。'),
    [
      `${shortName(coreSet.profile.name)} 的 4 招：${coreSet.chosen.map((sk) => `「${sk.name}」${cost(sk)} 费`).join('、')}。`,
      `${shortName(supportSet.profile.name)} 提供：${supportSkills(supportSet).map((sk) => `${sk.name}（${effectPhrase(sk, 16)}）`).join('、') || '无纯辅助技'}。`,
      `${shortName(controlSet.profile.name)} 的控制：${controlSkills(controlSet).map((sk) => sk.name).join('、') || '无'}。`,
    ],
    [coreSet.profile.id, supportSet.profile.id, controlSet.profile.id],
  );

  const missing = TYPE_ORDER.filter((t) => !metrics.coverageTypes.includes(t));
  const coverage: AnalysisBlock = block(
    'coverage',
    '属性覆盖及克制关系',
    `按推荐 4 招能打出 ≥2 倍伤害的属性 ${metrics.coverageChosen}/18${missing.length ? `，打不到的 ${missing.length} 种是 ${missing.join('、')}` : '，18 系全打得到'}；` +
      `按全学习面是 ${metrics.coverageLearnset}/18（只说明「理论上能打什么」，不能当作本套实力）。` +
      `共同弱点里最重的是 ${metrics.sharedWeak[0] ? `${metrics.sharedWeak[0].type}×${metrics.sharedWeak[0].count}` : '无（没有两只共用 ×2 弱点）'}${
        metrics.sharedWeak[0]?.answers.length ? `，由 ${metrics.sharedWeak[0].answers.join('、')} 以 ≤0.5 倍接住` : ''
      }。`,
    [
      ...metrics.coverageTypes.slice(0, 8).map((t) => `${t} 系：队内有 ×2 招`),
      ...missing.slice(0, 4).map((t) => `${t} 系：4 招里没有 ×2 招（学习面 ${sets.some((m) => m.profile.learnCoverage.includes(t)) ? '有，但没带' : '也没有'}）`),
    ],
    sets.map((m) => m.profile.id),
  );

  const resistAll = new Set<string>();
  for (const m of sets) for (const t of m.profile.resist) resistAll.add(t);
  const resilience: AnalysisBlock = block(
    'resilience',
    '防御、续航、控制和反制能力',
    `承伤核心是 ${shortName(tankSet.profile.name)}（生命 ${tankSet.profile.hp}／物防 ${tankSet.profile.def}／魔防 ${tankSet.profile.spd}，三项合计 ${tankSet.profile.bulk}）；` +
      `全队 ${sets.filter((m) => m.chosen.some((sk) => /减伤\d+%/.test(sk.effect ?? ''))).length} 只带减伤技，${resistAll.size} 种属性至少有一只以 ≤0.5 倍接住；` +
      `续航靠 ${healer.length ? healer.map((m) => shortName(m.profile.name)).join('、') : '回能技与聚能（默认没有每回合回血）'}；` +
      `控制手段 ${controlSkills(controlSet).length ? `${shortName(controlSet.profile.name)} 的 ${controlSkills(controlSet).map((sk) => sk.name).join('、')}` : '本套没有抽能/抬费，靠纯输出'}；` +
      `反制靠 ${sets.filter((m) => counterSkills(m).length).length} 只的应对技（应对成功必定先手并触发效果）。`,
    [
      `减伤：${sets.flatMap((m) => m.chosen.filter((sk) => /减伤\d+%/.test(sk.effect ?? '')).map((sk) => `${shortName(m.profile.name)}「${sk.name}」${/减伤(\d+)%/.exec(sk.effect ?? '')?.[1] ?? ''}%`)).join('；') || '无'}`,
      `控制：${controlSkills(controlSet).map((sk) => `${shortName(controlSet.profile.name)}「${sk.name}」`).join('、') || '无'}`,
      `反制：${sets.filter((m) => counterSkills(m).length).map((m) => `${shortName(m.profile.name)}（${counterSkills(m).map((sk) => sk.name).join('/')}）`).join('、') || '没有应对技，只能靠属性硬接'}`,
    ],
    [tankSet.profile.id, controlSet.profile.id],
  );

  const order = ROLES.map((r) => byRole(r).profile.id);
  const rotation: AnalysisBlock = block(
    'rotation',
    '精灵上场顺序与轮换策略（含零费换人位）',
    `顺序：${order.map((id, i) => `${i + 1}.${shortName(spiritsById.get(id)?.name ?? id)}（${ROLES[i]}）`).join(' → ')}。` +
      `换人不额外扣能量、只花一个回合（待实测），所以「零费换人位」的真实做法是：把带「迅捷」的精灵当止损位，主动换人入场时它会立刻用第一个能量够的迅捷技——` +
      (quick.length
        ? `本套由 ${quick.map((m) => shortName(m.profile.name)).join('、')} 承担（${quick.flatMap((m) => m.chosen.filter((sk) => /迅捷/.test(sk.effect ?? '')).map((sk) => `「${sk.name}」${cost(sk)} 费`)).join('、')}）。`
        : `本套没有迅捷技能，换人就只是止损，换入的当回合不能出招。`) +
      `另外 0 费技能（${zeroCostOwner.length ? zeroCostOwner.map((m) => shortName(m.profile.name)).join('、') : '本套没有'}）在被抽到 0 能量时仍能出手。`,
    [
      `首发：${shortName(leadSet.profile.name)}（${lead.openers.map((o) => o.name).join(' → ') || '按最便宜的招起手'}）。`,
      `承伤位：${shortName(tankSet.profile.name)}，只在对手高费招回合换上来。`,
      `收割位：${shortName(cleanSet.profile.name)}，残局先手收人头。`,
      quick.length ? `迅捷位：${quick.map((m) => shortName(m.profile.name)).join('、')}（换入即出招）` : '本套无迅捷，换人=纯止损',
    ],
    order,
  );

  const energy: AnalysisBlock = block(
    'energy',
    '能量分配与剩余能量',
    `${teamEnergyLine(eng)}默认没有每回合回能，能量靠聚能（一回合 +${GATHER_GAIN}）和特性/技能补；上限 10 点对每只都成立，` +
      `本套最高单招 ${eng.maxCost} 费${eng.overCapRisk.length ? `，其中 ${eng.overCapRisk.join('、')} 超出上限` : '，没有超过 10 点的招'}。`,
    eng.lines.concat([`聚能口径：一回合 +${GATHER_GAIN} 点；恢复瓶回复量官方未公布（待实测）。`]),
    sets.map((m) => m.profile.id),
  );

  const fastest = [...sets].sort((a, b) => b.profile.spe - a.profile.spe)[0];
  const counters: AnalysisBlock = block(
    'counters',
    '面对不同敌方阵容的应对策略',
    `遇到高爆发队：先上 ${shortName(tankSet.profile.name)} 吃第一轮，再用 ${shortName(coreSet.profile.name)} 反打；` +
      `遇到消耗/抽能队：用${arch.id === 'energy' ? '本套的抽能链把对手压到 0 能量' : `低费招（4 招里最低 ${Math.min(...sets.flatMap((m) => m.chosen.map(cost)))} 费）避免被抽空`}；` +
      `遇到速度队：靠 ${shortName(fastest.profile.name)}（速 ${fastest.profile.spe}）抢先后手，或用减伤技拖过第一轮；` +
      `遇到 ${metrics.coverageTypes.slice(0, 3).join('、')} 系：这些是本套 4 招能打 ×2 的属性，优先用对应成员上场，不要换错人。`,
    [
      `高爆发 → ${shortName(tankSet.profile.name)} 承伤，${shortName(coreSet.profile.name)} 反打。`,
      `消耗战 → ${arch.id === 'energy' ? '抽能链（碰瓷/抬费）压到 0 能量' : '低费招 + 聚能节奏，别把能量打空'}。`,
      `速度队 → ${shortName(fastest.profile.name)} 抢速或减伤拖延。`,
      `克制面 → 优先打 ${metrics.coverageTypes.slice(0, 4).join('、')} 系。`,
    ],
    [tankSet.profile.id, coreSet.profile.id],
  );

  return { core, coverage, resilience, rotation, energy, counters };
}

function leadSetName(sets: MemberSet[], id: string): string {
  return sets.find((m) => m.profile.id === id)?.profile.name ?? id;
}

function buildPlan(sets: MemberSet[], eng: ReturnType<typeof teamEnergy>, lead: LeadPlan, arch: Archetype): string[] {
  const byRole = (role: Role) => sets.find((m) => m.role === role) ?? sets[0];
  const coreSet = byRole('核心输出');
  const tankSet = byRole('承伤');
  const coreMain = [...coreSet.chosen].filter(isDmg).sort((a, b) => effPower(coreSet.profile, b) - effPower(coreSet.profile, a))[0];
  const leadName = shortName(spiritsById.get(lead.spiritId)?.name ?? lead.spiritId);
  return [
    `起手：${leadName}（速度 ${spiritsById.get(lead.spiritId)?.stats.spe ?? '—'}）先上场，${lead.openers.map((o) => `「${o.name}」`).join(' → ') || '按最便宜的招起手'}。`,
    `核心：${shortName(coreSet.profile.name)} ${coreSet.profile.physical ? '物攻' : '魔攻'} ${coreSet.profile.mainAtk}，「${coreMain?.name}」（${coreMain?.type}·威力 ${coreMain?.power}·${coreMain ? cost(coreMain) : 0} 费）。`,
    `承伤：${shortName(tankSet.profile.name)} 生命 ${tankSet.profile.hp}／物防 ${tankSet.profile.def}／魔防 ${tankSet.profile.spd}，专门接 ${tankSet.profile.resist.slice(0, 2).join('、') || '本系'} 的球。`,
    `能量：全队入场 ${eng.entryTotal} 点、平均 ${eng.avgCost} 费；${eng.gatherCount ? `${eng.gatherCount} 只需要先聚能` : '全员入场即可出招'}，聚能一回合 +${GATHER_GAIN}。`,
    `方向：${arch.label}——${arch.sub}。`,
  ];
}

/* ------------------------------------------------------------------ 组装 */

const ROUND_TOKEN = 'ROUND';

function makePreset(arch: Archetype, sets: MemberSet[], round: number, overlap = 0): TeamPreset {
  const eng = teamEnergy(sets.map((m) => ({ spirit: m.profile.spirit, chosen: m.chosen })));
  const metrics = metricsFor(sets, eng);
  const lead = buildLead(sets);
  const analysis = buildAnalysis(sets, metrics, eng, lead, arch);
  const teamSets = sets.map((s) => ({ spirit: s.profile.spirit, chosen: s.chosen }));

  const members: PresetMember[] = sets.map((m) => {
    const act = traitActivation(m.profile.spirit, m.chosen, teamSets);
    return {
      spiritId: m.profile.id,
      role: m.role,
      duty: dutyFor(m),
      note: noteFor(m),
      skills: m.chosen.map((sk) => ({
        name: sk.name,
        slot: m.notes.get(sk.name)?.slot ?? '补位',
        energy: cost(sk),
        why: m.notes.get(sk.name)?.why ?? `${sk.type}·${sk.category}，${cost(sk)} 费`,
      })),
      traitSynergy:
        act.status === 'idle'
          ? `${m.profile.spirit.trait?.name ?? '特性'}：${act.reason}（本套未触发${act.suggestion ? `，可换「${act.suggestion.name}」` : ''}）`
          : `${m.profile.spirit.trait?.name ?? '特性'}：${act.reason}`,
      traitStatus: act.status,
      energy: energyData(m),
    };
  });

  const summary = buildSummary(arch, sets, metrics, eng).replace(ROUND_TOKEN, String(round));
  // 上一轮去重被放宽时，必须把重叠写进弱点（校验会查）
  const overlapNote =
    overlap > 0 ? `；与第 ${round - 1} 轮重叠 ${overlap} 只：上一轮的 18 只已优先排除，这个方向凑不出合格阵容时才放宽` : '';
  return {
    id: `r${round}-${arch.id}`,
    name: teamName(arch, sets),
    sub: arch.sub,
    category: arch.category,
    archetype: arch.id,
    archetypeLabel: arch.label,
    tags: [
      `第 ${round} 轮`,
      arch.label,
      `速 ${metrics.fastest?.spe ?? '—'}`,
      `4 招覆盖 ${metrics.coverageChosen}/18`,
      `入场能量 ${metrics.entryTotal}`,
      `平均 ${metrics.avgCost} 费`,
    ],
    summary,
    pros: buildPros(sets, metrics, eng),
    plan: buildPlan(sets, eng, lead, arch),
    risk: buildRisk(sets, metrics, eng, arch) + overlapNote,
    chain: buildChain(sets),
    members,
    lead,
    synergies: buildSynergies(sets, metrics),
    battlePlan: buildBattlePlan(sets, metrics, eng, lead, arch),
    analysis,
    energySummary: {
      entryTotal: eng.entryTotal,
      avgCost: eng.avgCost,
      maxCost: eng.maxCost,
      readyCount: eng.readyCount,
      gatherCount: eng.gatherCount,
      starvedCount: eng.starvedCount,
      line: teamEnergyLine(eng),
    },
    metrics,
  };
}

function teamName(arch: Archetype, sets: MemberSet[]): string {
  const typeCount = new Map<string, number>();
  for (const m of sets) for (const t of m.profile.types) typeCount.set(t, (typeCount.get(t) ?? 0) + 1);
  const top = [...typeCount.entries()].sort((a, b) => b[1] - a[1])[0];
  const core = sets.find((m) => m.role === '核心输出') ?? sets[0];
  const typeWord = top && top[1] >= 3 ? `${top[0]}系` : `${core.profile.types[0]}`;
  const suffix =
    arch.id === 'burst'
      ? ['强攻', '破阵', '疾袭'][core.profile.spe % 3]
      : arch.id === 'balance'
        ? ['联防', '铁壁', '稳阵'][core.profile.hp % 3]
        : ['循环', '节流', '续航'][core.profile.spd % 3];
  return arch.id === 'energy' ? `低耗${suffix}队` : `${typeWord}${suffix}队`;
}

/* ------------------------------------------------------------------ 读写 */

function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch {
    return null;
  }
}

function writeAtomic(file: string, data: unknown) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`);
  fs.renameSync(tmp, file);
}

function backupRotation(rotation: TeamRotationFile) {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const target = path.join(BACKUP_DIR, `team-rotation.r${rotation.round}.json`);
  if (!fs.existsSync(target)) fs.copyFileSync(ROTATION_PATH, target);
}

interface Args {
  ifDue: boolean;
  dry: boolean;
  refresh: boolean;
  round: number | null;
  out: string | null;
}

function parseArgs(argv: string[]): Args {
  const out: Args = { ifDue: false, dry: false, refresh: false, round: null, out: null };
  for (const a of argv) {
    if (a === '--if-due') out.ifDue = true;
    else if (a === '--dry') out.dry = true;
    else if (a === '--refresh') out.refresh = true;
    else if (a.startsWith('--round=')) out.round = Number(a.slice(8));
    else if (a.startsWith('--out=')) out.out = a.slice(6);
  }
  return out;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const rotation = readJson<TeamRotationFile>(ROTATION_PATH);
  const history = readJson<RotationHistoryFile>(HISTORY_PATH) ?? { rounds: [] };

  if (args.refresh) {
    if (!rotation) {
      console.error('没有 team-rotation.json，无法 --refresh');
      process.exit(1);
    }
    const refreshed: TeamRotationFile = {
      ...rotation,
      generatedBy: 'scripts/rotate-teams.ts (refresh)',
      teams: rotation.teams.map((preset, i) => {
        const arch = ARCHETYPES.find((a) => a.id === preset.archetype) ?? ARCHETYPES[i] ?? ARCHETYPES[0];
        const sets = preset.members.map((m) => {
          const p = BY_ID.get(m.spiritId) ?? buildProfile(spiritsById.get(m.spiritId)!);
          const chosen = m.skills
            .map((ref) => p.pool.find((sk) => sk.name === ref.name) ?? [...p.pool, ...skillsOf(p.spirit)].find((sk) => sk.name === ref.name))
            .filter((sk): sk is ResolvedSkill => Boolean(sk));
          const pick = { chosen, notes: new Map(m.skills.map((ref) => [ref.name, { slot: ref.slot ?? '补位', why: ref.why }])) };
          return { profile: p, role: m.role as Role, chosen: pick.chosen, notes: pick.notes };
        });
        return makePreset(arch, sets, rotation.round);
      }),
    };
    const audit = auditRotation(refreshed, history);
    if (audit.problems.length) {
      console.error(`✗ 重写后的文案没通过校验（未写盘）：${audit.problems.length} 个问题`);
      for (const p of audit.problems.slice(0, 30)) console.error(`  - ${p}`);
      process.exit(1);
    }
    if (!args.dry) {
      backupRotation(rotation);
      writeAtomic(ROTATION_PATH, refreshed);
    }
    console.log(`✓ --refresh 完成：第 ${rotation.round} 轮 3 套文案已按新能量口径重写${args.dry ? '（dry，未写盘）' : ''}`);
    for (const w of audit.warnings) console.warn(`  ⚠ ${w}`);
    return;
  }

  if (args.ifDue && rotation) {
    const due = new Date(rotation.nextRotationAt).getTime();
    if (Number.isFinite(due) && Date.now() < due) {
      console.log(`未到轮换时间（下次 ${rotation.nextRotationAt}），什么都不做`);
      return;
    }
  }

  const round = args.round ?? (rotation ? rotation.round + 1 : 1);
  const now = new Date();
  const previousIds = new Set(history.rounds.flatMap((r) => r.spiritIds));
  const lastRound = history.rounds.filter((r) => r.round < round).sort((a, b) => b.round - a.round)[0];
  const banned = new Set(lastRound?.spiritIds ?? [...previousIds]);

  const teams: TeamPreset[] = [];
  const usedAcross = new Set<string>();
  ARCHETYPES.forEach((arch, i) => {
    const seed = 20261119 + round * 131 + i * 977;
    // 多试几个种子，再按「质量下限 + 分数」挑一个：覆盖 ≥16 种、承伤位不是负面前提、
    // 能量经济方向平均能耗 ≤2.9。凑不出合格的就退回最高分那个（不硬失败）。
    const candidates: { sets: MemberSet[]; score: number; ok: boolean; overlap: number }[] = [];
    for (let k = 0; k < 16; k += 1) {
      const ban = k === 0 ? new Set([...banned, ...usedAcross]) : new Set(usedAcross);
      const built = buildTeam(arch, ban, seed + k * 137);
      if (built.length < 6) continue;
      if (built.some((m) => usedAcross.has(m.profile.id))) continue;
      const cov = coverageOfSets(built).size;
      const eng = teamEnergy(built.map((m) => ({ spirit: m.profile.spirit, chosen: m.chosen })));
      const tankDrawback = built.some((m) => m.role === '承伤' && m.profile.drawback);
      const ok = cov >= 16 && !tankDrawback && (arch.id !== 'energy' || eng.avgCost <= 2.9);
      const overlap = built.filter((m) => banned.has(m.profile.id)).length;
      candidates.push({ sets: built, score: scoreTeam(built, arch), ok, overlap });
    }
    candidates.sort(
      (a, b) =>
        Number(b.overlap === 0) - Number(a.overlap === 0) ||
        Number(b.ok) - Number(a.ok) ||
        b.score - a.score,
    );
    let sets = candidates[0]?.sets ?? [];
    if (sets.length < 6) {
      console.error(`✗ ${arch.label} 只凑出 ${sets.length} 只，池子不够`);
      process.exit(1);
    }
    for (const m of sets) usedAcross.add(m.profile.id);
    const overlap = candidates.find((c) => c.sets === sets)?.overlap ?? sets.filter((m) => banned.has(m.profile.id)).length;
    teams.push(makePreset(arch, sets, round, overlap));
  });

  // 同轮重生成时，上一轮要从历史/备份恢复，不能写成自己
  let previous = rotation?.previous ?? null;
  if (rotation && rotation.round === round && (!previous || previous.round === round)) {
    const backup = readJson<TeamRotationFile>(path.join(BACKUP_DIR, `team-rotation.r${round - 1}.json`));
    const meta = history.rounds.find((r) => r.round === round - 1);
    previous = backup
      ? { round: backup.round, updatedAt: backup.updatedAt, archetypes: backup.archetypes, teams: backup.teams }
      : meta
        ? { round: meta.round, updatedAt: meta.updatedAt, archetypes: meta.archetypes }
        : null;
  }

  const next: TeamRotationFile = {
    round,
    updatedAt: beijingIso(now),
    nextRotationAt: beijingIso(new Date(now.getTime() + INTERVAL_HOURS * 3600 * 1000)),
    intervalHours: INTERVAL_HOURS,
    generatedBy: 'scripts/rotate-teams.ts v2 (energy model)',
    dataset: { spiritCount: meta.spiritCount, fetchedAt: meta.fetchedAt },
    // 同轮重生成沿用恢复出的上一轮；新一轮则把刚结束的这一轮完整存下来
    previous:
      rotation && rotation.round !== round
        ? {
            round: rotation.round,
            updatedAt: rotation.updatedAt,
            archetypes: rotation.archetypes,
            teams: rotation.teams,
          }
        : previous,
    archetypes: ARCHETYPES.map((a) => ({ id: a.id, label: a.label })),
    teams,
  };

  const historyNext: RotationHistoryFile = {
    rounds: [
      ...history.rounds.filter((r) => r.round !== round),
      {
        round,
        updatedAt: next.updatedAt,
        nextRotationAt: next.nextRotationAt,
        archetypes: next.archetypes,
        teams: teams.map((t) => ({
          id: t.id,
          name: t.name,
          category: t.category,
          archetype: t.archetype,
          archetypeLabel: t.archetypeLabel,
          spiritIds: t.members.map((m) => m.spiritId),
          spiritNames: t.members.map((m) => spiritsById.get(m.spiritId)?.name ?? m.spiritId),
        })),
        spiritIds: teams.flatMap((t) => t.members.map((m) => m.spiritId)),
      },
    ].sort((a, b) => a.round - b.round),
  };

  const audit = auditRotation(next, historyNext);
  if (audit.problems.length) {
    console.error(`✗ 生成的阵容没通过校验（未写盘，旧数据保持原样）：${audit.problems.length} 个问题`);
    for (const p of audit.problems.slice(0, 40)) console.error(`  - ${p}`);
    process.exit(1);
  }

  if (args.out) {
    fs.mkdirSync(path.dirname(args.out), { recursive: true });
    fs.writeFileSync(args.out, `${JSON.stringify(next, null, 2)}\n`);
    console.log(`已把第 ${round} 轮写到 ${args.out}（未动线上数据）`);
  } else if (args.dry) {
    console.log(`（dry）第 ${round} 轮，3 套阵容已通过校验，未写盘`);
  } else {
    if (rotation) backupRotation(rotation);
    writeAtomic(ROTATION_PATH, next);
    writeAtomic(HISTORY_PATH, historyNext);
  }

  for (const team of teams) {
    const e = team.energySummary!;
    const m = team.metrics!;
    console.log(
      `  ${team.name}｜${team.archetypeLabel}｜覆盖 ${m.coverageChosen}/18（学习面 ${m.coverageLearnset}/18）｜` +
        `入场能量 ${e.entryTotal}｜平均 ${e.avgCost} 费｜即招 ${e.readyCount}/6｜联动 ${team.synergies.length} 条｜` +
        `特性空转 ${team.members.filter((x) => x.traitStatus === 'idle').length}`,
    );
  }
  for (const w of audit.warnings) console.warn(`  ⚠ ${w}`);
  console.log(`✓ 第 ${round} 轮 3 套阵容已通过 ${audit.stats.members} 只 / ${audit.stats.skills} 条技能引用的全量校验${args.dry ? '（dry，未写盘）' : ''}`);
}

main();
