/**
 * 阵容推荐校验：当前这一轮的 3 套自动轮换阵容必须 100% 落在 BWIKI 图鉴数据里。
 *
 *   npm run verify:teams
 *   （内部执行 esbuild 打包 → node 运行，不依赖浏览器）
 *
 * 检查项：
 * 1) 元数据：round ≥ 1、updatedAt 可解析、nextRotationAt = updatedAt + 48h、恰好 3 套、id 与轮次一致；
 * 2) 战术：3 套的原型互不相同（archetype id 唯一）、每套 category 合法、名称/副标题/简介/优势/弱点都不为空；
 * 3) 成员：每套正好 6 只、队内不重复、全图鉴存在、特性存在且非空、每只正好 4 个技能且全部真实可学
 *    （学习面 / 技能石 / 血脉）、每个成员至少一个伤害技能、角色标签覆盖 先手/核心输出/控制/辅助/承伤/收割；
 * 3.5) 战术手册：每套有 lead（在队内、理由非空、开场技能可学）、至少 2 条 skillSynergies（引用真实精灵与技能）、
 *    恰好 5 个战术阶段且顺序为 开局/第一阶段/中期/后期/逆风局，每个阶段引用的精灵与技能都必须真实存在；
 * 4) 不重复：18 只 spiritId 互不重复；与上一轮的重叠必须为 0（生成脚本放宽时会写进 weakness，这里会报警）；
 * 5) 文案：chain 引用的精灵在队内、技能可学、文字非空，所有文字不含 undefined / NaN / Infinity；
 * 6) 数据面板（team-plan.ts）能对每队算出有限数字，云端事实块 presetFactBlock() 不含 undefined / NaN；
 * 7) 归档：rotation-history.json 的最后一轮与 team-rotation.json 一致。
 */
import fs from 'node:fs';
import path from 'node:path';
import { skillsOf, spirits } from '../src/lib/spirits';
import { presetFactBlock, presetSpirit, shortName, TEAM_PRESETS, TEAM_ROTATION } from '../src/lib/team-presets';
import { teamPlanMetrics } from '../src/lib/team-plan';
import type { ResolvedSkill } from '../src/lib/types';

const problems: string[] = [];
const warnings: string[] = [];
const badText = /undefined|NaN|Infinity|\[object Object\]|%%/;

const ROLES = ['先手', '核心输出', '控制', '辅助', '承伤', '收割'];
const PHASE_LABELS = ['开局', '第一阶段', '中期', '后期', '逆风局'];
const PHASE_KEYS = ['opening', 'advantage', 'mid', 'late', 'comeback'];
const CATEGORIES = [
  'rush',
  'nuke',
  'wall',
  'mixed',
  'tax',
  'sustain',
  'status',
  'weather',
  'mono',
  'punish',
];

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

/* ------------------------------------------------------------ 1. 元数据 */
const round = TEAM_ROTATION.round;
if (!Number.isInteger(round) || round < 1) problems.push(`轮次不合法：${round}`);
if (TEAM_ROTATION.intervalHours !== 48) problems.push(`轮换间隔应为 48 小时，实际 ${TEAM_ROTATION.intervalHours}`);
const updated = new Date(TEAM_ROTATION.updatedAt);
const next = new Date(TEAM_ROTATION.nextRotationAt);
if (Number.isNaN(updated.getTime())) problems.push(`updatedAt 无法解析：${TEAM_ROTATION.updatedAt}`);
if (Number.isNaN(next.getTime())) problems.push(`nextRotationAt 无法解析：${TEAM_ROTATION.nextRotationAt}`);
if (!Number.isNaN(updated.getTime()) && !Number.isNaN(next.getTime())) {
  const gapHours = (next.getTime() - updated.getTime()) / 3600000;
  if (Math.abs(gapHours - 48) > 0.01) problems.push(`updatedAt → nextRotationAt 间隔 ${gapHours} 小时，应为 48`);
}
if (TEAM_PRESETS.length !== 3) problems.push(`当前轮应有 3 套阵容，实际 ${TEAM_PRESETS.length}`);

