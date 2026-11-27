/**
 * 阵容推荐：页面只读 src/data/team-rotation.json。
 *
 * 这份 JSON 由 scripts/rotate-teams.ts 每 48 小时重新生成一次并 baked 进静态包，
 * 所以轮换不依赖用户打开网页：部署完成后所有人看到的就是同一轮阵容。
 * 这里只负责把 JSON 变成页面用的类型、解析技能，并给云端模型拼事实块。
 */
import rotationData from '../data/team-rotation.json';
import { resolveCarried } from './carried-skills';
import { spiritsById } from './spirits';
import type { ResolvedSkill, Spirit } from './types';
import type {
  ChainStep,
  PresetMember,
  PresetSkillRef,
  RotationRoundMeta,
  TeamCategory,
  TeamPreset,
  TeamRotationFile,
} from './team-types';

export type { ChainStep, PresetMember, PresetSkillRef, TeamCategory, TeamPreset, TeamRotationFile };

export const TEAM_ROTATION = rotationData as unknown as TeamRotationFile;

/** 当前这一轮的 3 套阵容（页面上只会出现这 3 套） */
export const TEAM_PRESETS: TeamPreset[] = TEAM_ROTATION.teams;

export const ROTATION_ROUND = TEAM_ROTATION.round;
export const ROTATION_UPDATED_AT = TEAM_ROTATION.updatedAt;
export const ROTATION_NEXT_AT = TEAM_ROTATION.nextRotationAt;
export const ROTATION_INTERVAL_HOURS = TEAM_ROTATION.intervalHours;

export const CATEGORY_LABEL: Record<TeamCategory, string> = {
  rush: '速攻压制',
  nuke: '重炮强攻',
  wall: '联防反击',
  mixed: '跨属性混搭',
  tax: '抽能压制',
  sustain: '吸血续航',
  status: '状态折磨',
  weather: '天气联动',
  mono: '纯属性强攻',
  punish: '换人惩罚',
};

export function presetById(id: string): TeamPreset | undefined {
  return TEAM_PRESETS.find((t) => t.id === id);
}

/** 名字后面的括号形态名在手机上会换行，列表里只显示主名。 */
export function shortName(name: string): string {
  return name.replace(/（[^）]*）/g, '');
}

export function presetSpirit(spiritId: string): Spirit | undefined {
  return spiritsById.get(spiritId);
}

/**
 * 把阵容里写的技能名解析成这只精灵实际能带的技能记录；查不到返回 null（校验脚本会报错）。
 * 自带学习面优先，其次「改血脉」能换到的那个技能——培养板块推荐的就是这一类，
 * 阵容必须按同一口径解析，否则两边对不上。
 */
export function resolveMemberSkill(spirit: Spirit, name: string): ResolvedSkill | null {
  return resolveCarried(spirit, name);
}

export function memberSpirits(preset: TeamPreset): Spirit[] {
  return preset.members
    .map((m) => spiritsById.get(m.spiritId))
    .filter((s): s is Spirit => s !== undefined);
}

/** 上一轮的归档信息（只用于页面上「上一轮已归档」的一行说明） */
export function previousRound(): {
  round: number;
  updatedAt: string;
  archetypes: { id: string; label: string }[];
} | null {
  return TEAM_ROTATION.previous ?? null;
}

/** 云端模型用的事实块：只写站内已经核验过的机制，数字全部来自图鉴原文。 */
export function presetFactBlock(preset: TeamPreset): string {
  const lines: string[] = [];
  lines.push(
    `站内「阵容推荐」第 ${TEAM_ROTATION.round} 轮预设：${preset.name}（${CATEGORY_LABEL[preset.category]}·${preset.sub}）。出现于 ${TEAM_ROTATION.updatedAt}，${TEAM_ROTATION.nextRotationAt} 换下一轮。用户是按这套打法把阵容导入对战的，请按这套机制解释，不要替换成别的体系。`,
  );
  lines.push(`配队思路：${preset.plan.join(' ')}`);
  if (preset.lead) {
    const lead = presetSpirit(preset.lead.spiritId);
    const openers = preset.lead.openers
      .map((op) => `${op.name}（${op.why}）`)
      .join('；');
    lines.push(
      `起手第一只：${lead?.name ?? preset.lead.spiritId}。${preset.lead.why}开场：${openers}。首发风险：${preset.lead.caution}`,
    );
  }
  if (preset.synergies?.length) {
    lines.push(
      `核心技能联动：${preset.synergies.map((s) => `「${s.title}」${s.text}`).join(' ')}`,
    );
  }
  if (preset.energySummary) {
    lines.push(`能量总览：${preset.energySummary.line}`);
  }
  if (preset.analysis) {
    lines.push(
      `团队配合六项：${Object.values(preset.analysis)
        .map((b) => `${b.title}——${b.text}`)
        .join(' ')}`,
    );
  }
  if (preset.battlePlan?.length) {
    lines.push(
      `五阶段战术链：${preset.battlePlan
        .map((p) => `${p.label}·${p.title}：${p.text}`)
        .join(' ')}`,
    );
  }
  const chain = preset.chain
    .map((step, i) => `${i + 1}. ${presetSpirit(step.spiritId)?.name ?? step.spiritId}：${step.text}`)
    .join(' ');
  lines.push(`特性×技能联动：${chain}`);
  const members = preset.members
    .map((m) => {
      const spirit = presetSpirit(m.spiritId);
      if (!spirit) return '';
      const trait = spirit.trait ? `特性「${spirit.trait.name}」：${spirit.trait.effect}` : '特性数据未提供';
      const skills = m.skills
        .map((ref) => {
          const sk = resolveMemberSkill(spirit, ref.name);
          return sk
            ? `${sk.name}（${sk.type}·${sk.category}${sk.power ? `·威力${sk.power}` : ''}${sk.energy ? `·能耗${sk.energy}` : ''}）`
            : ref.name;
        })
        .join('、');
      const en = m.energy
        ? `；能量：上场 ${m.energy.entry}/${m.energy.cap} 点，技能 ${m.energy.costs.join('/')} 费，回能 ${
            m.energy.recoveries.join('、') || '靠聚能'
          }${m.energy.firstTurn ? `，首回合可打「${m.energy.firstTurn.name}」剩 ${m.energy.firstTurn.leftover}` : '，首回合打不出'}`
        : '';
      return `${spirit.name}（${m.role}）：${trait}；核心技能 ${skills}${en}。`;
    })
    .filter(Boolean)
    .join(' ');
  lines.push(`逐只配置：${members}`);
  lines.push(`弱点：${preset.risk}`);
  return lines.join('\n');
}

/** 阵容页顶部的轮换状态（供 UI 与调试使用） */
export function rotationSummary(): {
  round: number;
  updatedAt: string;
  nextRotationAt: string;
  intervalHours: number;
  archetypes: { id: string; label: string }[];
  teams: RotationRoundMeta['teams'];
} {
  return {
    round: TEAM_ROTATION.round,
    updatedAt: TEAM_ROTATION.updatedAt,
    nextRotationAt: TEAM_ROTATION.nextRotationAt,
    intervalHours: TEAM_ROTATION.intervalHours,
    archetypes: TEAM_ROTATION.archetypes,
    teams: TEAM_ROTATION.teams.map((t) => ({
      id: t.id,
      name: t.name,
      category: t.category,
      archetype: t.archetype,
      archetypeLabel: t.archetypeLabel,
      spiritIds: t.members.map((m) => m.spiritId),
      spiritNames: [],
    })),
  };
}
