/**
 * 「培养方案」引擎：性格、个体值、4 个携带技能、改血脉全部由 src/data/ 的真数据推演。
 *
 * 数据来源（均可复现：python3 scripts/fetch-wiki.py）
 *   natures.json    模块:Natures/data —— 30 种性格各自提升/降低的能力项
 *   bloodlines.json 模块:Pets/data/Learnsets —— 每个学习面在 18 系别血脉 + 普通血脉下的血脉技能
 *   skills.json / learnsets.json / spirits.json —— 技能数值与学习面
 *   type-chart.json 模块:Pets/data/Types —— 18 系克制倍率
 *
 * 这里只有两类东西：图鉴原值，以及在这些原值上做的加减乘除。
 * 百分比口径（10% / 20%）来自游戏内说明，Wiki 只列提升/降低项，界面上会写清楚。
 *
 * 唯一的例外是「阵容对齐」：当期 48 小时轮换阵容里的 18 只精灵，四格直接取阵容推荐为它
 * 选出的 4 招（同技能、同顺序），其余（性格/个体值/防御弱点说明）照本流派自己算。
 * 阵容数据每 48 小时由 scripts/rotate-teams.ts 重算，所以培养页永远跟着最新阵容走。
 *
 * 配招的四格顺序（四格都只用它自己学得到的技能）：
 *   1 主攻    本系里综合效率最高的一招
 *   2 反克制  能对「打得动自己的属性」打出 ≥2 倍的攻击招（优先异属性，避免本系被一项抵抗全挡）
 *   3 第二输出 另一本系输出 / 能耗节奏互补的第二本系招 / 高质量异属性补盲
 *   4 辅助    回复·减伤·强化·控制等变化技；没有合适的就补第 4 个输出
 * 反克制只认 type-chart.json 的真实倍率（>= 2），没有就诚实退回补盲，不虚构克制关系。
 */
import bloodlinesData from '../data/bloodlines.json';
import naturesData from '../data/natures.json';
import rotationData from '../data/team-rotation.json';
import { spiritMetrics } from './analysis';
import type { StatKey } from './analysis';
import { BLOODLINE_RULE_NOTE, BLOODLINE_SKILL_LIMIT } from './equip-rules';
import { skillById, skillsOf, spirits } from './spirits';
import { matchup, TYPE_ORDER } from './typeChart';
import type { TeamRotationFile } from './team-types';
import type { BloodlineTable, Nature, NatureTable, ResolvedSkill, Skill, Spirit } from './types';

export { BLOODLINE_SKILL_LIMIT, BLOODLINE_RULE_NOTE };

export const natureTable = naturesData as unknown as NatureTable;
export const natures: Nature[] = natureTable.rows;
export const bloodlineTable = bloodlinesData as unknown as BloodlineTable;

/** 游戏内说明：性格增益随成长星级放大，1 星 10%，5 星 20%（Wiki 未公布百分比）。 */
export const NATURE_SCALE_NOTE = '*增益数值成长 1 星为 10%，成长 5 星为 20%。';

export type PresetKey = 'burst' | 'bulk';

export const PRESETS: { key: PresetKey; label: string; hint: string }[] = [
  { key: 'burst', label: '速攻爆发', hint: '威力/能耗优先，抢节奏先手压制' },
  { key: 'bulk', label: '耐久消耗', hint: '续航、减伤、控制优先，换回合数' },
];

const STAT_LABEL: Record<StatKey, string> = {
  hp: '生命',
  atk: '物攻',
  def: '物防',
  spa: '魔攻',
  spd: '魔防',
  spe: '速度',
};

const SOURCE_LABEL: Record<number, '升级' | '技能石' | '血脉'> = { 0: '升级', 1: '技能石', 2: '血脉' };

const mean = (arr: number[]) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0);

export function isDamaging(sk: Skill): boolean {
  return typeof sk.power === 'number' && sk.power > 0 && Boolean(sk.type);
}

/** 名字去掉括号里的形态后缀：「圣代甜甜（杨桃巧克力口味）」→「圣代甜甜」 */
export function baseName(name: string): string {
  return name.replace(/（[^）]*）/g, '').replace(/\([^)]*\)/g, '').trim();
}

const stars = (energy: number | null | undefined) => (energy == null ? '★—' : `★${energy}`);

/* ------------------------------------------------------------------ 属性强度 */

interface OffenceProfile {
  mean: number;
  superCount: number;
  resistCount: number;
}

const offenceCache = new Map<string, OffenceProfile>();

/** 一个攻击属性对 18 系的整体收益：平均倍率、克制几个系、被几个系抵抗。 */
export function offenceProfile(type: string): OffenceProfile {
  const hit = offenceCache.get(type);
  if (hit) return hit;
  let sum = 0;
  let superCount = 0;
  let resistCount = 0;
  for (const def of TYPE_ORDER) {
    const m = matchup(type, [def]).multiplier;
    sum += m;
    if (m >= 2) superCount += 1;
    if (m < 1) resistCount += 1;
  }
  const profile = { mean: sum / Math.max(1, TYPE_ORDER.length), superCount, resistCount };
  offenceCache.set(type, profile);
  return profile;
}

/** 这个攻击属性能 ×2 打穿的属性（type-chart 原表，按 18 系顺序）。 */
export function superTypesOf(atkType: string): string[] {
  return TYPE_ORDER.filter((def) => matchup(atkType, [def]).multiplier >= 2);
}

/* ------------------------------------------------------------------ 防御弱点 */

export interface WeakPoint {
  /** 能打这只精灵 ≥2 倍的攻击属性 */
  type: string;
  multiplier: number;
  /** 全合法池（升级 / 技能石 / 19 个血脉候选）里能对它 ×2 反制的攻击属性 */
  counterTypes: string[];
}

/** 防御弱点：所有对 spirit.type 打出 ≥2 倍伤害的攻击属性。 */
export function weaknessesOf(spirit: Spirit): { type: string; multiplier: number }[] {
  return TYPE_ORDER.map((atk) => ({ type: atk, multiplier: matchup(atk, spirit.type).multiplier }))
    .filter((w) => w.multiplier >= 2)
    .sort((a, b) => b.multiplier - a.multiplier || TYPE_ORDER.indexOf(a.type) - TYPE_ORDER.indexOf(b.type));
}

/** 这招能 ×2 反制到哪些弱点属性（返回弱点属性名，空数组 = 不是反克制招）。 */
function counterHitsOf(sk: Skill, weakTypes: string[]): string[] {
  if (!isDamaging(sk) || !weakTypes.length) return [];
  return weakTypes.filter((w) => matchup(sk.type, [w]).multiplier >= 2);
}

/* ------------------------------------------------------------------ 技能打分 */

function damageValue(sk: Skill, spirit: Spirit, mainCat: string, preset: PresetKey): number {
  const power = sk.power ?? 0;
  const energy = Math.max(1, sk.energy ?? 4);
  const stab = spirit.type.includes(sk.type) ? 1.25 : 1;
  const catFit = sk.category === mainCat ? 1 : 0.55;
  const cov = Math.max(0.5, 1 + (offenceProfile(sk.type).mean - 1) * 0.9);
  const charge = /蓄力/.test(sk.effect) ? 0.6 : 1;
  const styleFit = preset === 'burst' ? 1 : 0.94;
  /* 威力是主项，能耗做修正：高威力 + 低能耗（本作以能耗换威力）都加分 */
  const volume = power * (1 + 0.45 * (1 - Math.min(energy, 8) / 8));
  return volume * stab * catFit * cov * charge * styleFit * traitSynergy(spirit, sk);
}

/** 特性文本和技能文本命中同一个关键词时算协同（冻结/中毒/连击…），都是图鉴原文。 */
const SYNERGY_WORDS = ['冻结', '灼烧', '中毒', '寄生', '麻痹', '连击', '蓄力'];

