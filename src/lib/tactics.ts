/**
 * 本地战术引擎（Phase 3）：不联网、不调模型。
 *
 * 所有句子都由 src/data/ 里的图鉴原值推演：种族值、百分位、属性倍率、
 * 特性原文、可学技能的名称/属性/威力/能耗。这里不出现任何图鉴之外的
 * 精灵、技能或数值，因此离线也能给出可解释的中文战术结论。
 */
import { spiritMetrics, STAT_KEYS, teamMetrics } from './analysis';
import type { SpiritMetrics, TeamMetrics } from './analysis';
import { skillsOf } from './spirits';
import { formatMultiplier, matchup, TYPE_ORDER } from './typeChart';
import type { ResolvedSkill, Spirit } from './types';

export interface BriefSection {
  title: string;
  lines: string[];
}

export interface LocalBrief {
  headline: string;
  sections: BriefSection[];
  /** 生成口径说明，界面上用小字展示 */
  footnote: string;
}

const round1 = (n: number) => Math.round(n * 10) / 10;
const mean = (arr: number[]) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0);
const fmt = formatMultiplier;
const sign = (n: number) => (n > 0 ? `+${n}` : String(n));
/** 百分位说人话：第一名不说“超过 100%” */
const beat = (percentile: number, rank?: number) =>
  rank === 1 || percentile >= 99.95 ? '全图鉴最高' : `超过 ${percentile}% 的形态`;
const shortName = (name: string) => name.replace(/（[^）]*）/g, '');

function isDamaging(sk: ResolvedSkill): boolean {
  return typeof sk.power === 'number' && sk.power > 0 && Boolean(sk.type);
}

function uniqueSkills(list: ResolvedSkill[]): ResolvedSkill[] {
  const seen = new Set<string>();
  const out: ResolvedSkill[] = [];
  for (const sk of list) {
    if (seen.has(sk.name)) continue;
    seen.add(sk.name);
    out.push(sk);
  }
  return out;
}

function byPower(a: ResolvedSkill, b: ResolvedSkill): number {
  return (b.power ?? 0) - (a.power ?? 0) || (a.energy ?? 99) - (b.energy ?? 99);
}

/** 同一队里基准名重复时（例如不同形态），保留形态后缀，仍重名再补编号 */
function displayLabels(list: Spirit[]): Map<string, string> {
  const base = new Map<string, string>();
  for (const s of list) base.set(s.id, shortName(s.name));
  const counts = new Map<string, number>();
  for (const n of base.values()) counts.set(n, (counts.get(n) ?? 0) + 1);
  const map = new Map<string, string>();
  for (const s of list) {
    const short = base.get(s.id)!;
    if ((counts.get(short) ?? 0) <= 1) {
      map.set(s.id, short);
    } else if (s.name !== short) {
      map.set(s.id, s.name);
    } else {
      map.set(s.id, `${short} No.${s.dex}`);
    }
  }
  return map;
}

/** 技能简写：名称（属性·类别·威力·能耗）；变化技能不带威力 */
function skillTag(sk: ResolvedSkill): string {
  const bits = [sk.type, sk.category];
  if (isDamaging(sk)) bits.push(`威力${sk.power}`);
  if (typeof sk.energy === 'number') bits.push(`能耗${sk.energy}`);
  return `${sk.name}（${bits.join('·')}）`;
}

/* ============================================================ 单只强度解读 */

