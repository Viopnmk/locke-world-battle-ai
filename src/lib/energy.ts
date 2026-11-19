/**
 * 能量模型（全站唯一口径）
 *
 * 三个维度必须分开算，不能混：
 *   1) 上场能量（入场时这只精灵手里有多少点）——由特性决定，默认 10 点；
 *   2) 技能能耗（释放这一招要付多少点）——来自 skills.json 的 energy 字段；
 *   3) 能量恢复（聚能 5 点 / 特性回能 / 技能回能 / 击倒回能）——没有默认每回合收入。
 *
 * 已核实的规则（见 downloads/locke-energy-teams/report.md 的出处清单）：
 *   · 每只精灵能量上限 10 点（硬约束）。BWIKI 特性原文出现「突破能量上限」「自己的能量可以超过能量上限」，
 *     说明默认上限就是 10；公开攻略与官方手册也写「每只精灵 10 点能量」。
 *   · 普通精灵登场自带 10 点能量；「初始能量为0」的特性让入场能量变成 0（地脉 / 结晶水 / 散热 / 慢热型 / 盗魂铃）。
 *   · 聚能：消耗一回合，回复 5 点能量（官方手册原文「战斗中可以通过消耗一回合进行聚能来恢复能量」）。
 *   · 默认没有每回合自动回能；战斗结束后能量不自动回复。
 *
 * 标注「待验证」的部分：
 *   · 换人本身是否额外扣能量：官方手册只写「更换精灵会结束本回合」，没有写扣能量；这里按「不扣能量、只花一回合」处理。
 *   · 恢复瓶的具体回复量：官方只写「恢复能量」，有攻略称回满 10 点，未在游戏内文案确认。
 *   · 「己方精灵每使用1次X系技能」是否包含自己：影响入场加成次数，按「不含自己」保守估算。
 */
import type { ResolvedSkill, Spirit } from './types';

export const ENERGY_CAP = 10;
/** 聚能：消耗一回合，回复 5 点（官方手册 + 攻略一致） */
export const GATHER_GAIN = 5;

export type Confidence = 'verified' | 'inferred' | 'unverified';

export interface EnergyRule {
  id: string;
  label: string;
  text: string;
  confidence: Confidence;
  source: string;
}

/** 规则清单：报告、页面脚注与校验脚本共用同一份 */
export const ENERGY_RULES: EnergyRule[] = [
  {
    id: 'cap',
    label: '能量上限 10',
    text: '每只精灵的能量上限是 10 点，技能能耗不能超过它。',
    confidence: 'verified',
    source:
      'BWIKI 特性原文（「地脉馈赠：突破能量上限…」「多人宿舍：自己的能量可以超过能量上限」「盗魂铃：…（可突破上限）」）+ 官方手册与公开攻略「每只精灵 10 点能量」',
  },
  {
    id: 'entry',
    label: '上场能量',
    text: '普通精灵登场自带 10 点能量（等于上限）；带「初始能量为0」特性的精灵入场时是 0 点，靠特性条件补回来。',
    confidence: 'verified',
    source:
      'BWIKI 特性原文（地脉 / 结晶水 / 散热 / 慢热型 / 盗魂铃 五条都写「初始能量为0」）+ 公开资料「精灵登场时自带 10 点能量」',
  },
  {
    id: 'switch',
    label: '换人成本',
    text: '换人只消耗本回合行动，不额外扣能量（唯一例外是「降灵印记」等效果会让换入的精灵失去能量）。',
    confidence: 'unverified',
    source:
      '官方手册只写「更换精灵会结束本回合」；BWIKI 印记「降灵印记：场上的精灵离场后，更换入场的精灵失去1能量」。换人本身扣不扣能量待实测。',
  },
  {
    id: 'gather',
    label: '聚能',
    text: '聚能：消耗一回合，回复 5 点能量。这是没有回能特性/技能时的唯一常规回能手段。',
    confidence: 'verified',
    source: '官方手册原文「战斗中可以通过消耗一回合进行聚能来恢复能量」+ 攻略「聚能可获得 5 点能量」',
  },
  {
    id: 'income',
    label: '每回合收入',
    text: '默认没有每回合自动回能（只有特性、印记、技能能回）；战斗结束后能量也不自动回复。',
    confidence: 'verified',
    source: '官方手册原文「能量在战斗之后不会自动回复」+ 特性原文（奇丽草「回合结束时，回复3能量」这类才是回能来源）',
  },
  {
    id: 'bottle',
    label: '恢复瓶',
    text: '战斗中可用恢复瓶回复能量，初始 1 次；具体回复量官方文案未写。',
    confidence: 'unverified',
    source: '官方手册「在战斗中使用能够恢复精灵的能量…使用次数有限」；有攻略称「回满 10 点」，未确认。',
  },
  {
    id: 'overcap',
    label: '突破上限',
    text: '只有明写「突破上限 / 可超过上限」的特性（地脉馈赠、多人宿舍、盗魂铃）能让能量超过 10 点。',
    confidence: 'verified',
    source: 'BWIKI 特性原文三条',
  },
  {
    id: 'switchin-skill',
    label: '迅捷换入',
    text: '带「迅捷」的技能在主动换人入场时立刻释放（用第一个能量够用的迅捷技）。这是本作里最接近「换人不花能量还能出手」的机制。',
    confidence: 'verified',
    source: 'BWIKI 游戏描述「迅捷：通过主动更换精灵的方式入场时，使用第一个能量满足要求，并带有迅捷的技能」',
  },
];

