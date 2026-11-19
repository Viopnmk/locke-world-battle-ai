/**
 * 特性可用性判定（「这条特性在这 4 招里到底转不转」）
 *
 * 审计结论里最伤的一类错误，是把特性的机制当作文案直接抄进联动：
 * 「连续负荷」写着迸发延长，配的 4 招里一个迸发技能都没有；
 * 「草木苏醒时」每回复 1 能量加双攻，4 招里没有任何回能手段。
 * 这个模块只做一件事：把特性原文翻译成「它需要什么触发源」，再去 4 招里找。
 * 找不到就判 idle（空转），并给出学习面里能点亮的替代技能——绝不默认它能用。
 */
import { skillEnergyEffect } from './energy';
import { skillsOf } from './spirits';
import type { ResolvedSkill, Spirit } from './types';

export type TraitStatus = 'active' | 'conditional' | 'idle';

export interface TraitNeed {
  id: string;
  label: string;
  /** 需要 4 招里出现这样的技能 */
  matchSkill?: (sk: ResolvedSkill) => boolean;
  /** 需要对整套 4 招一起判断（例如「总技能能耗小于4」） */
  checkSet?: (chosen: ResolvedSkill[]) => boolean;
  /** 需要队友配合（换人惩罚、同系垫能等） */
  needsTeam?: boolean;
}

export interface TraitActivation {
  status: TraitStatus;
  /** 触发源（技能名 / 「入场时」/「队友」） */
  trigger: string | null;
  /** 判定说明：为什么成立 / 为什么空转 */
  reason: string;
  /** idle 时：学习面里能点亮的技能 */
  suggestion: { name: string; energy: number; why: string } | null;
  needs: TraitNeed[];
}

const has = (text: string, re: RegExp) => re.test(text);
const appliesStatus = (status: string) => (sk: ResolvedSkill) => new RegExp(`获得[^。；]{0,6}${status}`).test(sk.effect ?? '');
const charges = (sk: ResolvedSkill) => /蓄力/.test(sk.effect ?? '') && !/无需蓄力|蓄力状态|蓄力时|蓄力中/.test(sk.effect ?? '');
const counters = (sk: ResolvedSkill) => /应对/.test(sk.effect ?? '');
const bursts = (sk: ResolvedSkill) => /迸发[：:]/.test(sk.effect ?? '') && !/获得[^。；]{0,10}迸发/.test(sk.effect ?? '');
const zeroCost = (sk: ResolvedSkill) => (sk.energy ?? 0) === 0;
const recovers = (sk: ResolvedSkill) => skillEnergyEffect(sk).selfFixed > 0 || /回复能量/.test(sk.effect ?? '');
const damages = (sk: ResolvedSkill) => (sk.power ?? 0) > 0;
const defSkills = (sk: ResolvedSkill) => sk.category === '防御' || /减伤\d+%/.test(sk.effect ?? '');
const forcesSwitch = (sk: ResolvedSkill) => /使敌方[^。；]{0,6}返场|使敌方精灵返场|敌方和自己均脱离|强制换人/.test(sk.effect ?? '');

/**
 * 从特性原文解析出「它需要什么」。返回空数组 = 纯常驻/观察类特性（入场时、在場时、
 * 每有1只力竭…），不需要特定技能就能生效，但也要在文案里写清触发时机。
 */
