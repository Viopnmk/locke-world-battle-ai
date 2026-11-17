/**
 * 本地战术引擎（Phase 3）：不联网、不调模型。
 *
 * 所有句子都由 src/data/ 里的图鉴原值推演：种族值、百分位、属性倍率、
 * 特性原文、可学技能的名称/属性/威力/能耗。这里不出现任何图鉴之外的
 * 精灵、技能或数值，因此离线也能给出可解释的中文战术结论。
 */
import { spiritMetrics, STAT_KEYS, teamMetrics } from './analysis';
import type { SpiritMetrics, TeamMetrics } from './analysis';
import { estimateHit, DAMAGE_DISCLAIMER, DAMAGE_NOTE } from './damage';
import type { DamageHit } from './damage';
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

export interface ThreatLine {
  enemyId: string;
  enemyName: string;
  enemyTypes: string[];
  /** 最高一击（打我方最疼的一发） */
  top: {
    allyName: string;
    percent: number;
    skillName: string | null;
    skillType: string;
    multiplier: number;
  } | null;
  /** 威胁分：对我方每只取 min(伤害, 100) 求和，秒杀不重复计分 */
  score: number;
  /** 能 1–2 击带走（≥50%）的我方成员 */
  kos: { allyName: string; percent: number; skillName: string | null }[];
  oneShots: number;
  line: string;
}

export interface AnalystFactor {
  key: 'type' | 'damage' | 'speed' | 'bulk';
  label: string;
  /** 0–100，50 = 持平 */
  percent: number;
  side: 'mine' | 'enemy' | 'even';
  detail: string;
}

export interface AnalystBlock {
  key: string;
  title: string;
  lines: string[];
}

export interface AnalystAnswer {
  enemyId: string;
  enemyName: string;
  enemyTypes: string[];
  allyName: string;
  allyId: string;
  percent: number;
  skillName: string | null;
  skillType: string;
  incomingPercent: number;
  incomingSkillName: string | null;
  incomingSkillType: string | null;
  koCount: number;
  line: string;
}

export interface AnalystNote {
  /** 四项加权的胜率倾向，0–100 */
  percent: number;
  lean: string;
  factors: AnalystFactor[];
  summary: string[];
  blocks: AnalystBlock[];
}

export interface TeamBrief extends LocalBrief {
  threats: ThreatLine[];
  answers: AnalystAnswer[];
  analyst: AnalystNote;
  /** 伤害估算的口径说明，界面小字展示 */
  estimateNote: string;
}

const pctText = (n: number) => `${Math.round(n)}%`;

/** 把「我方值 / 敌方值」换成 0–100 的倾向分：比值越大越偏向我方，50 = 持平 */
function tiltFactor(mine: number, enemy: number): number {
  const m = Number.isFinite(mine) && mine > 0 ? mine : 0;
  const e = Number.isFinite(enemy) && enemy > 0 ? enemy : 0;
  if (m <= 0 && e <= 0) return 50;
  if (m <= 0) return 0;
  if (e <= 0) return 100;
  const tilt = 0.5 + 0.5 * Math.tanh(Math.log(m / e));
  return Math.round(tilt * 1000) / 10;
}

const FACTOR_WEIGHT: Record<AnalystFactor['key'], number> = {
  type: 0.35,
  damage: 0.3,
  speed: 0.2,
  bulk: 0.15,
};

const FACTOR_ADVICE: Record<AnalystFactor['key'], string> = {
  type: '别把核心往对方克制的属性上送，换人按倍率走',
  damage: '先手把输出打出去，别拖成互相磨血',
  speed: '避开正面消耗，靠先手或换宠抢节奏',
  bulk: '别硬顶伤害，靠换人分摊',
};

const bulkOf = (s: Spirit) => (s.stats.hp ?? 0) + (s.stats.def ?? 0) + (s.stats.spd ?? 0);

