import chartData from '../data/type-chart.json';
import type { TypeChart, TypeMeta } from './types';

export const chart = chartData as unknown as TypeChart;

export const TYPE_ORDER: string[] = chart.types.map((t) => t.name);

const metaByName = new Map<string, TypeMeta>(chart.types.map((t) => [t.name, t]));

export function typeMeta(name: string): TypeMeta | undefined {
  return metaByName.get(name);
}

export function typeColor(name: string): string {
  return metaByName.get(name)?.color ?? '#8a8f98';
}

/** Hex (#rrggbb) to rgba() so the type tints sit lightly behind text. */
export function tint(hex: string, alpha: number): string {
  const v = hex.replace('#', '');
  const n = parseInt(v.length === 3 ? v.split('').map((c) => c + c).join('') : v, 16);
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

export function pairKey(a: string, b: string): string {
  const ia = TYPE_ORDER.indexOf(a);
  const ib = TYPE_ORDER.indexOf(b);
  return ia <= ib ? `${a}|${b}` : `${b}|${a}`;
}

export type MatchupSource = 'single' | 'pair' | 'derived' | 'neutral';

export interface Matchup {
  attacker: string;
  defenders: string[];
  multiplier: number;
  source: MatchupSource;
  /** per defending type contribution, when the pair had to be combined */
  parts?: { type: string; multiplier: number }[];
}

/**
 * Incoming damage multiplier of `attacker` against one or two defending types.
 * Values come from the wiki's published matrix; a combination the wiki does not
 * list is combined with the rule its own 86 published pairs all follow
 * (multiply the single-type values, cap at 3).
 */
export function matchup(attacker: string, defenders: string[]): Matchup {
  const defs = defenders.filter(Boolean);
  if (defs.length === 0) {
    return { attacker, defenders: defs, multiplier: 1, source: 'neutral' };
  }
  if (defs.length === 1) {
    const m = chart.defense[defs[0]]?.[attacker];
    return { attacker, defenders: defs, multiplier: m ?? 1, source: m === undefined ? 'neutral' : 'single' };
  }
  const key = pairKey(defs[0], defs[1]);
  const published = chart.pairs[key]?.[attacker];
  if (published !== undefined) {
    return { attacker, defenders: defs, multiplier: published, source: 'pair' };
  }
  const parts = defs.map((d) => ({ type: d, multiplier: chart.defense[d]?.[attacker] ?? 1 }));
  const product = parts.reduce((acc, p) => acc * p.multiplier, 1);
  return {
    attacker,
    defenders: defs,
    multiplier: Math.min(Number(product.toFixed(2)), 3),
    source: 'derived',
    parts,
  };
}

export interface DefenceProfile {
  /** attacking types hitting this defender for more than 1x */
  weak: { type: string; multiplier: number }[];
  /** attacking types this defender takes less than 1x from */
  resist: { type: string; multiplier: number }[];
}

/** Everything that can hit a defending type combination, sorted strongest first. */
export function defenceProfile(defenders: string[]): DefenceProfile {
  const weak: DefenceProfile['weak'] = [];
  const resist: DefenceProfile['resist'] = [];
  for (const atk of TYPE_ORDER) {
    const m = matchup(atk, defenders).multiplier;
    if (m > 1) weak.push({ type: atk, multiplier: m });
    else if (m < 1) resist.push({ type: atk, multiplier: m });
  }
  weak.sort((a, b) => b.multiplier - a.multiplier || TYPE_ORDER.indexOf(a.type) - TYPE_ORDER.indexOf(b.type));
  resist.sort((a, b) => a.multiplier - b.multiplier || TYPE_ORDER.indexOf(a.type) - TYPE_ORDER.indexOf(b.type));
  return { weak, resist };
}

export function multiplierLabel(m: number): string {
  if (m >= 3) return '克制到顶';
  if (m >= 2) return '效果拔群';
  if (m > 1) return '略占优势';
  if (m === 1) return '普通伤害';
  if (m >= 0.5) return '抵抗';
  return '强抵抗';
}

export function formatMultiplier(m: number): string {
  return `×${Number.isInteger(m) ? m : m.toFixed(2).replace(/0$/, '')}`;
}

/** Colours the result card uses: warm for strong hits, cool for resisted ones. */
export function multiplierTone(m: number): { bg: string; fg: string } {
  if (m >= 2) return { bg: '#fdecec', fg: '#b8332f' };
  if (m > 1) return { bg: '#fdf3e4', fg: '#a86718' };
  if (m === 1) return { bg: '#eef1f3', fg: '#4a5560' };
  return { bg: '#e9f2fb', fg: '#2f6d9e' };
}
