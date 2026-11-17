/**
 * 把服务器端核验过的数据拼成「事实」文本，再包成模型消息。
 * 模型只能看这些事实，回答里的数字会再做一次溯源校验。
 */
import { STAT_KEYS, STAT_LABEL, TYPE_ORDER, matchup, multiplierText, skills, skillsOf, spiritById, spirits } from './data.mjs';
import { bestHit, spiritMetrics, teamMetrics, duelMetrics } from './analysis.mjs';

const pct = (n) => `${Math.round(n * 10) / 10}%`;
const int = (n) => (typeof n === 'number' ? String(n) : '—');

function statLine(spirit) {
  return STAT_KEYS.map((k) => `${STAT_LABEL[k]}${int(spirit.stats[k])}`).join('、');
}

function topSkills(spirit, n = 6) {
  const dmg = skillsOf(spirit).filter((s) => typeof s.power === 'number' && s.power > 0 && s.type);
  const byType = new Map();
  for (const sk of dmg) {
    const cur = byType.get(sk.type);
    if (!cur || (sk.power ?? 0) > (cur.power ?? 0)) byType.set(sk.type, sk);
  }
  return [...byType.values()]
    .sort((a, b) => (b.power ?? 0) - (a.power ?? 0))
    .slice(0, n)
    .map((sk) => `${sk.name}（${sk.type}·${sk.category}·威力${sk.power}${sk.energy ? `·能耗${sk.energy}` : ''}）`)
    .join('、');
}

function weakLine(spirit, limit = 5) {
  const m = spiritMetrics(spirit);
  const weak = m.weak.slice(0, limit).map((w) => `${w.type}${multiplierText(w.multiplier)}`).join('、') || '无';
  const resist = m.resist.slice(0, limit).map((r) => `${r.type}${multiplierText(r.multiplier)}`).join('、') || '无';
  return `弱于 ${weak}；抵抗 ${resist}`;
}

function spiritBlock(spirit, index, enemies, compact = false) {
  const m = spiritMetrics(spirit);
  const lines = [];
  lines.push(
    `${index + 1}) ${spirit.name}｜${spirit.type.join('/')}系｜No.${spirit.dex}${spirit.formLabel ? `·${spirit.formLabel}` : ''}｜总种族值${int(spirit.stats.total)}（全图鉴第${m.total.rank}/${m.total.population}，百分位${pct(m.total.percentile)}，评级${m.total.tier}）`,
  );
  lines.push(`   六项：${statLine(spirit)}`);
  if (!compact) {
    lines.push(
      `   单项百分位：${STAT_KEYS.map((k) => `${STAT_LABEL[k]}${pct(m.stats[k]?.percentile ?? 0)}`).join('、')}`,
    );
  }
  lines.push(`   特性「${spirit.trait?.name ?? '数据未提供'}」：${spirit.trait?.effect || '数据未提供'}`);
  lines.push(`   ${weakLine(spirit, compact ? 3 : 5)}`);
  lines.push(
    `   进攻覆盖：${m.offence.typesWithDamagingSkill}种属性有输出技能，其中${m.offence.strongCount}种能打出≥2倍；对${m.offence.noAnswer.length}种属性打不出>1倍`,
  );
  lines.push(`   代表输出技能：${topSkills(spirit, compact ? 4 : 6)}`);
  if (!compact) {
    const dmg = skillsOf(spirit).filter((s) => typeof s.power === 'number' && s.power > 0 && s.type);
    const bestPerType = new Map();
    for (const sk of dmg) {
      const cur = bestPerType.get(sk.type);
      if (!cur || (sk.power ?? 0) > (cur.power ?? 0)) bestPerType.set(sk.type, sk);
    }
    const coverage = [...bestPerType.values()]
      .sort((a, b) => (b.power ?? 0) - (a.power ?? 0))
      .slice(0, 5)
      .map((sk) => {
        const strong = TYPE_ORDER.filter((t) => matchup(sk.type, [t]) >= 2).slice(0, 4);
        const weak = TYPE_ORDER.filter((t) => matchup(sk.type, [t]) < 1).slice(0, 2);
        return `${sk.name}（${sk.type}·威力${sk.power}）：克制${strong.length ? strong.map((t) => `${t}${multiplierText(matchup(sk.type, [t]))}`).join('、') : '无'}${weak.length ? `；被${weak.join('、')}抵抗` : ''}`;
      });
    lines.push(`   技能克制面：${coverage.join('；')}`);
  }
  if (enemies?.length) {
    const vs = enemies
      .map((e) => {
        const h = bestHit(spirit, e.type);
        return `${e.name}${multiplierText(h.multiplier)}${h.skill ? `（${h.skill.name}）` : ''}`;
      })
      .join('、');
    lines.push(`   对敌方最高倍率：${vs}`);
  }
  return lines.join('\n');
}