export function teamBrief(mine: Spirit[], theirs: Spirit[], precomputed?: TeamMetrics): TeamBrief {
  const metrics = precomputed ?? teamMetrics(mine, theirs);
  const myLabel = displayLabels(mine);
  const enemyLabel = displayLabels(theirs);
  /* 双方出现同一个名字（镜像阵容/同名形态）时补上阵营，避免「派 烈火战神 打 烈火战神」看不出谁是谁 */
  const enemyNames = new Set(enemyLabel.values());
  const sharedNames = new Set([...myLabel.values()].filter((n) => enemyNames.has(n)));
  if (sharedNames.size) {
    for (const [id, name] of myLabel) if (sharedNames.has(name)) myLabel.set(id, `${name}（我方）`);
    for (const [id, name] of enemyLabel) if (sharedNames.has(name)) enemyLabel.set(id, `${name}（敌方）`);
  }
  const labelOfMine = (spirit: Spirit) => myLabel.get(spirit.id) ?? shortName(spirit.name);
  const labelOfEnemy = (spirit: Spirit) => enemyLabel.get(spirit.id) ?? shortName(spirit.name);

  /* -------------------------------------------------- 逐格：我方一击 / 敌方一击 */
  const pairs: {
    my: Spirit;
    enemy: Spirit;
    myHit: DamageHit | null;
    enHit: DamageHit | null;
    myMult: number;
    enMult: number;
    speedEdge: number;
  }[] = [];
  for (let i = 0; i < mine.length; i += 1) {
    for (let j = 0; j < theirs.length; j += 1) {
      const cell = metrics.matrix[i][j];
      pairs.push({
        my: mine[i],
        enemy: theirs[j],
        myHit: estimateHit(mine[i], theirs[j]),
        enHit: estimateHit(theirs[j], mine[i]),
        myMult: cell.attack.multiplier,
        enMult: cell.threat.multiplier,
        speedEdge: cell.speedEdge,
      });
    }
  }

  /* -------------------------------------------------- 敌方威胁小结 */
  const threats: ThreatLine[] = theirs.map((en) => {
    const rows = mine.map((m) => {
      const hit = estimateHit(en, m);
      return {
        spirit: m,
        allyName: labelOfMine(m),
        percent: hit?.percent ?? 0,
        skillName: hit?.skill.name ?? null,
        skillType: hit?.skill.type ?? en.type[0],
        multiplier: hit?.multiplier ?? 1,
      };
    });
    const sorted = [...rows].sort((a, b) => b.percent - a.percent);
    const topRow = sorted[0];
    const kos = sorted.filter((r) => r.percent >= 50);
    const oneShots = sorted.filter((r) => r.percent >= 100).length;
    const score = Math.round(rows.reduce((sum, r) => sum + Math.min(r.percent, 100), 0) * 10) / 10;
    const hasSkill = Boolean(topRow && topRow.skillName);

    const line = hasSkill
      ? `${labelOfEnemy(en)}：最高一击打我方 ${topRow.allyName} ${pctText(topRow.percent)}（代表招「${topRow.skillName}」）；能 1–2 击带走我方 ${kos.length} 只${
          kos.length ? `（其中 1 击秒杀 ${oneShots} 只）` : ''
        }。`
      : `${labelOfEnemy(en)}：学习面里没有伤害技能，只能靠变化技能，伤害按 0 计。`;

    return {
      enemyId: en.id,
      enemyName: labelOfEnemy(en),
      enemyTypes: en.type,
      top: topRow && hasSkill
        ? {
            allyName: topRow.allyName,
            percent: topRow.percent,
            skillName: topRow.skillName,
            skillType: topRow.skillType,
            multiplier: topRow.multiplier,
          }
        : null,
      score,
      kos,
      oneShots,
      line,
    };
  });
  /* 先按「能带走我方几只」排，再按秒杀数、最高一击、总威胁分；读者一眼能对上括号里的数字 */
  threats.sort(
    (a, b) =>
      b.kos.length - a.kos.length ||
      b.oneShots - a.oneShots ||
      (b.top?.percent ?? 0) - (a.top?.percent ?? 0) ||
      b.score - a.score,
  );

  /* -------------------------------------------------- 我方王牌（对全队总威胁最高） */
  const allyRows = mine.map((m, i) => {
    const outs = theirs.map((en, j) => ({
      enemy: en,
      enemyName: labelOfEnemy(en),
      percent: pairs[i * theirs.length + j]?.myHit?.percent ?? 0,
      skillName: pairs[i * theirs.length + j]?.myHit?.skill.name ?? null,
    }));
    const ins = theirs.map((en) => Math.min(estimateHit(en, m)?.percent ?? 0, 100));
    const total = Math.round(outs.reduce((sum, o) => sum + Math.min(o.percent, 100), 0) * 10) / 10;
    const raw = Math.round(outs.reduce((sum, o) => sum + o.percent, 0) * 10) / 10;
    const income = Math.round(ins.reduce((sum, v) => sum + v, 0) * 10) / 10;
    return { spirit: m, label: labelOfMine(m), outs, total, raw, income };
  });
  const aceRow = [...allyRows].sort((a, b) => b.total - a.total || b.raw - a.raw)[0] ?? null;

  /* -------------------------------------------------- 逐只敌方的应对者 */
  const answers: AnalystAnswer[] = threats.map((threat) => {
    const en = theirs.find((e) => e.id === threat.enemyId)!;
    const candidates = mine.map((m) => {
      const out = estimateHit(m, en);
      const inc = estimateHit(en, m);
      const outPct = out?.percent ?? 0;
      const incPct = inc?.percent ?? 0;
      const speedEdge = (m.stats.spe ?? 0) - (en.stats.spe ?? 0);
      /* 先看能打多疼，再惩罚挨打，速度先手算一点优势 */
      const score = Math.min(outPct, 100) * (speedEdge > 0 ? 1.15 : 1) - Math.min(incPct, 100) * 0.6;
      return { m, out, inc, outPct, incPct, speedEdge, score };
    });
    candidates.sort((a, b) => b.score - a.score || b.outPct - a.outPct);
    const chosen = candidates[0];
    const enemyKo = threat.kos.length;

    if (!chosen) {
      return {
        enemyId: en.id,
        enemyName: threat.enemyName,
        enemyTypes: en.type,
        allyName: '—',
        allyId: '',
        percent: 0,
        skillName: null,
        skillType: en.type[0],
        incomingPercent: 0,
        incomingSkillName: null,
        incomingSkillType: null,
        koCount: enemyKo,
        line: `对 ${threat.enemyName}：我方没有可出场的精灵。`,
      };
    }

    const lowestIncoming = Math.min(...candidates.map((c) => c.incPct));
    const highestOut = Math.max(...candidates.map((c) => c.outPct));
    let skillSentence: string;
    if (chosen.out?.skill) {
      const verb =
        chosen.outPct >= 100 ? '直接 1 击带走' : chosen.outPct >= 50 ? '2 击内解决' : '要磨到 3 击以上';
      skillSentence = `它用「${chosen.out.skill.name}」反手能打 ${pctText(chosen.outPct)}，${verb}`;
    } else {
      skillSentence = '它没有能打伤对方的技能，只能顶变化技能';
    }

    let incomingSentence: string;
    if (chosen.inc) {
      const incSkill = chosen.inc.skill.name;
      const inc = pctText(chosen.incPct);
      if (chosen.incPct >= 100) {
        incomingSentence = `但它挨对方「${incSkill}」约掉 ${inc}，自己也会被一招带走，只能抢速度先手`;
      } else if (chosen.incPct >= 50) {
        incomingSentence = `同时它挨对方「${incSkill}」约掉 ${inc}，撑两下就到线`;
      } else {
        let reason = '';
        if (chosen.outPct >= 50 && chosen.incPct <= lowestIncoming + 0.05) reason = '，是我方里最扛得住的选择';
        else if (chosen.outPct >= 50 && chosen.outPct >= highestOut - 0.05) reason = '，是我方打得最痛的一只';
        else if (chosen.outPct < 50 && chosen.outPct >= highestOut - 0.05) reason = '，但这是全队最高的一项输出，只能磨血';
        else if (chosen.outPct < 50) reason = '，双方都打不疼对方，属于磨血对位';
        incomingSentence = `同时它挨对方「${incSkill}」只掉 ${inc}${reason}`;
      }
    } else {
      incomingSentence = '对方没有伤害技能，打不痛它，可以放心对位';
    }

    const head = enemyKo
      ? `对 ${threat.enemyName}：它能 1–2 击带走我方 ${enemyKo} 只，派 ${labelOfMine(chosen.m)}对位`
      : `对 ${threat.enemyName}：它目前打不动我方任何一只，派 ${labelOfMine(chosen.m)}对位`;

    return {
      enemyId: en.id,
      enemyName: threat.enemyName,
      enemyTypes: en.type,
      allyName: labelOfMine(chosen.m),
      allyId: chosen.m.id,
      percent: chosen.outPct,
      skillName: chosen.out?.skill.name ?? null,
      skillType: chosen.out?.skill.type ?? en.type[0],
      incomingPercent: chosen.incPct,
      incomingSkillName: chosen.inc?.skill.name ?? null,
      incomingSkillType: chosen.inc?.skill.type ?? null,
      koCount: enemyKo,
      line: `${head}——${skillSentence}；${incomingSentence}。`,
    };
  });

  /* -------------------------------------------------- 四项加权胜率倾向 */
  const avg = (arr: number[]) => mean(arr);
  const myType = avg(pairs.map((p) => p.myMult));
  const enemyType = avg(pairs.map((p) => p.enMult));
  const myDamage = avg(pairs.map((p) => Math.min(p.myHit?.percent ?? 0, 150)));
  const enemyDamage = avg(pairs.map((p) => Math.min(p.enHit?.percent ?? 0, 150)));
  const wins = pairs.filter((p) => p.speedEdge > 0).length;
  const losses = pairs.filter((p) => p.speedEdge < 0).length;
  const mySpeed = 1 + (pairs.length ? wins / pairs.length : 0);
  const enemySpeed = 1 + (pairs.length ? losses / pairs.length : 0);
  const myBulk = avg(mine.map(bulkOf));
  const enemyBulk = avg(theirs.map(bulkOf));

  const factors: AnalystFactor[] = [
    {
      key: 'type',
      label: '属性压制',
      percent: tiltFactor(myType, enemyType),
      side: 'even',
      detail: `我方平均打出 ×${myType.toFixed(2)}，对方平均 ×${enemyType.toFixed(2)}`,
    },
    {
      key: 'damage',
      label: '伤害效率',
      percent: tiltFactor(myDamage, enemyDamage),
      side: 'even',
      detail: `我方平均单发 ${pctText(myDamage)}，对方 ${pctText(enemyDamage)}（单只按 150% 封顶）`,
    },
    {
      key: 'speed',
      label: '速度控制',
      percent: tiltFactor(mySpeed, enemySpeed),
      side: 'even',
      detail: `对位里我方先手 ${wins} 组、对方先手 ${losses} 组（共 ${pairs.length} 组）`,
    },
    {
      key: 'bulk',
      label: '耐久总值',
      percent: tiltFactor(myBulk, enemyBulk),
      side: 'even',
      detail: `我方平均 生命+双防 ${Math.round(myBulk)}，对方 ${Math.round(enemyBulk)}`,
    },
  ].map((f) => ({ ...f, side: f.percent >= 52 ? 'mine' : f.percent <= 48 ? 'enemy' : 'even' }) as AnalystFactor);

  const weighted = factors.reduce((sum, f) => sum + f.percent * FACTOR_WEIGHT[f.key], 0);
  const ourPercent = Math.round(Math.min(100, Math.max(0, weighted)));
  const lean = ourPercent >= 54 ? '我方略占优' : ourPercent <= 46 ? '敌方略占优' : '双方在伯仲之间';
  const deciding = [...factors].sort((a, b) => b.percent - a.percent)[0];
  const weakest = [...factors].sort((a, b) => a.percent - b.percent)[0];

  const leadScore = (row: { total: number; income: number }) => row.total - 0.5 * row.income;
  const leadRow = [...allyRows].sort((a, b) => leadScore(b) - leadScore(a) || b.raw - a.raw)[0] ?? null;

  const summary: string[] = [
    `按四项加权（属性压制 35% / 伤害效率 30% / 速度控制 20% / 耐久总值 15%），我方倾向 ${ourPercent}%，${lean}。`,
    `四项得分：${factors.map((f) => `${f.label} ${f.percent}`).join('、')}（50 = 持平）。`,
    `关键胜负手是${deciding.label}（${deciding.percent}，${
      deciding.side === 'mine' ? '我方领先' : deciding.side === 'enemy' ? '对方领先' : '基本持平'
    }）；短板在${weakest.label}，${FACTOR_ADVICE[weakest.key]}。`,
  ];

  /* -------------------------------------------------- 分析师点评的四段 */
  const blocks: AnalystBlock[] = [];

  if (aceRow) {
    const aceKos = aceRow.outs.filter((o) => o.percent >= 50).sort((a, b) => b.percent - a.percent);
    const aceOneShots = aceKos.filter((o) => o.percent >= 100).length;
    const aceLines = [
      `「${aceRow.label}」是我方火力核心：对敌方全队的总威胁最高（${aceRow.total} 点，每只按最多 100% 计）。`,
      aceKos.length
        ? `它能 1–2 击带走 ${aceKos.map((o) => o.enemyName).join('、')} 共 ${aceKos.length} 只${
            aceOneShots ? `（其中 1 击秒杀 ${aceOneShots} 只）` : ''
          }。`
        : '不过敌方目前没有它能 1–2 击带走的目标，更适合中盘换入当保险。',
      aceKos.length
        ? '围绕它打集火：先兑掉它能秒的目标，别让它上来就被对面换掉。'
        : '别让它先手硬拼，等对方血量被磨下来再上。',
    ];
    blocks.push({ key: 'ace', title: '🌟 我方王牌', lines: aceLines });
  }

  const topThreat = threats[0] ?? null;
  if (topThreat) {
    const names = topThreat.kos.map((k) => k.allyName).join('、');
    const threatLines = [
      topThreat.top
        ? `敌方最危险的是「${topThreat.enemyName}」：最高一击打我方 ${topThreat.top.allyName} ${pctText(
            topThreat.top.percent,
          )}（代表招「${topThreat.top.skillName}」）。`
        : `敌方最危险的是「${topThreat.enemyName}」，但它的学习面里没有伤害技能，威胁主要来自变化技能。`,
      topThreat.kos.length
        ? `它能 1–2 击威胁我方 ${names} 共 ${topThreat.kos.length} 只${
            topThreat.oneShots ? `（其中 1 击秒杀 ${topThreat.oneShots} 只）` : ''
          }。`
        : '它目前没有能 1–2 击带走的目标，属于靠变化技能磨血的类型。',
      '它上场时优先用下面的应对者对位，别让它舒服地连续出手。',
    ];
    blocks.push({ key: 'threat', title: '⚠️ 最大威胁', lines: threatLines });
  }

  blocks.push({
    key: 'answers',
    title: '🎯 应对建议',
    lines: answers.length ? answers.map((a) => a.line) : ['我方没有可出场的精灵。'],
  });

  if (leadRow) {
    const lead = leadRow.spirit;
    const spe = lead.stats.spe ?? 0;
    const speedRank = 1 + mine.filter((m) => (m.stats.spe ?? 0) > spe).length;
    const leadKos = leadRow.outs.filter((o) => o.percent >= 50);
    const enemyFastest = theirs.reduce<Spirit | null>(
      (best, e) => (!best || (e.stats.spe ?? 0) > (best.stats.spe ?? 0) ? e : best),
      null,
    );
    const slowerThanAll = Boolean(enemyFastest && (enemyFastest.stats.spe ?? 0) > spe);
    const leadLines = [
      `首发推荐「${leadRow.label}」：速度 ${spe}（全队第 ${speedRank}），开局能 1–2 击威胁敌方 ${leadKos.length} 只${
        leadKos.length ? `（${leadKos.map((o) => o.enemyName).join('、')}）` : ''
      }。`,
      leadKos.length
        ? slowerThanAll
          ? '它抢不到先手：思路是顶住第一轮再换输出，或直接按下面的应对建议派更快的队友先手压血线。'
          : '先手压一轮血线，逼对方先交换人或交保护；对面换上克制它的，就按上面的应对建议换人。'
        : '开局没有能带走的目标，先用变化技能或低风险输出试探，等对方先暴露速度再决定换谁。',
    ];
    if (enemyFastest && (enemyFastest.stats.spe ?? 0) > spe) {
      leadLines.push(
        `注意：对方 ${labelOfEnemy(enemyFastest)} 速度 ${enemyFastest.stats.spe} 比它快，开局别硬拼先手。`,
      );
    }
    blocks.push({ key: 'lead', title: '🚀 首发建议', lines: leadLines });
  }

  const analyst: AnalystNote = { percent: ourPercent, lean, factors, summary, blocks };

  /* -------------------------------------------------- 联防与盲区（保留原有结论） */
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

  const gaps = answers.filter((a) => a.percent < 100);
  if (gaps.length) {
    guardLines.push(
      `打不满血的：${gaps
        .slice(0, 4)
        .map((g) => `${g.enemyName}（我方最高只估算 ${pctText(g.percent)}）`)
        .join('、')}，这些目标要靠磨血或变化技能处理。`,
    );
  } else if (answers.length) {
    guardLines.push('打击面没有盲区：敌方每只我方都有人能估算到 100% 以上（一招带走）。');
  }

  if (metrics.speed.enemyFastest && metrics.speed.myFastest) {
    const mineTop = mine.reduce((x, y) => ((y.stats.spe ?? 0) > (x.stats.spe ?? 0) ? y : x));
    const enemyTop = theirs.reduce((x, y) => ((y.stats.spe ?? 0) > (x.stats.spe ?? 0) ? y : x));
    const fasterCount = theirs.filter((e) => (e.stats.spe ?? 0) > (mineTop.stats.spe ?? 0)).length;
    guardLines.push(
      `速度：我方最快 ${labelOfMine(mineTop)} ${metrics.speed.myFastest.spe}，对方最快 ${labelOfEnemy(enemyTop)} ${
        metrics.speed.enemyFastest.spe
      }${fasterCount ? `；对方有 ${fasterCount} 只快过我方最快的那只` : '；我方最快的那只比对方全员都快'}。`,
    );
  }

  if (metrics.sharedResist.length) {
    guardLines.push(
      `可以联防：${metrics.sharedResist
        .slice(0, 4)
        .map((r) => `${r.type}系被我方 ${r.count} 只抵抗`)
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
    if (leadRow) bits.push(`首发 ${leadRow.label}`);
    const good = answers.filter((a) => a.percent >= 100).length;
    bits.push(`${good}/${theirs.length} 只可一招带走`);
    if (gaps.length) bits.push(`${gaps.length} 只打不到 100%`);
    return `${bits.join(' · ')}。`;
  })();

  return {
    headline,
    sections: [{ title: '联防与盲区预警', lines: guardLines }],
    footnote: DAMAGE_NOTE,
    threats,
    answers,
    analyst,
    estimateNote: DAMAGE_DISCLAIMER,
  };
}
