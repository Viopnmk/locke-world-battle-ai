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

/** 证据强度：verified = 图鉴/官方文案能直接对上；inferred = 数据推算；unverified = 规则待实测 */
export type Confidence = 'verified' | 'inferred' | 'unverified';

export interface PresetSkillRef {
  /** 技能名，必须与 skills.json 中的 name 完全一致 */
  name: string;
  /** 为什么要带这个技能（真实机制） */
  why: string;
  /** 技能位：主攻 / 补盲 / 机制 / 防守（由生成脚本按角色算出来） */
  slot?: string;
  /** 能耗（原样写出来，页面不用再查） */
  energy?: number;
}

/** 一只精灵的能量明细（上场 / 技能 / 回能 / 剩余） */
export interface MemberEnergyData {
  /** 上场能量（入场时手里有多少点） */
  entry: number;
  /** 上限（默认 10） */
  cap: number;
  /** 上场能量从哪来：普通满 10 / 初始能量为0 / 突破上限… */
  entryLabel: string;
  /** 特性原文说明 */
  entryDetail: string;
  /** 4 个推荐技能的能耗 */
  costs: number[];
  maxCost: number;
  avgCost: number;
  /** 首回合能打出的最强招与剩余能量 */
  firstTurn: { name: string; cost: number; leftover: number } | null;
  /** 打最贵那一招需要聚能几回合（0 = 入场就能打） */
  gatherTurns: number;
  /** 回能手段：特性 / 技能 / 聚能 */
  recoveries: string[];
  /** ready 入场即出招 / gather 需先聚能 / starved 入场打不出 */
  status: 'ready' | 'gather' | 'starved';
  /** 一句话能量风险 */
  caution: string;
  confidence: Confidence;
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
  /** 特性状态：active 4 招里有触发源 / conditional 依赖时机 / idle 本套空转 */
  traitStatus?: 'active' | 'conditional' | 'idle';
  /** 能量明细 */
  energy?: MemberEnergyData;
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
  /** 证据强度 */
  confidence?: Confidence;
  /** 图鉴原文证据（生成器写入，校验脚本反向比对） */
  evidence?: string;
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
  /** 六项团队配合分析（能量、覆盖、轮换、反制…） */
  analysis?: TeamAnalysis;
  /** 能量总览 */
  energySummary?: {
    entryTotal: number;
    avgCost: number;
    maxCost: number;
    readyCount: number;
    gatherCount: number;
    starvedCount: number;
    line: string;
  };
  /** 可复算的数据面板（校验脚本逐项比对） */
  metrics?: {
    avgTotal: number;
    fastest: { name: string; spe: number } | null;
    /** 按推荐 4 招能打出 ≥2 倍的属性数 */
    coverageChosen: number;
    coverageTypes: string[];
    /** 按全学习面能打出 ≥2 倍的属性数（参考，不当作本套实力） */
    coverageLearnset: number;
    sharedWeak: { type: string; count: number; answers: string[] }[];
    entryTotal: number;
    avgCost: number;
    readyCount: number;
  };
}

/** 六项团队配合分析的一个板块 */
export interface AnalysisBlock {
  key: 'core' | 'coverage' | 'resilience' | 'rotation' | 'energy' | 'counters';
  title: string;
  text: string;
  bullets: string[];
  spiritIds: string[];
}

/** 任务要求的 6 项团队配合分析 */
export interface TeamAnalysis {
  /** 1. 核心输出与辅助配合 */
  core: AnalysisBlock;
  /** 2. 属性覆盖及克制关系 */
  coverage: AnalysisBlock;
  /** 3. 防御、续航、控制和反制能力 */
  resilience: AnalysisBlock;
  /** 4. 精灵上场顺序与轮换策略（含零费换人位） */
  rotation: AnalysisBlock;
  /** 5. 能量分配与剩余能量 */
  energy: AnalysisBlock;
  /** 6. 面对不同敌方阵容的应对策略 */
  counters: AnalysisBlock;
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
  previous: {
    round: number;
    updatedAt: string;
    archetypes: { id: string; label: string }[];
    /** 上一轮完整阵容：回滚时可以直接恢复，而不必重算 */
    teams?: TeamPreset[];
  } | null;
  archetypes: { id: string; label: string }[];
  teams: TeamPreset[];
}

export interface RotationHistoryFile {
  rounds: RotationRoundMeta[];
}
