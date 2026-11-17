/**
 * Adapter for the Phase 2 battle-analysis model (Cloudflare Workers AI).
 *
 * Phase 1 ships the interface and a deterministic, data-only pre-analysis that
 * runs entirely in the browser. No key, token or endpoint is written into the
 * repo: the endpoint and model come from build-time environment variables
 * (`VITE_AI_ENDPOINT`, `VITE_AI_MODEL`) and the worker is expected to hold the
 * credentials on its side, so the browser never sees one.
 */
import type { ResolvedSkill, Spirit } from '../lib/types';
import { defenceProfile, formatMultiplier, matchup } from '../lib/typeChart';

export interface AiConfig {
  endpoint: string | null;
  model: string;
}

const env = (import.meta as unknown as { env: Record<string, string | undefined> }).env ?? {};

export const aiConfig: AiConfig = {
  endpoint: env.VITE_AI_ENDPOINT?.trim() || null,
  model: env.VITE_AI_MODEL?.trim() || '（未配置模型）',
};

export const isAiConfigured = aiConfig.endpoint !== null;

export interface BattleSide {
  spirit: Spirit;
  skills: ResolvedSkill[];
}

export interface BattleAnalysisRequest {
  attacker: BattleSide;
  defender: BattleSide;
}

export interface BattleAnalysis {
  /** where the answer came from, so the UI never pretends a local calculation is a model */
  origin: 'model' | 'local';
  headline: string;
  matchup: string[];
  skillNotes: string[];
  cautions: string[];
}

export class AiNotConfiguredError extends Error {
  constructor() {
    super('未配置 AI 端点（VITE_AI_ENDPOINT）');
    this.name = 'AiNotConfiguredError';
  }
}

/** Chinese prompt grounded in the fetched wiki data; the worker only has to answer it. */
export function buildPrompt(req: BattleAnalysisRequest): string {
  const line = (side: BattleSide) => {
    const s = side.spirit;
    const stats = Object.entries(s.stats)
      .filter(([k, v]) => k !== 'total' && v !== null)
      .map(([k, v]) => `${k}:${v}`)
      .join(' ');
    const skills = side.skills
      .slice(0, 8)
      .map((k) => `${k.name}(${k.type || '无'}·${k.category}${k.power ? `·威力${k.power}` : ''}${k.energy ? `·能耗${k.energy}` : ''})`)
      .join('、');
    return `${s.name}｜属性 ${s.type.join('/')}｜${stats}｜总${s.stats.total}｜特性 ${s.trait?.name ?? '—'}：${s.trait?.effect ?? '—'}｜技能 ${skills}`;
  };
  return [
    '你是《洛克王国：世界》的对战分析助手。只依据下面给出的图鉴数据回答，不要编造数值或技能。',
    `进攻方：${line(req.attacker)}`,
    `防守方：${line(req.defender)}`,
    '请用简短中文输出：1) 属性克制结论（含倍率）2) 推荐 2 个技能及理由 3) 风险提示。总长度不超过 200 字。',
  ].join('\n');
}

/** Deterministic pre-analysis from real data — used before the model is wired up. */
export function analyzeLocally(req: BattleAnalysisRequest): BattleAnalysis {
  const defTypes = req.defender.spirit.type;
  const attackTypes = [...new Set(req.attacker.skills.map((s) => s.type).filter(Boolean))];
  const best = attackTypes
    .map((t) => ({ type: t, m: matchup(t, defTypes).multiplier }))
    .sort((a, b) => b.m - a.m)[0];

  const profile = defenceProfile(defTypes);
  const headline = best
    ? `用 ${best.type} 系技能打 ${defTypes.join('/')} 系：${formatMultiplier(best.m)}`
    : '进攻方没有带属性的技能';

  const skillNotes = req.attacker.skills
    .filter((s) => s.power && s.type)
    .map((s) => ({ s, m: matchup(s.type, defTypes).multiplier }))
    .sort((a, b) => b.m * (b.s.power ?? 0) - a.m * (a.s.power ?? 0))
    .slice(0, 3)
    .map(({ s, m }) => `${s.name}（${s.type}·威力${s.power}${
      s.energy !== null ? `·能耗${s.energy}` : ''
    }）→ ${formatMultiplier(m)}`);

  const cautions = [
    profile.weak.length
      ? `对手 ${defTypes.join('/')} 系被 ${profile.weak
          .map((w) => `${w.type}${formatMultiplier(w.multiplier)}`)
          .slice(0, 4)
          .join('、')} 克制，注意别让对手先手。`
      : '',
    profile.resist.length
      ? `${defTypes.join('/')} 系抵抗 ${profile.resist.map((r) => r.type).slice(0, 5).join('、')}，用这些属性收益低。`
      : '',
    req.defender.spirit.trait?.effect
      ? `对手特性「${req.defender.spirit.trait.name}」：${req.defender.spirit.trait.effect}`
      : '',
  ].filter(Boolean);

  return {
    origin: 'local',
    headline,
    matchup: [
      `进攻方 ${req.attacker.spirit.name}（${req.attacker.spirit.type.join('/')}）对阵 ${req.defender.spirit.name}（${defTypes.join('/')}）`,
      `防守方总种族值 ${req.defender.spirit.stats.total ?? '—'}`,
    ],
    skillNotes,
    cautions,
  };
}

/** Calls the configured worker; falls back with a clear error when nothing is set. */
export async function analyzeBattle(req: BattleAnalysisRequest): Promise<BattleAnalysis> {
  if (!aiConfig.endpoint) throw new AiNotConfiguredError();
  const res = await fetch(`${aiConfig.endpoint.replace(/\/$/, '')}/analyze`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: aiConfig.model, prompt: buildPrompt(req) }),
  });
  if (!res.ok) throw new Error(`AI 端点返回 ${res.status}`);
  const data = (await res.json()) as Partial<BattleAnalysis>;
  return {
    origin: 'model',
    headline: data.headline ?? '（模型未返回结论）',
    matchup: data.matchup ?? [],
    skillNotes: data.skillNotes ?? [],
    cautions: data.cautions ?? [],
  };
}