/* ------------------------------------------------------------ 特性 → 能量 */

export type EnergyEvent =
  | 'teammate-type-skill'
  | 'teammate-respond'
  | 'enemy-gather'
  | 'enemy-switch'
  | 'self-type-skill';

export interface TraitEnergyRule {
  id: string;
  /** 特性原文匹配（数字用捕获组，由 traitEnergyFacts 读出，不写死） */
  test: RegExp;
  /** 入场基础能量（不写 = 默认 10） */
  entryBase?: number;
  /** 入场前按事件累计的回能（每次多少点） */
  bonusPerEvent?: number;
  bonusEvent?: EnergyEvent;
  /** 事件里的属性限定，例如「每放1次地系技能」 */
  bonusType?: string;
  /** 入场时偷取敌方场上精灵能量（每只多少点） */
  stealOnEntry?: number;
  /** 回合结束固定回能 */
  perTurn?: number;
  /** 离场时回能（换下再上场等于回满） */
  onLeave?: number;
  /** 入场后首次行动的那一回合，每次行动后回能 */
  perActionFirstTurn?: number;
  /** 可突破 10 点上限 */
  overCap?: boolean;
  /** 给自己的能量上限加值（例如「突破能量上限并立即回复10能量」） */
  capBonus?: number;
  /** 每回合偷取敌方场上精灵能量 */
  drainPerTurn?: number;
  /** 自己使用某系技能后，敌方失去能量 */
  enemyLoseOnUse?: { type?: string; amount: number };
  /** 说明（照抄原文要点，不加工） */
  note: string;
  confidence: Confidence;
}

/**
 * 全库 662 条特性里与能量直接相关的规则。每条都对应 BWIKI 原文的一个子串，
 * 由 scripts/verify-teams.ts 反向断言「特性原文必须能匹配」，避免表里塞假规则。
 */
export const TRAIT_ENERGY_RULES: TraitEnergyRule[] = [
  {
    id: 'zero-type-skill',
    test: /初始能量为0，入场前己方精灵每(?:放|使用)1次(.)系技能，回复(\d+)能量/,
    entryBase: 0,
    bonusEvent: 'teammate-type-skill',
    note: '入场时 0 能量；入场前队友每用 1 次同系技能回 3 点',
    confidence: 'verified',
  },
  {
    id: 'zero-respond',
    test: /初始能量为0，入场前己方精灵每成功应对(\d+)次，回复(\d+)能量/,
    entryBase: 0,
    bonusEvent: 'teammate-respond',
    note: '入场时 0 能量；入场前队友每成功应对 1 次回 5 点',
    confidence: 'verified',
  },
  {
    id: 'zero-enemy-gather',
    test: /初始能量为0，首次入场前敌方每聚能(\d+)次，回复(\d+)能量（可突破上限）/,
    entryBase: 0,
    bonusEvent: 'enemy-gather',
    overCap: true,
    note: '入场时 0 能量；敌方每聚能 1 次回 5 点，可突破上限',
    confidence: 'verified',
  },
  {
    id: 'overcap-gift',
    test: /突破能量上限并立即回复(\d+)能量/,
    overCap: true,
    note: '入场即突破上限并额外回复 10 点',
    confidence: 'verified',
  },
  {
    id: 'cap-exempt',
    test: /自己的能量可以超过能量上限/,
    overCap: true,
    note: '能量可以超过 10 点上限',
    confidence: 'verified',
  },
  {
    id: 'turn-end-recover',
    test: /回合结束时，回复(\d+)能量/,
    note: '回合结束固定回能',
    confidence: 'verified',
  },
  {
    id: 'leave-refill',
    test: /离场时回复(\d+)能量/,
    note: '离场时回满：换下再上是零成本复位',
    confidence: 'verified',
  },
  {
    id: 'first-action-recover',
    test: /入场后首次行动，所选技能使用次数\+1，且该回合每次行动后回复(\d+)能量/,
    note: '入场后首次行动那一回合，每次行动后回能',
    confidence: 'verified',
  },
  {
    id: 'steal-on-entry',
    test: /入场时偷取敌方场上所有精灵(\d+)能量/,
    note: '入场时从敌方场上精灵偷能量',
    confidence: 'verified',
  },
  {
    id: 'drain-turn-end',
    test: /回合结束时，偷取敌方场上所有精灵(\d+)能量/,
    note: '每回合结束偷敌方能量',
    confidence: 'verified',
  },
  {
    id: 'enemy-lose-dark',
    test: /自己使用恶系技能后，敌方失去(\d+)能量/,
    note: '自己打恶系技能后，敌方失去能量',
    confidence: 'verified',
  },
  {
    id: 'self-pay-hp',
    test: /能量不足时，消耗5%生命，代替1能量/,
    note: '能量不足时可用 5% 生命顶 1 点能量（不是回能，是支付方式）',
    confidence: 'verified',
  },
];

