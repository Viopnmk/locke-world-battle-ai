/**
 * 阵容推荐校验：每一条「阵容推荐」都必须 100% 落在 BWIKI 图鉴数据里。
 *
 *   npm run verify:teams
 *   （内部执行 esbuild 打包 → node 运行，不依赖浏览器）
 *
 * 检查项：
 * 1) 队伍 id 唯一、members 正好 6 只、spiritId 全部存在于 spirits.json；
 * 2) 每只成员的 skills[].name 都必须是这只精灵真实可学的技能（学习面 / 技能石 / 血脉），
 *    且至少 2 个、至多 4 个；
 * 3) chain 里引用的 spiritId 必须在该队成员里，skillName（若有）必须该精灵可学；
 * 4) 渲染时会 quoting 的 trait 必须存在（trait.name + trait.effect 都不为空）；
 * 5) 数据面板（team-plan.ts）能对每队算出有限数字：平均种族值、最快速度、共同弱点、覆盖面；
 * 6) 云端事实块 presetFactBlock() 不含 undefined / NaN。
 */
import { skillsOf, spirits } from '../src/lib/spirits';
import { presetFactBlock, presetSpirit, TEAM_PRESETS } from '../src/lib/team-presets';
import { teamPlanMetrics } from '../src/lib/team-plan';
import type { ResolvedSkill } from '../src/lib/types';

const problems: string[] = [];
const badText = /undefined|NaN|Infinity|\[object Object\]|%%/;

const skillsBySpirit = new Map<string, ResolvedSkill[]>();
function learnable(spiritId: string): ResolvedSkill[] {
  let list = skillsBySpirit.get(spiritId);
  if (!list) {
    const spirit = spirits.find((s) => s.id === spiritId);
    list = spirit ? skillsOf(spirit) : [];
    skillsBySpirit.set(spiritId, list);
  }
  return list;
}

const ids = new Set<string>();
let memberCount = 0;
let skillRefCount = 0;
let chainRefCount = 0;

for (const preset of TEAM_PRESETS) {
  const label = `[${preset.id}] ${preset.name}`;

  if (ids.has(preset.id)) problems.push(`${label}: 队伍 id 重复`);
  ids.add(preset.id);
  if (!preset.name || !preset.sub || !preset.summary) problems.push(`${label}: 名称/副标题/简介有空值`);
  if (!preset.tags.length) problems.push(`${label}: 没有 tags`);
  if (!preset.plan.length) problems.push(`${label}: 没有配队逻辑`);
  if (!preset.chain.length) problems.push(`${label}: 没有核心联动`);
  if (!['weather', 'rush', 'grind'].includes(preset.category)) problems.push(`${label}: 未知分类 ${preset.category}`);

  if (preset.members.length !== 6) problems.push(`${label}: 成员 ${preset.members.length} 只，应为 6 只`);

  const memberIds = new Set(preset.members.map((m) => m.spiritId));
  if (memberIds.size !== preset.members.length) problems.push(`${label}: 成员有重复精灵`);

  for (const member of preset.members) {
    memberCount += 1;
    const spirit = presetSpirit(member.spiritId);
    if (!spirit) {
      problems.push(`${label}: 精灵 ${member.spiritId} 不在 spirits.json`);
      continue;
    }
    const own = learnable(member.spiritId);
    const ownNames = new Set(own.map((s) => s.name));
    if (!member.role) problems.push(`${label}/${spirit.name}: 没有角色标签`);
    if (!member.note) problems.push(`${label}/${spirit.name}: 没有一句话说明`);
    if (!spirit.trait?.name || !spirit.trait?.effect) problems.push(`${label}/${spirit.name}: 图鉴没有特性，无法引用`);
    if (member.skills.length < 2 || member.skills.length > 4) {
      problems.push(`${label}/${spirit.name}: 关键技能 ${member.skills.length} 个，应为 2~4 个`);
    }
    const seen = new Set<string>();
    for (const ref of member.skills) {
      skillRefCount += 1;
      if (seen.has(ref.name)) problems.push(`${label}/${spirit.name}: 技能 ${ref.name} 重复`);
      seen.add(ref.name);
      if (!ownNames.has(ref.name)) problems.push(`${label}/${spirit.name}: 「${ref.name}」不在学习面里`);
      if (!ref.why) problems.push(`${label}/${spirit.name}: 技能 ${ref.name} 没有说明`);
    }
    // 至少有一个能打出伤害的技能，否则「输出位」说不通
    const damaging = member.skills.filter((ref) => {
      const hit = own.find((s) => s.name === ref.name);
      return typeof hit?.power === 'number' && hit.power > 0;
    });
    if (!damaging.length) problems.push(`${label}/${spirit.name}: 关键技能里没有输出技能`);
  }

  for (const step of preset.chain) {
    chainRefCount += 1;
    if (!memberIds.has(step.spiritId)) problems.push(`${label}: 联动引用了非成员 ${step.spiritId}`);
    const spirit = presetSpirit(step.spiritId);
    if (!spirit) {
      problems.push(`${label}: 联动精灵 ${step.spiritId} 不存在`);
      continue;
    }
    if (step.skillName) {
      const own = learnable(step.spiritId);
      if (!own.some((s) => s.name === step.skillName)) {
        problems.push(`${label}/${spirit.name}: 联动技能「${step.skillName}」不可学`);
      }
    }
    if (!step.text) problems.push(`${label}/${spirit.name}: 联动说明为空`);
    const bad = badText.exec(step.text);
    if (bad) problems.push(`${label}/${spirit.name}: 联动文案含 ${bad[0]}`);
  }
}

/* ------------------------------------------------------------ 渲染数据面板 */
for (const preset of TEAM_PRESETS) {
  const m = teamPlanMetrics(preset);
  const label = `[${preset.id}] ${preset.name}`;
  for (const [key, value] of Object.entries({
    avgTotal: m.avgTotal,
    avgTopPower: m.avgTopPower,
    coverageCount: m.coverageCount,
  })) {
    if (!Number.isFinite(value) || value <= 0) problems.push(`${label}: ${key} = ${value}`);
  }
  if (!m.fastest || !m.fastest.spe) problems.push(`${label}: 最快速度没算出来`);
  if (!m.topPower) problems.push(`${label}: 最高单发威力没算出来`);
  if (!m.physical.length && !m.special.length) problems.push(`${label}: 物攻/魔攻分工没算出来`);
  const fact = presetFactBlock(preset);
  const bad = badText.exec(fact);
  if (bad) problems.push(`${label}: 云端事实块含 ${bad[0]}`);
  if (fact.length < 200) problems.push(`${label}: 云端事实块过短（${fact.length} 字）`);
}

/* ------------------------------------------------------------ 结果 */
console.log(`阵容推荐：${TEAM_PRESETS.length} 套 · 成员 ${memberCount} 只次 · 技能引用 ${skillRefCount} 条 · 联动 ${chainRefCount} 步`);
for (const preset of TEAM_PRESETS) {
  const m = teamPlanMetrics(preset);
  console.log(
    `  ${preset.name}｜平均种族值 ${m.avgTotal}｜最快 ${m.fastest?.name} ${m.fastest?.spe}｜` +
      `物攻 ${m.physical.length}/魔攻 ${m.special.length}｜覆盖面 ${m.coverageCount}/${18}｜共同弱点 ${
        m.sharedWeak.length ? m.sharedWeak.map((w) => `${w.type}×${w.count}`).join('、') : '无'
      }`,
  );
}

if (problems.length) {
  console.error(`\n✗ ${problems.length} 个问题：`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log('\n✓ 全部阵容、特性与技能引用都能在图鉴数据里找到');
