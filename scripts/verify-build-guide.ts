/**
 * 全量校验：665 只形态 × 2 个流派都跑一遍培养方案引擎，确认没有运行时错误、
 * undefined / NaN，技能全部来自该精灵自己的学习面，性格/个体值/血脉都有真数据。
 *
 * 新增（反克制门禁）：
 *   1) 每一格都必须有非空的中文 reason；
 *   2) 凡是精灵有防御弱点（克制表 ≥2 倍）、且合法可学池（升级 / 技能石 / 任意血脉）
 *      里存在能 ×2 反制的攻击招的，最终 4 格必须至少包含 1 个反克制招；
 *   3) slots 里的血脉技与 guide.bloodline.main 完全一致，且血脉技数量 ≤ 1。
 *
 *   npx esbuild scripts/verify-build-guide.ts --bundle --platform=node --format=esm --outfile=.cache/verify-build-guide.mjs
 *   node .cache/verify-build-guide.mjs
 */
import { buildGuide, bloodlineTable, natureTable, natures } from '../src/lib/build-guide';
import { skillById, skillsOf, spirits } from '../src/lib/spirits';
import { matchup, TYPE_ORDER } from '../src/lib/typeChart';
import type { PresetKey } from '../src/lib/build-guide';
import type { Skill } from '../src/lib/types';

const PRESETS: PresetKey[] = ['burst', 'bulk'];
const problems: string[] = [];
let runs = 0;

const isDamaging = (sk: Skill) => typeof sk.power === 'number' && sk.power > 0 && Boolean(sk.type);
/** 这招能不能 ×2 打穿弱点属性 w */
const hits = (sk: Skill, w: string) => isDamaging(sk) && matchup(sk.type, [w]).multiplier >= 2;

function checkText(label: string, text: string, seen: Set<string>) {
  const key = `${label}`;
  if (seen.has(key)) return;
  seen.add(key);
  const bad = /undefined|NaN|Infinity|\[object Object\]/.exec(text);
  if (bad) problems.push(`${label}: contains "${bad[0]}" → ${text.slice(Math.max(0, bad.index - 40), bad.index + 40)}`);
}

/* 统计口径 */
const stats = {
  runs: 0,
  withWeakness: 0,
  withoutWeakness: 0,
  counterAvailable: 0,
  counterOnlyByBlood: 0,
  counterInSlots: 0,
  counterSlotIsSecond: 0,
  counterFromBlood: 0,
  noCounterAnywhere: 0,
  bloodEquipped: 0,
  bloodNotEquipped: 0,
};