export interface TraitEnergyFacts {
  rule: TraitEnergyRule;
  /** 事件里的点数（每次回能 / 偷取 / 每回合 / 离场…） */
  amount: number;
  /** 事件里的属性限定（地脉=地、结晶水=冰、散热=火） */
  type: string | null;
}

/** 命中特性能量规则，并把原文里的数字读出来（不写死） */
export function traitEnergyFacts(effect: string | null | undefined): TraitEnergyFacts | null {
  if (!effect) return null;
  for (const rule of TRAIT_ENERGY_RULES) {
    const m = rule.test.exec(effect);
    if (!m) continue;
    if (rule.id === 'zero-type-skill') {
      return { rule, amount: Number(m[2]), type: m[1] };
    }
    if (rule.id === 'zero-respond' || rule.id === 'zero-enemy-gather' || rule.id === 'overcap-gift') {
      return { rule, amount: Number(m[2] ?? m[1]), type: null };
    }
    return { rule, amount: Number(m[1]), type: null };
  }
  return null;
}

export function traitEnergyRule(effect: string | null | undefined): TraitEnergyRule | null {
  return traitEnergyFacts(effect)?.rule ?? null;
}

/* ------------------------------------------------------------ 技能回能 */

export interface SkillEnergyEffect {
  /** 自己回复的固定点数（0 表示不是固定值） */
  selfFixed: number;
  /** 条件触发（应对成功 / 击败 / 回合条件） */
  conditional: boolean;
  /** 敌方失去/被偷的点数 */
  enemyLose: number;
  /** 原文 */
  text: string;
  confidence: Confidence;
}

export function skillEnergyEffect(sk: ResolvedSkill): SkillEnergyEffect {
  const text = sk.effect ?? '';
  const self = /自己回复(\d+)(?:点)?能量/.exec(text);
  const conditionalSelf = /(?:应对状态|应对防御|应对攻击|若使用本技能击败敌方|累计回复至少|每有1层|若敌方本回合更换精灵|若上回合|胜利后)[^。；]{0,40}?(?:自己回复|回复)(\d+)(?:点)?能量/.exec(text);
  const enemyLose = /(?:敌方失去|偷取敌方)(\d+)(?:点)?能量/.exec(text);
  const nonFixed = /回复能量，回复值等于/.test(text);
  const selfFixed = self ? Number(self[1]) : 0;
  return {
    selfFixed,
    conditional: !selfFixed && (Boolean(conditionalSelf) || nonFixed),
    enemyLose: enemyLose ? Number(enemyLose[1]) : 0,
    text,
    confidence: selfFixed || conditionalSelf || nonFixed ? 'verified' : 'inferred',
  };
}

/* ------------------------------------------------------------ 上场能量 */

