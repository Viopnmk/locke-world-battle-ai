/**
 * 确定性计算：所有数字都来自 data.mjs 的图鉴数据，不经过模型。
 * 这些结果会随 AI 回答一起返回（deterministic 字段），前端也用它做本地兜底。
 */
import {
  STAT_KEYS,
  STAT_LABEL,
  TYPE_ORDER,
  defenceProfile,
  matchup,
  multiplierText,
  skillsOf,
  spiritById,
  statRank,
  totalRank,
} from './data.mjs';

const round1 = (n) => Math.round(n * 10) / 10;
const round2 = (n) => Math.round(n * 100) / 100;
const mean = (arr) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0);

export function brief(spirit) {
  return {
    id: spirit.id,
    dex: spirit.dex,
    name: spirit.name,
    types: spirit.type,
    stats: spirit.stats,
    trait: spirit.trait,
    stage: spirit.stage,
    formLabel: spirit.formLabel || '',
    desc: spirit.desc,
  };
}

/** 伤害技能（威力 > 0 且带属性）。 */
export function damagingSkills(spirit) {
  return skillsOf(spirit).filter((s) => typeof s.power === 'number' && s.power > 0 && s.type);
}

/**
 * 这只精灵用可学技能打 targetTypes 的最佳一击。
 * 同倍率时取威力最高；完全没有输出技能时退回本系属性（说明里标注）。
 */
export function bestHit(spirit, targetTypes) {
  const dmg = damagingSkills(spirit);
  let best = null;
  for (const sk of dmg) {
    const mult = matchup(sk.type, targetTypes);
    const score = mult * (sk.power ?? 0);
    if (!best || score > best.score || (score === best.score && (sk.power ?? 0) > (best.skill?.power ?? 0))) {
      best = { mult, score, skill: sk, fallback: false };
    }
  }
  if (!best) {
    for (const t of spirit.type) {
      const mult = matchup(t, targetTypes);
      if (!best || mult > best.mult) best = { mult, score: mult * 60, skill: null, fallback: true, skillType: t };
    }
    if (!best) best = { mult: 1, score: 60, skill: null, fallback: true, skillType: spirit.type[0] };
  }
  return {
    multiplier: best.mult,
    skill: best.skill
      ? {
          id: best.skill.id,
          name: best.skill.name,
          type: best.skill.type,
          category: best.skill.category,
          power: best.skill.power,
          energy: best.skill.energy,
        }
      : null,
    skillType: best.skill ? best.skill.type : best.skillType,
    fallback: best.fallback,
  };
}