function teamBlock(title, list) {
  return [`${title}（${list.length}只）：`, ...list.map((s, i) => spiritBlock(s, i, null, true))].join('\n');
}

function matrixLines(mine, theirs, metrics) {
  const lines = [];
  for (let i = 0; i < mine.length; i += 1) {
    for (let j = 0; j < theirs.length; j += 1) {
      const c = metrics.matrix[i][j];
      const atk = c.attack.skill ? `${c.attack.skill.name}${multiplierText(c.attack.multiplier)}` : multiplierText(c.attack.multiplier);
      const thr = c.threat.skill ? `${c.threat.skill.name}${multiplierText(c.threat.multiplier)}` : multiplierText(c.threat.multiplier);
      const spd = c.speedEdge > 0 ? `我方快${c.speedEdge}` : c.speedEdge < 0 ? `敌方快${-c.speedEdge}` : '同速';
      lines.push(`- ${c.myName} → ${c.enemyName}：我方打${atk}，被反打${thr}，${spd}`);
    }
  }
  return lines.join('\n');
}

export function buildFacts(mode, ctx) {
  const header = `【已核验事实】数据来源：BWIKI 图鉴（服务器端从 ${spiritById.size} 条形态记录中解析，共 ${TYPE_ORDER.length} 种属性）。以下所有数值为图鉴原值或由原值直接计算，除此之外没有任何数据。
属性名称固定为：${TYPE_ORDER.join('、')}（写作“幽系”，不是“幽灵系”；不要使用这 ${TYPE_ORDER.length} 个之外的属性名）。`;

  if (mode === 'spirit') {
    const s = ctx.spirit;
    const m = spiritMetrics(s);
    return [
      header,
      `任务：分析单只精灵「${s.name}」的强度、定位与配招。`,
      spiritBlock(s, 0),
      `   可学技能${m.skills.total}个（升级${m.skills.byLearn.level}/技能石${m.skills.byLearn.stone}/血脉${m.skills.byLearn.blood}；物理${m.skills.byCategory.物理}/魔法${m.skills.byCategory.魔法}/变化${m.skills.byCategory.变化}）`,
      `   高威力技能：${m.skills.topPower.slice(0, 6).map((k) => `${k.name}（${k.type}·威力${k.power}${k.energy ? `·能耗${k.energy}` : ''}）`).join('、')}`,
      `   能耗效率最高的输出：${m.skills.efficient.slice(0, 4).map((k) => `${k.name}（威力${k.power}/能耗${k.energy}，效率${k.ratio}）`).join('、')}`,
      `   确定性定位标签：${m.roles.join('、')}`,
      `   介绍：${s.desc}`,
    ].join('\n');
  }

  const mine = ctx.myTeam;
  const theirs = ctx.enemyTeam;
  const metrics = teamMetrics(mine, theirs);

  const lines = [header, `任务：分析双方阵容（我方${mine.length}只，敌方${theirs.length}只），给出阵容互补、首发与换人策略。`];
  if (mine.length) lines.push(teamBlock('我方阵容', mine));
  if (mine.length && theirs.length) {
    lines.push(
      '我方每只对敌方的最高倍率：\n' +
        mine
          .map(
            (m) =>
              `- ${m.name}：${theirs
                .map((e) => {
                  const h = bestHit(m, e.type);
                  return `${e.name}${multiplierText(h.multiplier)}${h.skill ? `（${h.skill.name}）` : ''}`;
                })
                .join('、')}`,
          )
          .join('\n'),
    );
  }
  if (theirs.length) lines.push(teamBlock('敌方阵容', theirs));

  lines.push('【确定性对位表】');
  if (mine.length && theirs.length) lines.push(matrixLines(mine, theirs, metrics));

  if (metrics.sharedWeak.length) {
    lines.push(
      '【我方共同弱点】' +
        metrics.sharedWeak
          .slice(0, 6)
          .map((w) => `${w.type}系可克制我方${w.count}只（${w.members.join('、')}，最高${multiplierText(w.maxMultiplier)}）`)
          .join('；'),
    );
  } else {
    lines.push('【我方共同弱点】没有同一属性可同时克制我方2只以上。');
  }
  if (metrics.sharedResist.length) {
    lines.push(
      '【我方共同抵抗】' +
        metrics.sharedResist
          .slice(0, 6)
          .map((r) => `${r.type}系被我方${r.count}只抵抗（${r.members.join('、')}）`)
          .join('；'),
    );
  }
  if (metrics.coverageGaps.length) {
    lines.push(
      '【打击盲区】' +
        metrics.coverageGaps
          .map((g) => `${g.enemy}（${g.enemyTypes.join('/')}）我方最高只有${multiplierText(g.bestMultiplier)}${g.bestBy ? `（${g.bestBy}）` : ''}`)
          .join('；'),
    );
  } else if (mine.length && theirs.length) {
    lines.push('【打击盲区】无（我方对敌方每一只都至少有一个≥2倍的答案）。');
  }
  if (metrics.speed.myFastest && metrics.speed.enemyFastest) {
    lines.push(
      `【速度】我方最快${metrics.speed.myFastest.name}速度${int(metrics.speed.myFastest.spe)}，敌方最快${metrics.speed.enemyFastest.name}速度${int(metrics.speed.enemyFastest.spe)}；我方有${metrics.speed.myLeadCount}只快过敌方最快，${metrics.speed.myFasterCount}只快过敌方所有成员。`,
    );
  }
  lines.push(
    `【种族值】我方平均${metrics.totals.myAvg}，敌方平均${metrics.totals.enemyAvg}，差值${metrics.totals.diff > 0 ? '+' : ''}${metrics.totals.diff}。`,
  );
  if (metrics.lead) {
    lines.push(
      `【首发打分】${metrics.ranked
        .slice(0, 4)
        .map((r) => `${r.name}（对敌平均进攻${r.attack}，平均受威胁${r.threat}，速度平均差${r.speedEdge > 0 ? '+' : ''}${r.speedEdge}，综合${r.score}）`)
        .join('；')}`,
    );
  }
  if (mine.length === 1 && theirs.length === 1) {
    lines.push('【单打对位】' + duelMetrics(mine[0], theirs[0]).text);
  }

  return lines.join('\n');
}

