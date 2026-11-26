/**
 * 敌方 18 系 → 「换哪只上场 + 技能怎么放」纯计算模块
 *
 * 为什么单独一个模块：轮换每 48 小时换 3 套阵容，页面不能写死任何一套的文案。
 * 这里只吃 TeamPreset（6 只精灵 + 每人 4 个推荐技能），对 18 个系各算一份方案，
 * 换到下一轮时自动生效。
 *
 * 只用四类真实数据，不推演图鉴没写的东西：
 *   1) src/data/type-chart.json —— 18 系克制表（含双属性合成），承伤/反打倍率都从这里来；
 *   2) member.skills —— 这只精灵本套的真实 4 个推荐技能（名字必须能解析到 skills.json）；
 *   3) skills.json —— 真实属性/分类/威力/能耗/效果原文；
 *   4) member.energy —— 由 energy.ts 按特性算出的入场能量（默认 10 点、上限 10 点、聚能 +5）。
 *
 * 打分权重公开在 MATCHUP_WEIGHTS，页面上把每一项加减分都写出来，用户能自己对账。
 */
import { ENERGY_CAP, GATHER_GAIN } from './energy';
import { matchup, TYPE_ORDER } from './typeChart';
import { presetSpirit, resolveMemberSkill, shortName } from './team-presets';
import type { PresetMember, TeamPreset } from './team-types';
import type { ResolvedSkill, Spirit } from './types';

/* ------------------------------------------------------------ 打分权重 */

export const MATCHUP_WEIGHTS = {
  /** 承受敌方这个系的攻击（越低越好） */
  def: { strong: 7, resist: 5, neutral: 2, slight: -2, weak: -8 },
  /** 本只 4 招里对这个系的最高克制倍率（×2 优先） */
  atk: { quad: 10, double: 7, neutral: 1, resisted: -3, doubleResisted: -6 },
  /** 速度（先手权） */
  speed: { fast: 2, mid: 1, normal: 0, slow: -1 },
  /** 入场能量状态 */
  energy: { ready: 2, gather: 0, starved: -3 },
} as const;

/** 速度档位：>=120 高速线、>=100 中速、>=80 一般、其余偏慢 */
export const SPEED_TIERS = { fast: 120, mid: 100, normal: 80 } as const;

export type EnergyStatus = 'ready' | 'gather' | 'starved';

export interface ScorePart {
  /** 上页面的一句话，例如「承伤 ×0.5」 */
  label: string;
  points: number;
}

export function defPoints(multiplier: number): ScorePart['points'] {
  if (multiplier <= 0.25) return MATCHUP_WEIGHTS.def.strong;
  if (multiplier <= 0.5) return MATCHUP_WEIGHTS.def.resist;
  if (multiplier === 1) return MATCHUP_WEIGHTS.def.neutral;
  if (multiplier < 2) return MATCHUP_WEIGHTS.def.slight;
  return MATCHUP_WEIGHTS.def.weak;
}

export function atkPoints(multiplier: number): ScorePart['points'] {
  if (multiplier >= 4) return MATCHUP_WEIGHTS.atk.quad;
  if (multiplier >= 2) return MATCHUP_WEIGHTS.atk.double;
  if (multiplier === 1) return MATCHUP_WEIGHTS.atk.neutral;
  if (multiplier >= 0.5) return MATCHUP_WEIGHTS.atk.resisted;
  return MATCHUP_WEIGHTS.atk.doubleResisted;
}

export function speedPoints(spe: number | null): ScorePart['points'] {
  if (spe === null) return MATCHUP_WEIGHTS.speed.normal;
  if (spe >= SPEED_TIERS.fast) return MATCHUP_WEIGHTS.speed.fast;
  if (spe >= SPEED_TIERS.mid) return MATCHUP_WEIGHTS.speed.mid;
  if (spe >= SPEED_TIERS.normal) return MATCHUP_WEIGHTS.speed.normal;
  return MATCHUP_WEIGHTS.speed.slow;
}

export function energyPoints(status: EnergyStatus): ScorePart['points'] {
  return MATCHUP_WEIGHTS.energy[status];
}

/** ×0.5 / ×2 / ×1（整数不加小数点） */
export function fmtMult(m: number): string {
  return `×${Number.isInteger(m) ? m : m.toFixed(2).replace(/0$/, '')}`;
}

/* ------------------------------------------------------------ 结果结构 */

export interface MatchupSkillView {
  name: string;
  type: string;
  category: string;
  power: number | null;
  energy: number;
  /** 这一招打「敌方这个系」的倍率 */
  multiplier: number;
  effect: string;
}