export function traitNeeds(effect: string | null | undefined): TraitNeed[] {
  const text = effect ?? '';
  if (!text) return [];
  const needs: TraitNeed[] = [];

  if (has(text, /每回复1能量|回复1能量，/) && !/回合结束时/.test(text)) {
    needs.push({
      id: 'recover',
      label: '需要「自己回复能量」的技能来喂',
      matchSkill: recovers,
    });
  }
  if (has(text, /蓄力状态|进入蓄力|蓄力时/)) {
    needs.push({ id: 'charge', label: '需要 4 招里有蓄力技', matchSkill: charges });
  }
  if (has(text, /迸发/)) {
    needs.push({ id: 'burst', label: '需要 4 招里有带「迸发」的技能', matchSkill: bursts });
  }
  if (has(text, /能耗为0的技能/)) {
    needs.push({ id: 'zero-cost', label: '需要 4 招里有 0 费技能', matchSkill: zeroCost });
  }
  if (has(text, /应对成功/)) {
    needs.push({ id: 'counter', label: '需要自己的应对技（应对攻击/状态/防御）', matchSkill: counters });
  }
  if (has(text, /(?:^|，)自己使用(.)系技能后|^使用(.)系技能后/)) {
    const m = /(?:^|，)自己使用(.)系技能后/.exec(text) ?? /^使用(.)系技能后/.exec(text);
    const type = m?.[1] ?? m?.[2] ?? '';
    if (type) {
      needs.push({
        id: 'self-type',
        label: `需要自己的${type}系技能触发`,
        matchSkill: (sk) => sk.type === type,
      });
    }
  }
  if (has(text, /己方精灵每使用1次(.)系技能/)) {
    const type = /己方精灵每使用1次(.)系技能/.exec(text)?.[1] ?? '';
    needs.push({ id: 'ally-type', label: `队友每用 1 次${type}系技能垫层（不含自己，待验证）`, needsTeam: true });
  }
  if (has(text, /己方精灵每成功应对/)) {
    needs.push({ id: 'ally-counter', label: '队友需要成功应对来垫能量', needsTeam: true });
  }
  if (has(text, /己方精灵每使用1次防御技能/)) {
    needs.push({ id: 'ally-defense', label: '队友每用 1 次防御技能垫层', needsTeam: true });
  }
  if (has(text, /敌方精灵离场后|更换入场的精灵|敌方本回合更换精灵/)) {
    needs.push({ id: 'enemy-switch', label: '需要能把敌方逼下场（或对手主动换人）', needsTeam: true });
  }
  if (has(text, /防御技能应对(\d+)次后/)) {
    const times = Number(/防御技能应对(\d+)次后/.exec(text)?.[1] ?? 1);
    needs.push({
      id: 'defense-counters',
      label: `需要 ${times} 次防御技应对成功`,
      checkSet: (chosen) => chosen.filter((sk) => /减伤\d+%/.test(sk.effect ?? '') && /应对/.test(sk.effect ?? '')).length >= times,
    });
  }
  if (has(text, /总技能能耗小于(\d+)时/)) {
    const limit = Number(/总技能能耗小于(\d+)时/.exec(text)?.[1] ?? 0);
    needs.push({
      id: 'total-cost',
      label: `4 招总能耗要小于 ${limit}`,
      checkSet: (chosen) => chosen.reduce((a, sk) => a + (sk.energy ?? 0), 0) < limit,
    });
  }
  if (has(text, /使用能耗小于等于(\d+)的技能时/)) {
    const limit = Number(/使用能耗小于等于(\d+)的技能时/.exec(text)?.[1] ?? 0);
    needs.push({
      id: 'cheap-skill',
      label: `需要 ${limit} 费及以下的技能触发`,
      matchSkill: (sk) => (sk.energy ?? 0) <= limit,
    });
  }
  if (has(text, /自己每有1层(萌化|冻结|中毒|灼烧|寄生|引电)/)) {
    const status = /自己每有1层(萌化|冻结|中毒|灼烧|寄生|引电)/.exec(text)?.[1] ?? '';
    needs.push({
      id: 'self-status',
      label: `需要先给自己叠「${status}」`,
      matchSkill: (sk) => new RegExp(`自己获得[^。；]{0,6}${status}`).test(sk.effect ?? ''),
    });
  }
  if (has(text, /自己力竭时|自己倒下时/)) {
    needs.push({ id: 'self-faint', label: '只在自己力竭时结算（负面：给对手加成）', needsTeam: true });
  }
  if (has(text, /每有1只力竭/)) {
    needs.push({ id: 'defeat', label: '按双方力竭只数结算', needsTeam: true });
  }
  if (has(text, /造成克制伤害后/)) {
    needs.push({ id: 'resist-hit', label: '需要打出 ×2 克制伤害', matchSkill: damages });
  }
  if (has(text, /获得(冻结|中毒|灼烧|寄生|萌化|引电)/)) {
    const status = /获得(冻结|中毒|灼烧|寄生|萌化|引电)/.exec(text)?.[1] ?? '';
    needs.push({
      id: 'apply-status',
      label: `需要 4 招里能施加「${status}」`,
      matchSkill: appliesStatus(status),
    });
  }
  if (has(text, /天气/)) {
    needs.push({ id: 'weather', label: '需要能改天气的技能', matchSkill: (sk) => /天气/.test(sk.effect ?? '') });
  }
  if (has(text, /初始能量为0/)) {
    needs.push({ id: 'zero-entry', label: '入场 0 能量：需要队友先垫能量', needsTeam: true });
  }
  return needs;
}

