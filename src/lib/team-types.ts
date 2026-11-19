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
  /** 技能位：主攻 / 补盲 / 机制 / 防守（由生成脚本按角色算出来） */
  slot?: string;
}

export interface PresetMember {
  spiritId: string;
  /** 先手 / 核心输出 / 控制 / 辅助 / 承伤 / 收割 */
  role: string;
  /** 角色在队里的具体职责，例如「首发抢节奏」「属性联防盾」 */
  duty?: string;
  note: string;
  /** 4 个推荐技能，全部来自这只精灵的学习面 */
  skills: PresetSkillRef[];
  /** 特性在本队里的用法（图鉴原文 + 队内联动） */
  traitSynergy?: string;
}

/** 起手第一只：谁首发、为什么、开场打哪两招 */
export interface LeadPlan {
  spiritId: string;
  /** 为什么由它起手（速度 / 先手 / 强化 / 弱点数量） */
  why: string;
  /** 开场两招：先做什么、再做什么 */
  openers: PresetSkillRef[];
  /** 首发要盯的换人点 */
  caution: string;
}

/** 核心技能联动：队内两条真实的机制如何接上 */
export interface SkillSynergy {
  /** 联动标题，例如「冻结 → 极寒领域」 */
  title: string;
  /** 具体到技能名、特性名与数值的说明 */
  text: string;
  /** 参与的队内精灵 */
  spiritIds: string[];
  /** 引用的真实技能 */
  skills: { spiritId: string; name: string }[];
}

/** 完整战术配合链的 5 个阶段 */
export interface BattlePhase {
  key: 'opening' | 'advantage' | 'mid' | 'late' | 'comeback';
  /** 开局 / 第一阶段 / 中期 / 后期 / 逆风局 */
  label: string;
  /** 这一阶段的一句话主题 */
  title: string;
  text: string;
  spiritIds: string[];
  skills: { spiritId: string; name: string }[];
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
  /** 起手第一只（用户第一个问的问题） */
  lead: LeadPlan;
  /** 核心技能联动关系 */
  synergies: SkillSynergy[];
  /** 完整团队战术配合链：开局 → 第一阶段 → 中期 → 后期 → 逆风局 */
  battlePlan: BattlePhase[];
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