export interface MatchupCandidate {
  spiritId: string;
  dex: string;
  name: string;
  avatar: string;
  types: string[];
  role: string;
  duty: string | null;
  speed: number | null;
  /** 承受敌方该系攻击的倍率（越低越好） */
  defMultiplier: number;
  /** 4 招里对该系的最高克制倍率 */
  atkMultiplier: number;
  /** 最高克制倍率对应的那一招（同倍率取威力大的） */
  coreSkill: MatchupSkillView | null;
  energyStatus: EnergyStatus;
  entryEnergy: number;
  score: number;
  scoreParts: ScorePart[];
}

export interface MatchupStep {
  no: string;
  /** 开场先强化 / 核心输出 / 低费试探 / 先手干扰 / 聚能 / 补刀过渡 / 打不动就退 */
  label: string;
  kind: 'skill' | 'gather' | 'pivot';
  skill: MatchupSkillView | null;
  /** 一句话打法（含倍率与能量账） */
  text: string;
  /** 技能效果原文（图鉴照抄，不加工） */
  effect: string | null;
  energy: { before: number; after: number; cost: number | null; gain: number | null };
}

export interface TypeMatchupPlan {
  type: string;
  pick: MatchupCandidate;
  backup: MatchupCandidate;
  steps: MatchupStep[];
  /** 换入瞬间的机制提示（目前只有「迅捷」会被写出来） */
  switchInNote: string | null;
  /** 这一系的抗性事实（没有 0.5 抗性时照实写） */
  resistLine: string;
  /** 要盯的风险 */
  caution: string;
  /** 速览用：核心招一句话 */
  quick: string;
  /** 本套对这一系的最低价（用来找「最需注意」的系） */
  threat: number;
}

/* ------------------------------------------------------------ 技能分类（只看图鉴原文） */

const effectOf = (sk: ResolvedSkill): string => sk.effect ?? '';
const costOf = (sk: ResolvedSkill): number => (typeof sk.energy === 'number' ? sk.energy : 0);
const isDamage = (sk: ResolvedSkill): boolean => typeof sk.power === 'number' && sk.power > 0;
const isStatus = (sk: ResolvedSkill): boolean => sk.category === '状态';
const isGuard = (sk: ResolvedSkill): boolean => sk.category === '防御';
/** 图鉴写着「自己获得全技能威力 / 物攻 / 魔攻 / 双攻 / 速度」的强化招 */
const isSelfBuff = (sk: ResolvedSkill): boolean =>
  isStatus(sk) && /自己获得(?:全技能威力|物攻|魔攻|双攻|速度)/.test(effectOf(sk));
/** 图鉴写着「敌方获得…/敌方失去…/敌方全技能能耗…」的干扰招 */
const isDisrupt = (sk: ResolvedSkill): boolean =>
  isStatus(sk) && /敌方(?:获得|失去|全技能能耗)/.test(effectOf(sk));
const isCharge = (sk: ResolvedSkill): boolean => /蓄力/.test(effectOf(sk));
const isSwift = (sk: ResolvedSkill): boolean => /迅捷/.test(effectOf(sk));
/** 图鉴写着「使用后消耗全部生命」的换命招：不放进常规出招链，避免把自杀当输出 */
const isSuicide = (sk: ResolvedSkill): boolean => /使用后消耗全部生命/.test(effectOf(sk));

/* ------------------------------------------------------------ 单只打分 */

function memberSkills(spirit: Spirit, member: PresetMember): ResolvedSkill[] {
  const out: ResolvedSkill[] = [];
  for (const ref of member.skills) {
    const sk = resolveMemberSkill(spirit, ref.name);
    if (sk) out.push(sk);
  }
  return out;
}

function viewSkill(sk: ResolvedSkill, enemyType: string): MatchupSkillView {
  return {
    name: sk.name,
    type: sk.type,
    category: sk.category,
    power: sk.power ?? null,
    energy: costOf(sk),
    multiplier: matchup(sk.type, [enemyType]).multiplier,
    effect: effectOf(sk),
  };
}

