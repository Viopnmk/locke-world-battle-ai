/**
 * 装备规则（全局硬约束）
 *
 * 用户硬性规则：所有精灵最多只能装备一个血脉技能，不同血脉技能互相排斥。
 * 依据：Wiki 物品页「万能血脉秘药」——修改血脉的秘药，使精灵获得任意一种「系别血脉」；
 * 一只精灵只有一个血脉，所以 18 系别血脉 + 普通血脉给的 19 个血脉技能同一时间只能带 1 个。
 *
 * 这是数据层与两个推荐引擎（培养方案 build-guide / 阵容 rotate-teams）共用的唯一口径：
 * 谁要往配招里放血脉技能，都先经过这里收敛成「最多 1 个」，避免各写一套判断。
 *
 * 尚未确认的部分：Wiki 没有写明血脉技能是否一定占用四个携带位之一。
 * 这里按「占一格」保守处理——无论实际是 4 格内还是额外一格，本站给出的配招都不超过
 * 1 个血脉技能，两种机制下都成立（待实测）。
 */
import type { ResolvedSkill, Spirit } from './types';

export const BLOODLINE_SKILL_LIMIT = 1;

export const BLOODLINE_RULE_NOTE =
  '血脉互斥：一只精灵只有一个血脉，18 系别血脉 + 普通血脉的 19 个血脉技能只能选 1 个。' +
  '血脉技能是否占用四个携带位之一，Wiki 未写明，本站按「占一格」保守处理（待实测）。';

/** 学习面里带血脉来源（code 2）的技能，按「本系优先 → 输出技优先 → 威力高 → 能耗低」排序 */
export function rankBloodlineSkills(spirit: Spirit, list: ResolvedSkill[]): ResolvedSkill[] {
  const stab = (sk: ResolvedSkill) => (spirit.type.includes(sk.type) ? 0 : 1);
  const damaging = (sk: ResolvedSkill) => (typeof sk.power === 'number' && sk.power > 0 && sk.type ? 0 : 1);
  return [...list].sort(
    (a, b) =>
      stab(a) - stab(b) ||
      damaging(a) - damaging(b) ||
      (b.power ?? 0) - (a.power ?? 0) ||
      (a.energy ?? 99) - (b.energy ?? 99),
  );
}

/**
 * 一只精灵实际可装进配招的技能池：普通学习面（升级/技能石）全保留，
 * 血脉技能只保留最值得带的 1 个（默认 limit = 1）。
 */
export function equippableSkills(spirit: Spirit, learnset: ResolvedSkill[], limit = BLOODLINE_SKILL_LIMIT): ResolvedSkill[] {
  const normal = learnset.filter((sk) => sk.learn !== 2);
  const blood = rankBloodlineSkills(spirit, learnset.filter((sk) => sk.learn === 2)).slice(0, Math.max(0, limit));
  return [...normal, ...blood];
}