export interface TeamSkillSet {
  spirit: Spirit;
  chosen: ResolvedSkill[];
}

/**
 * 判定这只精灵在这套 4 招（+队友）里特性是否转得起来。
 * active：4 招里直接有触发源；conditional：依赖对手行为或入场/回合时机；
 * idle：4 招里找不到触发源——必须在文案里写「本套未触发」，并给出替代技能。
 */
export function traitActivation(spirit: Spirit, chosen: ResolvedSkill[], team: TeamSkillSet[]): TraitActivation {
  const effect = spirit.trait?.effect ?? '';
  const needs = traitNeeds(effect);
  if (!effect) {
    return { status: 'idle', trigger: null, reason: '图鉴未提供特性', suggestion: null, needs };
  }
  if (!needs.length) {
    const onEntry = /入场时|入场后首次行动/.test(effect);
    const depends = /若|当|受到|击败|每有|处于|敌方血脉|环境/.test(effect);
    const brief = effect.length > 46 ? `${effect.slice(0, 46)}…` : effect;
    return {
      status: 'conditional',
      trigger: onEntry ? '入场时' : '在场时',
      reason: depends
        ? `条件触发（取决于对手/环境，本套不保证满足）：原文「${brief}」`
        : `${onEntry ? '入场即结算' : '在场结算'}，不需要特定技能：原文「${brief}」`,
      suggestion: null,
      needs,
    };
  }

  const missing: TraitNeed[] = [];
  let trigger: string | null = null;

  for (const need of needs) {
    if (need.checkSet) {
      if (need.checkSet(chosen)) {
        trigger = trigger ? `${trigger}、4 招能耗合计满足` : '4 招能耗合计满足';
        continue;
      }
      missing.push(need);
      continue;
    }
    if (need.matchSkill) {
      const hit = chosen.find((sk) => need.matchSkill!(sk));
      if (hit) {
        trigger = trigger ? `${trigger}、${hit.name}` : hit.name;
        continue;
      }
      missing.push(need);
      continue;
    }
    if (need.needsTeam) {
      // 队友侧：在队内其它精灵的 4 招里找触发源
      const mates = team.filter((t) => t.spirit.id !== spirit.id);
      if (need.id === 'ally-type') {
        const type = /每使用1次(.)系技能/.exec(effect)?.[1] ?? '';
        const ally = mates.find((t) => t.chosen.some((sk) => sk.type === type));
        if (ally) {
          trigger = trigger ? `${trigger}、${ally.spirit.name}的${type}系技能` : `${ally.spirit.name}的${type}系技能`;
          continue;
        }
      }
      if (need.id === 'ally-counter') {
        const ally = mates.find((t) => t.chosen.some(counters));
        if (ally) {
          trigger = trigger ? `${trigger}、${ally.spirit.name}的应对技` : `${ally.spirit.name}的应对技`;
          continue;
        }
      }
      if (need.id === 'ally-defense') {
        const ally = mates.find((t) => t.chosen.some(defSkills));
        if (ally) {
          trigger = trigger ? `${trigger}、${ally.spirit.name}的防御技` : `${ally.spirit.name}的防御技`;
          continue;
        }
      }
      if (need.id === 'enemy-switch') {
        const ally = mates.find((t) => t.chosen.some(forcesSwitch));
        if (ally) {
          trigger = trigger ? `${trigger}、${ally.spirit.name}的逼退` : `${ally.spirit.name}的逼退`;
          continue;
        }
      }
      if (need.id === 'zero-entry') {
        // 入场 0 能量本身不是「能不能触发」，而是风险；由能量模块负责
        continue;
      }
      if (need.id === 'defeat' || need.id === 'self-faint') {
        continue;
      }
      missing.push(need);
    }
  }

  if (missing.length) {
    // 学习面里找能点亮的替代技能
    let suggestion: TraitActivation['suggestion'] = null;
    const need = missing[0];
    if (need.matchSkill) {
      const pool = skillsOf(spirit);
      const fit = pool
        .filter((sk) => need.matchSkill!(sk))
        .filter((sk) => (sk.energy ?? 0) <= 4)
        .sort((a, b) => (a.energy ?? 99) - (b.energy ?? 99) || (b.power ?? 0) - (a.power ?? 0))[0];
      if (fit) suggestion = { name: fit.name, energy: fit.energy ?? 0, why: need.label };
    }
    return {
      status: 'idle',
      trigger: null,
      reason: `本套 4 招里没有「${need.label}」的来源`,
      suggestion,
      needs,
    };
  }

  const negative = needs.some((n) => n.id === 'self-faint');
  return {
    status: 'conditional',
    trigger,
    reason: negative ? `只在自己力竭时结算（对己方不利）：原文「${effect.length > 40 ? `${effect.slice(0, 40)}…` : effect}」` : `触发源：${trigger ?? '入场/在场时机'}`,
    suggestion: null,
    needs,
  };
}

