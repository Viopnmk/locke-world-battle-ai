/**
 * 阵容校验核心（唯一实现）
 *
 * 同一份逻辑被两处调用：
 *   · scripts/rotate-teams.ts —— 写盘之前先跑一遍，不通过就退出，旧数据一个字节都不动；
 *   · scripts/verify-teams.ts —— npm run verify:teams 的 CLI 封装。
 *
 * 校验的是「说得对不对」，不只是「引用找不找得到」：
 *   能量（上场 / 技能 / 回能 / 10 点上限）、特性是否真的转得起来、血脉 ≤ 1、
 *   同 dex / 定位冲突、假联动（因果对不上原文）、覆盖口径（推荐 4 招 vs 学习面）。
 */
import { matchup, TYPE_ORDER } from '../../src/lib/typeChart';
import { carriedSkills, resolveCarried } from '../../src/lib/carried-skills';
import { buildGuide } from '../../src/lib/build-guide';
import { skillsOf, spirits, spiritsById } from '../../src/lib/spirits';
import { ENERGY_CAP, memberEnergy, entryEnergy, energyViolations, traitEnergyFacts } from '../../src/lib/energy';
import { teamConflicts, traitActivation } from '../../src/lib/trait-rules';
import { BLOODLINE_SKILL_LIMIT } from '../../src/lib/equip-rules';
import type { ResolvedSkill, Spirit } from '../../src/lib/types';
import type { RotationHistoryFile, TeamPreset, TeamRotationFile } from '../../src/lib/team-types';

export interface AuditStats {
  teams: number;
  members: number;
  uniqueSpirits: number;
  uniqueDex: number;
  skills: number;
  synergies: number;
  phases: number;
  activeTraits: number;
  idleTraits: number;
  entryTotal: number;
  coverage: { id: string; chosen: number; learnset: number }[];
}

export interface AuditResult {
  problems: string[];
  warnings: string[];
  stats: AuditStats;
}

const BAD_TEXT = /undefined|NaN|Infinity|\[object Object\]|%%/;
const ROLES = ['先手', '核心输出', '控制', '辅助', '承伤', '收割'];
const PHASE_LABELS = ['开局', '第一阶段', '中期', '后期', '逆风局'];
const PHASE_KEYS = ['opening', 'advantage', 'mid', 'late', 'comeback'];
const CATEGORIES = ['rush', 'nuke', 'wall', 'mixed', 'tax', 'sustain', 'status', 'weather', 'mono', 'punish'];
/** 审计报告里点名过的伪因果句式，出现在联动里就判错 */
const FAKE_CAUSE = [
  /白拿伤害/,
  /等于多打一发/,
  /免费.{0,3}伤害/,
  /能耗\+1[^。；]{0,20}伤害/,
  /抬费[^。；]{0,10}(增伤|伤害提升)/,
];

const learnCache = new Map<string, ResolvedSkill[]>();
/** 自带学习面（升级 / 技能石 / 本族血脉记录）——「学习面覆盖」这个口径用它，不含改血脉。 */
export function learnable(id: string): ResolvedSkill[] {
  let list = learnCache.get(id);
  if (!list) {
    const sp = spiritsById.get(id);
    list = sp ? skillsOf(sp) : [];
    learnCache.set(id, list);
  }
  return list;
}

/** 这只精灵实际能带上场的技能（自带 + 改血脉能换到的 19 选 1），用来核对阵容里的 4 招。 */
const carriedCache = new Map<string, ResolvedSkill[]>();
export function carried(id: string): ResolvedSkill[] {
  let list = carriedCache.get(id);
  if (!list) {
    const sp = spiritsById.get(id);
    list = sp ? carriedSkills(sp) : [];
    carriedCache.set(id, list);
  }
  return list;
}

/** 阵容里这 4 招解析成真实技能记录（自带优先，其次改血脉）；解析不到返回 null。 */
export function resolveMemberSkill(id: string, name: string): ResolvedSkill | null {
  const sp = spiritsById.get(id);
  return sp ? resolveCarried(sp, name) : null;
}

