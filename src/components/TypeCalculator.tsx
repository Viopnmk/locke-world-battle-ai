import { useMemo, useState } from 'react';
import { chart, defenceProfile, formatMultiplier, matchup, multiplierLabel, multiplierTone, tint, typeColor } from '../lib/typeChart';
import { spiritsWithTypes } from '../lib/spirits';

const TYPE_NAMES = chart.types.map((t) => t.name);

function Chip({ name, active, onClick }: { name: string; active: boolean; onClick: () => void }) {
  const color = typeColor(name);
  return (
    <button
      type="button"
      className={`type-chip type-chip--pick${active ? ' is-active' : ''}`}
      onClick={onClick}
      style={active ? { background: color, color: '#fff', borderColor: color } : { background: tint(color, 0.14), color }}
      aria-pressed={active}
    >
      {name}
    </button>
  );
}

export function TypeCalculator({ onOpenType }: { onOpenType: (type: string) => void }) {
  const [attacker, setAttacker] = useState<string>('火');
  const [defA, setDefA] = useState<string>('草');
  const [defB, setDefB] = useState<string>('');

  const defenders = [defA, defB].filter(Boolean);
  const result = useMemo(() => matchup(attacker, defenders), [attacker, defA, defB]);
  const profile = useMemo(() => defenceProfile(defenders), [defA, defB]);
  const rosterCount = useMemo(() => (defenders.length ? spiritsWithTypes(defenders).length : 0), [defA, defB]);
  const tone = multiplierTone(result.multiplier);

  const singleParts = defenders.map((d) => ({
    type: d,
    value: chart.defense[d]?.[attacker] ?? 1,
  }));

  return (
    <div className="calc">
      <section className="panel">
        <h2 className="panel__title">进攻属性</h2>
        <div className="chip-strip">
          {TYPE_NAMES.map((t) => (
            <Chip key={t} name={t} active={t === attacker} onClick={() => setAttacker(t)} />
          ))}
        </div>
      </section>

      <section className="panel">
        <h2 className="panel__title">防守属性</h2>
        <div className="defence-selects">
          <label>
            <span>主属性</span>
            <select value={defA} onChange={(e) => setDefA(e.target.value)}>
              <option value="">不选</option>
              {TYPE_NAMES.map((t) => (
                <option key={t} value={t}>
                  {t}系
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>次属性（可选）</span>
            <select value={defB} onChange={(e) => setDefB(e.target.value)}>
              <option value="">无</option>
              {TYPE_NAMES.filter((t) => t !== defA).map((t) => (
                <option key={t} value={t}>
                  {t}系
                </option>
              ))}
            </select>
          </label>
        </div>
      </section>

      <section className="result-card" style={{ background: tone.bg }}>
        <div className="result-card__top">
          <span className="type-chip" style={{ background: tint(typeColor(attacker), 0.18), color: typeColor(attacker) }}>
            {attacker}系
          </span>
          <span className="result-card__arrow" aria-hidden="true">→</span>
          <span className="result-card__defs">
            {defenders.length ? defenders.map((d) => `${d}系`).join(' / ') : '未选择防守方'}
          </span>
        </div>
        <div className="result-card__value" style={{ color: tone.fg }}>
          {defenders.length ? formatMultiplier(result.multiplier) : '—'}
        </div>
        <div className="result-card__label" style={{ color: tone.fg }}>
          {defenders.length ? multiplierLabel(result.multiplier) : '选择防守属性后显示倍率'}
        </div>
        {defenders.length ? (
          <ul className="result-card__notes">
            {singleParts.length === 2 ? (
              <li>
                单看：{singleParts.map((p) => `${p.type}系 ${formatMultiplier(p.value)}`).join(' ，')}
                {result.source === 'pair' ? '；双属性倍率取自 Wiki 已发布组合表' : ''}
                {result.source === 'derived' ? '；该组合 Wiki 未发布，按已发布的 86 组全部符合的规则计算（相乘、上限 ×3）' : ''}
              </li>
            ) : (
              <li>单属性倍率直接取自 Wiki 克制表</li>
            )}
            {rosterCount > 0 ? (
              <li>
                当前图鉴中有 {rosterCount} 只精灵是这个属性组合 ·{' '}
                <button type="button" className="link-button" onClick={() => onOpenType(defenders[0])}>
                  在图鉴中查看 {defenders[0]} 系
                </button>
              </li>
            ) : (
              <li>当前图鉴里没有这个属性组合的精灵</li>
            )}
          </ul>
        ) : null}
      </section>

      {defenders.length ? (
        <section className="panel">
          <h2 className="panel__title">
            这个防守组合 <span className="panel__hint">被谁克制 / 抵抗谁</span>
          </h2>
          <div className="match-summary">
            <div>
              <h3>弱点</h3>
              <div className="chip-line">
                {profile.weak.length
                  ? profile.weak.map((w) => (
                      <span key={w.type} className="type-chip type-chip--sm" style={{ background: '#fdecec', color: '#b8332f' }}>
                        {w.type} {formatMultiplier(w.multiplier)}
                      </span>
                    ))
                  : <span className="muted">没有弱点</span>}
              </div>
            </div>
            <div>
              <h3>抵抗</h3>
              <div className="chip-line">
                {profile.resist.length
                  ? profile.resist.map((r) => (
                      <span key={r.type} className="type-chip type-chip--sm" style={{ background: '#e9f2fb', color: '#2f6d9e' }}>
                        {r.type} {formatMultiplier(r.multiplier)}
                      </span>
                    ))
                  : <span className="muted">没有抵抗</span>}
              </div>
            </div>
          </div>
          <p className="calc__footnote">
            倍率区间 {chart.multipliers.map((m) => formatMultiplier(m)).join(' / ')}；状态免疫来自 Wiki：
            {Object.entries(chart.statusImmunity).map(([t, s]) => `${t}系免疫${s}`).join('、')}。
          </p>
        </section>
      ) : null}

      <section className="panel panel--quiet">
        <h2 className="panel__title">全部属性一览</h2>
        <div className="chart-grid">
          {TYPE_NAMES.map((def) => {
            const row = chart.defense[def] ?? {};
            const strong = Object.entries(row)
              .filter(([, m]) => m > 1)
              .map(([t]) => t);
            return (
              <button key={def} type="button" className="chart-cell" onClick={() => setDefA(def)}>
                <span className="type-chip type-chip--sm" style={{ background: tint(typeColor(def), 0.16), color: typeColor(def) }}>
                  {def}
                </span>
                <span className="chart-cell__text">{strong.length ? `怕 ${strong.join('、')}` : '无弱点'}</span>
              </button>
            );
          })}
        </div>
        <p className="source-line">
          克制数据：
          <a href={chart.source.page} target="_blank" rel="noreferrer">
            BWIKI 克制计算器
          </a>
          {' · '}
          <a href={chart.source.moduleUrl} target="_blank" rel="noreferrer">
            数据模块
          </a>
        </p>
      </section>
    </div>
  );
}
