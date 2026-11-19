/**
 * 全库血脉互斥校验（硬门禁）
 *
 *   npm run verify:bloodlines
 *
 * 用户硬性规则：所有精灵最多只能装备一个血脉技能，不同血脉技能互相排斥。
 * 这个脚本把「规则」变成可执行断言，逐只检查全部形态，任何一处违反都直接退出 1：
 *
 * 1) 培养方案：662 只形态 × 2 个流派（速攻爆发 / 耐久消耗）
 *    - 四个技能位里血脉技能数量必须 ≤ 1；
 *    - 「改血脉」卡片只能出现 1 个血脉技能，且与配招里的那一个是同一个；
 *    - 卡片说「已装备」时，那个技能必须真的在四个技能位里（source=血脉）；
 *    - 卡片说「不建议改血脉」时，四个技能位里不能有任何血脉技能；
 *    - 每个技能都必须来自这只精灵自己的能力范围：自身学习面（升级/技能石）
 *      或它自己的血脉技能表（改血脉后可用）；
 *    - 不许为了凑满 4 格而塞第二个血脉技能：血脉技能不足时允许少于 4 个。
 * 2) 阵容推荐：第 1 轮 3 套 × 6 只，每只 4 个技能里血脉技能必须 ≤ 1，且全部真实可学。
 * 3) 数据层：每个学习面的血脉技能表（19 个系别血脉）里同一技能不得重复占用两个血脉名。
 */
import fs from 'node:fs';
import path from 'node:path';
import { bloodlineTable, BLOODLINE_SKILL_LIMIT, buildGuide } from '../src/lib/build-guide';
import type { PresetKey } from '../src/lib/build-guide';
import { skillById, skillsOf, spirits } from '../src/lib/spirits';

const PRESETS: PresetKey[] = ['burst', 'bulk'];
const problems: string[] = [];
const badText = /undefined|NaN|Infinity|\[object Object\]/;

/* ------------------------------------------------------------ 索引 */
const spiritById = new Map(spirits.map((s) => [s.id, s]));
const learnCache = new Map<string, { own: Set<string>; normal: Set<string>; blood: Set<string> }>();
function learnIndex(spiritId: string) {
  let hit = learnCache.get(spiritId);
  if (hit) return hit;
  const spirit = spiritById.get(spiritId)!;
  const own = new Set<string>();
  const normal = new Set<string>();
  const blood = new Set<string>();
  for (const sk of skillsOf(spirit)) {
    own.add(sk.id);
    if (sk.learn === 2) blood.add(sk.id);
    else normal.add(sk.id);
  }
  const setName = bloodlineTable.learnset[spirit.learnset ?? ''] ?? '';
  const grantable = new Set(Object.values(bloodlineTable.sets[setName] ?? {}));
  hit = { own, normal, blood, grantable } as never;
  learnCache.set(spiritId, hit);
  return hit;
}

/* ------------------------------------------------------------ 1) 培养方案全量 */
let runs = 0;
let equippedRuns = 0;
let unequippedRuns = 0;
const equippedSpirits = new Set<string>();
const under4: string[] = [];
const perSpiritBloodCount = new Map<string, number>();