function traitWord(spirit: Spirit, sk: Skill): string | null {
  const trait = spirit.trait?.effect ?? '';
  if (!trait) return null;
  for (const word of SYNERGY_WORDS) {
    if (trait.includes(word) && sk.effect.includes(word)) return word;
  }
  return null;
}

function traitSynergy(spirit: Spirit, sk: Skill): number {
  return traitWord(spirit, sk) ? 1.12 : 1;
}

/**
 * 变化技的功能分：按图鉴原文里的真实幅度打分，而不是只数「命中了几类关键词」。
 * 「双攻+150%」和「双攻+30%」、 「回复50%生命」和「回复20%生命」显然不是一个量级。
 * 百分比按原文读；原文给的是固定值（速度+80）时按 0.8 折算成同量纲（估算口径，不是游戏数值）。
 */
function maxBonusValue(text: string): number {
  let best = 0;
  const re = /\+(\d+(?:\.\d+)?)(%?)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const v = Number(m[1]) * (m[2] === '%' ? 1 : 0.8);
    if (v > best) best = v;
  }
  return best;
}

interface UtilityComponent {
  tag: string;
  score: number;
}

function utilityComponents(sk: Skill): UtilityComponent[] {
  const text = sk.effect ?? '';
  const out: UtilityComponent[] = [];
  const heal = /回复(\d+)%生命/.exec(text);
  if (heal) out.push({ tag: '回复', score: 0.6 + 0.06 * Number(heal[1]) });
  else if (/回复[^。]{0,4}生命|回复[一二三四五六七八九十]+成/.test(text)) out.push({ tag: '回复', score: 1.6 });
  const guard = /减伤(\d+)%/.exec(text);
  if (guard) out.push({ tag: '减伤', score: 0.5 + 0.03 * Number(guard[1]) });
  if (/免疫/.test(text)) out.push({ tag: '免疫', score: 2.0 });
  const status = /(冻结|麻痹|中毒|寄生|灼烧)/.exec(text);
  if (status) {
    const layers = /(\d+)层/.exec(text);
    out.push({ tag: status[1], score: 0.8 + 0.25 * (layers ? Number(layers[1]) : 1) });
  }
  if (/永久\+|提升|增益|强化|获得[^。；]{0,12}\+\d/.test(text)) {
    out.push({ tag: '强化', score: 0.6 + 0.022 * Math.max(30, maxBonusValue(text)) });
  }
  if (/解除|清除|净化/.test(text)) out.push({ tag: '解控', score: 1.7 });
  if (/能量/.test(text)) out.push({ tag: '回能', score: 1.1 });
  return out.sort((a, b) => b.score - a.score);
}

function utilityTags(sk: Skill): string[] {
  return utilityComponents(sk).map((c) => c.tag);
}

function utilityValue(sk: Skill, preset: PresetKey, spirit?: Spirit): number {
  const comps = utilityComponents(sk);
  if (!comps.length) return 0;
  /* 主效果全额，附带效果（「应对防御：改为…」这类条件加码）只算三成五，避免一件事被数两遍 */
  let score = comps[0].score + 0.35 * comps.slice(1).reduce((acc, c) => acc + c.score, 0);
  if (/应对/.test(sk.effect ?? '')) score += 0.8;
  score -= Math.max(0, (sk.energy ?? 3) - 2) * 0.25;
  if (spirit) {
    const word = traitWord(spirit, sk);
    /* 「蓄力」是整套节奏机制：特性明写蓄力时，蓄力技几乎等于零成本，协同价値远高于一个普通关键词 */
    if (word) score += word === '蓄力' ? 1.2 : 0.9;
  }
  return score * (preset === 'bulk' ? 1.45 : 1.05);
}

/* ------------------------------------------------------------------ 血脉互斥 */

/* 硬规则（同一套配招最多 1 个血脉技能）的口径与说明集中在 src/lib/equip-rules.ts，
   这里只负责：在 19 个血脉候选里挑出唯一一个最优，其余血脉技能不进候选池。 */

/** 这一招能补上几个「本体属性打不出 ≥2 倍」的目标属性。 */
function coverageGainOf(spirit: Spirit, sk: Skill): number {
  if (!isDamaging(sk)) return 0;
  const ownTypes = spirit.type.filter(Boolean);
  return TYPE_ORDER.filter((def) => {
    const own = ownTypes.reduce((acc, t) => Math.max(acc, matchup(t, [def]).multiplier), 0);
    return own < 2 && matchup(sk.type, [def]).multiplier >= 2;
  }).length;
}

interface BloodOption {
  blood: string;
  skill: Skill;
  level: number | null;
  kind: BloodPick['kind'];
  value: number;
  gain: number;
  /** 这招能 ×2 反制的弱点属性（空 = 不是反克制招） */
  counterHits: string[];
  reason: string;
}

/**
 * 这只精灵在 18 系别血脉 + 普通血脉下能拿到的全部血脉技能，逐个打分后从高到低排序。
 * 打分口径（全部由图鉴原值算出）：属性本系 ×1.25、物理/魔法定位、威力与能耗、
 * 克制面（能补几个本体打不动的属性）、能反制几个自身弱点（每覆盖一个 +12%）、
 * 特性关键词协同、变化技能的功能权重。
 */
function bloodCandidates(
  spirit: Spirit,
  mainCat: '物理' | '魔法',
  preset: PresetKey,
  weakTypes: string[],
): BloodOption[] {
  const setName = bloodlineTable.learnset[spirit.learnset ?? ''] ?? '';
  const set: Record<string, string> = bloodlineTable.sets[setName] ?? {};
  const out: BloodOption[] = [];
  for (const [blood, sid] of Object.entries(set)) {
    const skill = skillById(sid);
    if (!skill) continue;
    const level = bloodlineTable.levels[blood] ?? null;
    const damaging = isDamaging(skill);
    const stab = spirit.type.includes(skill.type);
    const gain = coverageGainOf(spirit, skill);
    const counterHits = damaging ? counterHitsOf(skill, weakTypes) : [];
    let value: number;
    let kind: BloodPick['kind'];
    if (damaging) {
      /* 和普通技能用同一把尺子（本系已在 damageValue 里 ×1.25），再给补盲属性一点点加权 */
      value = damageValue(skill, spirit, mainCat, preset) * (1 + 0.06 * gain) * (1 + 0.12 * counterHits.length);
      kind = stab ? '本系' : '补盲';
    } else {
      value = utilityValue(skill, preset, spirit);
      kind = '功能';
    }
    const detail = damaging
      ? `${skill.type}系${skill.category}，威力 ${skill.power} / 能耗 ${skill.energy}`
      : `${skill.type}系变化：${skill.effect || '—'}`;
    const chargeNote = /蓄力/.test(skill.effect) ? '；蓄力招要占一回合换这份威力' : '';
    const gainNote = damaging && gain > 0 && !stab ? `，补 ${gain} 个本体打不动的属性` : '';
    const counterNote = counterHits.length ? `，能 ×2 反制弱点 ${counterHits.join('、')}` : '';
    const reason = damaging
      ? stab
        ? `改${blood}血脉拿「${skill.name}」：${detail}，本系 1.25 加成${gainNote}${counterNote}${chargeNote}`
        : `改${blood}血脉拿「${skill.name}」：${detail}${gainNote}${counterNote}${chargeNote}`
      : `改${blood}血脉拿「${skill.name}」：${detail}${counterNote}`;
    out.push({ blood, skill, level, kind, value, gain, counterHits, reason });
  }
  return out.sort(
    (a, b) =>
      b.value - a.value ||
      (a.kind === '本系' ? 0 : 1) - (b.kind === '本系' ? 0 : 1) ||
      (a.level ?? 99) - (b.level ?? 99),
  );
}

/* ------------------------------------------------------------------ 性格 */

function findNature(up: StatKey, down: StatKey): Nature {
  return natures.find((n) => n.upKey === up && n.downKey === down) ?? natures[0];
}

