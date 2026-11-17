/**
 * Phase 5 全量校验：伤害估算 + 分析师点评。
 *
 *   npx esbuild scripts/verify-tactics.ts --bundle --platform=node --format=esm --outfile=.cache/verify-tactics.mjs
 *   node .cache/verify-tactics.mjs
 *
 * 1) 662 只形态两两对位（438,244 组）全部跑一遍估算：数字有限、技能来自攻击方自己的学习面；
 * 2) 662 只形态的单只解读重跑一遍，确认没有 NaN / undefined；
 * 3) 300 组随机阵容（1v1 到 6v6，每次随机 1–6 只）跑完整 teamBrief，检查文案、排序、应对者归属。
 */
import { teamMetrics } from '../src/lib/analysis';
import { estimateHit } from '../src/lib/damage';
import { skillsOf, spirits } from '../src/lib/spirits';
import { spiritBrief, teamBrief } from '../src/lib/tactics';
import type { Spirit } from '../src/lib/types';

const problems: string[] = [];
const badText = /undefined|NaN|Infinity|\[object Object\]|%%/;

function checkText(label: string, text: string) {
  const bad = badText.exec(text);
  if (bad) problems.push(`${label}: contains "${bad[0]}" → ${text.slice(Math.max(0, bad.index - 40), bad.index + 40)}`);
}

/* ------------------------------------------------------------ 1) 全量对位 */
const learnCache = new Map<string, Set<string>>();
function learnsetOf(s: Spirit): Set<string> {
  let set = learnCache.get(s.id);
  if (!set) {
    set = new Set(skillsOf(s).map((sk) => sk.id));
    learnCache.set(s.id, set);
  }
  return set;
}

let pairCount = 0;
for (const attacker of spirits) {
  const own = learnsetOf(attacker);
  for (const defender of spirits) {
    pairCount += 1;
    const hit = estimateHit(attacker, defender);
    if (!hit) {
      // 学习面里一个伤害技能都没有的形态允许返回 null，但必须是真的没有
      const dmg = skillsOf(attacker).filter((s) => typeof s.power === 'number' && s.power > 0 && s.type);
      if (dmg.length) problems.push(`${attacker.name} → ${defender.name}: estimateHit null but ${dmg.length} damaging skills`);
      continue;
    }
    if (!Number.isFinite(hit.percent) || hit.percent < 0) problems.push(`${attacker.name} → ${defender.name}: percent ${hit.percent}`);
    if (!own.has(hit.skill.id)) problems.push(`${attacker.name} → ${defender.name}: skill ${hit.skill.name} not in own learnset`);
    if (!(hit.multiplier > 0)) problems.push(`${attacker.name} → ${defender.name}: multiplier ${hit.multiplier}`);
    if (!hit.defenceStat || !hit.hpStat) problems.push(`${attacker.name} → ${defender.name}: zero defence/hp`);
  }
}

/* ------------------------------------------------------------ 2) 单只解读 */
for (const spirit of spirits) {
  const brief = spiritBrief(spirit);
  for (const line of [brief.headline, brief.footnote, ...brief.sections.flatMap((s) => s.lines)]) {
    checkText(`spiritBrief/${spirit.name}`, line);
  }
}

/* ------------------------------------------------------------ 3) 随机阵容 */
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a += 0x6d2b79f5;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(20261118);
const int = (lo: number, hi: number) => lo + Math.floor(rand() * (hi - lo + 1));

function pickTeam(size: number): Spirit[] {
  const picked: Spirit[] = [];
  const used = new Set<string>();
  let guard = 0;
  while (picked.length < size && guard < 500) {
    guard += 1;
    const s = spirits[int(0, spirits.length - 1)];
    if (used.has(s.id)) continue;
    used.add(s.id);
    picked.push(s);
  }
  return picked;
}