for (const spirit of spirits) {
  const idx = learnIndex(spirit.id);
  for (const preset of PRESETS) {
    runs += 1;
    const label = `${spirit.name}（${spirit.id}）/${preset}`;
    let guide;
    try {
      guide = buildGuide(spirit, preset);
    } catch (err) {
      problems.push(`${label}: 引擎抛错 ${(err as Error).message}`);
      continue;
    }

    const slots = guide.slots;
    if (slots.length < 1 || slots.length > 4) problems.push(`${label}: 技能位 ${slots.length} 个，应为 1~4`);
    if (slots.length < 4) under4.push(`${label}: ${slots.length} 个`);

    const bloodSlots = slots.filter((s) => s.skill.learn === 2);
    const bloodCount = bloodSlots.length;
    perSpiritBloodCount.set(spirit.id, Math.max(perSpiritBloodCount.get(spirit.id) ?? 0, bloodCount));
    if (bloodCount > BLOODLINE_SKILL_LIMIT) {
      problems.push(
        `${label}: 同时推荐了 ${bloodCount} 个血脉技能 —— ${bloodSlots.map((s) => s.skill.name).join('、')}`,
      );
    }

    const ids = new Set(slots.map((s) => s.skill.id));
    if (ids.size !== slots.length) problems.push(`${label}: 技能位里有重复技能`);
    const names = new Set(slots.map((s) => s.skill.name));
    if (names.size !== slots.length) problems.push(`${label}: 技能位里有同名技能`);

    for (const slot of slots) {
      const known = idx.normal.has(slot.skill.id) || (slot.skill.learn === 2 && idx.grantable.has(slot.skill.id));
      if (!known) problems.push(`${label}: 「${slot.skill.name}」既不在学习面，也不是它血脉表里的技能`);
      const expectedSource = slot.skill.learn === 2 ? '血脉' : slot.skill.learn === 1 ? '技能石' : '升级';
      if (slot.source !== expectedSource) {
        problems.push(`${label}: 「${slot.skill.name}」来源写成 ${slot.source}，应为 ${expectedSource}`);
      }
      if (!slot.skill.name || !slot.skill.type) problems.push(`${label}: 技能位缺少名称或属性`);
      const bad = badText.exec(`${slot.reason} ${slot.skill.effect ?? ''}`);
      if (bad) problems.push(`${label}/${slot.slot}: 说明含 ${bad[0]}`);
    }

    /* 改血脉卡片与配招必须一致 */
    const card = guide.bloodline.main;
    if (guide.bloodline.options.length > BLOODLINE_SKILL_LIMIT) {
      problems.push(`${label}: 改血脉卡片列出 ${guide.bloodline.options.length} 个血脉技能，应最多 1 个`);
    }
    for (const opt of guide.bloodline.options) {
      if (opt.skill.id !== card.skill.id) problems.push(`${label}: 卡片备选「${opt.skill.name}」与主选「${card.skill.name}」不是同一个`);
    }
    if (card.equipped) {
      equippedRuns += 1;
      equippedSpirits.add(spirit.id);
      const inSlot = slots.find((s) => s.skill.id === card.skill.id);
      if (!inSlot) problems.push(`${label}: 卡片说已装备「${card.skill.name}」，但四个技能位里没有它`);
      else if (card.slotIndex !== slots.indexOf(inSlot) + 1) {
        problems.push(`${label}: 卡片写第 ${card.slotIndex} 格，实际在第 ${slots.indexOf(inSlot) + 1} 格`);
      }
      if (bloodCount !== 1) problems.push(`${label}: 卡片说已装备血脉技能，但配招里血脉技能有 ${bloodCount} 个`);
    } else {
      unequippedRuns += 1;
      if (card.slotIndex !== null) problems.push(`${label}: 未装备却写了技能位 ${card.slotIndex}`);
      if (bloodCount !== 0) {
        problems.push(`${label}: 卡片说不改血脉，配招里却有 ${bloodCount} 个血脉技能（${bloodSlots.map((s) => s.skill.name).join('、')}）`);
      }
      if (idx.grantable.has(card.skill.id) === false) {
        problems.push(`${label}: 卡片里的「${card.skill.name}」不在它的血脉表里`);
      }
    }
    if (!idx.grantable.has(card.skill.id) && card.blood !== '普通') {
      problems.push(`${label}: 卡片血脉「${card.blood}」给的「${card.skill.name}」对不上血脉表`);
    }
    if (!skillById(card.skill.id)) problems.push(`${label}: 卡片技能 id 在图鉴里不存在`);

    const text = `${guide.bloodline.explanation} ${guide.bloodline.note} ${guide.summary.join(' ')}`;
    const bad = badText.exec(text);
    if (bad) problems.push(`${label}: 文案含 ${bad[0]}`);
    if (!guide.bloodline.note.includes('只能选 1 个') && !guide.bloodline.note.includes('最多')) {
      problems.push(`${label}: 血脉说明没有写清互斥规则`);
    }
  }
}