/* ------------------------------------------------------------ 2. 战术 */
const archetypes = new Set<string>();
const ids = new Set<string>();
for (const preset of TEAM_PRESETS) {
  const label = `[${preset.id}] ${preset.name}`;
  if (ids.has(preset.id)) problems.push(`${label}: 队伍 id 重复`);
  ids.add(preset.id);
  if (!preset.id.startsWith(`r${round}-`)) problems.push(`${label}: id 前缀应为 r${round}-`);
  if (archetypes.has(preset.archetype)) problems.push(`${label}: 战术原型 ${preset.archetype} 在本轮重复`);
  archetypes.add(preset.archetype);
  if (!preset.archetypeLabel) problems.push(`${label}: 没有战术原型名称`);
  if (!CATEGORIES.includes(preset.category)) problems.push(`${label}: 未知分类 ${preset.category}`);
  if (!preset.name || !preset.sub || !preset.summary) problems.push(`${label}: 名称/副标题/简介有空值`);
  if (!preset.tags.length) problems.push(`${label}: 没有 tags`);
  if (!preset.plan.length) problems.push(`${label}: 没有配队逻辑`);
  if (!preset.pros.length) problems.push(`${label}: 没有优势`);
  if (!preset.risk) problems.push(`${label}: 没有弱点`);
  if (!preset.chain.length) problems.push(`${label}: 没有核心联动`);
  const bad = badText.exec(`${preset.summary} ${preset.pros.join(' ')} ${preset.risk} ${preset.plan.join(' ')}`);
  if (bad) problems.push(`${label}: 文案含 ${bad[0]}`);
}

if (archetypes.size !== TEAM_PRESETS.length) problems.push('本轮 3 套阵容的战术原型不互不相同');

/* ------------------------------------------------------------ 3. 成员 */
let memberCount = 0;
let skillRefCount = 0;
let chainRefCount = 0;
const allSpiritIds: string[] = [];