function natureLine(n: Nature): string {
  return `「${n.up} +10%，${n.down} -10%」`;
}

/* ------------------------------------------------------------------ 阵容对齐 */

/**
 * 当期 48 小时轮换阵容里这只精灵的位置。
 * 数据来自 src/data/team-rotation.json（由 scripts/rotate-teams.ts 每 48 小时重算一次并 baked 进静态包），
 * 所以「阵容推荐」页看到的四招，就是培养页这里的四招；轮换后培养页会自动跟着变。
 */
export interface TeamAlignment {
  round: number;
  teamId: string;
  teamName: string;
  category: string;
  /** 队内分工：先手 / 核心输出 / 控制 / 辅助 / 承伤 / 收割 */
  role: string;
  /** 技能名，顺序与阵容页完全一致 */
  skillNames: string[];
}

const ROTATION = rotationData as unknown as TeamRotationFile;

const TEAM_ALIGNMENT = new Map<string, TeamAlignment>();
for (const team of ROTATION.teams) {
  for (const member of team.members) {
    if (TEAM_ALIGNMENT.has(member.spiritId)) continue;
    TEAM_ALIGNMENT.set(member.spiritId, {
      round: ROTATION.round,
      teamId: team.id,
      teamName: team.name,
      category: team.category,
      role: member.role,
      skillNames: member.skills.map((s) => s.name),
    });
  }
}

/** 这只精灵在不在当期轮换阵容里；在的话四招必须与阵容页完全一致。 */
export function teamAlignmentOf(spiritId: string): TeamAlignment | null {
  return TEAM_ALIGNMENT.get(spiritId) ?? null;
}

interface TeamSkillHit {
  skill: ResolvedSkill;
  /** 只有靠改血脉才能拿到这一招时才有值 */
  blood: { blood: string; level: number | null } | null;
}

/** 这一招是改哪个血脉拿到的（在它的血脉学习面里按技能 id 反查）。 */
function bloodGrantOf(spirit: Spirit, skill: Skill): { blood: string; level: number | null } | null {
  const setName = bloodlineTable.learnset[spirit.learnset ?? ''] ?? '';
  const set = bloodlineTable.sets[setName] ?? {};
  for (const [blood, sid] of Object.entries(set)) {
    if (sid === skill.id) return { blood, level: bloodlineTable.levels[blood] ?? null };
  }
  return null;
}

/** 阵容里写的技能名 → 这只精灵真正能带的技能：自带学习面优先，其次是改血脉能换到的那一招。 */
function teamSkillFor(spirit: Spirit, name: string): TeamSkillHit | null {
  const own = skillsOf(spirit);
  const regular = own.find((s) => s.name === name && s.learn !== 2);
  if (regular) return { skill: regular, blood: null };
  const inherited = own.find((s) => s.name === name && s.learn === 2);
  if (inherited) return { skill: inherited, blood: bloodGrantOf(spirit, inherited) };
  const setName = bloodlineTable.learnset[spirit.learnset ?? ''] ?? '';
  for (const [blood, sid] of Object.entries(bloodlineTable.sets[setName] ?? {})) {
    const sk = skillById(sid);
    if (!sk || sk.name !== name) continue;
    const level = bloodlineTable.levels[blood] ?? null;
    return { skill: { ...sk, learn: 2, level: level ?? undefined }, blood: { blood, level } };
  }
  return null;
}

/** 特性原文和技能原文里同时出现的机制词（迸发 / 萌化 / 连击…）——两边原文都有这个字，不是推测。 */
const SHARED_MECHANICS = ['迸发', '连击', '萌化', '蓄力', '冻结', '灼烧', '中毒', '寄生', '麻痹', '迅捷', '减伤', '回复', '能量'];

function sharedMechanic(spirit: Spirit, sk: Skill): string | null {
  const trait = spirit.trait?.effect ?? '';
  const effect = sk.effect ?? '';
  if (!trait || !effect) return null;
  for (const word of SHARED_MECHANICS) {
    if (trait.includes(word) && effect.includes(word)) return word;
  }
  return null;
}

/** 图鉴原文直接引用时去掉句尾标点 */
function effectText(sk: Skill): string {
  const text = (sk.effect ?? '').replace(/[。；;，,\s]+$/, '');
  if (!text) return '变化技能';
  return text.length > 36 ? `${text.slice(0, 36)}…` : text;
}

/** 有条件/代价的攻击招（「若敌方能量等于0」「敌方每有1能量」）把原文写进来，收割位就靠这些机制。 */
const CONDITIONAL_EFFECT = /若|每有|每层|倍伤害|倍|等于|低于|高于/;

function teamSlotReason(
  spirit: Spirit,
  sk: Skill,
  counters: string[],
  head: string,
  bloodLabel: string | null,
): string {
  const damaging = isDamaging(sk);
  const parts: string[] = [];
  parts.push(
    damaging
      ? `${sk.type}系${sk.category}，威力 ${sk.power}、能耗 ${stars(sk.energy)}`
      : `${sk.type}系变化，能耗 ${stars(sk.energy)}`,
  );
  if (bloodLabel) parts.push(bloodLabel);
  if (damaging && spirit.type.includes(sk.type)) parts.push('本系加成');
  if (counters.length) {
    parts.push(`×2 反制弱点 ${counters.join('、')}`);
  } else if (damaging) {
    const supers = superTypesOf(sk.type);
    parts.push(
      supers.length
        ? `×2 克制 ${supers.slice(0, 5).join('、')}${supers.length > 5 ? ' 等' : ''}`
        : '没有 ×2 克制面，靠威力与能耗硬打',
    );
  }
  /* 有条件、有代价的技能（「若敌方能量等于 0，造成 20 倍」「敌方每有 1 能量威力 -10%」）直接引原文 */
  if (!damaging || CONDITIONAL_EFFECT.test(sk.effect ?? '')) parts.push(`图鉴原文：${effectText(sk)}`);
  const word = sharedMechanic(spirit, sk);
  if (word && spirit.trait) parts.push(`特性「${spirit.trait.name}」正好管到「${word}」这一环`);
  return `${head}：${parts.join('；')}。`;
}

/**
 * 把本流派算出来的方案改成「阵容同款」：四招与顺序取阵容推荐，
 * 反克制结论、改血脉卡片与详细模式里提到四招的句子跟着改；性格/个体值/弱点表保持本流派自己的算法。
 */