export const SYSTEM_PROMPT = `你是《洛克王国：世界》的对战分析教练，只做数据解读。
硬性规则（必须遵守）：
1. 只使用用户消息【已核验事实】里的数据。不得编造、推测或补全事实中没有的精灵、种族值、技能、特性、属性倍率、等级、赛季、蛋组或游戏机制。
2. 引用数字时只能原样使用事实中出现过的数字；事实没有给出的，直接写“数据未提供”，不要估算。
3. 属性倍率只引用事实里列出的倍数，不要自己计算新的倍率组合；同属性不等于克制，克制关系只看事实列出的倍率。
4. 不要写“作为 AI”“仅供参考”之类的套话，不要提免责声明，不要编造版本或赛季信息。
5. 用简体中文，短句、可执行，避免空话。总字数控制在 320 字以内。
6. 只能讨论【我方阵容】和【敌方阵容】里出现的精灵；建议换人时只能换上我方阵容里的精灵，绝不能建议换上敌方或未列出的精灵。
7. 特性名、技能名必须原样使用事实中出现的名字，不得自创或改写。
8. 引用特性或技能效果时按事实原文，不要改写其中的数值、对象或触发条件；不要声称某技能克制事实未列出的属性。`;

export function outputFormat(mode) {
  if (mode === 'spirit') {
    return `请严格按以下标题输出，每个标题下 2-4 条短句（每条不超过 40 字）：
【结论】一句话总评（含评级与关键数字）
【定位】它适合做什么、不适合做什么
【配招】推荐 3-4 个技能并说明理由（只用事实中出现的技能名）
【使用要点】上场时机、先手/后手、能量节奏
【风险】最怕什么、数据缺口`;
  }
  return `请严格按以下标题输出，每个标题下 2-4 条短句（每条不超过 40 字）：
【结论】一句话判断双方阵容强弱与关键倍率
【阵容互补】我方阵容的联防与互补，指出共同弱点怎么补
【首发与换人】建议首发、遇到谁换谁，结合速度与对位倍率
【风险】最需要注意的威胁与打击盲区`;
}

