export interface Stats {
  hp: number | null;
  atk: number | null;
  def: number | null;
  spa: number | null;
  spd: number | null;
  spe: number | null;
  total: number | null;
}

export interface Trait {
  name: string;
  effect: string;
}

export interface Measure {
  min: number;
  max: number;
  unit: string;
  raw: string;
}

export interface Spirit {
  id: string;
  dex: string;
  name: string;
  page: string;
  type: string[];
  stats: Stats;
  trait: Trait | null;
  stage: number | null;
  form: string;
  /** 形态名称，如「首领形态」「蓬松的样子」 */
  formLabel: string;
  season: string | null;
  eggGroups: string[];
  height: Measure | null;
  weight: Measure | null;
  rideable: boolean;
  doubleRide: boolean;
  avatar: string;
  desc: string;
  learnset: string | null;
  extraStones?: string[];
}

/** [skill id, learn code (0 = by level, 1 = skill stone, 2 = blood line), level?] */
export type LearnEntry = [string, number, number?];

export type Learnsets = Record<string, LearnEntry[]>;

export interface Skill {
  id: string;
  name: string;
  type: string;
  category: string;
  power: number | null;
  energy: number | null;
  effect: string;
  /** real upload URL resolved from the wiki's `icon` file name; null when the wiki has no file */
  icon?: string | null;
}

/** 性格：wiki 只公布提升/降低哪一项能力，不公布百分比。 */
export interface Nature {
  id: number;
  name: string;
  up: string;
  upKey: 'hp' | 'atk' | 'def' | 'spa' | 'spd' | 'spe';
  down: string;
  downKey: 'hp' | 'atk' | 'def' | 'spa' | 'spd' | 'spe';
  subnatures: string[];
}

export interface NatureTable {
  stats: { id: number; name: string }[];
  statKeys: Record<string, string>;
  rows: Nature[];
  source: { module: string; moduleUrl: string; page: string };
}

/** 血脉：每个学习面在 18 系别血脉 + 普通血脉下各继承一个血脉技能。 */
export interface BloodlineTable {
  levels: Record<string, number | null>;
  order: string[];
  sets: Record<string, Record<string, string>>;
  learnset: Record<string, string>;
  source: { module: string; moduleUrl: string; page: string };
}

export interface TypeMeta {
  name: string;
  id: number;
  icon: string;
  color: string;
  light: string;
  dark: string;
}

export interface TypeChart {
  types: TypeMeta[];
  statusImmunity: Record<string, string>;
  defense: Record<string, Record<string, number>>;
  pairs: Record<string, Record<string, number>>;
  derivedPairs: string[];
  rule: string;
  multipliers: number[];
  source: { module: string; moduleUrl: string; page: string };
}

export interface Meta {
  game: string;
  spiritCount: number;
  pageReportedCount: number | null;
  fetchedAt: string;
  sources: { name: string; url: string }[];
  fieldsFromWiki: string[];
  notPublished: string[];
  coverage: Record<string, number>;
  byType: Record<string, number>;
  spiritsWithoutSkills: string[];
  typeChart: { types: number; singleEntries: number; dualEntries: number; derivedPairs: string[]; multipliers: number[] };
}

export type LearnCode = 0 | 1 | 2;

export interface ResolvedSkill extends Skill {
  learn: LearnCode;
  level?: number;
}