function alignWithTeam(base: BuildGuide, spirit: Spirit, team: TeamAlignment): BuildGuide {
  const resolved = team.skillNames.map((name) => teamSkillFor(spirit, name));
  /* 技能名跟数据对不上（阵容数据坏了）就退回本流派自己的配招，门禁脚本会把这条差异报出来 */
  if (resolved.length !== 4 || resolved.some((hit) => hit === null)) return base;

  const weakTypes = base.weaknesses.map((w) => w.type);
  const ownTypeText = spirit.type.filter(Boolean).join('、');
  const tag = `第 ${team.round} 轮《${team.teamName}》${team.role}位`;

  const slots: BuildSlot[] = [];
  resolved.forEach((hit, index) => {
    const { skill, blood } = hit!;
    const damaging = isDamaging(skill);
    const stab = spirit.type.includes(skill.type);
    const counters = counterHitsOf(skill, weakTypes);
    let slotLabel: string;
    let kind: SlotKind;
    if (!damaging) {
      slotLabel = '辅助';
      kind = 'support';
    } else if (index === 0) {
      slotLabel = '主攻';
      kind = 'primary';
    } else if (counters.length) {
      slotLabel = '反克制';
      kind = 'counter';
    } else if (stab) {
      slotLabel = '第二输出';
      kind = 'second';
    } else {
      slotLabel = '补盲';
      kind = 'fill';
    }
    const bloodLabel =
      skill.learn === 2 && blood
        ? blood.blood === '普通'
          ? `普通血脉技能${blood.level ? `（Lv.${blood.level}）` : ''}`
          : `改${blood.blood}血脉取得${blood.level ? `（Lv.${blood.level}）` : ''}`
        : null;
    const head = `阵容同款·第 ${index + 1} 格（第 ${team.round} 轮《${team.teamName}》${team.role}位，与阵容页同技能同顺序）`;
    slots.push({
      skill,
      source: SOURCE_LABEL[skill.learn] ?? '升级',
      slot: slotLabel,
      kind,
      reason: teamSlotReason(spirit, skill, counters, head, bloodLabel),
    });
  });

  /* ---- 反克制结论：照阵容的四招重算，不带反克招时把原因写清楚（不报「需复核」） */
  const lockedIdx = (() => {
    let best = -1;
    let bestScore = 0;
    slots.forEach((s, i) => {
      const hitsHere = counterHitsOf(s.skill, weakTypes).length;
      if (!hitsHere) return;
      /* 能反制几个弱点优先，其次越疼越好（收割位会带上便宜的收尾招，不能让它顶替主输出） */
      const score = hitsHere * 10000 + (s.skill.power ?? 0);
      if (score > bestScore) {
        best = i;
        bestScore = score;
      }
    });
    return best;
  })();
  const lockedSlot = lockedIdx >= 0 ? slots[lockedIdx] : null;
  const lockedHits = lockedSlot ? counterHitsOf(lockedSlot.skill, weakTypes) : [];
  const counterNote = !weakTypes.length
    ? `这四招与阵容推荐${tag}完全一致；${spirit.name} 在克制表里没有 ×2 弱点（${ownTypeText}系），所以四格不设反克制位。`
    : lockedSlot
      ? `这四招与阵容推荐${tag}完全一致；反克制由第 ${lockedIdx + 1} 格「${lockedSlot.skill.name}」（${lockedSlot.source}）承担，${lockedSlot.skill.type} 系对 ${lockedHits.join('、')} 打出 ×2，正好反制能打穿${ownTypeText}系的属性。`
      : base.counter.poolTypes.length
        ? `这四招与阵容推荐${tag}完全一致：阵容侧按「${team.role}」的分工没带 ×2 反制 ${weakTypes.join('、')} 的攻击招（全合法池里有 ${base.counter.poolTypes.join('、')} 系可反制）。培养页照阵容同步，不另配一套，免得两边又打架。`
        : `这四招与阵容推荐${tag}完全一致；全合法池（升级 / 技能石 / 19 个血脉候选）里也没有能 ×2 反制 ${weakTypes.join('、')} 的攻击招。`;
  const counter: CounterPlan = {
    hasWeakness: weakTypes.length > 0,
    poolTypes: base.counter.poolTypes,
    locked: lockedSlot
      ? {
          name: lockedSlot.skill.name,
          type: lockedSlot.skill.type,
          covered: lockedHits,
          fromBlood: lockedSlot.skill.learn === 2,
          slotIndex: lockedIdx + 1,
        }
      : null,
    note: counterNote,
  };

  /* ---- 改血脉卡片：阵容带血脉技就同步填好，没带就明说不改血脉 */
  const bloodIndex = slots.findIndex((s) => s.skill.learn === 2);
  const bloodSlot = bloodIndex >= 0 ? slots[bloodIndex] : null;
  const equippedBlood: { blood: string; level: number | null } | null = bloodSlot
    ? bloodGrantOf(spirit, bloodSlot.skill) ?? { blood: '普通', level: null }
    : null;
  const mainBlood: BloodPick = equippedBlood && bloodSlot
    ? {
        blood: equippedBlood.blood,
        skill: bloodSlot.skill,
        level: equippedBlood.level,
        kind: !isDamaging(bloodSlot.skill) ? '功能' : spirit.type.includes(bloodSlot.skill.type) ? '本系' : '补盲',
        reason:
          equippedBlood.blood === '普通'
            ? `阵容推荐${tag}四招里的「${bloodSlot.skill.name}」是普通血脉技能${equippedBlood.level ? `，Lv.${equippedBlood.level} 可学` : ''}，占一个血脉技能位。`
            : `阵容推荐${tag}用这唯一的血脉名额换「${bloodSlot.skill.name}」：改${equippedBlood.blood}血脉拿到，Lv.${equippedBlood.level ?? 15} 可学。`,
        value: 0,
        equipped: true,
        slotIndex: bloodIndex + 1,
      }
    : {
        blood: base.bloodline.main.blood,
        skill: base.bloodline.main.skill,
        level: base.bloodline.main.level,
        kind: base.bloodline.main.kind,
        reason: `阵容推荐${tag}的四招不需要血脉技，培养页保持普通血脉。`,
        value: 0,
        equipped: false,
        slotIndex: null,
      };
  const variantsNote = base.variants.length
    ? ` 同族另有 ${base.variants.length} 个形态分支（${base.variants
        .slice(0, 3)
        .map((v) => v.formLabel || baseName(v.name))
        .join('、')}${base.variants.length > 3 ? '…' : ''}），种族值分布不同，方案要按具体形态重算。`
    : '';
  const bloodlineNote =
    (equippedBlood ? `血脉技能在 Lv.${equippedBlood.level ?? 15} 解锁。` : '') + BLOODLINE_RULE_NOTE + variantsNote;
  const bloodlineExplanation = mainBlood.equipped
    ? `${spirit.name} 在当期阵容推荐（${tag}）里带了血脉技「${mainBlood.skill.name}」（${
        mainBlood.blood === '普通'
          ? `普通血脉技能${mainBlood.level ? `，Lv.${mainBlood.level} 可学` : ''}`
          : `改${mainBlood.blood}血脉拿到，Lv.${mainBlood.level ?? 15} 可学`
      }），培养页照阵容同步，放在第 ${mainBlood.slotIndex} 格。一套配招最多 1 个血脉技，四格里不会再出现第二个。`
    : `${spirit.name} 在当期阵容推荐（${tag}）里没有血脉技，培养页就不加带血脉技能、保持普通血脉。` +
      (base.bloodline.main.blood !== '普通'
        ? `全库单独算下来收益最高的是${base.bloodline.main.blood}血脉「${base.bloodline.main.skill.name}」，但一套配招只带 1 个血脉技，阵容侧没选它。`
        : 'Wiki 里这只精灵没有可用的血脉技能表。');

  /* ---- 详细模式：把提到四招与改血脉的那两句换成阵容口径 */
  const alignLine = `四个技能直接取「阵容推荐」${tag}的配招，同技能同顺序：${slots
    .map((s) => s.skill.name)
    .join(' / ')}；48 小时轮换产出新阵容后，这里会自动跟着变，不用手动同步。`;
  const summary = base.summary.map((line) => {
    if (line.startsWith('四个技能的顺序是')) return alignLine;
    if (line === base.bloodline.explanation) return bloodlineExplanation;
    if (line.startsWith('流派切换：')) {
      return `流派切换：${PRESETS.map((p) => `${p.label}（${p.hint}）`).join(' / ')}——这只精灵在阵容推荐里，四招固定跟随阵容，切流派只重算性格、个体值与说明。`;
    }
    return line;
  });

  return {
    ...base,
    slots,
    counter,
    bloodline: { main: mainBlood, options: [mainBlood], note: bloodlineNote, explanation: bloodlineExplanation },
    summary,
    aligned: { ...team },
  };
}

/* ------------------------------------------------------------------ 输出结构 */

export type SlotKind = 'primary' | 'counter' | 'second' | 'support' | 'fill';

export interface BuildSlot {
  skill: ResolvedSkill;
  source: '升级' | '技能石' | '血脉';
  slot: string;
  kind: SlotKind;
  reason: string;
}

export interface NaturePick {
  nature: Nature;
  line: string;
  reason: string;
}

export interface IvPick {
  key: StatKey;
  label: string;
  reason: string;
}