export function buildMessages(mode, ctx) {
  const facts = buildFacts(mode, ctx);
  const user = `${facts}\n\n【输出格式】\n${outputFormat(mode)}`;
  return {
    facts,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: user },
    ],
  };
}

/* ------------------------------------------------------------ 输出校验 */

const normNum = (raw) => {
  const n = Number(raw);
  if (!Number.isFinite(n)) return raw;
  return String(Math.round(n * 1000) / 1000);
};

/** 事实里出现过的所有数字 + 常见小整数，作为可引用白名单。 */
export function allowedNumbers(facts) {
  const set = new Set();
  for (const m of facts.matchAll(/\d+(?:\.\d+)?/g)) set.add(normNum(m[0]));
  for (let i = 0; i <= 18; i += 1) set.add(String(i));
  set.add('100');
  return set;
}

const TYPE_PREFIX_SKIP = new Set(['双', '单', '本', '同', '全', '各', '多', '无', '副', '主', '这', '该', '属', '一', '两']);

/* ------------------------------------------------------------ 名称白名单 */

const KNOWN_TRAITS = new Set(spirits.map((s) => s.trait?.name).filter(Boolean));
const KNOWN_SKILLS = new Set(skills.map((s) => s.name));
const KNOWN_SPIRITS = new Set(spirits.map((s) => s.name));
const ROLE_LABELS = new Set(['高速输出', '重炮输出', '稳定输出', '耐久坦克', '能抗能打', '先手压制', '功能辅助', '均衡替补']);
const SECTION_WORDS = new Set([
  '结论',
  '定位',
  '配招',
  '使用要点',
  '风险',
  '阵容互补',
  '首发与换人',
  '分析',
  '说明',
]);
const GENERIC_TRAIT = new Set(['精灵', '宠物', '隐藏', '专属', '自身', '对方', '敌方', '我方', '这个', '那个', '其', '该', '本']);

/**
 * 校验模型回答：数字、属性名、特性名/技能名是否都能在事实里找到，
 * 以及是否建议换上不在我方阵容里的精灵。问题只作为提示，不篡改原文。
 */