export interface EntryEnergy {
  /** 入场时手里的能量（默认 10） */
  base: number;
  /** 上限（默认 10；突破上限的特性会更高） */
  cap: number;
  /** 入场后能靠条件补回的能量（每次多少点） */
  bonusPerEvent: number;
  bonusEvent: EnergyEvent | null;
  bonusType: string | null;
  /** 入场偷取的能量（每只敌方） */
  stealOnEntry: number;
  /** 可突破上限 */
  overCap: boolean;
  label: string;
  detail: string;
  ruleId: string | null;
  confidence: Confidence;
}

const DEFAULT_ENTRY: EntryEnergy = {
  base: ENERGY_CAP,
  cap: ENERGY_CAP,
  bonusPerEvent: 0,
  bonusEvent: null,
  bonusType: null,
  stealOnEntry: 0,
  overCap: false,
  label: '普通上场（满 10 点）',
  detail: '图鉴没有「初始能量为0」类特性，按普通精灵登场自带 10 点能量处理（官方手册 + 攻略口径）。',
  ruleId: null,
  confidence: 'verified',
};

export function entryEnergy(spirit: Spirit): EntryEnergy {
  const effect = spirit.trait?.effect ?? '';
  const facts = traitEnergyFacts(effect);
  if (!facts) return { ...DEFAULT_ENTRY };
  const { rule, amount, type } = facts;

  const bonusPerEvent = rule.bonusEvent ? amount : 0;
  const stealOnEntry = rule.id === 'steal-on-entry' ? amount : 0;
  const perTurn = rule.id === 'turn-end-recover' ? amount : 0;
  const onLeave = rule.id === 'leave-refill' ? amount : 0;

  // 「突破能量上限并立即回复10能量」= 上限抬到 20、入场就是 20 点
  const capBonus = rule.id === 'overcap-gift' ? amount : 0;
  const base = typeof rule.entryBase === 'number' ? rule.entryBase + capBonus : ENERGY_CAP;
  return {
    base,
    cap: ENERGY_CAP + capBonus,
    bonusPerEvent,
    bonusEvent: rule.bonusEvent ?? null,
    bonusType: type,
    stealOnEntry,
    overCap: Boolean(rule.overCap),
    label:
      base === 0
        ? '初始能量为 0'
        : rule.id === 'overcap-gift'
          ? `突破上限（${base} 点）`
          : onLeave
            ? `普通上场（满 10 点，离场回 ${onLeave}）`
            : perTurn
              ? `普通上场（满 10 点，每回合 +${perTurn}）`
              : '普通上场（满 10 点）',
    detail: `${spirit.trait?.name ?? '特性'}：${rule.note}`,
    ruleId: rule.id,
    confidence: rule.confidence,
  };
}

/** 入场后实际能用多少点：普通 10；「初始能量为0」为 0（条件补能不写死，单独列） */
export function usableEntryEnergy(spirit: Spirit): number {
  const e = entryEnergy(spirit);
  return e.base + e.stealOnEntry;
}

/* ------------------------------------------------------------ 单只能量画像 */

export interface SkillCostLine {
  name: string;
  type: string;
  category: string;
  power: number | null;
  energy: number;
  /** 相对「上场能量」是否付得起 */
  affordableOnEntry: boolean;
  /** 付完还剩多少（付不起为 null） */
  leftover: number | null;
  /** 纯靠聚能要几回合才能付得起（付得起为 0） */
  gatherTurns: number;
}

export interface MemberEnergy {
  spiritId: string;
  name: string;
  entry: EntryEnergy;
  /** 上场能量（含入场偷取，条件补能不算） */
  usable: number;
  costs: SkillCostLine[];
  minCost: number;
  maxCost: number;
  avgCost: number;
  zeroCostSkills: number;
  /** 首回合能打出的最强招 */
  firstTurn: { name: string; cost: number; power: number | null; leftover: number } | null;
  /** 最贵那一招要聚能几回合（0 = 入场就能打） */
  gatherTurnsForMax: number;
  /** 回能手段（特性 / 技能） */
  recoveries: string[];
  /** 是否需要额外聚能才能把 4 招都打过一遍 */
  needsGather: boolean;
  /** 是否有超过 10 点的需求（无突破上限特性时为核心风险） */
  overCap: boolean;
  /** 状态：入场即可用 / 需要聚能 / 几乎打不出 */
  status: 'ready' | 'gather' | 'starved';
  caution: string;
}

const round1 = (n: number) => Math.round(n * 10) / 10;