/** 精灵强度：种族值分布 + 属性受击 + 进攻覆盖 + 技能池。 */
export function spiritMetrics(spirit) {
  const stats = {};
  for (const key of STAT_KEYS) {
    const r = statRank(key, spirit.stats[key]);
    if (r) stats[key] = { label: STAT_LABEL[key], ...r };
  }
  const total = totalRank(spirit.stats.total);
  const profile = defenceProfile(spirit.type);
  const list = skillsOf(spirit);
  const dmg = list.filter((s) => typeof s.power === 'number' && s.power > 0 && s.type);
  const support = list.filter((s) => !(typeof s.power === 'number' && s.power > 0));

  // 每种属性只用威力最高的技能代表
  const bestByType = new Map();
  for (const sk of dmg) {
    const cur = bestByType.get(sk.type);
    if (!cur || (sk.power ?? 0) > (cur.power ?? 0)) bestByType.set(sk.type, sk);
  }
  const offenceTypes = [...bestByType.keys()];
  const vsAll = TYPE_ORDER.map((t) => ({
    type: t,
    best: offenceTypes.length ? Math.max(...offenceTypes.map((at) => matchup(at, [t]))) : 0,
  }));
  const strongAgainst = vsAll.filter((v) => v.best >= 2).map((v) => ({ type: v.type, multiplier: v.best }));
  const noAnswer = vsAll.filter((v) => v.best <= 1).map((v) => v.type);

  const learnCount = { level: 0, stone: 0, blood: 0 };
  for (const sk of list) {
    if (sk.learn === 0) learnCount.level += 1;
    else if (sk.learn === 1) learnCount.stone += 1;
    else if (sk.learn === 2) learnCount.blood += 1;
  }
  const categoryCount = { 物理: 0, 魔法: 0, 变化: 0 };
  for (const sk of list) {
    if (categoryCount[sk.category] !== undefined) categoryCount[sk.category] += 1;
  }

  const topPower = [...dmg]
    .sort((a, b) => (b.power ?? 0) - (a.power ?? 0) || (a.energy ?? 99) - (b.energy ?? 99))
    .slice(0, 8)
    .map((sk) => ({
      name: sk.name,
      type: sk.type,
      category: sk.category,
      power: sk.power,
      energy: sk.energy,
      effect: sk.effect,
    }));

  const efficient = [...dmg]
    .filter((sk) => sk.energy)
    .sort((a, b) => (b.power ?? 0) / (b.energy ?? 1) - (a.power ?? 0) / (a.energy ?? 1))
    .slice(0, 5)
    .map((sk) => ({ name: sk.name, type: sk.type, power: sk.power, energy: sk.energy, ratio: round2((sk.power ?? 0) / (sk.energy ?? 1)) }));

  // 确定性定位标签（只按百分位与技能构成判断）
  const p = (k) => stats[k]?.percentile ?? 0;
  const offencePeak = Math.max(p('atk'), p('spa'));
  const bulk = mean([p('hp'), p('def'), p('spd')]);
  const roles = [];
  if (p('spe') >= 85 && offencePeak >= 70) roles.push('高速输出');
  else if (offencePeak >= 85) roles.push('重炮输出');
  else if (offencePeak >= 60) roles.push('稳定输出');
  if (bulk >= 80) roles.push('耐久坦克');
  else if (bulk >= 65) roles.push('能抗能打');
  if (p('spe') >= 90) roles.push('先手压制');
  if (support.length >= 8) roles.push('功能辅助');
  if (!roles.length) roles.push('均衡替补');

  return {
    id: spirit.id,
    name: spirit.name,
    dex: spirit.dex,
    types: spirit.type,
    total,
    stats,
    roles,
    weak: profile.weak.map((w) => ({ type: w.type, multiplier: w.multiplier })),
    resist: profile.resist.map((r) => ({ type: r.type, multiplier: r.multiplier })),
    offence: {
      typesWithDamagingSkill: offenceTypes.length,
      strongAgainst,
      strongCount: strongAgainst.length,
      noAnswer,
    },
    skills: {
      total: list.length,
      damaging: dmg.length,
      support: support.length,
      byLearn: learnCount,
      byCategory: categoryCount,
      topPower,
      efficient,
    },
  };
}

export function spiritLine(spirit) {
  const m = spiritMetrics(spirit);
  return {
    ...brief(spirit),
    metrics: {
      total: m.total,
      roles: m.roles,
      weak: m.weak,
      resist: m.resist,
      offence: m.offence,
      skillCount: m.skills.total,
    },
  };
}