for (const spirit of spirits) {
  const learnable = new Set(skillsOf(spirit).map((s) => s.id));
  /* 改血脉后能拿到的技能（19 个别系血脉 + 普通），与学习面一起构成合法的能力范围 */
  const setName = bloodlineTable.learnset[spirit.learnset ?? ''] ?? '';
  const grantable = new Set(Object.values(bloodlineTable.sets[setName] ?? {}));
  /* 全合法池（含 19 个血脉候选）里所有可用的攻击招 */
  const legalDamaging: Skill[] = [];
  for (const id of [...learnable, ...grantable]) {
    const sk = skillById(id);
    if (sk && isDamaging(sk) && !legalDamaging.some((x) => x.id === sk.id)) legalDamaging.push(sk);
  }
  const regularDamaging = [...learnable]
    .map((id) => skillById(id))
    .filter((sk): sk is Skill => Boolean(sk) && isDamaging(sk!));

  const weakTypes = TYPE_ORDER.filter((atk) => matchup(atk, spirit.type).multiplier >= 2);
  const counterPool = weakTypes.length ? legalDamaging.filter((sk) => weakTypes.some((w) => hits(sk, w))) : [];
  const regularCounterPool = weakTypes.length ? regularDamaging.filter((sk) => weakTypes.some((w) => hits(sk, w))) : [];

  for (const preset of PRESETS) {
    runs += 1;
    stats.runs += 1;
    let guide;
    try {
      guide = buildGuide(spirit, preset);
    } catch (err) {
      problems.push(`${spirit.name}/${preset}: threw ${(err as Error).message}`);
      continue;
    }
    const seen = new Set<string>();
    /* 宁缺毋滥：血脉技能 ≤1，合法技能不够时允许少于 4 格 */
    if (guide.slots.length < 1 || guide.slots.length > 4) {
      problems.push(`${spirit.name}/${preset}: ${guide.slots.length} slots`);
    }
    const ids = new Set(guide.slots.map((s) => s.skill.id));
    if (ids.size !== guide.slots.length) problems.push(`${spirit.name}/${preset}: duplicate skills`);
    for (const slot of guide.slots) {
      const legal = learnable.has(slot.skill.id) || (slot.skill.learn === 2 && grantable.has(slot.skill.id));
      if (!legal) problems.push(`${spirit.name}: ${slot.skill.name} not in its own learnset`);
      if (!['升级', '技能石', '血脉'].includes(slot.source)) problems.push(`${spirit.name}: bad source ${slot.source}`);
      if (!slot.skill.name || !slot.skill.type) problems.push(`${spirit.name}: skill without name/type`);
      /* 门禁 1：每一格都要有具体说明 */
      if (!slot.reason || slot.reason.trim().length < 8) {
        problems.push(`${spirit.name}/${preset}/${slot.slot}: 说明为空或过短 → 「${slot.reason}」`);
      }
      checkText(`${spirit.name}/${preset}/${slot.slot}`, `${slot.reason} ${slot.skill.effect}`, seen);
    }
    for (const n of [guide.nature.main, guide.nature.alt]) {
      if (!natures.some((x) => x.id === n.nature.id)) problems.push(`${spirit.name}: nature not in table`);
      if (!n.line.includes('+10%') || !n.line.includes('-10%')) problems.push(`${spirit.name}: nature line ${n.line}`);
      checkText(`${spirit.name}/${preset}/nature`, n.reason, seen);
    }
    if (guide.ivs.length !== 3) problems.push(`${spirit.name}/${preset}: ${guide.ivs.length} ivs`);
    if (new Set(guide.ivs.map((i) => i.key)).size !== guide.ivs.length) problems.push(`${spirit.name}: duplicate ivs`);

    /* 门禁 2：有弱点 + 合法池里有 ×2 反克招 → 四格里必须有至少一个 */
    if (!weakTypes.length) {
      stats.withoutWeakness += 1;
      if (guide.counter.hasWeakness) problems.push(`${spirit.name}/${preset}: 无弱点却标了 hasWeakness`);
    } else {
      stats.withWeakness += 1;
      if (!guide.counter.hasWeakness) problems.push(`${spirit.name}/${preset}: 有弱点 ${weakTypes.join('、')} 却标了无弱点`);
    }
    const slotCounters = guide.slots.filter((s) => weakTypes.some((w) => hits(s.skill, w)));
    if (counterPool.length) {
      stats.counterAvailable += 1;
      if (!regularCounterPool.length) stats.counterOnlyByBlood += 1;
      if (!slotCounters.length) {
        problems.push(
          `${spirit.name}/${preset}: 弱点 ${weakTypes.join('、')} 在可学池里有 ×2 反克招（${counterPool
            .slice(0, 4)
            .map((s) => `${s.type}系「${s.name}」`)
            .join('、')}），四格却没带任何一个`,
        );
      } else {
        stats.counterInSlots += 1;
        if (guide.slots[1] && weakTypes.some((w) => hits(guide.slots[1].skill, w))) stats.counterSlotIsSecond += 1;
        if (slotCounters.some((s) => s.skill.learn === 2)) stats.counterFromBlood += 1;
      }
      if (!guide.counter.locked) problems.push(`${spirit.name}/${preset}: counter.locked 为空`);
      else if (!weakTypes.some((w) => guide.counter.locked!.covered.includes(w))) {
        problems.push(`${spirit.name}/${preset}: counter.locked 的覆盖属性与弱点对不上`);
      }
    } else {
      stats.noCounterAnywhere += 1;
      if (guide.counter.locked) problems.push(`${spirit.name}/${preset}: 无任何反克招却标了 locked`);
      if (weakTypes.length && !/可学池无 ×2 反克弱点招式/.test(guide.counter.note)) {
        problems.push(`${spirit.name}/${preset}: 无可用反克招，说明却没写清 → ${guide.counter.note}`);
      }
    }

    /* 门禁 3：血脉技数量 ≤1，且与改血脉卡片完全一致 */
    const bloodInSlots = guide.slots.filter((s) => s.skill.learn === 2);
    if (bloodInSlots.length > 1) {
      problems.push(`${spirit.name}/${preset}: ${bloodInSlots.length} 个血脉技能`);
    }
    const card = guide.bloodline.main;
    if (guide.bloodline.options.length > 1) problems.push(`${spirit.name}: more than one bloodline option`);
    if (card.equipped) {
      stats.bloodEquipped += 1;
      if (bloodInSlots.length !== 1) problems.push(`${spirit.name}/${preset}: 卡片说已装备，配招里血脉技 ${bloodInSlots.length} 个`);
      else if (bloodInSlots[0].skill.id !== card.skill.id) {
        problems.push(`${spirit.name}/${preset}: 卡片「${card.skill.name}」≠ 配招里的「${bloodInSlots[0].skill.name}」`);
      }
      if (!grantable.has(card.skill.id)) problems.push(`${spirit.name}: 卡片血脉技不在它的血脉表里`);
      if (card.slotIndex !== guide.slots.findIndex((s) => s.skill.id === card.skill.id) + 1) {
        problems.push(`${spirit.name}/${preset}: 卡片写的格位与实际不符`);
      }
    } else {
      stats.bloodNotEquipped += 1;
      if (bloodInSlots.length) problems.push(`${spirit.name}/${preset}: 卡片说不改血脉，配招里却有血脉技`);
      if (card.slotIndex !== null) problems.push(`${spirit.name}/${preset}: 未装备却写了格位`);
    }

    if (!guide.bloodline.main.skill?.name) problems.push(`${spirit.name}: bloodline without skill`);
    checkText(`${spirit.name}/${preset}/blood`, `${guide.bloodline.explanation} ${guide.bloodline.note}`, seen);
    for (const line of guide.summary) checkText(`${spirit.name}/${preset}/summary`, line, seen);
    /* 弱点列表本身要与克制表一致 */
    for (const w of guide.weaknesses) {
      if (matchup(w.type, spirit.type).multiplier < 2) problems.push(`${spirit.name}: 弱点 ${w.type} 不是 ≥2 倍`);
    }
    const json = JSON.stringify(guide);
    if (/undefined|NaN/.test(json)) problems.push(`${spirit.name}/${preset}: serialized object has undefined/NaN`);
    if (json.length < 600) problems.push(`${spirit.name}/${preset}: suspiciously small guide`);
  }
}

const pct = (a: number, b: number) => (b ? `${((a / b) * 100).toFixed(1)}%` : '—');

console.log(`natures in table: ${natureTable.rows.length}`);
console.log(`spirits: ${spirits.length}   runs: ${runs}   problems: ${problems.length}`);
console.log('--- 反克制覆盖统计 ---');
console.log(`有防御弱点的方案：${stats.withWeakness} ／ 无弱点：${stats.withoutWeakness}`);
console.log(`合法池里有 ×2 反克招的方案：${stats.counterAvailable}（其中只能靠血脉拿到：${stats.counterOnlyByBlood}）`);
console.log(`四格带上反克招：${stats.counterInSlots}（${pct(stats.counterInSlots, stats.counterAvailable)}）；反克制位落在第 2 格：${stats.counterSlotIsSecond}；靠血脉拿到反克制：${stats.counterFromBlood}`);
console.log(`全合法池都没有反克招、诚实退回补盲：${stats.noCounterAnywhere}`);
console.log(`改血脉卡片：已装备 ${stats.bloodEquipped} ／ 不改血脉 ${stats.bloodNotEquipped}`);
for (const p of problems.slice(0, 40)) console.log(' -', p);
if (problems.length) process.exit(1);
console.log('OK');