/* 一行可读结论，直接用于卡片「特性」那一行 */
export function traitLine(spirit: Spirit, chosen: ResolvedSkill[], team: TeamSkillSet[]): string {
  const act = traitActivation(spirit, chosen, team);
  const name = spirit.trait?.name ?? '特性';
  if (act.status === 'idle') {
    const fix = act.suggestion
      ? `；换成「${act.suggestion.name}」（${act.suggestion.energy} 费）就能点亮`
      : '；本套没有可替换的触发技';
    return `「${name}」${act.reason}${fix}`;
  }
  return `「${name}」${act.reason}`;
}

/* ------------------------------------------------------------ 队内互斥 */

export interface TeamConflict {
  aId: string;
  aName: string;
  bId: string;
  bName: string;
  reason: string;
}

/**
 * 队内互斥：一条特性会直接关掉另一只的回能/回血来源。
 * 例：「陨落：在场时，双方回合结束时的效果不会触发」会把队友「毒蘑菇：回合结束时偷取…」
 * 直接废掉——这种同队组合必须在生成时避开，校验时也要拦住。
 */
export function teamConflicts(team: { spirit: Spirit; chosen: ResolvedSkill[] }[]): TeamConflict[] {
  const out: TeamConflict[] = [];
  for (const a of team) {
    const aEff = a.spirit.trait?.effect ?? '';
    if (!/回合结束时的效果不会触发/.test(aEff)) continue;
    for (const b of team) {
      if (b.spirit.id === a.spirit.id) continue;
      const bTrait = b.spirit.trait?.effect ?? '';
      const bSkillTurnEnd = b.chosen.some((sk) => /回合结束时/.test(sk.effect ?? ''));
      if (/回合结束时/.test(bTrait) || bSkillTurnEnd) {
        out.push({
          aId: a.spirit.id,
          aName: a.spirit.name,
          bId: b.spirit.id,
          bName: b.spirit.name,
          reason: `「${a.spirit.trait?.name}」让双方回合结束时的效果不触发，${b.spirit.name} 的${/回合结束时/.test(bTrait) ? `特性「${b.spirit.trait?.name}」` : '回合结束类技能'}会被一起关掉`,
        });
      }
    }
  }
  return out;
}