export interface BloodPick {
  blood: string;
  skill: Skill;
  level: number | null;
  kind: '本系' | '补盲' | '功能';
  reason: string;
  value: number;
  /** 这个血脉技能是否真的进了四个携带技能（false = 本方案不改血脉、不带血脉技能） */
  equipped: boolean;
  /** 它占的是第几格（1~4），未装备时为 null */
  slotIndex: number | null;
}

export interface CounterPlan {
  /** 这只精灵有没有防御弱点 */
  hasWeakness: boolean;
  /** 全合法池（升级/技能石/19 个血脉候选）里能 ×2 反制弱点的攻击属性 */
  poolTypes: string[];
  /** 四格里实际锁定的那一招反克制技能；没有就是 null */
  locked: { name: string; type: string; covered: string[]; fromBlood: boolean; slotIndex: number } | null;
  note: string;
}

export interface FormVariant {
  name: string;
  formLabel: string;
}

export interface BuildGuide {
  spiritId: string;
  preset: PresetKey;
  presetLabel: string;
  roleLabel: string;
  roleTags: string[];
  mainKey: 'atk' | 'spa';
  mainLabel: string;
  mainCat: '物理' | '魔法';
  slots: BuildSlot[];
  /** 防御弱点（type-chart 原表），每个弱点附上全合法池里可反制的攻击属性 */
  weaknesses: WeakPoint[];
  counter: CounterPlan;
  nature: { main: NaturePick; alt: NaturePick };
  ivs: IvPick[];
  /** options 现在最多 1 个（与 main 同一个）：血脉技能互斥，不再给第二个备选 */
  bloodline: { main: BloodPick; options: BloodPick[]; note: string; explanation: string };
  variants: FormVariant[];
  summary: string[];
  /** 在当期轮换阵容里时：四招与阵容推荐完全一致；不在阵容里为 null */
  aligned: TeamAlignment | null;
}

function toSlot(sk: ResolvedSkill, slot: string, kind: SlotKind, reason: string): BuildSlot {
  return { skill: sk, source: SOURCE_LABEL[sk.learn] ?? '升级', slot, kind, reason };
}

/* ------------------------------------------------------------------ 主函数 */

/**
 * 本流派自己的配招算法（全库 665 只都走这里）。
 * 对外不要直接调用——用下面的 buildGuide()，它会把阵容里的 18 只换成阵容同款四招。
 */
