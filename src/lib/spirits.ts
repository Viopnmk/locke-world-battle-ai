import spiritsData from '../data/spirits.json';
import learnsetsData from '../data/learnsets.json';
import skillsData from '../data/skills.json';
import metaData from '../data/meta.json';
import type { LearnEntry, Learnsets, Meta, ResolvedSkill, Skill, Spirit } from './types';

export const spirits = spiritsData as unknown as Spirit[];
export const learnsets = learnsetsData as unknown as Learnsets;
export const meta = metaData as unknown as Meta;

const skillById = new Map<string, Skill>((skillsData as unknown as Skill[]).map((s) => [s.id, s]));
export const skills: Skill[] = skillsData as unknown as Skill[];

export const spiritsById = new Map<string, Spirit>(spirits.map((s) => [s.id, s]));

/** Searchable blob per spirit, built once (name, dex, page title, types). */
const haystack = new Map<string, string>(
  spirits.map((s) => [s.id, `${s.name} ${s.page} ${s.dex} ${s.type.join(' ')}`.toLowerCase()]),
);

export function searchSpirits(query: string, typeFilter: string | null): Spirit[] {
  const q = query.trim().toLowerCase();
  return spirits.filter((s) => {
    if (typeFilter && !s.type.includes(typeFilter)) return false;
    if (!q) return true;
    const blob = haystack.get(s.id) ?? '';
    return blob.includes(q) || s.id.toLowerCase().includes(q);
  });
}

/** Dex order, then id — the wiki lists forms of one spirit next to each other. */
export function sortByDex(list: Spirit[]): Spirit[] {
  return [...list].sort((a, b) => {
    const na = Number(a.dex) || 9999;
    const nb = Number(b.dex) || 9999;
    return na - nb || a.id.localeCompare(b.id);
  });
}

const LEARN_ORDER = [0, 1, 2] as const;

export function skillsOf(spirit: Spirit): ResolvedSkill[] {
  const entries: LearnEntry[] = [...(spirit.learnset ? learnsets[spirit.learnset] ?? [] : [])];
  const known = new Set(entries.map((e) => e[0]));
  for (const id of spirit.extraStones ?? []) {
    if (!known.has(id)) {
      entries.push([id, 1]);
      known.add(id);
    }
  }
  const out: ResolvedSkill[] = [];
  for (const [id, code, level] of entries) {
    const skill = skillById.get(id);
    if (!skill) continue;
    out.push({ ...skill, learn: code as ResolvedSkill['learn'], level });
  }
  return out.sort((a, b) => {
    const la = LEARN_ORDER.indexOf(a.learn);
    const lb = LEARN_ORDER.indexOf(b.learn);
    if (la !== lb) return la - lb;
    if (a.learn === 0 && b.learn === 0) return (a.level ?? 999) - (b.level ?? 999);
    return a.name.localeCompare(b.name, 'zh-Hans-CN');
  });
}

export function skillGroups(list: ResolvedSkill[]): { key: string; title: string; hint: string; skills: ResolvedSkill[] }[] {
  return [
    { key: 'level', title: '升级学习', hint: '按等级', skills: list.filter((s) => s.learn === 0) },
    { key: 'stone', title: '技能石', hint: '技能石 / 赛季补给', skills: list.filter((s) => s.learn === 1) },
    { key: 'bloodline', title: '血脉技能', hint: '血脉继承', skills: list.filter((s) => s.learn === 2) },
  ].filter((g) => g.skills.length > 0);
}

export function typeCounts(): { type: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const s of spirits) {
    for (const t of s.type) counts.set(t, (counts.get(t) ?? 0) + 1);
  }
  return [...counts.entries()].map(([type, count]) => ({ type, count }));
}

export function spiritsWithTypes(types: string[]): Spirit[] {
  const wanted = types.filter(Boolean);
  if (wanted.length === 0) return [];
  return spirits.filter((s) => wanted.every((t) => s.type.includes(t)));
}