export function spiritBrief(spirit: Spirit, precomputed?: SpiritMetrics): LocalBrief {
  const m = precomputed ?? spiritMetrics(spirit);
  const total = m.total;

  const rankedStats = STAT_KEYS.filter((k) => m.stats[k]).map((k) => ({ key: k, ...m.stats[k]! }));
  const strongest = [...rankedStats].sort((a, b) => b.percentile - a.percentile)[0];
  const weakest = [...rankedStats].sort((a, b) => a.percentile - b.percentile)[0];

  const atk = spirit.stats.atk ?? 0;
  const spa = spirit.stats.spa ?? 0;
  const physical = atk >= spa;
  const mainKey = physical ? 'atk' : 'spa';
  const mainLabel = physical ? '物攻' : '魔攻';
  const offLabel = physical ? '魔攻' : '物攻';
  const mainStat = m.stats[mainKey];
  const offStat = m.stats[physical ? 'spa' : 'atk'];
  const spe = m.stats.spe;
  const bulk = round1(mean([m.stats.hp, m.stats.def, m.stats.spd].map((s) => s?.percentile ?? 0)));
  const balanced = Math.abs(atk - spa) <= 15;

  /* ---------------------------------------------------------- 配招推荐 */
  const learnable = uniqueSkills(skillsOf(spirit));
  const damaging = learnable.filter(isDamaging).sort(byPower);
  const support = learnable.filter((sk) => !isDamaging(sk));
  const mainCategory = physical ? '物理' : '魔法';

  const picks: { label: string; skill: ResolvedSkill; reason: string }[] = [];
  const sameSide = damaging.filter((sk) => sk.category === mainCategory);
  const otherSide = damaging.filter((sk) => sk.category !== mainCategory);

  const stabFirst = [...sameSide].sort((a, b) => {
    const aStab = spirit.type.includes(a.type) ? 1 : 0;
    const bStab = spirit.type.includes(b.type) ? 1 : 0;
    return bStab - aStab || byPower(a, b);
  });

  const primary = stabFirst[0];
  const secondary = stabFirst[1] ?? otherSide[0];
  if (primary) {
    picks.push({
      label: '主攻',
      skill: primary,
      reason: spirit.type.includes(primary.type)
        ? `本系最高威力${mainCategory}技能，威力${primary.power}${primary.energy ? `、能耗${primary.energy}` : ''}`
        : `可学${mainCategory}技能里威力最高（${primary.power}）`,
    });
  }
  if (secondary && secondary !== primary) {
    picks.push({
      label: '副攻',
      skill: secondary,
      reason: spirit.type.includes(secondary.type)
        ? `另一个本系输出，${secondary.category}·威力${secondary.power}`
        : `${secondary.type}系${secondary.category}输出，威力${secondary.power}`,
    });
  }

  // 补盲：专打「主攻属性打不动」的防守属性
  const primaryTypes = [...new Set([primary, secondary].filter(Boolean).map((sk) => (sk as ResolvedSkill).type))];
  const blocked = primaryTypes.length
    ? TYPE_ORDER.filter((t) => primaryTypes.every((pt) => matchup(pt, [t]).multiplier <= 0.5))
    : [];
  let coverage: ResolvedSkill | null = null;
  let coverageTargets: string[] = [];
  if (blocked.length) {
    const candidates = damaging
      .filter((sk) => !primaryTypes.includes(sk.type))
      .map((sk) => ({
        sk,
        hits: blocked.filter((t) => matchup(sk.type, [t]).multiplier >= 2),
      }))
      .filter((c) => c.hits.length > 0)
      .sort((a, b) => b.hits.length - a.hits.length || byPower(a.sk, b.sk));
    if (candidates[0]) {
      coverage = candidates[0].sk;
      coverageTargets = blocked.filter((t) => matchup(coverage!.type, [t]).multiplier >= 2);
      picks.push({
        label: '补盲',
        skill: coverage,
        reason: `${coverage.type}系，可对 ${coverageTargets.slice(0, 4).join('、')} 打出 ${fmt(2)} 以上，弥补主攻被抵抗的缺口`,
      });
    }
  }

  // 变化技能：优先有回复/减伤/增益等实际效果、能耗低的
  const KEYWORDS = ['回复', '减伤', '提升', '增益', '免疫', '清除', '降低', '偷取', '护盾'];
  const supportBest = [...support]
    .map((sk) => {
      const hits = KEYWORDS.filter((k) => (sk.effect ?? '').includes(k)).length;
      return { sk, hits, energy: sk.energy ?? 99 };
    })
    .filter((x) => x.hits > 0)
    .sort((a, b) => b.hits - a.hits || a.energy - b.energy)[0];
  if (supportBest) {
    picks.push({
      label: '变化',
      skill: supportBest.sk,
      reason: `${supportBest.sk.category}技能，${(supportBest.sk.effect ?? '').replace(/\s+/g, '')}`
    });
  }

  /* ---------------------------------------------------------- 章节 */
  const concl: string[] = [
    `${total.tier} 级 · 总种族值 ${total.value}，全图鉴第 ${total.rank}/${total.population} 名（${beat(total.percentile, total.rank)}）。`,
  ];
  if (strongest && weakest) {
    concl.push(
      `最突出的是${strongest.label} ${strongest.value}（第${strongest.rank}，${beat(strongest.percentile, strongest.rank)}）；短板是${weakest.label} ${weakest.value}（${beat(weakest.percentile, weakest.rank)}）。`,
    );
  }
  if (balanced) {
    concl.push(`双攻接近（物攻${atk}/魔攻${spa}），两套输出技能都吃得下，属于双刀型。`);
  } else {
    concl.push(`物攻${atk} / 魔攻${spa}，明显偏${mainLabel}，配招就按${mainLabel}挑技能。`);
  }

  const role: string[] = [`定位：${m.roles.join('、')}。`];
  if (mainStat) {
    role.push(
      `${mainLabel} ${mainStat.value}（${beat(mainStat.percentile, mainStat.rank)}）${offStat ? `；${offLabel} ${offStat.value}（${beat(offStat.percentile, offStat.rank)}）` : ''}。`,
    );
  }
  if (spe) {
    const speedTone =
      spe.percentile >= 90 ? '顶级速度，先手面很宽' : spe.percentile >= 70 ? '速度合格，多数对位能先手' : spe.percentile >= 40 ? '速度中游，要先看对方速度' : '速度偏慢，基本是后手';
    role.push(`速度 ${spe.value}（第${spe.rank}，${beat(spe.percentile, spe.rank)}）：${speedTone}。`);
  }
  role.push(`耐久三围综合百分位 ${bulk}%：${bulk >= 75 ? '能抗，适合中盘换入' : bulk >= 55 ? '抗压一般，别硬吃克制' : '偏脆，尽量先手解决' }。`);

  const skillLines: string[] = [];
  if (picks.length) {
    for (const p of picks) skillLines.push(`${p.label}｜${skillTag(p.skill)} — ${p.reason}`);
  } else {
    skillLines.push('图鉴里没有这只精灵的可学技能记录，无法给出配招。');
  }
  if (m.skills.efficient[0]) {
    const e = m.skills.efficient[0];
    skillLines.push(`能耗效率最高：${e.name}（威力${e.power}/能耗${e.energy}，效率 ${e.ratio}）。`);
  }

  const usage: string[] = [];
  if (spe && spe.percentile >= 80 && (mainStat?.percentile ?? 0) >= 70) {
    usage.push('适合抢先上场：靠速度先进攻，把克制伤害在对方出手前打出去。');
  } else if (spe && spe.percentile < 45) {
    usage.push('上场前先确认对方速度：落后时先吃一轮，尽量换入能抗的队友再输出。');
  } else {
    usage.push('均衡型：可以首发试探，也可以对位换入，按对方属性决定。');
  }
  if (bulk >= 70) usage.push('耐久不错，能吃一次普通伤害换一次出手机会。');
  if (m.skills.byCategory.物理 && m.skills.byCategory.魔法) {
    usage.push(`技能池物理 ${m.skills.byCategory.物理} 个、魔法 ${m.skills.byCategory.魔法} 个，按${mainLabel}取用即可。`);
  }
  if (spirit.trait?.effect) {
    usage.push(`特性「${spirit.trait.name}」：${spirit.trait.effect}`);
  } else if (spirit.trait) {
    usage.push(`特性「${spirit.trait.name}」：图鉴未提供效果文本。`);
  }

  const risk: string[] = [];
  if (m.weak.length) {
    risk.push(
      `怕 ${m.weak
        .slice(0, 4)
        .map((w) => `${w.type}${fmt(w.multiplier)}`)
        .join('、')}，这些属性打过来最疼。`,
    );
  } else {
    risk.push('没有属性可以克制它（图鉴倍率里没有 >1 倍）。');
  }
  if (m.resist.length) {
    risk.push(`可以顶 ${m.resist.slice(0, 4).map((r) => `${r.type}${fmt(r.multiplier)}`).join('、')}。`);
  }
  if (m.offence.noAnswer.length) {
    risk.push(
      `打不出 >1 倍的属性有 ${m.offence.noAnswer.length} 种：${m.offence.noAnswer.slice(0, 6).join('、')}${m.offence.noAnswer.length > 6 ? ' 等' : ''}。`,
    );
  }
  if (m.offence.strongCount === 0) {
    risk.push('技能池里没有能打出 ≥2 倍的属性，只能靠平伤和变化技能。');
  }
  if (!support.length) {
    risk.push('没有变化技能，缺少回复/减伤手段。');
  }

  return {
    headline: `${spirit.name}：${total.tier} 级（第 ${total.rank}/${total.population}）· ${m.roles.join(' / ')}${weakest ? ` · 短板 ${weakest.label} ${weakest.value}` : ''}。`,
    sections: [
      { title: '结论', lines: concl },
      { title: '定位', lines: role },
      { title: '配招建议', lines: skillLines },
      { title: '使用要点', lines: usage },
      { title: '风险与短板', lines: risk },
    ],
    footnote: `基于图鉴 ${total.population} 只形态的种族值百分位、属性倍率表、特性原文与 ${m.skills.total} 个可学技能本地计算，未调用任何模型。`,
  };
}