export function memberEnergy(spirit: Spirit, chosen: ResolvedSkill[]): MemberEnergy {
  const entry = entryEnergy(spirit);
  const usable = entry.base + entry.stealOnEntry;
  const costs: SkillCostLine[] = chosen.map((sk) => {
    const cost = typeof sk.energy === 'number' ? sk.energy : 0;
    const affordable = cost <= usable;
    const leftover = affordable ? usable - cost : null;
    const gap = Math.max(0, cost - usable);
    const gatherTurns = gap === 0 ? 0 : Math.ceil(gap / GATHER_GAIN);
    return {
      name: sk.name,
      type: sk.type,
      category: sk.category,
      power: sk.power ?? null,
      energy: cost,
      affordableOnEntry: affordable,
      leftover,
      gatherTurns,
    };
  });

  const usableTh = costs.filter((c) => c.power && c.power > 0);
  const affordableDmg = usableTh.filter((c) => c.affordableOnEntry).sort((a, b) => (b.power ?? 0) - (a.power ?? 0));
  const firstTurn = affordableDmg[0]
    ? { name: affordableDmg[0].name, cost: affordableDmg[0].energy, power: affordableDmg[0].power, leftover: (affordableDmg[0].leftover ?? 0) }
    : null;

  const maxCost = costs.length ? Math.max(...costs.map((c) => c.energy)) : 0;
  const minCost = costs.length ? Math.min(...costs.map((c) => c.energy)) : 0;
  const avgCost = costs.length ? round1(costs.reduce((a, b) => a + b.energy, 0) / costs.length) : 0;
  const gatherTurnsForMax = Math.max(0, Math.ceil(Math.max(0, maxCost - usable) / GATHER_GAIN));

  const recoveries: string[] = [];
  if (entry.bonusPerEvent > 0) {
    const ev =
      entry.bonusEvent === 'teammate-type-skill'
        ? `队友每用 1 次${entry.bonusType ?? ''}系技能 +${entry.bonusPerEvent}`
        : entry.bonusEvent === 'teammate-respond'
          ? `队友每成功应对 1 次 +${entry.bonusPerEvent}`
          : entry.bonusEvent === 'enemy-gather'
            ? `敌方每聚能 1 次 +${entry.bonusPerEvent}`
            : `按条件 +${entry.bonusPerEvent}`;
    recoveries.push(`特性（${ev}）`);
  }
  const facts = traitEnergyFacts(spirit.trait?.effect);
  if (facts && facts.rule.id === 'enemy-lose-dark') recoveries.push(`对敌方抽能：恶系技能后 -${facts.amount}`);
  if (entry.stealOnEntry > 0) recoveries.push(`入场偷取 ${entry.stealOnEntry} 点/只`);
  if (entry.base === 0 && entry.bonusPerEvent === 0) recoveries.push('无（靠聚能 +5/回合）');
  if (entry.base > 0 && entry.bonusPerEvent === 0 && entry.stealOnEntry === 0) recoveries.push('无（默认无每回合回能，靠聚能 +5/回合）');

  const skillFix = chosen
    .map((sk) => ({ sk, eff: skillEnergyEffect(sk) }))
    .filter(({ eff }) => eff.selfFixed > 0);
  for (const { sk, eff } of skillFix) {
    recoveries.push(`技能「${sk.name}」+${eff.selfFixed} 点（${sk.energy} 费）`);
  }

  if (facts?.rule.id === 'turn-end-recover') recoveries.push(`特性每回合 +${facts.amount}`);
  if (facts?.rule.id === 'leave-refill') recoveries.push(`离场 +${facts.amount}（换下再上回满）`);
  if (facts?.rule.id === 'first-action-recover') recoveries.push(`入场首回合每次行动 +${facts.amount}`);
  if (facts?.rule.id === 'drain-turn-end') recoveries.push(`每回合偷取敌方 ${facts.amount} 点`);

  const status: MemberEnergy['status'] = firstTurn ? (gatherTurnsForMax > 0 ? 'gather' : 'ready') : 'starved';

  let caution = '';
  if (usable === 0) caution = `入场 0 能量，必须先靠队友垫${entry.bonusEvent === 'teammate-respond' ? '「应对成功」' : '同系技能'}，否则第一回合只能聚能。`;
  else if (!firstTurn) caution = `4 招最低 ${minCost} 费，入场 ${usable} 点打不出任何一招，只能先聚能。`;
  else if (gatherTurnsForMax > 0) caution = `最贵的「${costs.find((c) => c.energy === maxCost)?.name ?? ''}」${maxCost} 费，入场 ${usable} 点，需先聚能 ${gatherTurnsForMax} 回合。`;
  else caution = `4 招都在 ${usable} 点以内，入场即可出招，最贵 ${maxCost} 费后还剩 ${usable - maxCost} 点。`;

  return {
    spiritId: spirit.id,
    name: spirit.name,
    entry,
    usable,
    costs,
    minCost,
    maxCost,
    avgCost,
    zeroCostSkills: costs.filter((c) => c.energy === 0).length,
    firstTurn,
    gatherTurnsForMax,
    recoveries,
    needsGather: gatherTurnsForMax > 0 || status === 'starved',
    overCap: entry.overCap || maxCost > ENERGY_CAP,
    status,
    caution,
  };
}