/** 双方阵容：对位矩阵、共同弱点、打击盲区、速度与种族值对比、首发打分。 */
export function teamMetrics(mine, theirs) {
  const matrix = [];
  for (const my of mine) {
    const row = [];
    for (const en of theirs) {
      const atk = bestHit(my, en.type);
      const threat = bestHit(en, my.type);
      row.push({
        myId: my.id,
        myName: my.name,
        enemyId: en.id,
        enemyName: en.name,
        attack: { multiplier: atk.multiplier, skill: atk.skill, skillType: atk.skillType },
        threat: { multiplier: threat.multiplier, skill: threat.skill, skillType: threat.skillType },
        speedEdge: (my.stats.spe ?? 0) - (en.stats.spe ?? 0),
        faster: (my.stats.spe ?? 0) > (en.stats.spe ?? 0),
      });
    }
    matrix.push(row);
  }

  const sharedWeak = [];
  const sharedResist = [];
  for (const atkType of TYPE_ORDER) {
    const hitMembers = mine.filter((m) => matchup(atkType, m.type) >= 2);
    if (hitMembers.length >= 2) {
      sharedWeak.push({
        type: atkType,
        count: hitMembers.length,
        members: hitMembers.map((m) => m.name),
        maxMultiplier: Math.max(...hitMembers.map((m) => matchup(atkType, m.type))),
      });
    }
    const resistMembers = mine.filter((m) => matchup(atkType, m.type) <= 0.5);
    if (resistMembers.length >= 2) {
      sharedResist.push({ type: atkType, count: resistMembers.length, members: resistMembers.map((m) => m.name) });
    }
  }
  sharedWeak.sort((a, b) => b.count - a.count || b.maxMultiplier - a.maxMultiplier);
  sharedResist.sort((a, b) => b.count - a.count);

  const coverageGaps = [];
  if (theirs.length && mine.length) {
    for (const en of theirs) {
      const answers = mine
        .map((m) => ({ name: m.name, mult: bestHit(m, en.type).multiplier }))
        .sort((a, b) => b.mult - a.mult);
      if (!answers.length || answers[0].mult < 2) {
        coverageGaps.push({
          enemy: en.name,
          enemyTypes: en.type,
          bestMultiplier: answers[0]?.mult ?? 0,
          bestBy: answers[0]?.name ?? null,
        });
      }
    }
  }

  const myFastest = mine.length
    ? mine.reduce((a, b) => ((a.stats.spe ?? 0) >= (b.stats.spe ?? 0) ? a : b))
    : null;
  const enemyFastest = theirs.length
    ? theirs.reduce((a, b) => ((a.stats.spe ?? 0) >= (b.stats.spe ?? 0) ? a : b))
    : null;
  const speed = {
    myFastest: myFastest ? { name: myFastest.name, spe: myFastest.stats.spe } : null,
    enemyFastest: enemyFastest ? { name: enemyFastest.name, spe: enemyFastest.stats.spe } : null,
    myFasterCount: theirs.length
      ? mine.filter((m) => theirs.every((e) => (m.stats.spe ?? 0) > (e.stats.spe ?? 0))).length
      : 0,
    myLeadCount: 0,
  };
  if (theirs.length) {
    speed.myLeadCount = mine.filter((m) => (m.stats.spe ?? 0) > (enemyFastest?.stats.spe ?? 0)).length;
  }

  const totals = {
    myAvg: mine.length ? round1(mean(mine.map((m) => m.stats.total ?? 0))) : 0,
    enemyAvg: theirs.length ? round1(mean(theirs.map((m) => m.stats.total ?? 0))) : 0,
  };
  totals.diff = round1(totals.myAvg - totals.enemyAvg);

  const scored = mine.map((m) => {
    const atk = theirs.length ? round2(mean(theirs.map((e) => bestHit(m, e.type).multiplier))) : 0;
    const threat = theirs.length ? round2(mean(theirs.map((e) => bestHit(e, m.type).multiplier))) : 0;
    const spd = theirs.length ? round1(mean(theirs.map((e) => (m.stats.spe ?? 0) - (e.stats.spe ?? 0)))) : 0;
    const score = round2(atk - threat + (spd > 0 ? 0.3 : spd < 0 ? -0.3 : 0));
    return { name: m.name, id: m.id, attack: atk, threat, speedEdge: spd, score };
  });
  scored.sort((a, b) => b.score - a.score);

  return {
    matrix,
    sharedWeak,
    sharedResist,
    coverageGaps,
    speed,
    totals,
    lead: scored[0] ?? null,
    ranked: scored,
  };
}

/** 单打对位（spirit 模式/快捷分析也用得到）。 */
export function duelMetrics(mine, theirs) {
  const atk = bestHit(mine, theirs.type);
  const threat = bestHit(theirs, mine.type);
  return {
    attacker: mine.name,
    defender: theirs.name,
    attack: { multiplier: atk.multiplier, skill: atk.skill },
    threat: { multiplier: threat.multiplier, skill: threat.skill },
    speedEdge: (mine.stats.spe ?? 0) - (theirs.stats.spe ?? 0),
    text: `${mine.name} 打 ${theirs.name}：${multiplierText(atk.multiplier)}${atk.skill ? `（${atk.skill.name}·${atk.skill.type}·威力${atk.skill.power}）` : ''}；被反打 ${multiplierText(threat.multiplier)}`,
  };
}

export function spiritByIdSafe(id) {
  return spiritById.get(id) ?? null;
}
