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
