/**
 * 伤害估算（Worker 端，与前端 src/lib/damage.ts 同一套规则）。
 *
 * 伤害% ≈ 100 × 0.25 × 攻击 × 技能威力 × 本系1.25 × 属性倍率 ÷ (防御 × 生命)
 * 系数 0.25 按 662 只形态全部对位的「最高一击」中位数 ≈ 60% 生命校准。
 * BWIKI 未公布完整伤害公式与等级/个体值常数，所以这是估算，用于比较强弱与击杀数。
 */
import { matchup, skillsOf } from './data.mjs';

export const STAB_MULTIPLIER = 1.25;
export const DAMAGE_SCALE = 0.25;

const round1 = (n) => Math.round(n * 10) / 10;

function safeStat(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
}

export function estimateHit(attacker, defender) {
  const skills = skillsOf(attacker).filter((s) => typeof s.power === 'number' && s.power > 0 && s.type);
  if (!skills.length) return null;

  const hp = safeStat(defender.stats.hp, 100);
  let best = null;
  for (const skill of skills) {
    const magic = skill.category === '魔法';
    const attackStat = safeStat(magic ? attacker.stats.spa : attacker.stats.atk, 100);
    const defenceStat = safeStat(magic ? defender.stats.spd : defender.stats.def, 100);
    const power = skill.power;
    if (!power) continue;
    const stab = attacker.type.includes(skill.type) ? STAB_MULTIPLIER : 1;
    const multiplier = matchup(skill.type, defender.type);
    const percent = round1((100 * DAMAGE_SCALE * attackStat * power * stab * multiplier) / (defenceStat * hp));
    if (!Number.isFinite(percent)) continue;
    if (
      !best ||
      percent > best.percent ||
      (percent === best.percent &&
        (power > (best.skill.power ?? 0) ||
          (power === (best.skill.power ?? 0) && (skill.energy ?? 99) < (best.skill.energy ?? 99))))
    ) {
      best = {
        skill: {
          id: skill.id,
          name: skill.name,
          type: skill.type,
          category: skill.category,
          power: skill.power,
          energy: skill.energy,
        },
        percent,
        multiplier,
        stab,
        attackStat,
        defenceStat,
        hpStat: hp,
      };
    }
  }
  return best;
}

export function koLabel(percent) {
  if (percent >= 100) return '1 击秒杀';
  if (percent >= 50) return '1–2 击带走';
  return '3 击以上';
}

const pctText = (n) => `${Math.round(n)}%`;

/** 敌我威胁与击杀摘要：给模型当事实用，界面也用同一套口径 */
export function teamThreats(mine, theirs) {
  const threats = theirs.map((en) => {
    const rows = mine.map((m) => ({ spirit: m, hit: estimateHit(en, m) }));
    const sorted = [...rows].sort((a, b) => (b.hit?.percent ?? 0) - (a.hit?.percent ?? 0));
    const top = sorted[0];
    const kos = sorted.filter((r) => (r.hit?.percent ?? 0) >= 50);
    const oneShots = kos.filter((r) => (r.hit?.percent ?? 0) >= 100).length;
    return {
      name: en.name,
      types: en.type,
      top: top?.hit
        ? { ally: top.spirit.name, percent: top.hit.percent, skill: top.hit.skill.name }
        : null,
      kos: kos.map((r) => ({ ally: r.spirit.name, percent: r.hit.percent, skill: r.hit.skill.name })),
      oneShots,
      line: top?.hit
        ? `${en.name}：最高一击打我方 ${top.spirit.name} ${pctText(top.hit.percent)}（代表招「${top.hit.skill.name}」）；能1–2击带走我方 ${kos.length} 只${
            kos.length ? `（其中1击秒杀 ${oneShots} 只）` : ''
          }`
        : `${en.name}：学习面里没有伤害技能，伤害按 0 计`,
    };
  });
  threats.sort(
    (a, b) => b.kos.length - a.kos.length || b.oneShots - a.oneShots || (b.top?.percent ?? 0) - (a.top?.percent ?? 0),
  );

  const allies = mine.map((m) => {
    const outs = theirs.map((en) => ({ enemy: en, hit: estimateHit(m, en) }));
    const total = Math.round(outs.reduce((sum, o) => sum + Math.min(o.hit?.percent ?? 0, 100), 0) * 10) / 10;
    const income = Math.round(
      theirs.reduce((sum, en) => sum + Math.min(estimateHit(en, m)?.percent ?? 0, 100), 0) * 10,
    ) / 10;
    return {
      name: m.name,
      spe: m.stats.spe,
      total,
      income,
      kos: outs.filter((o) => (o.hit?.percent ?? 0) >= 50).map((o) => o.enemy.name),
      line: `${m.name}：对敌总威胁 ${total} 分（每只按最多100%计），能1–2击带走 ${
        outs.filter((o) => (o.hit?.percent ?? 0) >= 50).map((o) => o.enemy.name).join('、') || '无'
      }`,
    };
  });

  const ace = [...allies].sort((a, b) => b.total - a.total)[0] ?? null;
  const lead = [...allies].sort((a, b) => b.total - 0.5 * b.income - (a.total - 0.5 * a.income))[0] ?? null;

  return { threats, allies, ace, lead };
}

export const DAMAGE_FACTS_HEADER =
  '【伤害与击杀估算（服务器端按图鉴种族值、技能威力、本系1.25与属性倍率估算；游戏完整伤害公式未公布，所以是估算值，不是实测）】';
export const DAMAGE_FACTS_RULE =
  '口径：伤害% = 攻击 × 技能威力 ÷ 对方防御 ÷ 对方生命 × 本系1.25 × 属性倍率 × 校准系数0.25；50% 为两下带走，100% 为一下带走。不含特性、暴击、连击与状态伤害。';
