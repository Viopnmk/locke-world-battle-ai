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
 */
import bloodlinesData from '../data/bloodlines.json';
import naturesData from '../data/natures.json';
import { spiritMetrics } from './analysis';
import type { StatKey } from './analysis';
import { BLOODLINE_RULE_NOTE, BLOODLINE_SKILL_LIMIT } from './equip-rules';
import { skillById, skillsOf, spirits } from './spirits';
import { matchup, TYPE_ORDER } from './typeChart';
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

function traitSynergy(spirit: Spirit, sk: Skill): number {
  const trait = spirit.trait?.effect ?? '';
  if (!trait) return 1;
  for (const word of SYNERGY_WORDS) {
    if (trait.includes(word) && sk.effect.includes(word)) return 1.12;
  }
  return 1;
}

const UTILITY: { re: RegExp; weight: number; tag: string }[] = [
  { re: /回复[^。]{0,4}生命|回复\d+%|回复[一二三四五六七八九十]+成/, weight: 3.2, tag: '回复' },
  { re: /减伤/, weight: 2.6, tag: '减伤' },
  { re: /免疫/, weight: 2.4, tag: '免疫' },
  { re: /应对/, weight: 1.7, tag: '应对' },
  { re: /冻结|麻痹|中毒|寄生|灼烧/, weight: 2.0, tag: '状态' },
  { re: /永久\+|提升|增益|强化/, weight: 1.5, tag: '增益' },
  { re: /解除|清除|净化/, weight: 1.7, tag: '解控' },
  { re: /能量/, weight: 1.1, tag: '回能' },
];

function utilityTags(sk: Skill): string[] {
  return UTILITY.filter((k) => k.re.test(sk.effect)).map((k) => k.tag);
}

function utilityValue(sk: Skill, preset: PresetKey, spirit?: Spirit): number {
  let score = 0;
  for (const k of UTILITY) if (k.re.test(sk.effect)) score += k.weight;
  score -= Math.max(0, (sk.energy ?? 3) - 2) * 0.25;
  if (spirit && traitSynergy(spirit, sk) > 1) score += 0.9;
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
  reason: string;
}

/**
 * 这只精灵在 18 系别血脉 + 普通血脉下能拿到的全部血脉技能，逐个打分后从高到低排序。
 * 打分口径（全部由图鉴原值算出）：属性本系 ×1.25、物理/魔法定位、威力与能耗、
 * 克制面（能补几个本体打不动的属性）、特性关键词协同、变化技能的功能权重。
 */