function threatens(spirit: Spirit): boolean {
  return skillsOf(spirit).some((sk) => (sk.power ?? 0) > 0);
}

/** 「能打出 ≥2 倍的属性」：按给定技能集算，不复用 bestHit 的挑招口径 */
export function coverageOf(spirit: Spirit, list: ResolvedSkill[]): string[] {
  const dmg = list.filter((sk) => (sk.power ?? 0) > 0 && sk.type);
  return TYPE_ORDER.filter((t) => dmg.some((sk) => matchup(sk.type, [t]).multiplier >= 2));
}

export function auditRotation(rotation: TeamRotationFile, history: RotationHistoryFile): AuditResult {
  const problems: string[] = [];
  const warnings: string[] = [];
  const stat: AuditStats = {
    teams: rotation.teams.length,
    members: 0,
    uniqueSpirits: 0,
    uniqueDex: 0,
    skills: 0,
    synergies: 0,
    phases: 0,
    activeTraits: 0,
    idleTraits: 0,
    entryTotal: 0,
    coverage: [],
  };

  /* 1) 元数据 */
  if (!Number.isInteger(rotation.round) || rotation.round < 1) problems.push(`轮次不合法：${rotation.round}`);
  if (rotation.intervalHours !== 48) problems.push(`轮换间隔应为 48 小时，实际 ${rotation.intervalHours}`);
  const updated = new Date(rotation.updatedAt);
  const next = new Date(rotation.nextRotationAt);
  if (Number.isNaN(updated.getTime())) problems.push(`updatedAt 无法解析：${rotation.updatedAt}`);
  if (Number.isNaN(next.getTime())) problems.push(`nextRotationAt 无法解析：${rotation.nextRotationAt}`);
  if (!Number.isNaN(updated.getTime()) && !Number.isNaN(next.getTime())) {
    const gap = (next.getTime() - updated.getTime()) / 3600000;
    if (Math.abs(gap - 48) > 0.01) problems.push(`updatedAt → nextRotationAt 间隔 ${gap} 小时，应为 48`);
  }
  if (rotation.teams.length !== 3) problems.push(`当前轮应有 3 套阵容，实际 ${rotation.teams.length}`);
  if (rotation.previous && rotation.previous.round >= rotation.round) {
    problems.push(`previous 指向第 ${rotation.previous.round} 轮，不能等于或晚于当前第 ${rotation.round} 轮`);
  }

  /* 2) 逐队 */
  const archetypes = new Set<string>();
  const ids = new Set<string>();
  const allIds: string[] = [];
  const allDex: string[] = [];

  for (const preset of rotation.teams) {
    const label = `[${preset.id}] ${preset.name}`;
    if (ids.has(preset.id)) problems.push(`${label}: 队伍 id 重复`);
    ids.add(preset.id);
    if (!preset.id.startsWith(`r${rotation.round}-`)) problems.push(`${label}: id 前缀应为 r${rotation.round}-`);
    if (archetypes.has(preset.archetype)) problems.push(`${label}: 战术原型 ${preset.archetype} 在本轮重复`);
    archetypes.add(preset.archetype);
    if (!CATEGORIES.includes(preset.category)) problems.push(`${label}: 未知分类 ${preset.category}`);
    if (!preset.name || !preset.sub || !preset.summary) problems.push(`${label}: 名称/副标题/简介有空值`);
    if (!preset.tags.length) problems.push(`${label}: 没有 tags`);
    if (!preset.plan.length) problems.push(`${label}: 没有配队逻辑`);
    if (!preset.pros.length) problems.push(`${label}: 没有优势`);
    if (!preset.risk) problems.push(`${label}: 没有弱点`);
    if (!preset.chain.length) problems.push(`${label}: 没有核心联动`);
    const bad = BAD_TEXT.exec(`${preset.summary} ${preset.pros.join(' ')} ${preset.risk} ${preset.plan.join(' ')}`);
    if (bad) problems.push(`${label}: 文案含 ${bad[0]}`);

    if (preset.members.length !== 6) problems.push(`${label}: 成员 ${preset.members.length} 只，应为 6 只`);

    const memberIds = preset.members.map((m) => m.spiritId);
    if (new Set(memberIds).size !== memberIds.length) problems.push(`${label}: 成员有重复精灵`);
    if (new Set(preset.members.map((m) => m.role)).size !== 6) problems.push(`${label}: 6 只的角色有重复（定位冲突）`);
    for (const role of ROLES) {
      if (!preset.members.some((m) => m.role === role)) problems.push(`${label}: 缺少角色「${role}」`);
    }

    const teamSpirits = preset.members.map((m) => spiritsById.get(m.spiritId)).filter((s): s is Spirit => Boolean(s));
    const teamDex = teamSpirits.map((s) => s.dex);
    if (new Set(teamDex).size !== teamDex.length) {
      const dup = teamDex.filter((d, i) => teamDex.indexOf(d) !== i);
      problems.push(`${label}: 队内出现同图鉴编号 ${[...new Set(dup)].join('/')}（同 dex 形态不能同队）`);
    }
    allDex.push(...teamDex);
    allIds.push(...memberIds);

    const chosenSets = preset.members.map((m) => ({
      spirit: spiritsById.get(m.spiritId),
      chosen: m.skills.map((ref) => resolveMemberSkill(m.spiritId, ref.name)).filter((s): s is ResolvedSkill => Boolean(s)),
    }));

    let entryTotal = 0;
    let activeTraits = 0;
    let idleTraits = 0;

    for (const member of preset.members) {
      stat.members += 1;
      const spirit = spiritsById.get(member.spiritId);
      if (!spirit) {
        problems.push(`${label}: 精灵 ${member.spiritId} 不在 spirits.json`);
        continue;
      }
      if (!threatens(spirit)) problems.push(`${label}/${spirit.name}: 学习面里没有任何输出技能`);
      /* 4 招的合法口径 = 自带学习面 + 改血脉能换到的技能（培养板块推荐的就是这一类） */
      const own = carried(member.spiritId);
      const ownNames = new Set(own.map((s) => s.name));
      if (!member.note || !member.duty || !member.traitSynergy) {
        problems.push(`${label}/${spirit.name}: note / duty / traitSynergy 有空值`);
      }
      if (member.skills.length !== 4) problems.push(`${label}/${spirit.name}: 推荐技能 ${member.skills.length} 个，应为 4 个`);
      if (new Set(member.skills.map((s) => s.name)).size !== member.skills.length) {
        problems.push(`${label}/${spirit.name}: 4 招里有重复技能`);
      }

      const chosen: ResolvedSkill[] = [];
      for (const ref of member.skills) {
        stat.skills += 1;
        if (!ownNames.has(ref.name)) {
          problems.push(`${label}/${spirit.name}: 「${ref.name}」既不在学习面里，也不是改血脉能换到的技能`);
          continue;
        }
        const sk = own.find((s) => s.name === ref.name)!;
        chosen.push(sk);
        if (!ref.slot) problems.push(`${label}/${spirit.name}: 技能「${ref.name}」没有技能位`);
        if (!ref.why) problems.push(`${label}/${spirit.name}: 技能「${ref.name}」没有说明`);
        if (typeof ref.energy === 'number' && ref.energy !== (sk.energy ?? 0)) {
          problems.push(`${label}/${spirit.name}: 「${ref.name}」标注 ${ref.energy} 费，图鉴是 ${sk.energy} 费`);
        }
        if ((sk.energy ?? 0) > ENERGY_CAP && !entryEnergy(spirit).overCap) {
          problems.push(`${label}/${spirit.name}: 「${ref.name}」${sk.energy} 费超过 10 点上限，且没有突破上限特性`);
        }
      }

      /* 血脉互斥 */
      const bloodCount = chosen.filter((sk) => sk.learn === 2).length;
      if (bloodCount > BLOODLINE_SKILL_LIMIT) {
        problems.push(`${label}/${spirit.name}: 带了 ${bloodCount} 个血脉技能，超过上限 ${BLOODLINE_SKILL_LIMIT}`);
      }
      /* 配招一致性（2026-11-27 新增门禁）：阵容的 4 招必须与培养板块 buildGuide(spirit,'burst') 完全相同、同序。
         以前阵容引擎自己选招，用户在「阵容」看到 4 招、点进「培养」却是另外 4 招；
         现在两条路径共用一个函数，这条门禁防止以后 48 小时轮换时再次分叉。 */
      const guide = buildGuide(spirit, 'burst');
      const guideNames = guide.slots.map((slot) => slot.skill.name);
      const declaredNames = member.skills.map((ref) => ref.name);
      if (guideNames.join('|') !== declaredNames.join('|')) {
        problems.push(
          `${label}/${spirit.name}: 4 招与培养板块不一致（阵容 ${declaredNames.join('、') || '空'} ／ 培养 ${guideNames.join('、') || '空'}）`,
        );
      }
      if (!chosen.some((sk) => (sk.power ?? 0) > 0)) problems.push(`${label}/${spirit.name}: 4 招里没有输出技能`);

      /* 能量复算 */
      const violations = energyViolations(spirit, chosen);
      for (const v of violations) problems.push(`${label}: ${v}`);
      const recomputed = memberEnergy(spirit, chosen);
      const declared = member.energy;
      if (!declared) {
        problems.push(`${label}/${spirit.name}: 没有能量明细`);
      } else {
        const exp = entryEnergy(spirit);
        if (declared.entry !== recomputed.usable) {
          problems.push(`${label}/${spirit.name}: 上场能量标 ${declared.entry}，复算 ${recomputed.usable}`);
        }
        if (declared.cap !== exp.cap) problems.push(`${label}/${spirit.name}: 能量上限标 ${declared.cap}，应为 ${exp.cap}`);
        if (declared.costs.join(',') !== chosen.map((s) => s.energy ?? 0).join(',')) {
          problems.push(`${label}/${spirit.name}: 技能能耗明细与图鉴不一致`);
        }
        if (declared.maxCost !== recomputed.maxCost) problems.push(`${label}/${spirit.name}: 最高技能能耗标 ${declared.maxCost}，复算 ${recomputed.maxCost}`);
        if (declared.gatherTurns !== recomputed.gatherTurnsForMax) {
          problems.push(`${label}/${spirit.name}: 聚能回合标 ${declared.gatherTurns}，复算 ${recomputed.gatherTurnsForMax}`);
        }
        if (declared.status !== recomputed.status) problems.push(`${label}/${spirit.name}: 能量状态标 ${declared.status}，复算 ${recomputed.status}`);
        if ((declared.firstTurn?.name ?? null) !== (recomputed.firstTurn?.name ?? null)) {
          problems.push(`${label}/${spirit.name}: 首回合可用招标 ${declared.firstTurn?.name ?? '无'}，复算 ${recomputed.firstTurn?.name ?? '无'}`);
        }
        if (!declared.recoveries.length) problems.push(`${label}/${spirit.name}: 没有写回能手段（没有也要写「靠聚能」）`);
        if (declared.entry > 0 && !declared.entryDetail) problems.push(`${label}/${spirit.name}: 上场能量没有写依据`);
      }

      /* 特性是否真的能用 */
      const teamSets = chosenSets
        .filter((s): s is { spirit: Spirit; chosen: ResolvedSkill[] } => Boolean(s.spirit))
        .map((s) => ({ spirit: s.spirit, chosen: s.chosen }));
      const act = traitActivation(spirit, chosen, teamSets);
      if (member.traitStatus !== act.status) {
        problems.push(`${label}/${spirit.name}: 特性状态标 ${member.traitStatus}，复算 ${act.status}（${act.reason}）`);
      }
      if (act.status === 'idle') {
        idleTraits += 1;
        if (!/未触发/.test(member.traitSynergy ?? '')) {
          problems.push(`${label}/${spirit.name}: 特性「${spirit.trait?.name}」在本套空转，但 traitSynergy 没写「未触发」`);
        }
      } else {
        activeTraits += 1;
      }
      entryTotal += recomputed.usable;
    }

    /* 队内互斥：一条特性把队友的回能/回血关掉 */
    const conflicts = teamConflicts(chosenSets.filter((s): s is { spirit: Spirit; chosen: ResolvedSkill[] } => Boolean(s.spirit)));
    for (const c of conflicts) problems.push(`${label}: 队内互斥——${c.reason}`);

    stat.activeTraits += activeTraits;
    stat.idleTraits += idleTraits;
    stat.entryTotal += entryTotal;

    /* 覆盖口径：必须按「推荐 4 招」算，并与 metrics 对上 */
    const chosenCoverage = new Set<string>();
    const learnCoverage = new Set<string>();
    for (const member of preset.members) {
      const spirit = spiritsById.get(member.spiritId);
      if (!spirit) continue;
      const ch = member.skills.map((ref) => resolveMemberSkill(member.spiritId, ref.name)).filter((s): s is ResolvedSkill => Boolean(s));
      for (const t of coverageOf(spirit, ch)) chosenCoverage.add(t);
      for (const t of coverageOf(spirit, learnable(member.spiritId))) learnCoverage.add(t);
    }
    stat.coverage.push({ id: preset.id, chosen: chosenCoverage.size, learnset: learnCoverage.size });
    if (preset.metrics) {
      if (preset.metrics.coverageChosen !== chosenCoverage.size) {
        problems.push(`${label}: metrics 覆盖标 ${preset.metrics.coverageChosen}，按 4 招复算 ${chosenCoverage.size}`);
      }
      if (preset.metrics.coverageLearnset !== learnCoverage.size) {
        problems.push(`${label}: 学习面覆盖标 ${preset.metrics.coverageLearnset}，复算 ${learnCoverage.size}`);
      }
      if (preset.metrics.entryTotal !== entryTotal) {
        problems.push(`${label}: 入场能量合计标 ${preset.metrics.entryTotal}，复算 ${entryTotal}`);
      }
    } else {
      problems.push(`${label}: 没有覆盖/能量 metrics（口径无法核对）`);
    }
    const summaryCover = /覆盖\s*(\d+)\s*\/\s*18/.exec(preset.summary);
    if (summaryCover && Number(summaryCover[1]) !== chosenCoverage.size) {
      problems.push(`${label}: 简介写覆盖 ${summaryCover[1]}/18，按 4 招是 ${chosenCoverage.size}/18`);
    }

    /* 起手 */
    if (!preset.lead) {
      problems.push(`${label}: 没有起手第一只`);
    } else {
      const leadSpirit = spiritsById.get(preset.lead.spiritId);
      if (!leadSpirit || !memberIds.includes(preset.lead.spiritId)) problems.push(`${label}: 起手精灵不在队里`);
      if (preset.lead.why.length < 12) problems.push(`${label}: 起手理由太短`);
      if (!preset.lead.caution) problems.push(`${label}: 起手没有换人提醒`);
      if (preset.lead.openers.length < 1 || preset.lead.openers.length > 2) problems.push(`${label}: 开场技能应为 1~2 个`);
      const leadMember = preset.members.find((m) => m.spiritId === preset.lead.spiritId);
      const leadNames = new Set((leadMember?.skills ?? []).map((s) => s.name));
      for (const op of preset.lead.openers) {
        if (!leadNames.has(op.name)) problems.push(`${label}: 开场技能「${op.name}」不在首发精灵的 4 招里`);
      }
      if (leadMember && leadMember.role !== '先手') warnings.push(`${label}: 首发角色是「${leadMember.role}」不是先手`);
    }

    /* 联动：证据 + 因果 */
    if (preset.synergies.length < 2) problems.push(`${label}: 核心联动只有 ${preset.synergies.length} 条，至少 2 条`);
    if (preset.synergies.length > 5) problems.push(`${label}: 核心联动 ${preset.synergies.length} 条，应为 2~5 条`);
    for (const [i, syn] of preset.synergies.entries()) {
      stat.synergies += 1;
      const tag = `${label}/联动${i + 1}`;
      if (!syn.title || !syn.text || syn.text.length < 30) problems.push(`${tag}: 标题/说明缺失或过短`);
      if (!syn.spiritIds.length) problems.push(`${tag}: 没有引用队内精灵`);
      for (const sid of syn.spiritIds) if (!memberIds.includes(sid)) problems.push(`${tag}: 引用了非成员 ${sid}`);
      for (const ref of syn.skills) {
        const member = preset.members.find((m) => m.spiritId === ref.spiritId);
        if (!member) {
          problems.push(`${tag}: 技能「${ref.name}」的持有者不在队里`);
          continue;
        }
        if (!member.skills.some((s) => s.name === ref.name)) {
          problems.push(`${tag}: 「${ref.name}」不在 ${spiritsById.get(ref.spiritId)?.name ?? ref.spiritId} 的推荐 4 招里（只可学不算）`);
        }
      }
      for (const re of FAKE_CAUSE) {
        if (re.test(syn.text)) problems.push(`${tag}: 出现无原文支持的因果关系「${re.exec(syn.text)?.[0]}」`);
      }
      if (syn.confidence === 'verified' && !syn.evidence) problems.push(`${tag}: 标 verified 却没有 evidence 原文`);
      if (syn.evidence) {
        const cited = syn.skills.map((ref) => {
          const sk = resolveMemberSkill(ref.spiritId, ref.name);
          return sk?.effect ?? '';
        });
        const traits = syn.spiritIds.map((sid) => spiritsById.get(sid)?.trait?.effect ?? '');
        const haystack = [...cited, ...traits].join('\n');
        const probe = syn.evidence.replace(/…/g, '');
        const pieces = probe.split(/[；;]/).filter((p) => p.length >= 4);
        const hit = pieces.length ? pieces.some((p) => haystack.includes(p)) : haystack.includes(probe);
        if (!hit) problems.push(`${tag}: evidence 找不到对应的图鉴原文`);
      }
      const bad = BAD_TEXT.exec(`${syn.title} ${syn.text}`);
      if (bad) problems.push(`${tag}: 文案含 ${bad[0]}`);
    }

    /* 5 阶段 */
    if (preset.battlePlan.length !== 5) problems.push(`${label}: 战术配合链 ${preset.battlePlan.length} 阶段，应为 5 阶段`);
    if (preset.battlePlan.map((p) => p.label).join('/') !== PHASE_LABELS.join('/')) {
      problems.push(`${label}: 战术阶段顺序不对`);
    }
    for (const [i, phase] of preset.battlePlan.entries()) {
      stat.phases += 1;
      const tag = `${label}/${phase.label}`;
      if (!PHASE_KEYS.includes(phase.key)) problems.push(`${tag}: 未知阶段 key`);
      if (!phase.title || !phase.text || phase.text.length < 40) problems.push(`${tag}: 标题/说明缺失或过短`);
      for (const sid of phase.spiritIds) if (!memberIds.includes(sid)) problems.push(`${tag}: 引用非成员 ${sid}`);
      for (const ref of phase.skills) {
        const member = preset.members.find((m) => m.spiritId === ref.spiritId);
        if (!member || !member.skills.some((s) => s.name === ref.name)) {
          problems.push(`${tag}: 「${ref.name}」不在该成员的推荐 4 招里`);
        }
      }
      if (BAD_TEXT.test(`${phase.title} ${phase.text}`)) problems.push(`${tag}: 文案含非法字符`);
    }
    if (preset.lead) {
      const leadSpirit = spiritsById.get(preset.lead.spiritId);
      if (leadSpirit && preset.battlePlan[0] && !preset.battlePlan[0].text.includes(leadSpirit.name.replace(/（[^）]*）/g, ''))) {
        problems.push(`${label}: 开局阶段没有点名首发`);
      }
    }

    /* chain */
    for (const step of preset.chain) {
      if (!memberIds.includes(step.spiritId)) problems.push(`${label}: 联动引用了非成员`);
      if (step.skillName) {
        const member = preset.members.find((m) => m.spiritId === step.spiritId);
        if (!member?.skills.some((s) => s.name === step.skillName)) {
          problems.push(`${label}: chain 引用「${step.skillName}」不在 4 招里`);
        }
      }
      if (!step.text) problems.push(`${label}: 联动说明为空`);
    }

    /* 六项分析 */
    const analysis = preset.analysis;
    if (!analysis) {
      problems.push(`${label}: 没有六项团队配合分析`);
    } else {
      const need: [keyof typeof analysis, string][] = [
        ['core', '核心输出与辅助配合'],
        ['coverage', '属性覆盖及克制关系'],
        ['resilience', '防御、续航、控制与反制'],
        ['rotation', '上场顺序与轮换'],
        ['energy', '能量分配与剩余'],
        ['counters', '面对不同敌方阵容'],
      ];
      for (const [key, name] of need) {
        const block = analysis[key];
        if (!block) {
          problems.push(`${label}: 缺少「${name}」分析`);
          continue;
        }
        if (block.key !== key) problems.push(`${label}: 「${name}」block.key=${block.key}`);
        if (!block.title || !block.text || block.text.length < 40) problems.push(`${label}: 「${name}」说明过短`);
        if (!block.bullets.length) problems.push(`${label}: 「${name}」没有条目`);
        for (const sid of block.spiritIds) if (!memberIds.includes(sid)) problems.push(`${label}: 「${name}」引用非成员`);
      }
      const e = analysis.energy;
      if (e && preset.energySummary) {
        if (!e.text.includes(String(preset.energySummary.entryTotal))) {
          problems.push(`${label}: 能量分析没有写出 6 只入场合计 ${preset.energySummary.entryTotal}`);
        }
        if (!e.text.includes(String(preset.energySummary.avgCost))) {
          problems.push(`${label}: 能量分析没有写出平均能耗 ${preset.energySummary.avgCost}`);
        }
      }
    }
  }

  /* 3) 跨队与历史 */
  stat.uniqueSpirits = new Set(allIds).size;
  stat.uniqueDex = new Set(allDex).size;
  if (stat.uniqueSpirits !== allIds.length) problems.push('本轮 3 套之间有重复精灵');
  if (stat.uniqueDex !== allDex.length) problems.push('本轮 3 套之间出现同图鉴编号');

  const current = history.rounds.find((r) => r.round === rotation.round);
  if (!current) {
    problems.push(`rotation-history.json 里没有第 ${rotation.round} 轮`);
  } else {
    const same = current.spiritIds.length === allIds.length && current.spiritIds.every((id, i) => id === allIds[i]);
    if (!same) problems.push(`rotation-history.json 第 ${rotation.round} 轮的 spiritId 与 team-rotation.json 不一致`);
  }
  const previous = history.rounds.filter((r) => r.round < rotation.round).sort((a, b) => b.round - a.round)[0];
  if (previous) {
    const prev = new Set(previous.spiritIds);
    const overlap = allIds.filter((id) => prev.has(id));
    if (overlap.length) {
      warnings.push(`与第 ${previous.round} 轮重叠 ${overlap.length} 只`);
      for (const preset of rotation.teams) {
        const hits = preset.members.filter((m) => prev.has(m.spiritId));
        if (hits.length && !/重叠/.test(preset.risk)) {
          problems.push(`[${preset.id}] 与上一轮重叠 ${hits.length} 只，但弱点里没有说明`);
        }
      }
    }
  }

  return { problems, warnings, stats: stat };
}

/** 数组顺序参与历史去重，所以导出这个工具给生成器用 */
export function orderedIds(rotation: TeamRotationFile): string[] {
  return rotation.teams.flatMap((t) => t.members.map((m) => m.spiritId));
}

export function spiritName(id: string): string {
  return spiritsById.get(id)?.name ?? id;
}

export { ROLES, PHASE_LABELS };
