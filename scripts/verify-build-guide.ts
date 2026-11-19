/**
 * 全量校验：662 只形态 × 2 个流派都跑一遍培养方案引擎，确认没有运行时错误、
 * undefined / NaN，技能全部来自该精灵自己的学习面，性格/个体值/血脉都有真数据。
 *
 *   npx esbuild scripts/verify-build-guide.ts --bundle --platform=node --format=esm --outfile=.cache/verify-build-guide.mjs
 *   node .cache/verify-build-guide.mjs
 */
import { buildGuide, bloodlineTable, natureTable, natures } from '../src/lib/build-guide';
import { skillsOf, spirits } from '../src/lib/spirits';
import type { PresetKey } from '../src/lib/build-guide';

const PRESETS: PresetKey[] = ['burst', 'bulk'];
const problems: string[] = [];
let runs = 0;

function checkText(label: string, text: string, seen: Set<string>) {
  const key = `${label}`;
  if (seen.has(key)) return;
  seen.add(key);
  const bad = /undefined|NaN|Infinity|\[object Object\]/.exec(text);
  if (bad) problems.push(`${label}: contains "${bad[0]}" → ${text.slice(Math.max(0, bad.index - 40), bad.index + 40)}`);
}

for (const spirit of spirits) {
  const learnable = new Set(skillsOf(spirit).map((s) => s.id));
  /* 改血脉后能拿到的技能（19 个别系血脉 + 普通），与学习面一起构成合法的能力范围 */
  const setName = bloodlineTable.learnset[spirit.learnset ?? ''] ?? '';
  const grantable = new Set(Object.values(bloodlineTable.sets[setName] ?? {}));
  for (const preset of PRESETS) {
    runs += 1;
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
    if (guide.slots.filter((s) => s.skill.learn === 2).length > 1) {
      problems.push(`${spirit.name}/${preset}: more than one bloodline skill in slots`);
    }
    const ids = new Set(guide.slots.map((s) => s.skill.id));
    if (ids.size !== guide.slots.length) problems.push(`${spirit.name}/${preset}: duplicate skills`);
    for (const slot of guide.slots) {
      const legal = learnable.has(slot.skill.id) || (slot.skill.learn === 2 && grantable.has(slot.skill.id));
      if (!legal) problems.push(`${spirit.name}: ${slot.skill.name} not in its own learnset`);
      if (!['升级', '技能石', '血脉'].includes(slot.source)) problems.push(`${spirit.name}: bad source ${slot.source}`);
      if (!slot.skill.name || !slot.skill.type) problems.push(`${spirit.name}: skill without name/type`);
      checkText(`${spirit.name}/${preset}/${slot.slot}`, `${slot.reason} ${slot.skill.effect}`, seen);
    }
    for (const n of [guide.nature.main, guide.nature.alt]) {
      if (!natures.some((x) => x.id === n.nature.id)) problems.push(`${spirit.name}: nature not in table`);
      if (!n.line.includes('+10%') || !n.line.includes('-10%')) problems.push(`${spirit.name}: nature line ${n.line}`);
      checkText(`${spirit.name}/${preset}/nature`, n.reason, seen);
    }
    if (guide.ivs.length !== 3) problems.push(`${spirit.name}/${preset}: ${guide.ivs.length} ivs`);
    if (new Set(guide.ivs.map((i) => i.key)).size !== guide.ivs.length) problems.push(`${spirit.name}: duplicate ivs`);
    if (!guide.bloodline.main.skill?.name) problems.push(`${spirit.name}: bloodline without skill`);
    if (guide.bloodline.options.length > 1) problems.push(`${spirit.name}: more than one bloodline option`);
    if (guide.bloodline.main.equipped) {
      if (!guide.slots.some((s) => s.skill.id === guide.bloodline.main.skill.id)) {
        problems.push(`${spirit.name}: bloodline marked equipped but not in slots`);
      }
    } else if (guide.slots.some((s) => s.skill.learn === 2)) {
      problems.push(`${spirit.name}: bloodline marked not equipped but a bloodline skill is in slots`);
    }
    checkText(`${spirit.name}/${preset}/blood`, `${guide.bloodline.explanation} ${guide.bloodline.note}`, seen);
    for (const line of guide.summary) checkText(`${spirit.name}/${preset}/summary`, line, seen);
    const json = JSON.stringify(guide);
    if (/undefined|NaN/.test(json)) problems.push(`${spirit.name}/${preset}: serialized object has undefined/NaN`);
    if (json.length < 600) problems.push(`${spirit.name}/${preset}: suspiciously small guide`);
  }
}

console.log(`natures in table: ${natureTable.rows.length}`);
console.log(`spirits: ${spirits.length}   runs: ${runs}   problems: ${problems.length}`);
for (const p of problems.slice(0, 40)) console.log(' -', p);
if (problems.length) process.exit(1);
console.log('OK');