function buildGuideBaseline(spirit: Spirit, preset: PresetKey = 'burst'): BuildGuide {
  const m = spiritMetrics(spirit);
  const atk = spirit.stats.atk ?? 0;
  const spa = spirit.stats.spa ?? 0;
  const physical = atk >= spa;
  const mainKey: 'atk' | 'spa' = physical ? 'atk' : 'spa';
  const mainLabel = STAT_LABEL[mainKey];
  const mainCat: '物理' | '魔法' = physical ? '物理' : '魔法';
  const dumpKey: StatKey = physical ? 'spa' : 'atk';
  const dumpLabel = STAT_LABEL[dumpKey];
  const spePct = m.stats.spe?.percentile ?? 0;
  const offPct = m.stats[mainKey]?.percentile ?? 0;
  const bulkPct = mean([m.stats.hp, m.stats.def, m.stats.spd].map((s) => s?.percentile ?? 0));
  const defPct = m.stats.def?.percentile ?? 0;
  const spdPct = m.stats.spd?.percentile ?? 0;
  const wall = preset === 'bulk' || (bulkPct >= 72 && offPct < 82);

  /* ---- 防御弱点：能打它 ≥2 倍的攻击属性（type-chart 原表） */
  const weakPoints = weaknessesOf(spirit);
  const weakTypes = weakPoints.map((w) => w.type);
  const ownTypeText = spirit.type.filter(Boolean).join('、');

  /* ---- 技能池：同一名字只留一个（不同学习来源）
     血脉技能互斥：19 个血脉技能里先选出唯一一个「最优」，其余血脉技能根本不进候选池，
     所以后面的四个技能位无论怎么填，都不可能同时出现两个血脉技能。 */
  const dedupeByName = (list: ResolvedSkill[]): ResolvedSkill[] => {
    const seenNames = new Set<string>();
    const out: ResolvedSkill[] = [];
    for (const sk of list) {
      if (seenNames.has(sk.name)) continue;
      seenNames.add(sk.name);
      out.push(sk);
    }
    return out;
  };
  const ownSkills = dedupeByName(skillsOf(spirit));
  const regularPool = ownSkills.filter((sk) => sk.learn !== 2);
  const regularNames = new Set(regularPool.map((sk) => sk.name));
  /* 普通学习面就能学到的技能，不需要靠改血脉再拿一遍，不参与「最优秀血技能」的评比 */
  const allBlood = bloodCandidates(spirit, mainCat, preset, weakTypes);
  const bloodRanked = allBlood.filter((o) => !regularNames.has(o.skill.name));

  /* ---- 唯一血脉名额的决策：优先用这一个名额补上反克制的空白
     1) 常规学习面（升级/技能石）根本没有能反制弱点的攻击招 → 血脉名额直接给最优的血脉反制招；
     2) 常规能反制、但血脉那招覆盖的弱点更多（比如机械系同时打冰/萌，本系只能打龙）
        → 只要它不是明显更弱的技能，就把名额给它；
     3) 其余情况按综合得分取第一名。 */
  const regularDamaging = regularPool.filter(isDamaging);
  const regularCounterBest = regularDamaging
    .map((sk) => counterHitsOf(sk, weakTypes).length)
    .reduce((acc, n) => Math.max(acc, n), 0);
  const bloodCounters = bloodRanked
    .filter((o) => o.counterHits.length > 0)
    .sort((a, b) => b.counterHits.length - a.counterHits.length || b.value - a.value);
  const topBlood = bloodRanked[0] ?? null;
  let champion: BloodOption | null = topBlood;
  if (bloodCounters.length) {
    const bestCounter = bloodCounters[0];
    if (regularCounterBest === 0) {
      champion = bestCounter;
    } else if (bestCounter.counterHits.length > regularCounterBest) {
      const floor = topBlood ? topBlood.value * 0.55 : 0;
      champion = bestCounter.value >= floor ? bestCounter : topBlood;
    }
  }
  const championAsSkill: ResolvedSkill | null = champion
    ? { ...champion.skill, learn: 2, level: champion.level ?? undefined }
    : null;
  const pool: ResolvedSkill[] = championAsSkill ? [...regularPool, championAsSkill] : [...regularPool];
  const damaging = pool.filter(isDamaging);
  const support = pool.filter((sk) => !isDamaging(sk));

  const damageRanked = damaging
    .map((sk) => ({ sk, v: damageValue(sk, spirit, mainCat, preset) }))
    .sort((a, b) => b.v - a.v || (b.sk.power ?? 0) - (a.sk.power ?? 0));
  const supportRanked = support
    .map((sk) => ({ sk, v: utilityValue(sk, preset, spirit), tags: utilityTags(sk) }))
    .sort((a, b) => b.v - a.v || (a.sk.energy ?? 9) - (b.sk.energy ?? 9));

  const slots: BuildSlot[] = [];
  const taken = new Set<string>();
  const typeUsed = new Set<string>();
  /* 硬门禁：四个技能位里已经有一个血脉技能时，任何血脉技能都不允许再进来 */
  const bloodInSlots = () => slots.filter((s) => s.skill.learn === 2).length;
  const canAdd = (sk: ResolvedSkill) =>
    !taken.has(sk.id) && !(sk.learn === 2 && bloodInSlots() >= BLOODLINE_SKILL_LIMIT);

  /** 「威力 200、能耗 ★3」这类纯图鉴数值，变化技不带威力 */
  const powerText = (sk: Skill) =>
    isDamaging(sk) ? `威力 ${sk.power}、能耗 ${stars(sk.energy)}` : `变化技、能耗 ${stars(sk.energy)}`;
  /** 图鉴原文直接引用时去掉句尾标点，避免「……。；特性」这种叠标点 */
  const effectLine = (sk: Skill) => (sk.effect ?? '').replace(/[。；;，,\s]+$/, '') || '变化技能';

  /* 本系加成后的有效威力：只用来判断「这一招是不是比另一招又贵又弱」，不是伤害数字 */
  const effPower = (sk: Skill) =>
    (sk.power ?? 0) * (spirit.type.includes(sk.type) ? 1.25 : 1);
  /**
   * 已经被带上的技能完全压制：同类别、有效威力不更高、能耗不更低、也拿不出新的 ×2 克制面。
   * 这种技能不推荐——场上有更便宜又更疼的一招，玩家不会去点它。
   */
  const dominatedBy = (sk: Skill, base: BuildSlot[]): BuildSlot | null => {
    if (!isDamaging(sk)) return null;
    for (const slot of base) {
      const other = slot.skill;
      if (!isDamaging(other) || other.category !== sk.category) continue;
      if (effPower(sk) > effPower(other)) continue;
      if ((sk.energy ?? 9) < (other.energy ?? 9)) continue;
      const otherSupers = new Set(superTypesOf(other.type));
      if (sk.type !== other.type && superTypesOf(sk.type).some((def) => !otherSupers.has(def))) continue;
      return slot;
    }
    return null;
  };
  const traitNote = (sk: Skill) => {
    const word = traitWord(spirit, sk);
    if (!word || !spirit.trait) return '';
    return `；特性「${spirit.trait.name}」正好管到「${word}」这一环`;
  };

  /* 1) 主攻：本系里最高效的一招（评分里已含本系 1.25、类别与消耗） */
  const primaryEntry =
    damageRanked.find((e) => canAdd(e.sk) && spirit.type.includes(e.sk.type)) ?? damageRanked.find((e) => canAdd(e.sk)) ?? null;
  const primary = primaryEntry ? primaryEntry.sk : null;
  if (primary) {
    const stab = spirit.type.includes(primary.type);
    const supers = superTypesOf(primary.type);
    const coverText = supers.length
      ? `（对 ${supers.length} 个属性 ×2：${supers.join('、')}）`
      : '（本身没有 ×2 克制面，靠威力和能耗硬打）';
    const chargeNote = /蓄力/.test(primary.effect) ? '；蓄力招要先蓄一回合，换这份威力' : '';
    taken.add(primary.id);
    typeUsed.add(primary.type);
    slots.push(
      toSlot(
        primary,
        '主攻',
        'primary',
        `${stab ? `本系${primary.category}主攻` : `主力输出（${primary.type}系）`}：${powerText(primary)}，${
          stab ? '享本系加成，' : ''
        }是核心输出招${coverText}${chargeNote}${traitNote(primary)}`,
      ),
    );
  }

  /* 2) 反克制位：能 ×2 打穿「打自己的属性」的攻击招，优先异属性（同属性容易被一招抵抗全挡） */
  const counterPool = damageRanked
    .filter((e) => canAdd(e.sk))
    .map((e) => ({
      ...e,
      hits: counterHitsOf(e.sk, weakTypes),
      fresh: typeUsed.has(e.sk.type) ? 0 : 1,
    }))
    .filter((e) => e.hits.length > 0)
    .sort((a, b) => b.hits.length - a.hits.length || b.fresh - a.fresh || b.v - a.v);
  /* 主攻本身就是唯一的反克制招时，也认它（四格里已经有反制手段） */
  const counterEntry = counterPool[0] ?? null;
  if (counterEntry) {
    const sk = counterEntry.sk;
    const sameAsPrimary = primary ? sk.type === primary.type : false;
    const newCover = superTypesOf(sk.type).filter(
      (def) => !primary || matchup(primary.type, [def]).multiplier < 2,
    );
    const newCoverText = newCover.length ? `；新覆盖 ${newCover.join('、')}` : '';
    taken.add(sk.id);
    typeUsed.add(sk.type);
    slots.push(
      toSlot(
        sk,
        '反克制',
        'counter',
        sameAsPrimary
          ? `反打弱点：${sk.type}系 ×2 克制 ${counterEntry.hits.join('、')}（正是克制${ownTypeText}系的属性）；本系反打——可学池里没有别的属性反制这组弱点，只能用它`
          : `反打弱点：${sk.type}系 ×2 克制 ${counterEntry.hits.join('、')}（正是克制${ownTypeText}系的属性）；${powerText(sk)}${newCoverText}`,
      ),
    );
  } else {
    /* 这一格没有单独的 ×2 反克招：要么主攻本身已经反制，要么合法池里确实没有，两者说明要分开写 */
    const gaps = TYPE_ORDER.filter((def) => {
      const best = [...typeUsed].reduce((acc, atkType) => Math.max(acc, matchup(atkType, [def]).multiplier), 0);
      return best < 1;
    });
    const coverEntry = damageRanked
      .filter((e) => canAdd(e.sk))
      .map((e) => ({ ...e, fresh: typeUsed.has(e.sk.type) ? 0 : 1 }))
      .sort((a, b) => b.fresh - a.fresh || b.v - a.v)[0];
    const primaryCounters = primary ? counterHitsOf(primary, weakTypes) : [];
    if (coverEntry) {
      const sk = coverEntry.sk;
      taken.add(sk.id);
      typeUsed.add(sk.type);
      const gapText = gaps.length ? `，能补上主攻打不动的 ${gaps.slice(0, 4).join('、')}` : '';
      slots.push(
        toSlot(
          sk,
          '补盲',
          'fill',
          primaryCounters.length && primary
            ? `反克制已由主攻「${primary.name}」承担（${primary.type}系 ×2 克制 ${primaryCounters.join('、')}），这格改补打击面：${sk.type} 系，${powerText(sk)}${gapText}`
            : `可学池无 ×2 反克弱点招式，改用 ${sk.type} 系补打击面：${powerText(sk)}${gapText}`,
        ),
      );
    }
  }

  /* 3) 第二输出：双属性补另一本系，单属性优先能耗节奏互补的第二本系招 */
  const primaryEnergy = primary?.energy ?? null;
  const secondEntry = damageRanked
    .filter((e) => canAdd(e.sk) && !dominatedBy(e.sk, slots))
    .map((e) => {
      const stab = spirit.type.includes(e.sk.type);
      const otherStab = stab && !typeUsed.has(e.sk.type);
      const energyDiff = primaryEnergy != null && (e.sk.energy ?? 0) !== primaryEnergy;
      /* 本系第二招更值钱：便宜一档的威力比不过同属性被抵抗的风险 */
      const score = e.v * (stab ? 1.15 : 1) * (energyDiff ? 1.03 : 1);
      return { ...e, stab, otherStab, energyDiff, score };
    })
    .sort((a, b) => b.score - a.score)[0];
  if (secondEntry && slots.length < 4) {
    const sk = secondEntry.sk;
    const energy = sk.energy ?? 0;
    const gapNote =
      energy >= 8
        ? `能耗 ★${energy}，一次上场只有 10 点，只够打这一发，留作收尾`
        : primaryEnergy != null && energy !== primaryEnergy
          ? `与主攻（能耗 ${stars(primaryEnergy)}）差 ${Math.abs(energy - primaryEnergy)} 点，节奏互补`
          : '和主攻同一档能耗，出手节奏接近';
    const offCover = superTypesOf(sk.type).filter((def) => !primary || matchup(primary.type, [def]).multiplier < 2);
    taken.add(sk.id);
    typeUsed.add(sk.type);
    slots.push(
      toSlot(
        sk,
        '第二输出',
        'second',
        secondEntry.otherStab
          ? `第二本系输出：${sk.type}系，${powerText(sk)}，双属性各一条本系输出线，对手用一项抵抗挡不住两边`
          : secondEntry.stab
            ? `第二招本系输出：${powerText(sk)}，${gapNote}，本系输出多一个选择`
            : offCover.length
              ? `补打击面：${sk.type}系，${powerText(sk)}，能 ×2 补上 ${offCover.join('、')}`
              : `备用输出：${sk.type}系，${powerText(sk)}，没有 ×2 克制面，纯粹拿威力顶伤害`,
      ),
    );
  }

  /* 4) 辅助：带一个最划算的状态/防御技能（特性关键词命中时更优先） */
  const supportGate = preset === 'bulk' ? 1.4 : 1.6;
  const supportEntry = supportRanked.find((e) => e.v >= supportGate && canAdd(e.sk)) ?? null;
  if (supportEntry && slots.length < 4) {
    const sk = supportEntry.sk;
    const keyword = supportEntry.tags[0] ?? '辅助';
    taken.add(sk.id);
    slots.push(
      toSlot(
        sk,
        '辅助',
        'support',
        `辅助位：带「${keyword}」效果——${effectLine(sk)}${traitNote(sk)}`,
      ),
    );
  }
  for (const entry of damageRanked) {
    if (slots.length >= 4) break;
    if (!canAdd(entry.sk)) continue;
    if (dominatedBy(entry.sk, slots)) continue;
    taken.add(entry.sk.id);
    slots.push(
      toSlot(
        entry.sk,
        '输出',
        'fill',
        `第 ${slots.length + 1} 输出：${entry.sk.type}系，${powerText(entry.sk)}，再多一条打击面`,
      ),
    );
  }
  /* 万一攻击技能不足 4 个，用剩下的变化技能补位 */
  for (const entry of supportRanked) {
    if (slots.length >= 4) break;
    if (!canAdd(entry.sk)) continue;
    taken.add(entry.sk.id);
    slots.push(toSlot(entry.sk, '变化', 'support', `变化位：${effectLine(entry.sk)}`));
  }

  /* ---- 反克制结论（给界面顶部一句话，也是门禁核对的那一条） */
  const legalDamaging: Skill[] = [...regularDamaging];
  for (const o of allBlood) {
    if (!isDamaging(o.skill)) continue;
    if (legalDamaging.some((sk) => sk.id === o.skill.id)) continue;
    legalDamaging.push(o.skill);
  }
  const poolCounterTypes = [...new Set(legalDamaging.filter((sk) => counterHitsOf(sk, weakTypes).length).map((sk) => sk.type))];
  const weaknesses: WeakPoint[] = weakPoints.map((w) => ({
    ...w,
    counterTypes: [...new Set(legalDamaging.filter((sk) => matchup(sk.type, [w.type]).multiplier >= 2).map((sk) => sk.type))],
  }));
  const lockedSlotIdx = (() => {
    const counterIdx = slots.findIndex((s) => s.kind === 'counter');
    if (counterIdx >= 0) return counterIdx;
    return slots.findIndex((s) => counterHitsOf(s.skill, weakTypes).length > 0);
  })();
  const lockedSk = lockedSlotIdx >= 0 ? slots[lockedSlotIdx] : null;
  const lockedHits = lockedSk ? counterHitsOf(lockedSk.skill, weakTypes) : [];
  const counterNote = !weakTypes.length
    ? `${spirit.name} 在克制表里没有 ×2 弱点（${ownTypeText}系），所以这四格不设反克制位，直接按输出与辅助补。`
    : lockedSk
      ? `反克制位已锁定 ${lockedSk.skill.type} 系「${lockedSk.skill.name}」（${lockedSk.source}，第 ${lockedSlotIdx + 1} 格），对 ${lockedHits.join('、')} 打出 ×2，正好反制能打穿${ownTypeText}系的属性。`
      : poolCounterTypes.length
        ? `全合法池里有 ${poolCounterTypes.join('、')} 系能反制弱点，但本方案四格没带上，需复核。`
        : `全合法池（升级 / 技能石 / 19 个血脉候选）里可学池无 ×2 反克弱点招式，反克制位改为补盲。`;
  const counter: CounterPlan = {
    hasWeakness: weakTypes.length > 0,
    poolTypes: poolCounterTypes,
    locked: lockedSk
      ? {
          name: lockedSk.skill.name,
          type: lockedSk.skill.type,
          covered: lockedHits,
          fromBlood: lockedSk.skill.learn === 2,
          slotIndex: lockedSlotIdx + 1,
        }
      : null,
    note: counterNote,
  };

  /* ---- 性格 */
  const speedNature = findNature('spe', dumpKey);
  const powerNature = findNature(mainKey, dumpKey);
  const hpNature = findNature('hp', dumpKey);
  const guardKey: StatKey = defPct <= spdPct ? 'def' : 'spd';
  const guardNature = findNature(guardKey, dumpKey);

  let mainNature: NaturePick;
  let altNature: NaturePick;
  if (wall) {
    mainNature = {
      nature: hpNature,
      line: natureLine(hpNature),
      reason: `耐久向：生命 +10% 撑住换血，把不用的${dumpLabel} -10%（耐久三项均值跑赢 ${Math.round(bulkPct)}% 的形态）`,
    };
    altNature = {
      nature: guardNature,
      line: natureLine(guardNature),
      reason: `换成正向加成${STAT_LABEL[guardKey]}：${STAT_LABEL[guardKey]} +10%，仍然只牺牲${dumpLabel}`,
    };
  } else if (spePct >= 60 && spePct >= offPct - 5) {
    mainNature = {
      nature: speedNature,
      line: natureLine(speedNature),
      reason: `速度 ${spirit.stats.spe ?? '—'}（超过 ${Math.round(spePct)}% 的形态）是先手本钱：速度 +10% 抢序列，${dumpLabel} -10% 不影响输出`,
    };
    altNature = {
      nature: powerNature,
      line: natureLine(powerNature),
      reason: `换成纯伤害：${mainLabel} +10%，${dumpLabel} -10%，速度回到原值`,
    };
  } else {
    mainNature = {
      nature: powerNature,
      line: natureLine(powerNature),
      reason: `${mainLabel} ${spirit.stats[mainKey] ?? '—'} 是主输出：${mainLabel} +10%，${dumpLabel} -10%（这项目本来就打不出伤害）`,
    };
    altNature = {
      nature: speedNature,
      line: natureLine(speedNature),
      reason: `反过来抢速度：速度 +10%，${dumpLabel} -10%`,
    };
  }

  /* ---- 个体值：3 个优先项 */
  const ivs: IvPick[] = [];
  const pushIv = (key: StatKey, reason: string) => {
    if (ivs.some((iv) => iv.key === key)) return;
    ivs.push({ key, label: STAT_LABEL[key], reason });
  };
  if (wall) {
    pushIv('hp', '生命先拉满：耐久向的换血本钱');
    pushIv(guardKey, `${STAT_LABEL[guardKey]}偏低（${spirit.stats[guardKey] ?? '—'}），个体值补最短的那块板`);
    if (spePct >= 60) pushIv('spe', '速度守住不落后，先手变化技能');
    else pushIv(mainKey, `${mainLabel}留一点，站场时也能换血`);
  } else {
    pushIv('hp', '生命兜底：输出手也要活过一次集火');
    pushIv(mainKey, `${mainLabel}拉满，直接乘在伤害公式上`);
    pushIv('spe', spePct >= 50 ? '速度补满，先手压制的关键' : '速度补一点，追到同速段');
  }

  /* ---- 改血脉（全库唯一入口：只给一个血脉技能，其余血脉技能全部剔除） */
  const equippedSlot = slots.findIndex((s) => s.skill.learn === 2);
  const equipped = equippedSlot >= 0 ? slots[equippedSlot] : null;
  const fallbackBloodSkill = ownSkills.find((sk) => sk.learn === 2) ?? regularPool[0];
  const mainBlood: BloodPick = champion
    ? {
        blood: champion.blood,
        skill: champion.skill,
        level: champion.level,
        kind: champion.kind,
        reason: champion.reason,
        value: champion.value,
        equipped: Boolean(equipped),
        slotIndex: equipped ? equippedSlot + 1 : null,
      }
    : {
        blood: '普通',
        skill: fallbackBloodSkill,
        level: null,
        kind: '功能',
        reason: 'Wiki 没有这只精灵的血脉技能表，保持默认普通血脉',
        value: 0,
        equipped: false,
        slotIndex: null,
      };
  const options: BloodPick[] = [mainBlood];
  const variants: FormVariant[] = spirits
    .filter((s) => baseName(s.name) === baseName(spirit.name) && s.id !== spirit.id)
    .map((s) => ({ name: s.name, formLabel: s.formLabel }));

  const chargeSuffix = /蓄力/.test(mainBlood.skill.effect) ? '；它是蓄力招，得占一回合换这份威力' : '';
  const bloodDetail =
    `${mainBlood.blood}血脉「${mainBlood.skill.name}」` +
    (isDamaging(mainBlood.skill as Skill)
      ? `（${mainBlood.skill.type}系${mainBlood.skill.category}，威力 ${mainBlood.skill.power ?? '—'} / 能耗 ${mainBlood.skill.energy ?? '—'}）${chargeSuffix}`
      : `（${mainBlood.skill.type}系变化：${mainBlood.skill.effect || '—'}）`);
  const rivalNote = (() => {
    if (!topBlood) return '';
    if (champion !== topBlood) {
      return `综合得分最高的是${topBlood.blood}血脉「${topBlood.skill.name}」（${Math.round(topBlood.value)} 分），但它反制不了这只精灵的弱点，所以名额给了「${mainBlood.skill.name}」。`;
    }
    const second = bloodRanked.find((o) => o !== champion);
    if (!second) return '';
    return `得分第二的${second.blood}血脉「${second.skill.name}」（${Math.round(second.value)} 分 vs ${Math.round(mainBlood.value)} 分）与它互斥，已剔除。`;
  })();
  const lastSlot = slots[slots.length - 1];
  const championCounters = champion ? counterHitsOf(champion.skill, weakTypes) : [];
  const counterPickNote =
    champion && championCounters.length && mainBlood.equipped
      ? `常规学习面${
          regularCounterBest === 0
            ? `没有能 ×2 反制 ${weakTypes.join('、')} 的攻击招`
            : `能反制的属性不如它全（最多覆盖 ${regularCounterBest} 个弱点）`
        }，所以这唯一的血脉名额优先给了它——${champion.skill.type}系 ×2 克制 ${championCounters.join('、')}。`
      : '';
  const bloodlineExplanation = !champion
    ? `${spirit.name} 的 Wiki 学习面里没有可用的血脉技能表，保持默认普通血脉，不推荐改血脉。`
    : mainBlood.equipped
      ? `${spirit.name}同时能拿到 ${bloodRanked.length} 个血脉技能，但改血脉只改一个技能位，所以只保留收益最高的${bloodDetail}，` +
        `放进第 ${mainBlood.slotIndex} 格（${slots[mainBlood.slotIndex! - 1]?.slot ?? '输出'}）。${counterPickNote}${rivalNote}`
      : `${spirit.name}能拿到的 ${bloodRanked.length} 个血脉技能里，最高收益是${bloodDetail}，` +
        `但仍赢不过本方案的四格（最弱的一格是第 ${slots.length} 格「${lastSlot?.skill.name ?? '—'}」），` +
        `所以不建议改血脉，也不携带血脉技能（保留普通血脉）。血脉技能只能选一个，不会为了凑满四个技能再塞一个进去。`;

  const bloodlineNote =
    (champion ? `血脉技能在 Lv.${mainBlood.level ?? 15} 解锁。` : '') +
    `${BLOODLINE_RULE_NOTE}` +
    (variants.length
      ? ` 同族另有 ${variants.length} 个形态分支（${variants.slice(0, 3).map((v) => v.formLabel || baseName(v.name)).join('、')}${variants.length > 3 ? '…' : ''}），种族值分布不同，方案要按具体形态重算。`
      : '');

  /* ---- 详细模式的推理段落 */
  const statText = (key: StatKey) => {
    const p = m.stats[key];
    return p ? `${p.label} ${p.value}（超过 ${Math.round(p.percentile)}%）` : '';
  };
  const summary: string[] = [
    `种族值：${(['hp', 'atk', 'def', 'spa', 'spd', 'spe'] as StatKey[]).map(statText).filter(Boolean).join('，')}；总 ${m.total.value}。`,
    `${atk === spa ? `物攻与魔攻持平（各 ${atk}），先按${mainCat}输出配` : `${mainLabel} ${spirit.stats[mainKey] ?? '—'} 高于${dumpLabel} ${spirit.stats[dumpKey] ?? '—'}，所以走${mainCat}输出`}；${
      wall ? `耐久三项均值超过 ${Math.round(bulkPct)}% 的形态，适合${preset === 'bulk' ? '拖回合的消耗流' : '站场换血的打法'}` : `速度超过 ${Math.round(spePct)}% 的形态，${spePct >= 60 ? '可以抢节奏' : '需要先手道具/队友提速'}`
    }。`,
    weakTypes.length
      ? `防御弱点（克制表原表 ≥2 倍）：${weakPoints.map((w) => `${w.type} ×${w.multiplier}`).join('、')}；全合法池（升级/技能石/任意血脉）里能反制它们的攻击属性：${poolCounterTypes.length ? poolCounterTypes.join('、') : '没有'}。`
      : '防御弱点：克制表里没有能对它打出 ≥2 倍的属性。',
    `四个技能的顺序是「${slots.slice(0, 4).map((slot) => slot.slot).join(' → ')}」，每招都出自它自己的学习面（等级/技能石/血脉），没有跨精灵预置。`,
    `性格只改两项：+10% 给${mainNature.nature.up}，-10% 给${mainNature.nature.down}。${wall ? '耐久向优先生命' : spePct >= 60 && spePct >= offPct - 5 ? '速度是这只精灵的稀缺资源' : '主输出项收益最高'}。`,
    `个体值只点三项：${ivs.map((iv) => iv.label).join('、')}，其余项让给这三项，避免摊薄。`,
    bloodlineExplanation,
    `流派切换：${PRESETS.map((p) => `${p.label}（${p.hint}）`).join(' / ')}——切流派会重算技能分、性格与个体值，但不会改变它的种族值和属性。`,
  ];

  return {
    spiritId: spirit.id,
    preset,
    presetLabel: PRESETS.find((p) => p.key === preset)?.label ?? '速攻爆发',
    roleLabel: m.roles.slice(0, 2).join(' · ') || '均衡替补',
    roleTags: m.roles,
    mainKey,
    mainLabel,
    mainCat,
    slots: slots.slice(0, 4),
    weaknesses,
    counter,
    nature: { main: mainNature, alt: altNature },
    ivs: ivs.slice(0, 3),
    bloodline: {
      main: mainBlood,
      options: options.slice(0, 4),
      note: bloodlineNote,
      explanation: bloodlineExplanation,
    },
    variants,
    summary,
    aligned: null,
  };
}

/**
 * 培养页入口。
 * 当期 48 小时轮换阵容里的精灵：四招直接取「阵容推荐」为它选的 4 招（同技能、同顺序），
 * 其余（性格 / 个体值 / 防御弱点说明）仍按本流派自己算。
 * 其余 647 只：用本流派自己的「优先反克制弱点 + 真实说明」配招。
 */
export function buildGuide(spirit: Spirit, preset: PresetKey = 'burst'): BuildGuide {
  const base = buildGuideBaseline(spirit, preset);
  const alignment = teamAlignmentOf(spirit.id);
  if (!alignment) return base;
  return alignWithTeam(base, spirit, alignment);
}