export function evaluateCandidate(member: PresetMember, enemyType: string): MatchupCandidate | null {
  const spirit = presetSpirit(member.spiritId);
  if (!spirit) return null;
  const skills = memberSkills(spirit, member);
  const damaging = skills.filter(isDamage).map((sk) => viewSkill(sk, enemyType));
  // 最高克制倍率优先，同倍率取威力大的那一招
  const best = [...damaging].sort(
    (a, b) => b.multiplier - a.multiplier || (b.power ?? 0) - (a.power ?? 0) || a.energy - b.energy,
  )[0] ?? null;

  const defMultiplier = matchup(enemyType, spirit.type).multiplier;
  const atkMultiplier = best?.multiplier ?? 1;
  const speed = spirit.stats.spe ?? null;
  const energyStatus: EnergyStatus = member.energy?.status ?? 'ready';
  const entryEnergy = member.energy?.entry ?? ENERGY_CAP;

  const scoreParts: ScorePart[] = [
    { label: `承伤 ${fmtMult(defMultiplier)}`, points: defPoints(defMultiplier) },
    { label: `反打 ${fmtMult(atkMultiplier)}`, points: atkPoints(atkMultiplier) },
    { label: `速度 ${speed ?? '—'}`, points: speedPoints(speed) },
    { label: energyLabel(energyStatus), points: energyPoints(energyStatus) },
  ];

  return {
    spiritId: spirit.id,
    dex: spirit.dex,
    name: spirit.name,
    avatar: spirit.avatar,
    types: spirit.type,
    role: member.role,
    duty: member.duty ?? null,
    speed,
    defMultiplier,
    atkMultiplier,
    coreSkill: best,
    energyStatus,
    entryEnergy,
    score: scoreParts.reduce((a, b) => a + b.points, 0),
    scoreParts,
  };
}

export function energyLabel(status: EnergyStatus): string {
  return status === 'ready' ? '入场即出招' : status === 'gather' ? '需先聚能' : '入场 0 能量';
}

/** 排序：分数 → 反打倍率 → 承伤更低 → 速度更快 → 图鉴编号 */
function rankCandidates(a: MatchupCandidate, b: MatchupCandidate): number {
  return (
    b.score - a.score ||
    b.atkMultiplier - a.atkMultiplier ||
    a.defMultiplier - b.defMultiplier ||
    (b.speed ?? 0) - (a.speed ?? 0) ||
    (Number(a.dex) || 9999) - (Number(b.dex) || 9999)
  );
}

/* ------------------------------------------------------------ 出招顺序 */

interface Draft {
  label: string;
  kind: 'skill' | 'gather' | 'pivot';
  skill: ResolvedSkill | null;
  text: string;
  effect: string | null;
  before: number;
  after: number;
  cost: number | null;
  gain: number | null;
}

function gatherStep(label: string, before: number, cap: number, need: number): Draft {
  const gap = Math.max(0, need - before);
  const turns = Math.max(1, Math.ceil(gap / GATHER_GAIN));
  const after = Math.min(cap, before + turns * GATHER_GAIN);
  return {
    label,
    kind: 'gather',
    skill: null,
    text: `先聚能 ${turns} 回合（每回合 +${GATHER_GAIN} 点，上限 ${cap}）：${before} → ${after} 点。`,
    effect: null,
    before,
    after,
    cost: null,
    gain: turns * GATHER_GAIN,
  };
}

function skillStep(
  label: string,
  sk: ResolvedSkill,
  enemyType: string,
  before: number,
): Draft {
  const cost = costOf(sk);
  const mult = matchup(sk.type, [enemyType]).multiplier;
  const parts: string[] = [];
  if (isDamage(sk)) parts.push(`对${enemyType}系 ${fmtMult(mult)}`);
  parts.push(`能量 ${before} → ${Math.max(0, before - cost)} 点`);
  if (isCharge(sk)) parts.push('图鉴写明这招要「蓄力」，出招占一个蓄力回合、别把节奏算成两发');
  return {
    label,
    kind: 'skill',
    skill: sk,
    text: parts.join('，') + '。',
    effect: effectOf(sk),
    before,
    after: Math.max(0, before - cost),
    cost,
    gain: null,
  };
}

/**
 * 2~3 步出招：① 开场（强化/核心/低费试探）→ ② 核心克制招（能量不够就先聚能）→ ③ 补刀过渡或聚能。
 * 只在这只精灵真实的 4 个推荐技能里挑，不新增技能。
 */
