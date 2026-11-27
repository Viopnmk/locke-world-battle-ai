/**
 * 「这只精灵实际能带上场的技能」= 自己的学习面（升级 / 技能石 / 本族血脉记录）+ 改血脉能换来的技能。
 *
 * 培养板块 buildGuide 的配招里会出现「改 X 血脉拿到的那个技能」——它不在 learnsets.json 的
 * 本族记录里（那一条只记这只精灵天生/技能石能学的），而是 bloodlines.json 里「19 选 1」中的一个。
 * 阵容要跟培养页 100% 一致，就必须认这一类技能；否则阵容页解析不到技能名，校验也会误判成「不在学习面里」。
 *
 * 口径（与 equip-rules.ts 一致）：血脉技能同一时间只能用 1 个，这里返回的记录带 learn = 2，
 * 是否超限仍由调用方按 BLOODLINE_SKILL_LIMIT 判断。
 */
import bloodlinesData from '../data/bloodlines.json';
import { skillById, skillsOf } from './spirits';
import type { BloodlineTable, ResolvedSkill, Spirit } from './types';

const table = bloodlinesData as unknown as BloodlineTable;

/** 这只精灵改 18 系 / 普通血脉后能换到的全部技能（每个血脉 1 个，共 19 个候选）。 */
export function bloodSkillsOf(spirit: Spirit): ResolvedSkill[] {
  const setName = table.learnset[spirit.learnset ?? ''] ?? '';
  const set: Record<string, string> = table.sets[setName] ?? {};
  const out: ResolvedSkill[] = [];
  for (const sid of Object.values(set)) {
    const sk = skillById(sid);
    if (!sk) continue;
    out.push({ ...sk, learn: 2 });
  }
  return out;
}

/** 自带学习面 + 19 个血脉候选，按名字去重（自带优先，血脉候选排后面）。 */
export function carriedSkills(spirit: Spirit): ResolvedSkill[] {
  const own = skillsOf(spirit);
  const seen = new Set(own.map((sk) => sk.name));
  const out = [...own];
  for (const sk of bloodSkillsOf(spirit)) {
    if (seen.has(sk.name)) continue;
    seen.add(sk.name);
    out.push(sk);
  }
  return out;
}

/** 按技能名解析这只精灵实际能带的一个技能；自带优先，其次血脉。查不到返回 null。 */
export function resolveCarried(spirit: Spirit, name: string): ResolvedSkill | null {
  return skillsOf(spirit).find((sk) => sk.name === name) ?? bloodSkillsOf(spirit).find((sk) => sk.name === name) ?? null;
}