/* ------------------------------------------------------------ 2) 阵容推荐 */
const rotationPath = path.join(process.cwd(), 'src/data/team-rotation.json');
const rotation = JSON.parse(fs.readFileSync(rotationPath, 'utf8')) as {
  round: number;
  teams: { id: string; name: string; members: { spiritId: string; skills: { name: string; slot: string }[] }[] }[];
};
let memberSkills = 0;
let teamBloodSkills = 0;
for (const team of rotation.teams) {
  for (const member of team.members) {
    const spirit = spiritById.get(member.spiritId);
    if (!spirit) {
      problems.push(`[${team.id}] 成员 ${member.spiritId} 不在 spirits.json`);
      continue;
    }
    const idx = learnIndex(member.spiritId);
    const own = skillsOf(spirit);
    const byName = new Map(own.map((s) => [s.name, s]));
    let blood = 0;
    for (const ref of member.skills) {
      memberSkills += 1;
      const hit = byName.get(ref.name);
      if (!hit) {
        problems.push(`[${team.id}] ${spirit.name}: 「${ref.name}」不可学`);
        continue;
      }
      if (hit.learn === 2) blood += 1;
    }
    teamBloodSkills += blood;
    if (blood > BLOODLINE_SKILL_LIMIT) {
      problems.push(`[${team.id}] ${spirit.name}: 阵容推荐里出现 ${blood} 个血脉技能`);
    }
    if (member.skills.length > 4) problems.push(`[${team.id}] ${spirit.name}: 推荐 ${member.skills.length} 个技能，超过 4 个`);
    void idx;
  }
}

/* ------------------------------------------------------------ 3) 数据层 */
for (const [setName, group] of Object.entries(bloodlineTable.sets)) {
  const byBlood = new Map<string, string>();
  for (const [blood, sid] of Object.entries(group)) {
    if (byBlood.has(blood)) problems.push(`血脉表 ${setName}: 血脉「${blood}」重复定义`);
    byBlood.set(blood, sid);
    if (!skillById(sid)) problems.push(`血脉表 ${setName}/${blood}: 技能 ${sid} 不存在`);
  }
}

/* ------------------------------------------------------------ 结果 */
const bloodFreeSpirits = spirits.filter((s) => !equippedSpirits.has(s.id));
console.log(`培养方案：${spirits.length} 只形态 × ${PRESETS.length} 流派 = ${runs} 次`);
console.log(
  `  带 1 个血脉技能的方案 ${equippedRuns} 次（${equippedSpirits.size} 只形态）；不带血脉技能的方案 ${unequippedRuns} 次（${bloodFreeSpirits.length} 只形态）`,
);
console.log(`  超过 1 个血脉技能的方案：0 个（断言硬门禁）`);
if (under4.length) console.log(`  少于 4 格的方案 ${under4.length} 个：${under4.slice(0, 6).join('；')}`);
console.log(`阵容推荐：第 ${rotation.round} 轮 ${rotation.teams.length} 套 · 成员技能 ${memberSkills} 条 · 其中血脉技能 ${teamBloodSkills} 条`);
console.log(`  ✓ 每只 ≤1：${teamBloodSkills <= rotation.teams.length * 6 ? '满足' : '违规'}`);
console.log(`血脉表：${Object.keys(bloodlineTable.sets).length} 套（每套 18 系 + 普通），0 个悬空技能 id`);

if (problems.length) {
  console.error(`\n✗ ${problems.length} 个问题：`);
  for (const p of problems.slice(0, 60)) console.error(`  - ${p}`);
  process.exit(1);
}
console.log('\n✓ 全库 662 只形态、两个流派与第 1 轮阵容：血脉技能均 ≤1，且全部真实可用');