/* ============================================================ 双方阵容实战 */

export interface TeamBrief extends LocalBrief {
  /** 敌方每只的应对方案，界面可以额外可视化 */
  answers: {
    enemyId: string;
    enemyName: string;
    enemyTypes: string[];
    best: { name: string; id: string; multiplier: number; threat: number; speedEdge: number; skill: ResolvedSkill | null; skillType: string };
    alternative: { name: string; multiplier: number; threat: number } | null;
    hasAnswer: boolean;
  }[];
}

export function teamBrief(mine: Spirit[], theirs: Spirit[], precomputed?: TeamMetrics): TeamBrief {
  const metrics = precomputed ?? teamMetrics(mine, theirs);
  const mineById = new Map(mine.map((s) => [s.id, s]));
  const theirsById = new Map(theirs.map((s) => [s.id, s]));
  const myLabel = displayLabels(mine);
  const enemyLabel = displayLabels(theirs);
  const labelOfMine = (spirit: Spirit) => myLabel.get(spirit.id) ?? shortName(spirit.name);
  const labelOfEnemy = (spirit: Spirit) => enemyLabel.get(spirit.id) ?? shortName(spirit.name);

  /* -------------------------------------------------- 逐只敌方：最佳答案 */
  const answers: TeamBrief['answers'] = theirs.map((en, j) => {
    const cells = mine.map((m, i) => {
      const cell = metrics.matrix[i][j];
      return {
        name: labelOfMine(m),
        id: m.id,
        multiplier: cell.attack.multiplier,
        threat: cell.threat.multiplier,
        speedEdge: cell.speedEdge,
        skill: cell.attack.skill,
        skillType: cell.attack.skillType,
      };
    });
    const sorted = [...cells].sort(
      (a, b) => b.multiplier - a.multiplier || a.threat - b.threat || b.speedEdge - a.speedEdge,
    );
    const best = sorted[0];
    const altRaw = sorted[1];
    return {
      enemyId: en.id,
      enemyName: labelOfEnemy(en),
      enemyTypes: en.type,
      best,
      alternative:
        altRaw && altRaw.id !== best?.id
          ? { name: altRaw.name, multiplier: altRaw.multiplier, threat: altRaw.threat }
          : null,
      hasAnswer: Boolean(best && best.multiplier >= 2),
    };
  });

  /* -------------------------------------------------- 首发 */
  const leadRanked = metrics.ranked;
  const leadRow = leadRanked[0] ?? null;
  const lead = leadRow ? mineById.get(leadRow.id) ?? null : null;
  const altLeadRow = leadRanked[1] ?? null;
  const altLead = altLeadRow ? mineById.get(altLeadRow.id) ?? null : null;

  const leadLines: string[] = [];
  if (lead && leadRow) {
    leadLines.push(
      `首选 ${labelOfMine(lead)}：对敌平均进攻 ${fmt(leadRow.attack)}、平均受威胁 ${fmt(leadRow.threat)}、速度平均差 ${sign(leadRow.speedEdge)}，对位综合分 ${leadRow.score}（我方最高）。`,
    );
    const leadSpe = lead.stats.spe ?? 0;
    const enemyFastest = metrics.speed.enemyFastest;
    const fastestSpirit = enemyFastest ? theirs.reduce((x, y) => ((y.stats.spe ?? 0) > (x.stats.spe ?? 0) ? y : x)) : null;
    const enemyLabelFastest = fastestSpirit ? labelOfEnemy(fastestSpirit) : '';
    if (enemyFastest) {
      const faster = theirs.filter((e) => (e.stats.spe ?? 0) < leadSpe).length;
      leadLines.push(
        `速度 ${leadSpe}，快过敌方 ${faster}/${theirs.length} 只${enemyFastest ? `（对方最快 ${enemyLabelFastest} ${enemyFastest.spe}）` : ''}。`,
      );
    }
    // 最佳开场目标 / 最忌讳的对象
    const targets = answers
      .filter((a) => a.best.id === lead.id)
      .sort((a, b) => b.best.multiplier - a.best.multiplier);
    const goodTarget = targets.find((t) => t.best.multiplier >= 2);
    if (goodTarget) {
      leadLines.push(
        `最想遇到 ${goodTarget.enemyName}［${goodTarget.enemyTypes.join('/')}］：${goodTarget.best.skill ? `${goodTarget.best.skill.name} 威力${goodTarget.best.skill.power}` : `${goodTarget.best.skillType}系输出`} 打 ${fmt(goodTarget.best.multiplier)}。`,
      );
    }
    const leadIdx = mine.findIndex((m) => m.id === lead.id);
    const worstThreat = leadIdx >= 0
      ? theirs
          .map((e, j) => ({ e, cell: metrics.matrix[leadIdx][j] }))
          .sort((a, b) => b.cell.threat.multiplier - a.cell.threat.multiplier)[0]
      : null;
    if (worstThreat && worstThreat.cell.threat.multiplier >= 2) {
      leadLines.push(
        `风险：遇到 ${labelOfEnemy(worstThreat.e)} 会被 ${worstThreat.cell.threat.skill ? `「${worstThreat.cell.threat.skill.name}」` : ''}${fmt(worstThreat.cell.threat.multiplier)} 反打，别让它先手。`,
      );
    }
    if (altLead && altLeadRow) {
      leadLines.push(
        `备选 ${labelOfMine(altLead)}（进攻 ${fmt(altLeadRow.attack)} / 受威胁 ${fmt(altLeadRow.threat)}），想先稳一手时换它上场。`,
      );
    }
  } else {
    leadLines.push('我方阵容为空。');
  }

  /* -------------------------------------------------- 逐只应对 */
  const answerLines: string[] = [];
  for (const a of answers) {
    const en = theirsById.get(a.enemyId);
    if (!en) continue;
    const types = a.enemyTypes.join('/');
    const best = a.best;
    if (best && a.hasAnswer) {
      const spd =
        best.speedEdge > 0 ? `我方快 ${best.speedEdge}` : best.speedEdge < 0 ? `我方慢 ${-best.speedEdge}` : '同速';
      const parts = [
        `挡 ${a.enemyName}［${types}］：上 ${best.name}，${
          best.skill ? `${best.skill.name}（${best.skill.type}·威力${best.skill.power}）` : `${best.skillType}系输出`
        } 打 ${fmt(best.multiplier)}，${spd}。`,
      ];
      if (best.threat >= 2) {
        parts.push(`注意：它也吃 ${a.enemyName} 的克制（${fmt(best.threat)}），别站着挨。`);
      } else if (best.threat <= 0.5) {
        parts.push(`对方反打只有 ${fmt(best.threat)}，可以顶着打。`);
      } else {
        parts.push(`对方反打 ${fmt(best.threat)}，属正常互换。`);
      }
      if (a.alternative && a.alternative.multiplier >= 2 && a.alternative.threat <= 1) {
        parts.push(`备选 ${a.alternative.name}（${fmt(a.alternative.multiplier)}，受 ${fmt(a.alternative.threat)}）。`);
      }
      answerLines.push(parts.join(''));
    } else if (best) {
      answerLines.push(
        `挡 ${a.enemyName}［${types}］：没有 ${fmt(2)} 答案，我方最高只有 ${fmt(best.multiplier)}（${best.name}）${
          best.speedEdge > 0 ? '，可凭速度先手换血' : ''
        }。建议避战或用变化技能消耗。`,
      );
    }
  }

  /* -------------------------------------------------- 联防与盲区 */
  const guardLines: string[] = [];
  if (metrics.sharedWeak.length) {
    for (const w of metrics.sharedWeak.slice(0, 3)) {
      const carriers = theirs.filter((e) => e.type.includes(w.type));
      const enemyCarriers = [...new Set(carriers.map((e) => labelOfEnemy(e)))];
      const hitMembers = mine.filter((m) => matchup(w.type, m.type).multiplier >= 2);
      const members = [...new Set(hitMembers.map((m) => labelOfMine(m)))];
      const verdict = enemyCarriers.length
        ? `对方 ${enemyCarriers.slice(0, 3).join('、')} 正好带${w.type}系，换人要挑不吃这个的`
        : `对方目前没有${w.type}系，暂时安全`;
      guardLines.push(
        `${w.type}系一招能克制我方 ${members.length} 只（${members.join('、')}，最高 ${fmt(w.maxMultiplier)}）；${verdict}。`,
      );
    }
  } else {
    guardLines.push('没有同一属性可以同时克制我方 2 只以上，联防结构没有明显共振点。');
  }

  const gaps = answers.filter((a) => !a.hasAnswer);
  if (gaps.length) {
    guardLines.push(
      `盲区：${gaps
        .slice(0, 4)
        .map((g) => `${g.enemyName}［${g.enemyTypes.join('/')}］我方最高 ${fmt(g.best?.multiplier ?? 0)}`)
        .join('、')}，这些目标只能靠平伤或变化技能处理。`,
    );
    const gapTypes = [...new Set(gaps.flatMap((g) => g.enemyTypes))];
    if (gapTypes.length) guardLines.push(`对方阵营里我方打不痛的类型：${gapTypes.join('、')}。`);
  } else if (answers.length) {
    guardLines.push('打击面无盲区：敌方每只我方都有人能打出 ≥2 倍。');
  }

  if (metrics.speed.enemyFastest && metrics.speed.myFastest) {
    const mineTop = mine.reduce((x, y) => ((y.stats.spe ?? 0) > (x.stats.spe ?? 0) ? y : x));
    const enemyTop = theirs.reduce((x, y) => ((y.stats.spe ?? 0) > (x.stats.spe ?? 0) ? y : x));
    const laneFastestMine = labelOfMine(mineTop);
    const laneFastestEnemy = labelOfEnemy(enemyTop);
    const fasterCount = theirs.filter((e) => (e.stats.spe ?? 0) > (mineTop.stats.spe ?? 0)).length;
    guardLines.push(
      `速度：我方最快 ${laneFastestMine} ${metrics.speed.myFastest.spe}，对方最快 ${laneFastestEnemy} ${metrics.speed.enemyFastest.spe}${fasterCount ? `；对方有 ${fasterCount} 只快过我方最快的那只` : '；我方最快的那只比对方全员都快'}。`,
    );
  }

  if (metrics.sharedResist.length) {
    guardLines.push(
      `可以联防：${metrics.sharedResist
        .slice(0, 4)
        .map((r) => `${r.type}系被 ${r.count} 只抵抗`)
        .join('、')}。`,
    );
  }
  guardLines.push(
    `种族值：我方平均 ${metrics.totals.myAvg}，对方平均 ${metrics.totals.enemyAvg}（${sign(metrics.totals.diff)}）${
      metrics.totals.diff >= 0 ? '，面板略占优，按对位打即可' : '，面板落后，靠克制倍率找突破口'
    }。`,
  );

  const headline = (() => {
    const bits = [`我方 ${mine.length} 只 vs 对方 ${theirs.length} 只`];
    if (lead) bits.push(`首发 ${labelOfMine(lead)}`);
    const good = answers.filter((a) => a.hasAnswer).length;
    bits.push(`${good}/${theirs.length} 只敌方有 ≥2 倍答案`);
    if (gaps.length) bits.push(`${gaps.length} 只存在盲区`);
    return `${bits.join(' · ')}。`;
  })();

  return {
    headline,
    sections: [
      { title: '首发推荐与理由', lines: leadLines },
      { title: '逐只敌方应对方案', lines: answerLines.length ? answerLines : ['我方没有可出场的精灵。'] },
      { title: '联防与盲区预警', lines: guardLines },
    ],
    footnote: `全部由内置图鉴（${mine.length + theirs.length} 只参战精灵的种族值、属性倍率与可学技能）本地计算，0 网络请求、0 生成时间。`,
    answers,
  };
}