function buildSteps(
  spirit: Spirit,
  member: PresetMember,
  enemyType: string,
  entry: number,
  cap: number,
  status: EnergyStatus,
  backupName: string,
): Draft[] {
  const skills = memberSkills(spirit, member);
  // 换命招（彗星等「使用后消耗全部生命」）不进常规出招链
  const hits = skills
    .filter((sk) => isDamage(sk) && !isSuicide(sk))
    .map((sk) => ({ sk, mult: matchup(sk.type, [enemyType]).multiplier }))
    .sort((a, b) => b.mult - a.mult || (b.sk.power ?? 0) - (a.sk.power ?? 0) || costOf(a.sk) - costOf(b.sk));
  const core = hits[0]?.sk ?? null;
  const used = new Set<string>();
  const steps: Draft[] = [];
  let energy = entry;
  // 标签只说数据：×2 以上叫「核心克制」，等倍叫「主力输出」
  const coreLabel = core ? (matchup(core.type, [enemyType]).multiplier >= 2 ? '核心克制' : '主力输出') : '主力输出';

  const pushGather = (label: string, need: number) => {
    const d = gatherStep(label, energy, cap, need);
    steps.push(d);
    energy = d.after;
  };
  const pushSkill = (label: string, sk: ResolvedSkill) => {
    const d = skillStep(label, sk, enemyType, energy);
    steps.push(d);
    energy = d.after;
    used.add(sk.name);
  };

  // ① 开场：入场 0 能量先聚能 → 强化招（强化+核心能在现有能量内打完）→ 直接核心 → 低费试探/干扰
  if (status === 'starved' || entry <= 0) {
    pushGather('先聚能', core ? costOf(core) : 0);
  } else {
    const buffs = skills
      .filter((sk) => isSelfBuff(sk) && costOf(sk) <= energy)
      .sort((a, b) => costOf(a) - costOf(b));
    const coreCost = core ? costOf(core) : 0;
    const buff = buffs.find((sk) => costOf(sk) + coreCost <= energy) ?? null;
    const cheap = hits.filter((h) => costOf(h.sk) <= energy).map((h) => h.sk)[0] ?? null;
    const disrupt = skills
      .filter((sk) => isDisrupt(sk) && costOf(sk) <= energy)
      .sort((a, b) => costOf(a) - costOf(b))[0] ?? null;
    if (buff) pushSkill('开场先强化', buff);
    else if (core && coreCost <= energy) pushSkill(coreLabel, core);
    else if (cheap) pushSkill('低费先试探', cheap);
    else if (disrupt) pushSkill('先手干扰', disrupt);
    else if (core) pushGather('先聚能', coreCost);
  }

  // ② 核心招还没打：能量不够就先聚能，再打
  if (core && !used.has(core.name)) {
    if (energy < costOf(core)) pushGather('补聚能', costOf(core));
    if (steps.length < 3) pushSkill(coreLabel, core);
  }

  // ③ 收尾：顺着剩下不被抗的招补刀；不够能量就先聚能再补（前提是还留得下这一步）
  while (steps.length < 3) {
    const next = hits.find((h) => !used.has(h.sk.name) && h.mult >= 1);
    if (!next) break;
    if (costOf(next.sk) <= energy) {
      pushSkill(next.mult >= 2 ? '接着补一发' : '补刀过渡', next.sk);
    } else if (steps.length <= 1) {
      pushGather('补聚能', costOf(next.sk));
    } else {
      break;
    }
  }

  // 剩下的招全被这个系抗：如实写「别硬打，留能量换备选」，不凑虚假输出
  if (steps.length < 2) {
    const remain = hits.filter((h) => !used.has(h.sk.name));
    const fought = steps.length > 0;
    const resisted = remain.length
      ? `剩下 ${remain.length} 招打${enemyType}系都被抗（最高只有 ${fmtMult(
          Math.max(...remain.map((h) => h.mult)),
        )} 倍），别拿它们硬打`
      : '这只的 4 招没有对这个系的输出';
    steps.push({
      label: fought ? '打完就退' : '打不动就退',
      kind: 'pivot',
      skill: null,
      text: `${resisted}：留 ${energy} 点能量换「${backupName}」接这一系，或者聚能等下一波。`,
      effect: null,
      before: energy,
      after: energy,
      cost: null,
      gain: null,
    });
  }

  return steps.slice(0, 3);
}

/* ------------------------------------------------------------ 一系一份方案 */