/* ------------------------------------------------------------ 队伍能量 */

export interface TeamEnergy {
  members: MemberEnergy[];
  /** 6 只入场能量合计（默认 60） */
  entryTotal: number;
  /** 4 招平均能耗 */
  avgCost: number;
  /** 最高单招能耗 */
  maxCost: number;
  /** 入场即可出招的只数 */
  readyCount: number;
  /** 需要聚能的只数 */
  gatherCount: number;
  /** 入场即 0 能量的只数 */
  starvedCount: number;
  /** 有 0 费技能的只数 */
  zeroCostOwners: number;
  /** 是否存在需要超过 10 点的招 */
  overCapRisk: string[];
  lines: string[];
}

export function teamEnergy(members: { spirit: Spirit; chosen: ResolvedSkill[] }[]): TeamEnergy {
  const list = members.map((m) => memberEnergy(m.spirit, m.chosen));
  const entryTotal = list.reduce((a, b) => a + b.usable, 0);
  const allCosts = list.flatMap((m) => m.costs.map((c) => c.energy));
  const avgCost = allCosts.length ? round1(allCosts.reduce((a, b) => a + b, 0) / allCosts.length) : 0;
  const maxCost = allCosts.length ? Math.max(...allCosts) : 0;
  return {
    members: list,
    entryTotal,
    avgCost,
    maxCost,
    readyCount: list.filter((m) => m.firstTurn).length,
    gatherCount: list.filter((m) => m.needsGather).length,
    starvedCount: list.filter((m) => m.usable === 0).length,
    zeroCostOwners: list.filter((m) => m.zeroCostSkills > 0).length,
    overCapRisk: list.filter((m) => m.maxCost > ENERGY_CAP && !m.entry.overCap).map((m) => `${m.name} ${m.maxCost} 费`),
    lines: list.map(
      (m) =>
        `${m.name}：上场 ${m.usable} 点｜技能 ${m.costs.map((c) => c.energy).join('/')} 费｜回能 ${
          m.recoveries.length ? m.recoveries.join('、') : '无'
        }｜首回合可打 ${m.firstTurn ? `「${m.firstTurn.name}」剩 ${m.firstTurn.leftover} 点` : '无'}`,
    ),
  };
}

/** 一句总分：6 只入场能量合计 / 平均技能能耗 / 需要聚能的只数 */
export function teamEnergyLine(e: TeamEnergy): string {
  return `6 只入场能量合计 ${e.entryTotal} 点（默认每只 10 点），4 招平均能耗 ${e.avgCost}，最高单招 ${e.maxCost} 费；入场即可出招 ${e.readyCount}/6，需要先聚能 ${e.gatherCount} 只。`;
}

/** 校验用：4 招里若出现超过 10 费且没有突破上限特性，直接判不合法 */
export function energyViolations(spirit: Spirit, chosen: ResolvedSkill[]): string[] {
  const out: string[] = [];
  const e = entryEnergy(spirit);
  for (const sk of chosen) {
    const cost = sk.energy ?? 0;
    if (cost > ENERGY_CAP && !e.overCap) out.push(`「${sk.name}」${cost} 费超过 10 点上限（${spirit.name} 没有突破上限特性）`);
  }
  const usable = e.base + e.stealOnEntry;
  if (usable === 0) {
    const minDmg = chosen.filter((s) => (s.power ?? 0) > 0).sort((a, b) => (a.energy ?? 0) - (b.energy ?? 0))[0];
    if (minDmg && (minDmg.energy ?? 0) > 0) {
      out.push(`${spirit.name} 入场 0 能量，输出招最低 ${minDmg.energy} 费，首回合没有任何可用输出（需要 0 费招或队友垫能）`);
    }
  }
  return out;
}
