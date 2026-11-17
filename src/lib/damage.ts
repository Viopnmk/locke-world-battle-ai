/**
 * 伤害估算（Phase 5）：只把图鉴原值代入一个公开的公式，给出「一发大概打掉对方多少生命」。
 *
 * 为什么是「估算」：BWIKI 没有公布游戏内完整的伤害公式，也没有公布对战时的等级、
 * 个体值、努力值等换算常数。所以这里不假装是官方数值，而是：
 *
 *   伤害% ≈ 100 × 校准系数 × 攻击 × 技能威力 × 本系(1.25) × 属性倍率 ÷ (防御 × 生命)
 *
 * - 攻击 = 物攻招用攻击方 atk、魔法招用攻击方 spa（图鉴原值）
 * - 防御 = 物攻招用防守方 def、魔法招用防守方 spd（图鉴原值）
 * - 生命 = 防守方 hp（图鉴原值）
 * - 威力、属性、类别全部来自该精灵自己的学习面（图鉴原值）
 * - 本系加成沿用项目一直使用的同属性 1.25 倍口径
 * - 属性倍率取 type-chart（图鉴 86 条单/双属性原表）
 *
 * 校准系数 0.5 的基准是一句人话：一只「平均精灵」（攻/防/生命都在 120 上下）用
 * 100 威力本系招去打另一只平均精灵，大约掉半血。这样 50% 就是「两下带走」的门槛，
 * 100% 是「一下带走」，正好对上实战里最常问的两个问题。
 *
 * 估算不包含：特性加成、性格/个体值、连击与多段、蓄力、护盾、回复、暴击、
 * 状态伤害。因此它只适合比较「谁打谁更疼、够不够秒」，不是逐回合模拟。
 */
import { damagingSkills } from './analysis';
import { matchup } from './typeChart';
import type { ResolvedSkill, Spirit } from './types';

/** 同属性技能加成（项目内统一口径，Wiki 未公布具体数值） */
export const STAB_MULTIPLIER = 1.25;
/**
 * 估算校准系数 0.25：在 662 只形态两两组成的全部对位里，把「最高一击」的
 * 中位数落在 60% 生命上下 —— 平均一次对位要两下才带走，秒杀与磨血各占两端，
 * 这样 1 击 / 1–2 击 / 3 击以上三档才分得开。
 */
export const DAMAGE_SCALE = 0.25;

export interface DamageHit {
  skill: ResolvedSkill;
  /** 估算伤害，占防守方最大生命的百分比（1 位小数） */
  percent: number;
  multiplier: number;
  stab: number;
  attackStat: number;
  defenceStat: number;
  hpStat: number;
  category: string;
}

const round1 = (n: number) => Math.round(n * 10) / 10;

/** 数据缺失时的兜底：不让任何一只精灵因为缺一项数值就整个算不出来 */
function safeStat(value: number | null | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
}

/**
 * 攻击方用「自己可学技能里打得最疼的一招」打防守方，返回这一发的估算伤害。
 * 没有输出技能时返回 null（界面写「无输出技能」，不编造一个数字）。
 */
export function estimateHit(attacker: Spirit, defender: Spirit): DamageHit | null {
  const skills = damagingSkills(attacker);
  if (!skills.length) return null;

  const hp = safeStat(defender.stats.hp, 100);
  let best: DamageHit | null = null;

  for (const skill of skills) {
    const magic = skill.category === '魔法';
    const attackStat = safeStat(magic ? attacker.stats.spa : attacker.stats.atk, 100);
    const defenceStat = safeStat(magic ? defender.stats.spd : defender.stats.def, 100);
    const power = typeof skill.power === 'number' && skill.power > 0 ? skill.power : 0;
    if (!power) continue;
    const stab = attacker.type.includes(skill.type) ? STAB_MULTIPLIER : 1;
    const multiplier = matchup(skill.type, defender.type).multiplier;
    const raw = (100 * DAMAGE_SCALE * attackStat * power * stab * multiplier) / (defenceStat * hp);
    const percent = round1(raw);
    if (!Number.isFinite(percent)) continue;
    const cand: DamageHit = {
      skill,
      percent,
      multiplier,
      stab,
      attackStat,
      defenceStat,
      hpStat: hp,
      category: skill.category,
    };
    if (
      !best ||
      cand.percent > best.percent ||
      (cand.percent === best.percent && (power > (best.skill.power ?? 0) ||
        (power === (best.skill.power ?? 0) && (skill.energy ?? 99) < (best.skill.energy ?? 99))))
    ) {
      best = cand;
    }
  }
  return best;
}

/** 只取百分比，给排序 / 汇总用 */
export function estimatePercent(attacker: Spirit, defender: Spirit): number {
  return estimateHit(attacker, defender)?.percent ?? 0;
}

export type KoTier = 1 | 2 | 3;

/** 100% 以上 = 1 击秒杀；50% 以上 = 1–2 击带走；其余 3 击以上 */
export function koTier(percent: number): KoTier {
  if (percent >= 100) return 1;
  if (percent >= 50) return 2;
  return 3;
}

export const KO_LABEL: Record<KoTier, string> = {
  1: '1 击秒杀',
  2: '1–2 击带走',
  3: '3 击以上',
};

export function koLabel(percent: number): string {
  return KO_LABEL[koTier(percent)];
}

/** 界面小字：口径 + 免责说明，任何展示 % 的地方都带上 */
export const DAMAGE_NOTE =
  '伤害 % 为估算：攻击 × 技能威力 ÷ 对方防御 ÷ 对方生命 × 本系 1.25 × 属性倍率 × 校准系数 0.25；系数按 662 只形态全部对位的「最高一击」中位数 ≈ 60% 生命校准，所以 50% 是两下带走、100% 是一下带走。';

export const DAMAGE_DISCLAIMER =
  '种族值、技能威力、属性倍率全部取自 BWIKI 图鉴原值；游戏内完整伤害公式与等级、个体值常数 Wiki 未公布，所以这是用于比较强弱的估算，不是逐回合实测，也不含特性、暴击、连击与状态伤害。';