export function checkGrounding(text, facts, ctxNames = {}) {
  const allowed = allowedNumbers(facts);
  const numbers = [...new Set(text.match(/\d+(?:\.\d+)?/g) ?? [])];
  const unverified = numbers.filter((n) => !allowed.has(normNum(n)));

  const typeIssues = [];
  const knownType = new Set(TYPE_ORDER);
  for (const m of text.matchAll(/([\u4e00-\u9fa5]{1,2})系/g)) {
    const t = m[1];
    if (TYPE_PREFIX_SKIP.has(t) || knownType.has(t)) continue;
    // 正则可能把前面的动词/助词一起吃进来（“克制水系”），末字是真实属性就放过
    if (knownType.has(t.slice(-1)) || knownType.has(t.slice(-2))) continue;
    if (!typeIssues.includes(t)) typeIssues.push(t);
  }

  // 特性名：句子里“XX特性”的 XX 必须是一只真实精灵的特性名
  const unknownTerms = [];
  const addTerm = (term, kind) => {
    const t = term.trim();
    if (!t || t.length > 8) return;
    if (KNOWN_TRAITS.has(t) || KNOWN_SKILLS.has(t) || KNOWN_SPIRITS.has(t)) return;
    if (ROLE_LABELS.has(t) || SECTION_WORDS.has(t) || GENERIC_TRAIT.has(t)) return;
    if (!unknownTerms.some((x) => x.term === t)) unknownTerms.push({ term: t, kind });
  };
  const plain = text.replace(/[「」『』“”"'《》]/g, '');
  const isKnownTerm = (cand) => {
    if (KNOWN_TRAITS.has(cand) || KNOWN_SPIRITS.has(cand) || KNOWN_SKILLS.has(cand)) return true;
    // “威胁是雪影娃娃的特性”：定语里出现了精灵名，属于泛指，不算编造
    for (let len = 2; len <= Math.min(6, cand.length); len += 1) {
      const tail = cand.slice(-len);
      if (KNOWN_TRAITS.has(tail) || KNOWN_SPIRITS.has(tail) || KNOWN_SKILLS.has(tail)) return true;
    }
    return false;
  };
  for (const m of plain.matchAll(/的([\u4e00-\u9fa5]{2,6})特性/g)) {
    const cand = m[1];
    if (isKnownTerm(cand)) continue;
    addTerm(cand, '特性');
  }
  // 引号里紧跟在“特性/技能”后的名字
  for (const m of text.matchAll(/(?:特性|技能)[「『“]([^」』”]{1,14})[」』”]/g)) {
    addTerm(m[1], '名称');
  }
  // “捉迷藏”特性：引号在关键词前面
  for (const m of text.matchAll(/[「『“]([^」』”]{1,14})[」』”]\s*(?:特性|技能)/g)) {
    addTerm(m[1], '名称');
  }

  // 换人建议里出现了不在我方阵容的精灵
  const mine = new Set(ctxNames.mine ?? []);
  const outOfTeam = [];
  if (mine.size) {
    const swapRe = [/换(?:上|成|为|下)?\s*([\u4e00-\u9fa5]{2,10})/g, /换[^，。；]{0,8}?为\s*([\u4e00-\u9fa5]{2,10})/g];
    for (const re of swapRe) {
      for (const m of text.matchAll(re)) {
        const t = m[1].replace(/[，。、；：！？,.;:].*$/, '');
        let hit = null;
        for (let len = Math.min(t.length, 8); len >= 2; len -= 1) {
          if (KNOWN_SPIRITS.has(t.slice(0, len))) {
            hit = t.slice(0, len);
            break;
          }
        }
        if (hit && !mine.has(hit) && !outOfTeam.includes(hit)) outOfTeam.push(hit);
      }
    }
  }

  return {
    grounded: unverified.length === 0 && typeIssues.length === 0 && unknownTerms.length === 0 && outOfTeam.length === 0,
    numbersChecked: numbers.length,
    unverifiedNumbers: unverified,
    typeIssues,
    unknownTerms,
    outOfTeam,
  };
}