function bloodCandidates(spirit: Spirit, mainCat: '物理' | '魔法', preset: PresetKey): BloodOption[] {
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
    let value: number;
    let kind: BloodPick['kind'];
    if (damaging) {
      /* 和普通技能用同一把尺子（本系已在 damageValue 里 ×1.25），再给补盲属性一点点加权 */
      value = damageValue(skill, spirit, mainCat, preset) * (1 + 0.06 * gain);
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
    const reason = damaging
      ? stab
        ? `改${blood}血脉拿「${skill.name}」：${detail}，本系 1.25 加成${gainNote}${chargeNote}`
        : `改${blood}血脉拿「${skill.name}」：${detail}${gainNote}${chargeNote}`
      : `改${blood}血脉拿「${skill.name}」：${detail}`;
    out.push({ blood, skill, level, kind, value, gain, reason });
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

/* ------------------------------------------------------------------ 输出结构 */

export interface BuildSlot {
  skill: ResolvedSkill;
  source: '升级' | '技能石' | '血脉';
  slot: string;
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
  nature: { main: NaturePick; alt: NaturePick };
  ivs: IvPick[];
  /** options 现在最多 1 个（与 main 同一个）：血脉技能互斥，不再给第二个备选 */
  bloodline: { main: BloodPick; options: BloodPick[]; note: string; explanation: string };
  variants: FormVariant[];
  summary: string[];
}

function toSlot(
  sk: ResolvedSkill,
  slot: string,
  reason: string,
): BuildSlot {
  return { skill: sk, source: SOURCE_LABEL[sk.learn] ?? '升级', slot, reason };
}

/* ------------------------------------------------------------------ 主函数 */

export function buildGuide(spirit: Spirit, preset: PresetKey = 'burst'): BuildGuide {
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
  const allBlood = bloodCandidates(spirit, mainCat, preset);
  const bloodRanked = allBlood.filter((o) => !regularNames.has(o.skill.name));
  const champion = bloodRanked[0] ?? null;
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

  const powerText = (sk: Skill) => {
    const bits = [`威力 ${sk.power ?? '—'}`, `能耗 ${sk.energy ?? '—'}`];
    return bits.join(' / ');
  };

  /* 1) 主攻：本系里最高效的一招（评分里已含本系 1.25、类别与消耗） */
  const primaryEntry = damageRanked.find((e) => canAdd(e.sk) && spirit.type.includes(e.sk.type))
    ?? damageRanked.find((e) => canAdd(e.sk));
  if (primaryEntry) {
    const sk = primaryEntry.sk;
    const prof = offenceProfile(sk.type);
    taken.add(sk.id);
    typeUsed.add(sk.type);
    slots.push(
      toSlot(
        sk,
        '主攻',
        `本系${sk.category}最高效：${powerText(sk)}，克制 ${prof.superCount} 个属性`,
      ),
    );
  }

  /* 2) 副攻：换一个属性，避开被抵抗的同属性堆叠 */
  const secondaryEntry = damageRanked.find((e) => canAdd(e.sk) && !typeUsed.has(e.sk.type))
    ?? damageRanked.find((e) => canAdd(e.sk));
  if (secondaryEntry) {
    const sk = secondaryEntry.sk;
    taken.add(sk.id);
    typeUsed.add(sk.type);
    slots.push(
      toSlot(
        sk,
        '副攻',
        `${sk.type}系第二打击面：${powerText(sk)}，和主攻属性互补，不容易被一项抵抗挡住`,
      ),
    );
  }

  /* 3) 补盲：先算清楚现有属性打不动的系，再挑能补上的技能（换属性优先） */
  const gaps = TYPE_ORDER.filter((def) => {
    const best = [...typeUsed].reduce((acc, atkType) => Math.max(acc, matchup(atkType, [def]).multiplier), 0);
    return best < 1;
  });
  const coverPool = damageRanked
    .filter((e) => canAdd(e.sk))
    .map((e) => ({
      ...e,
      gain: gaps.filter((def) => matchup(e.sk.type, [def]).multiplier >= 2).length,
      fresh: typeUsed.has(e.sk.type) ? 0 : 1,
    }))
    .sort((a, b) => b.fresh - a.fresh || b.gain - a.gain || b.v - a.v);
  const coverEntry = coverPool[0];
  const coverSlot: BuildSlot | null = coverEntry
    ? toSlot(
        coverEntry.sk,
        coverEntry.fresh ? '补盲' : '副攻',
        coverEntry.fresh
          ? coverEntry.gain > 0
            ? `补上 ${gaps.slice(0, 4).join('、')} 这些主攻被抵抗的目标：${powerText(coverEntry.sk)}`
            : `${coverEntry.sk.type}系第三属性，${powerText(coverEntry.sk)}，再多一条打击面`
          : `同属性里威力更高的另一招：${powerText(coverEntry.sk)}`,
      )
    : null;

  /* 4) 变化：带一个最划算的状态/防御技能（特性关键词命中时更优先） */
  const supportGate = preset === 'bulk' ? 1.4 : 1.6;
  const supportEntry = supportRanked.find((e) => e.v >= supportGate && canAdd(e.sk));
  const supportSlot: BuildSlot | null = supportEntry
    ? toSlot(
        supportEntry.sk,
        '变化',
        `${supportEntry.tags.length ? `${supportEntry.tags.join('·')}：` : ''}${supportEntry.sk.effect || '变化技能'}`,
      )
    : null;

  /* 流派决定第 3、4 个位置放谁：速攻先补打击面，耐久先带续航 */
  const queue = preset === 'bulk' ? [supportSlot, coverSlot] : [coverSlot, supportSlot];
  for (const slot of queue) {
    if (!slot || slots.length >= 4) continue;
    if (!canAdd(slot.skill)) continue;
    taken.add(slot.skill.id);
    slots.push(slot);
  }
  for (const entry of damageRanked) {
    if (slots.length >= 4) break;
    if (!canAdd(entry.sk)) continue;
    taken.add(entry.sk.id);
    slots.push(toSlot(entry.sk, '输出', `${entry.sk.type}系输出，${powerText(entry.sk)}`));
  }
  /* 万一攻击技能不足 4 个（理论上不会），用剩下的变化技能补位 */
  for (const entry of supportRanked) {
    if (slots.length >= 4) break;
    if (!canAdd(entry.sk)) continue;
    taken.add(entry.sk.id);
    slots.push(toSlot(entry.sk, '变化', entry.sk.effect || '变化技能'));
  }

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
    const second = bloodRanked[1];
    if (!second) return '';
    return `得分第二的${second.blood}血脉「${second.skill.name}」（${Math.round(second.value)} 分 vs ${Math.round(mainBlood.value)} 分）与它互斥，已剔除。`;
  })();
  const lastSlot = slots[slots.length - 1];
  const bloodlineExplanation = !champion
    ? `${spirit.name} 的 Wiki 学习面里没有可用的血脉技能表，保持默认普通血脉，不推荐改血脉。`
    : mainBlood.equipped
      ? `${spirit.name}同时能拿到 ${bloodRanked.length} 个血脉技能，但改血脉只改一个技能位，所以只保留收益最高的${bloodDetail}，` +
        `放进第 ${mainBlood.slotIndex} 格（${slots[mainBlood.slotIndex! - 1]?.slot ?? '输出'}）。${rivalNote}`
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
  };
}
