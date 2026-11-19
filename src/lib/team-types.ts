/**
 * 「阵容推荐」的数据结构。
 *
 * 页面读 src/data/team-rotation.json（由 scripts/rotate-teams.ts 生成并 baked 进静态包），
 * 因此轮换不依赖用户打开网页。类型单独放这里，是为了让生成脚本只依赖类型、
 * 不依赖已经带数据的 team-presets.ts（否则第一次生成前会因缺 JSON 而打包失败）。
 */

export type TeamCategory =
  | 'rush'
  | 'nuke'
  | 'wall'
  | 'mixed'
  | 'tax'
  | 'sustain'
  | 'status'
  | 'weather'
  | 'mono'
  | 'punish';

export interface PresetSkillRef {
  /** 技能名，必须与 skills.json 中的 name 完全一致 */
  name: string;
  /** 为什么要带这个技能（真实机制） */
  why: string;
}

export interface PresetMember {
  spiritId: string;
  /** 先手 / 核心输出 / 控制 / 辅助 / 承伤 / 收割 */
  role: string;
  note: string;
  skills: PresetSkillRef[];
}

export interface ChainStep {
  spiritId: string;
  /** 可选：这一环用到的真实技能 */
  skillName?: string;
  text: string;
}

export interface TeamPreset {
  id: string;
  name: string;
  sub: string;
  category: TeamCategory;
  /** 战术原型 id（例如 rush / weather） */
  archetype: string;
  archetypeLabel: string;
  tags: string[];
  summary: string;
  /** 优势：全部由数据现算 */
  pros: string[];
  plan: string[];
  /** 弱点与代价：照实写 */
  risk: string;
  chain: ChainStep[];
  members: PresetMember[];
}

export interface RotationTeamMeta {
  id: string;
  name: string;
  category: TeamCategory;
  archetype: string;
  archetypeLabel: string;
  spiritIds: string[];
  spiritNames: string[];
}

export interface RotationRoundMeta {
  round: number;
  updatedAt: string;
  nextRotationAt: string;
  archetypes: { id: string; label: string }[];
  teams: RotationTeamMeta[];
  /** 18 个 spiritId，供下一轮去重 */
  spiritIds: string[];
}

export interface TeamRotationFile {
  round: number;
  updatedAt: string;
  nextRotationAt: string;
  intervalHours: number;
  generatedBy: string;
  dataset: { spiritCount: number; fetchedAt: string };
  previous: { round: number; updatedAt: string; archetypes: { id: string; label: string }[] } | null;
  archetypes: { id: string; label: string }[];
  teams: TeamPreset[];
}

export interface RotationHistoryFile {
  rounds: RotationRoundMeta[];
}