for (const preset of TEAM_PRESETS) {
  const label = `[${preset.id}] ${preset.name}`;
  if (preset.members.length !== 6) problems.push(`${label}: 成员 ${preset.members.length} 只，应为 6 只`);

  const memberIds = new Set(preset.members.map((m) => m.spiritId));
  if (memberIds.size !== preset.members.length) problems.push(`${label}: 成员有重复精灵`);

  const roles = new Set(preset.members.map((m) => m.role));
  for (const role of ROLES) {
    if (!roles.has(role)) problems.push(`${label}: 缺少角色「${role}」`);
  }

  for (const member of preset.members) {
    memberCount += 1;
    allSpiritIds.push(member.spiritId);
    const spirit = presetSpirit(member.spiritId);
    if (!spirit) {
      problems.push(`${label}: 精灵 ${member.spiritId} 不在 spirits.json`);
      continue;
    }
    const own = learnable(member.spiritId);
    const ownNames = new Set(own.map((s) => s.name));
    if (!member.note) problems.push(`${label}/${spirit.name}: 没有一句话说明`);
    if (!spirit.trait?.name || !spirit.trait?.effect) problems.push(`${label}/${spirit.name}: 图鉴没有特性，无法引用`);
    if (member.skills.length !== 4) {
      problems.push(`${label}/${spirit.name}: 推荐技能 ${member.skills.length} 个，应为 4 个`);
    }
    if (!member.duty) problems.push(`${label}/${spirit.name}: 没有角色职责说明`);
    if (!member.traitSynergy) problems.push(`${label}/${spirit.name}: 没有特性用法说明`);
    const seen = new Set<string>();
    for (const ref of member.skills) {
      skillRefCount += 1;
      if (seen.has(ref.name)) problems.push(`${label}/${spirit.name}: 技能 ${ref.name} 重复`);
      seen.add(ref.name);
      if (!ref.slot) problems.push(`${label}/${spirit.name}: 技能 ${ref.name} 没有技能位（主攻/补盲/机制/防守）`);
      if (!ownNames.has(ref.name)) problems.push(`${label}/${spirit.name}: 「${ref.name}」不在学习面里`);
      if (!ref.why) problems.push(`${label}/${spirit.name}: 技能 ${ref.name} 没有说明`);
      const bad = badText.exec(ref.why);
      if (bad) problems.push(`${label}/${spirit.name}: 技能说明含 ${bad[0]}`);
    }
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

/* ------------------------------------------------------------ 3.5 起手 / 4 技能 / 联动 / 5 阶段 */
const learnableNames = (id: string) => new Set(learnable(id).map((s) => s.name));
let leadCount = 0;
let synergyCount = 0;
let phaseCount = 0;

for (const preset of TEAM_PRESETS) {
  const label = `[${preset.id}] ${preset.name}`;
  const ids = new Set(preset.members.map((m) => m.spiritId));
  const lead = preset.lead;

  if (!lead) {
    problems.push(`${label}: 没有起手第一只（lead）`);
  } else {
    leadCount += 1;
    const spirit = presetSpirit(lead.spiritId);
    if (!ids.has(lead.spiritId)) problems.push(`${label}: 起手精灵 ${lead.spiritId} 不在队里`);
    if (!spirit) {
      problems.push(`${label}: 起手精灵 ${lead.spiritId} 不在 spirits.json`);
    } else {
      const own = learnableNames(lead.spiritId);
      if (!lead.why || lead.why.length < 12) problems.push(`${label}/${spirit.name}: 起手理由太短`);
      if (!lead.caution) problems.push(`${label}/${spirit.name}: 起手没有换人提醒`);
      if (lead.openers.length < 1 || lead.openers.length > 2) {
        problems.push(`${label}/${spirit.name}: 开场技能 ${lead.openers.length} 个，应为 1~2 个`);
      }
      for (const op of lead.openers) {
        if (!own.has(op.name)) problems.push(`${label}/${spirit.name}: 开场技能「${op.name}」不可学`);
        if (!op.why) problems.push(`${label}/${spirit.name}: 开场技能「${op.name}」没有说明`);
        const bad = badText.exec(op.why);
        if (bad) problems.push(`${label}/${spirit.name}: 开场技能说明含 ${bad[0]}`);
      }
      const role = preset.members.find((m) => m.spiritId === lead.spiritId)?.role;
      if (role !== '先手') warnings.push(`${label}: 起手 ${spirit.name} 的角色是「${role}」，不是先手`);
      const bad = badText.exec(`${lead.why} ${lead.caution}`);
      if (bad) problems.push(`${label}/${spirit.name}: 起手文案含 ${bad[0]}`);
    }
  }

  if (preset.synergies.length < 2) problems.push(`${label}: 核心技能联动只有 ${preset.synergies.length} 条，至少 2 条`);
  if (preset.synergies.length > 4) problems.push(`${label}: 核心技能联动 ${preset.synergies.length} 条，应为 2~4 条`);
  for (const [i, syn] of preset.synergies.entries()) {
    synergyCount += 1;
    const tag = `${label}/联动${i + 1}`;
    if (!syn.title || !syn.text) problems.push(`${tag}: 标题或说明为空`);
    if (syn.text.length < 40) problems.push(`${tag}: 说明过短（${syn.text.length} 字）`);
    if (!syn.spiritIds.length) problems.push(`${tag}: 没有引用队内精灵`);
    for (const sid of syn.spiritIds) {
      if (!ids.has(sid)) problems.push(`${tag}: 引用了非成员 ${sid}`);
    }
    for (const ref of syn.skills) {
      if (!ids.has(ref.spiritId)) problems.push(`${tag}: 技能 ${ref.name} 的持有者 ${ref.spiritId} 不在队里`);
      if (!learnableNames(ref.spiritId).has(ref.name)) {
        problems.push(`${tag}: 技能「${ref.name}」不在 ${presetSpirit(ref.spiritId)?.name ?? ref.spiritId} 的学习面里`);
      }
    }
    const bad = badText.exec(`${syn.title} ${syn.text}`);
    if (bad) problems.push(`${tag}: 文案含 ${bad[0]}`);
  }

  if (preset.battlePlan.length !== 5) {
    problems.push(`${label}: 战术配合链 ${preset.battlePlan.length} 阶段，应为 5 阶段`);
  }
  const labels = preset.battlePlan.map((p) => p.label);
  if (labels.join('/') !== PHASE_LABELS.join('/')) {
    problems.push(`${label}: 战术阶段顺序是 ${labels.join('/')}，应为 ${PHASE_LABELS.join('/')}`);
  }
  for (const [i, phase] of preset.battlePlan.entries()) {
    phaseCount += 1;
    const tag = `${label}/${phase.label}`;
    if (!PHASE_KEYS.includes(phase.key)) problems.push(`${tag}: 未知阶段 key ${phase.key}`);
    if (!phase.title || !phase.text) problems.push(`${tag}: 标题或说明为空`);
    if (phase.text.length < 60) problems.push(`${tag}: 说明过短（${phase.text.length} 字）`);
    for (const sid of phase.spiritIds) {
      if (!ids.has(sid)) problems.push(`${tag}: 引用了非成员 ${sid}`);
    }
    for (const ref of phase.skills) {
      if (!ids.has(ref.spiritId)) problems.push(`${tag}: 技能 ${ref.name} 的持有者 ${ref.spiritId} 不在队里`);
      if (!learnableNames(ref.spiritId).has(ref.name)) {
        problems.push(`${tag}: 技能「${ref.name}」不在 ${presetSpirit(ref.spiritId)?.name ?? ref.spiritId} 的学习面里`);
      }
    }
    const bad = badText.exec(`${phase.title} ${phase.text}`);
    if (bad) problems.push(`${tag}: 文案含 ${bad[0]}`);
  }
  const leadSpirit = preset.lead ? presetSpirit(preset.lead.spiritId) : undefined;
  if (leadSpirit && preset.battlePlan[0] && !preset.battlePlan[0].text.includes(shortName(leadSpirit.name))) {
    problems.push(`${label}: 开局阶段没有点名首发 ${leadSpirit.name}`);
  }
}

/* ------------------------------------------------------------ 4. 跨队不重复 + 与上一轮去重 */
const uniqueSpirits = new Set(allSpiritIds);
if (uniqueSpirits.size !== allSpiritIds.length) {
  const dupes = allSpiritIds.filter((id, i) => allSpiritIds.indexOf(id) !== i);
  problems.push(`本轮 3 套之间有重复精灵：${[...new Set(dupes)].map((id) => presetSpirit(id)?.name ?? id).join('、')}`);
}

const historyPath = path.join(process.cwd(), 'src/data/rotation-history.json');
const history = JSON.parse(fs.readFileSync(historyPath, 'utf8')) as {
  rounds: { round: number; spiritIds: string[]; teams: { name: string }[] }[];
};
const current = history.rounds.find((r) => r.round === round);
if (!current) problems.push(`rotation-history.json 里没有第 ${round} 轮`);
else {
  const same =
    current.spiritIds.length === allSpiritIds.length &&
    current.spiritIds.every((id, i) => id === allSpiritIds[i]);
  if (!same) problems.push(`rotation-history.json 第 ${round} 轮的 18 个 spiritId 与 team-rotation.json 不一致`);
  if (current.teams.length !== TEAM_PRESETS.length) problems.push('history 里的队伍数量与当前轮不一致');
}

const previous = history.rounds.filter((r) => r.round < round).sort((a, b) => b.round - a.round)[0];
if (previous) {
  const prevIds = new Set(previous.spiritIds);
  const overlap = allSpiritIds.filter((id) => prevIds.has(id));
  if (overlap.length) {
    const names = overlap.map((id) => presetSpirit(id)?.name ?? id).join('、');
    // 生成脚本只在凑不出合格阵容时才放宽，并把重叠写进「弱点」，所以这里报警但不直接判错
    warnings.push(`与第 ${previous.round} 轮重叠 ${overlap.length} 只：${names}（需在弱点里写明）`);
    for (const preset of TEAM_PRESETS) {
      const hits = preset.members.filter((m) => prevIds.has(m.spiritId));
      if (hits.length && !/重叠/.test(preset.risk)) {
        problems.push(`[${preset.id}] 与前一轮重叠 ${hits.length} 只，但弱点里没有说明`);
      }
    }
  }
}

/* ------------------------------------------------------------ 5. 渲染数据面板 */
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
  if (m.physical.length + m.special.length + m.balanced.length !== preset.members.length) {
    problems.push(`${label}: 物攻/魔攻分工没算出来`);
  }
  const fact = presetFactBlock(preset);
  const bad = badText.exec(fact);
  if (bad) problems.push(`${label}: 云端事实块含 ${bad[0]}`);
  if (fact.length < 400) problems.push(`${label}: 云端事实块过短（${fact.length} 字）`);
}

/* ------------------------------------------------------------ 6. 结果 */
console.log(
  `第 ${round} 轮 · ${TEAM_ROTATION.updatedAt} 更新 → ${TEAM_ROTATION.nextRotationAt} 换下一轮（48 小时）`,
);
console.log(
  `阵容 ${TEAM_PRESETS.length} 套 · 成员 ${memberCount} 只次 / ${uniqueSpirits.size} 只不重复 · 技能引用 ${skillRefCount} 条 · 联动 ${chainRefCount} 步`,
);
console.log(
  `战术手册：起手 ${leadCount} 只 · 核心联动 ${synergyCount} 条 · 战术阶段 ${phaseCount} 个（每套 5 个）`,
);
for (const preset of TEAM_PRESETS) {
  const m = teamPlanMetrics(preset);
  const leadName = preset.lead ? presetSpirit(preset.lead.spiritId)?.name ?? '—' : '—';
  console.log(
    `  ${preset.name}（${preset.archetypeLabel}）｜起手 ${leadName}｜联动 ${preset.synergies.length} 条｜` +
      `平均种族值 ${m.avgTotal}｜最快 ${m.fastest?.name} ${m.fastest?.spe}｜` +
      `物攻 ${m.physical.length}/魔攻 ${m.special.length}｜覆盖面 ${m.coverageCount}/18｜共同弱点 ${
        m.sharedWeak.length ? m.sharedWeak.map((w) => `${w.type}×${w.count}`).join('、') : '无'
      }`,
  );
}

for (const w of warnings) console.warn(`  ⚠ ${w}`);

if (problems.length) {
  console.error(`\n✗ ${problems.length} 个问题：`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log('\n✓ 本轮 3 套阵容、特性与技能引用都能在图鉴数据里找到');