const sizePairs = new Set<string>();
let runs = 0;
for (let i = 0; i < 300; i += 1) {
  // 前 36 组覆盖 1v1–6v6 的每一种组合，后面完全随机
  const mySize = i < 36 ? (Math.floor(i / 6) % 6) + 1 : int(1, 6);
  const enSize = i < 36 ? (i % 6) + 1 : int(1, 6);
  const mine = pickTeam(mySize);
  const theirs = pickTeam(enSize);
  sizePairs.add(`${mine.length}v${theirs.length}`);
  runs += 1;

  let brief;
  try {
    const metrics = teamMetrics(mine, theirs);
    brief = teamBrief(mine, theirs, metrics);
  } catch (err) {
    problems.push(`run#${i} ${mine.length}v${theirs.length}: threw ${(err as Error).message}`);
    continue;
  }

  const label = `run#${i} ${mine.length}v${theirs.length}`;
  if (!brief.threats.length) problems.push(`${label}: no threats`);
  if (brief.threats.length !== theirs.length) problems.push(`${label}: ${brief.threats.length} threats for ${theirs.length} enemies`);
  if (brief.answers.length !== theirs.length) problems.push(`${label}: ${brief.answers.length} answers for ${theirs.length} enemies`);

  // 威胁从高到低：带走只数 → 秒杀数 → 最高一击 → 总威胁分
  const rank = (t: typeof brief.threats[number]) => [t.kos.length, t.oneShots, t.top?.percent ?? 0, t.score];
  for (let j = 1; j < brief.threats.length; j += 1) {
    const a = rank(brief.threats[j - 1]);
    const b = rank(brief.threats[j]);
    let ok = false;
    for (let k = 0; k < a.length; k += 1) {
      if (a[k] === b[k]) continue;
      ok = a[k] > b[k];
      break;
    }
    if (!ok && a.join('|') !== b.join('|')) problems.push(`${label}: threats not sorted at ${j} (${a.join('/')} vs ${b.join('/')})`);
  }

  const mineIds = new Set(mine.map((s) => s.id));
  const theirsByLabel = new Map(brief.threats.map((t) => [t.enemyId, theirs.find((e) => e.id === t.enemyId)!]));

  for (const threat of brief.threats) {
    const en = theirsByLabel.get(threat.enemyId);
    if (!en) {
      problems.push(`${label}: threat ${threat.enemyName} not in enemy team`);
      continue;
    }
    if (threat.kos.length > mine.length) problems.push(`${label}: ${threat.enemyName} kos ${threat.kos.length} > ${mine.length}`);
    if (threat.oneShots > threat.kos.length) problems.push(`${label}: ${threat.enemyName} oneShots > kos`);
    if (threat.top) {
      const maxPct = Math.max(...mine.map((m) => estimateHit(en, m)?.percent ?? 0));
      if (!Number.isFinite(threat.top.percent) || threat.top.percent < 0) problems.push(`${label}: bad top percent`);
      if (threat.top.percent > maxPct + 0.001) problems.push(`${label}: top percent ${threat.top.percent} exceeds max ${maxPct}`);
      if (Math.abs(threat.top.percent - maxPct) > 0.11) problems.push(`${label}: top percent not the max`);
    }
    checkText(`${label}/threat`, threat.line);
  }

  for (const ans of brief.answers) {
    if (!mineIds.has(ans.allyId)) problems.push(`${label}: answer ally ${ans.allyName} not in my team`);
    if (!Number.isFinite(ans.percent) || ans.percent < 0) problems.push(`${label}: bad answer percent`);
    checkText(`${label}/answer`, ans.line);
    const ally = mine.find((m) => m.id === ans.allyId);
    const en = theirs.find((e) => e.id === ans.enemyId);
    if (ally && en) {
      const real = estimateHit(ally, en);
      if (real && Math.abs(real.percent - ans.percent) > 0.11) problems.push(`${label}: answer percent mismatch`);
      if (ans.skillName && real && ans.skillName !== real.skill.name) problems.push(`${label}: answer skill mismatch`);
      const back = estimateHit(en, ally);
      if (back && Math.abs(back.percent - ans.incomingPercent) > 0.11) problems.push(`${label}: incoming percent mismatch`);
      if (back && ans.incomingSkillName && ans.incomingSkillName !== back.skill.name) problems.push(`${label}: incoming skill mismatch`);
    }
  }

  const { analyst } = brief;
  if (!Number.isFinite(analyst.percent) || analyst.percent < 0 || analyst.percent > 100) {
    problems.push(`${label}: analyst percent ${analyst.percent}`);
  }
  if (analyst.factors.length !== 4) problems.push(`${label}: ${analyst.factors.length} factors`);
  for (const f of analyst.factors) {
    if (!Number.isFinite(f.percent) || f.percent < 0 || f.percent > 100) problems.push(`${label}: factor ${f.label} ${f.percent}`);
    checkText(`${label}/factor`, f.detail);
  }
  if (analyst.summary.length < 3) problems.push(`${label}: summary too short`);
  for (const line of analyst.summary) checkText(`${label}/summary`, line);
  for (const key of ['ace', 'threat', 'answers', 'lead'] as const) {
    if (!analyst.blocks.some((b) => b.key === key)) problems.push(`${label}: missing block ${key}`);
  }
  for (const block of analyst.blocks) {
    if (!block.lines.length) problems.push(`${label}: empty block ${block.key}`);
    for (const line of block.lines) {
      checkText(`${label}/${block.key}`, line);
      if (line.trim().length < 6) problems.push(`${label}/${block.key}: line too short "${line}"`);
    }
  }
  for (const line of brief.sections.flatMap((s) => s.lines)) checkText(`${label}/guard`, line);
  checkText(`${label}/headline`, brief.headline);
  checkText(`${label}/footnote`, brief.footnote);
  checkText(`${label}/estimateNote`, brief.estimateNote);

  const json = JSON.stringify(brief);
  if (/undefined|NaN|Infinity/.test(json)) problems.push(`${label}: serialized brief has undefined/NaN`);
  if (json.length < 800) problems.push(`${label}: suspiciously small brief (${json.length})`);
}

/* ------------------------------------------------------------ 结果 */
console.log(`pair checks: ${pairCount} (${spirits.length} spirits × ${spirits.length})`);
console.log(`spirit briefs: ${spirits.length}`);
console.log(`team briefs: ${runs}`);
console.log(`team sizes covered: ${[...sizePairs].sort().join(', ')}`);
if (problems.length) {
  console.log(`\n✗ ${problems.length} problem(s):`);
  for (const p of problems.slice(0, 40)) console.log(' -', p);
  process.exit(1);
}
console.log('\n✓ 0 problems：伤害估算、威胁排序、应对者归属、四段点评全部通过');
