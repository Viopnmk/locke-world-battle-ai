/**
 * 服务器端唯一数据源：直接复用仓库里从 BWIKI 抓取的 JSON。
 * 前端传来的只有精灵 id，所有种族值、技能、特性、属性倍率都在这里重新解析，
 * 模型拿到的「事实」也由这里生成，不采信客户端自报的数值。
 */
import spiritsRaw from '../../src/data/spirits.json';
import skillsRaw from '../../src/data/skills.json';
import learnsetsRaw from '../../src/data/learnsets.json';
import chartRaw from '../../src/data/type-chart.json';

export const spirits = spiritsRaw;
export const skills = skillsRaw;
export const learnsets = learnsetsRaw;
export const chart = chartRaw;

export const TYPE_ORDER = chart.types.map((t) => t.name);
export const TYPE_META = new Map(chart.types.map((t) => [t.name, t]));
export const STAT_KEYS = ['hp', 'atk', 'def', 'spa', 'spd', 'spe'];
export const STAT_LABEL = {
  hp: '生命',
  atk: '物攻',
  def: '物防',
  spa: '魔攻',
  spd: '魔防',
  spe: '速度',
};

export const spiritById = new Map(spirits.map((s) => [s.id, s]));
const spiritByName = new Map(spirits.map((s) => [s.name, s]));
const spiritByPage = new Map(spirits.map((s) => [s.page, s]));
const skillById = new Map(skills.map((s) => [s.id, s]));

const cleanKey = (v) => String(v ?? '').trim();

/** 接受精灵 id、名称或图鉴页名；无法识别时返回 null（由调用方报 400）。 */
export function findSpirit(key) {
  const k = cleanKey(key);
  if (!k) return null;
  return spiritById.get(k) || spiritByName.get(k) || spiritByPage.get(k) || null;
}

export function skillOf(id) {
  return skillById.get(id) ?? null;
}

/** 学习面 = learnset + 额外技能石，和前端 skillsOf() 同一规则。 */
export function skillsOf(spirit) {
  const entries = [...(spirit.learnset ? learnsets[spirit.learnset] ?? [] : [])];
  const known = new Set(entries.map((e) => e[0]));
  for (const id of spirit.extraStones ?? []) {
    if (!known.has(id)) {
      entries.push([id, 1]);
      known.add(id);
    }
  }
  const out = [];
  for (const [id, code, level] of entries) {
    const sk = skillById.get(id);
    if (sk) out.push({ ...sk, learn: code, level });
  }
  return out;
}

/* ------------------------------------------------------------ 分布与排名 */

const statDist = {};
for (const key of STAT_KEYS) {
  statDist[key] = spirits
    .map((s) => s.stats[key])
    .filter((v) => typeof v === 'number')
    .sort((a, b) => a - b);
}
const totalDist = spirits
  .map((s) => s.stats.total)
  .filter((v) => typeof v === 'number')
  .sort((a, b) => a - b);
const POPULATION = spirits.length;

function rankIn(sorted, value) {
  // 并列按「比它强的数量 + 1」计名次
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid] > value) hi = mid;
    else lo = mid + 1;
  }
  return sorted.length - lo + 1;
}

function percentileIn(sorted, value) {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid] <= value) lo = mid + 1;
    else hi = mid;
  }
  return round1((lo / sorted.length) * 100);
}

const round1 = (n) => Math.round(n * 10) / 10;
const round2 = (n) => Math.round(n * 100) / 100;

export function tierOf(percentile) {
  if (percentile >= 95) return 'S';
  if (percentile >= 80) return 'A';
  if (percentile >= 55) return 'B';
  if (percentile >= 25) return 'C';
  return 'D';
}

export function statRank(key, value) {
  const sorted = statDist[key];
  if (!sorted || typeof value !== 'number') return null;
  return { value, rank: rankIn(sorted, value), percentile: percentileIn(sorted, value) };
}

export function totalRank(value) {
  if (typeof value !== 'number') return null;
  const percentile = percentileIn(totalDist, value);
  return {
    value,
    rank: rankIn(totalDist, value),
    population: POPULATION,
    percentile,
    tier: tierOf(percentile),
  };
}

/* ------------------------------------------------------------ 属性倍率 */

export function pairKey(a, b) {
  const ia = TYPE_ORDER.indexOf(a);
  const ib = TYPE_ORDER.indexOf(b);
  return ia <= ib ? `${a}|${b}` : `${b}|${a}`;
}

/** 攻击方属性 attacker 打 defenders（1~2 个属性）的倍率，规则与前端一致。 */
export function matchup(attacker, defenders) {
  const defs = (defenders ?? []).filter(Boolean);
  if (defs.length === 0) return 1;
  if (defs.length === 1) {
    const m = chart.defense[defs[0]]?.[attacker];
    return m === undefined ? 1 : m;
  }
  const published = chart.pairs[pairKey(defs[0], defs[1])]?.[attacker];
  if (published !== undefined) return published;
  const product = defs.reduce((acc, d) => acc * (chart.defense[d]?.[attacker] ?? 1), 1);
  return Math.min(round2(product), 3);
}

export function defenceProfile(types) {
  const weak = [];
  const resist = [];
  for (const atk of TYPE_ORDER) {
    const m = matchup(atk, types);
    if (m > 1) weak.push({ type: atk, multiplier: m });
    else if (m < 1) resist.push({ type: atk, multiplier: m });
  }
  weak.sort((a, b) => b.multiplier - a.multiplier || TYPE_ORDER.indexOf(a.type) - TYPE_ORDER.indexOf(b.type));
  resist.sort((a, b) => a.multiplier - b.multiplier || TYPE_ORDER.indexOf(a.type) - TYPE_ORDER.indexOf(b.type));
  return { weak, resist };
}

export function multiplierText(m) {
  const n = Number.isInteger(m) ? String(m) : String(round2(m));
  return `×${n}`;
}