function buildPlan(preset: TeamPreset, enemyType: string): TypeMatchupPlan | null {
  const candidates = preset.members
    .map((m) => evaluateCandidate(m, enemyType))
    .filter((c): c is MatchupCandidate => c !== null)
    .sort(rankCandidates);
  if (!candidates.length) return null;
  const pick = candidates[0];
  // 备选退路优先挑「比主力更抗这一系」的那只（换上去才叫退路），没有就取分数第二
  const backup =
    candidates.find((c) => c.spiritId !== pick.spiritId && c.defMultiplier < pick.defMultiplier) ??
    candidates[1] ??
    candidates[0];
  const spirit = presetSpirit(pick.spiritId);
  const member = preset.members.find((m) => m.spiritId === pick.spiritId);
  if (!spirit || !member) return null;

  const entry = member.energy?.entry ?? ENERGY_CAP;
  const cap = member.energy?.cap ?? ENERGY_CAP;
  const status = member.energy?.status ?? 'ready';
  const drafts = buildSteps(spirit, member, enemyType, entry, cap, status, shortName(backup.name));

  // 抗性事实：全队最抗这一系的是谁
  const mostResistant = [...candidates].sort(
    (a, b) => a.defMultiplier - b.defMultiplier || b.score - a.score,
  )[0];
  const resistLine =
    mostResistant.defMultiplier <= 0.5
      ? mostResistant.spiritId === pick.spiritId
        ? `本套最抗${enemyType}系的就是主力${shortName(pick.name)}：只吃 ${fmtMult(mostResistant.defMultiplier)}。`
        : `本套最抗${enemyType}系的是${shortName(mostResistant.name)}（只吃 ${fmtMult(
            mostResistant.defMultiplier,
          )}）；主力${shortName(pick.name)}吃 ${fmtMult(pick.defMultiplier)}，要更稳就换它。`
      : `本套 6 只没有对${enemyType}系的 0.5 倍抗性（最抗的${shortName(mostResistant.name)}也吃 ${fmtMult(
          mostResistant.defMultiplier,
        )}），只能等倍对拼、按最高反打效率打。`;

  const cautionParts: string[] = [resistLine];
  if (pick.defMultiplier >= 2) {
    const guard = memberSkills(spirit, member).filter(isGuard).sort((a, b) => costOf(a) - costOf(b))[0];
    cautionParts.push(
      `主力自己也吃 ${fmtMult(pick.defMultiplier)}，别硬顶${guard ? `；被压时先打「${guard.name}」（${costOf(guard)} 费）减伤` : ''}，被针对就退回${shortName(backup.name)}。`,
    );
  }
  if (pick.speed !== null && pick.speed < SPEED_TIERS.mid) {
    cautionParts.push(`速度 ${pick.speed} 在 120 高速线以下，遇到高速对手是后手。`);
  }
  if (status !== 'ready' && member.energy) {
    cautionParts.push(member.energy.caution);
  }

  const swift = member.skills
    .map((ref) => resolveMemberSkill(spirit, ref.name))
    .find((sk): sk is ResolvedSkill => Boolean(sk) && isSwift(sk!));
  const switchInNote = swift
    ? `主动换入时，带「迅捷」的「${swift.name}」（${costOf(swift)} 费）会先自动释放一次。`
    : null;

  const coreText = pick.coreSkill
    ? `${pick.coreSkill.name} ${fmtMult(pick.coreSkill.multiplier)}${pick.coreSkill.power ? `·威力${pick.coreSkill.power}` : ''}`
    : '无输出招';

  return {
    type: enemyType,
    pick,
    backup,
    steps: drafts.map((d, i) => ({
      no: ['①', '②', '③'][i] ?? String(i + 1),
      label: d.label,
      kind: d.kind,
      skill: d.skill ? viewSkill(d.skill, enemyType) : null,
      text: d.text,
      effect: d.effect,
      energy: { before: d.before, after: d.after, cost: d.cost, gain: d.gain },
    })),
    switchInNote,
    resistLine,
    caution: cautionParts.join(' '),
    quick: coreText,
    threat: pick.score,
  };
}

/** 3 套阵容 × 18 系，全部现算 */
export function buildTeamMatchup(preset: TeamPreset): TypeMatchupPlan[] {
  return TYPE_ORDER.map((type) => buildPlan(preset, type)).filter((p): p is TypeMatchupPlan => p !== null);
}

/** 默认点开哪一系：这一套最没有把握（主力得分最低）的那一系，最值得先看 */
export function weakestType(plans: TypeMatchupPlan[]): string {
  if (!plans.length) return TYPE_ORDER[0];
  return [...plans].sort((a, b) => a.threat - b.threat)[0].type;
}

/** 速览行的备选同上：同一份数据，页面直接用 */
export function planOf(plans: TypeMatchupPlan[], type: string): TypeMatchupPlan {
  return plans.find((p) => p.type === type) ?? plans[0];
}

