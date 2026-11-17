import type { TeamMetrics } from '../lib/analysis';
import type { Spirit } from '../lib/types';
import { formatMultiplier, tint, typeColor } from '../lib/typeChart';

const shortName = (name: string) => name.replace(/（[^）]*）/g, '');

function tone(mult: number): string {
  if (mult >= 2) return 'is-strong';
  if (mult > 1) return 'is-good';
  if (mult >= 1) return 'is-neutral';
  return 'is-weak';
}

interface Props {
  mine: Spirit[];
  enemy: Spirit[];
  metrics: TeamMetrics;
}

export function TeamAnalysis({ mine, enemy, metrics }: Props) {
  return (
    <section className="panel">
      <h2 className="panel__title">
        确定性对位 <span className="panel__hint">图鉴数据算出，不经过模型</span>
      </h2>

      <div className="team-summary">
        <div>
          <small>平均种族值</small>
          <strong>
            {metrics.totals.myAvg} <span className="vs">vs</span> {metrics.totals.enemyAvg}
          </strong>
          <span className={metrics.totals.diff >= 0 ? 'diff diff--up' : 'diff diff--down'}>
            {metrics.totals.diff >= 0 ? '+' : ''}
            {metrics.totals.diff}
          </span>
        </div>
        <div>
          <small>最快速度</small>
          <strong>
            {metrics.speed.myFastest ? `${shortName(metrics.speed.myFastest.name)} ${metrics.speed.myFastest.spe}` : '—'}
          </strong>
          <span className="muted">
            敌方 {metrics.speed.enemyFastest ? `${shortName(metrics.speed.enemyFastest.name)} ${metrics.speed.enemyFastest.spe}` : '—'}
          </span>
        </div>
      </div>

      <div className="matrix-wrap">
        <div
          className="matrix"
          style={{ gridTemplateColumns: `minmax(64px, 1.25fr) repeat(${enemy.length}, minmax(0, 1fr))` }}
        >
          <span className="matrix__corner">我方 \ 敌方</span>
          {enemy.map((e) => (
            <span key={e.id} className="matrix__col" title={e.name}>
              {shortName(e.name)}
              <small>{e.stats.total ?? '—'}</small>
            </span>
          ))}
          {mine.map((m, i) => (
            <Row key={m.id} mine={m} enemy={enemy} metrics={metrics} row={i} />
          ))}
        </div>
      </div>
      <p className="matrix__legend">
        大号 = 我方用可学技能打对方的最高倍率；<span className="legend-dot is-strong" /> ≥2 倍优势，
        <span className="legend-dot is-neutral" /> 1 倍，<span className="legend-dot is-weak" /> 被抵抗。小字 = 对方反打我方。
      </p>

      <h3 className="subhead">我方共同弱点</h3>
      {metrics.sharedWeak.length ? (
        <div className="chip-line">
          {metrics.sharedWeak.map((w) => (
            <span key={w.type} className="type-chip type-chip--sm" style={{ background: '#fdecec', color: '#b8332f' }}>
              {w.type} {formatMultiplier(w.maxMultiplier)} · {w.count}只
            </span>
          ))}
        </div>
      ) : (
        <p className="muted">没有同一属性可以同时克制我方 2 只以上。</p>
      )}

      <h3 className="subhead">打击盲区</h3>
      {metrics.coverageGaps.length ? (
        <ul className="ai__list">
          {metrics.coverageGaps.map((g) => (
            <li key={g.enemy}>
              {g.enemy}（{g.enemyTypes.join('/')}）我方最高只有 {formatMultiplier(g.bestMultiplier)}
              {g.bestBy ? `（${g.bestBy}）` : ''}
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted">无 · 敌方每只都有我方成员能打出 ≥2 倍。</p>
      )}

      <h3 className="subhead">首发建议（按对位打分）</h3>
      <ol className="lead-list">
        {metrics.ranked.slice(0, 3).map((r, i) => (
          <li key={r.id} className={i === 0 ? 'is-lead' : ''}>
            <span className="lead-list__name">{i === 0 ? '★ ' : ''}{r.name}</span>
            <span className="lead-list__nums">
              攻 {r.attack} · 受 {r.threat} · 速 {r.speedEdge > 0 ? `+${r.speedEdge}` : r.speedEdge}
            </span>
            <span className="lead-list__score">{r.score}</span>
          </li>
        ))}
      </ol>
      <p className="calc__footnote">打分 = 对敌平均进攻倍率 − 平均受威胁倍率 + 速度奖励，只用于排序，不代替模型判断。</p>

      <div className="shared-resist">
        <h3 className="subhead">我方共同抵抗</h3>
        {metrics.sharedResist.length ? (
          <div className="chip-line">
            {metrics.sharedResist.slice(0, 8).map((r) => (
              <span key={r.type} className="type-chip type-chip--sm" style={{ background: tint(typeColor(r.type), 0.14), color: typeColor(r.type) }}>
                {r.type} · {r.count}只
              </span>
            ))}
          </div>
        ) : (
          <p className="muted">没有 2 只以上共同抵抗的属性。</p>
        )}
      </div>
    </section>
  );
}

function Row({ mine: m, enemy, metrics, row }: { mine: Spirit; enemy: Spirit[]; metrics: TeamMetrics; row: number }) {
  return (
    <>
      <span className="matrix__row" title={m.name}>
        {shortName(m.name)}
        <small>{m.stats.total ?? '—'}</small>
      </span>
      {enemy.map((e, j) => {
        const c = metrics.matrix[row][j];
        return (
          <span key={e.id} className={`matrix__cell ${tone(c.attack.multiplier)}`} title={`${c.myName} 打 ${c.enemyName}`}>
            <strong>{formatMultiplier(c.attack.multiplier)}</strong>
            <small className={c.threat.multiplier >= 2 ? 'is-danger' : ''}>受{formatMultiplier(c.threat.multiplier)}</small>
          </span>
        );
      })}
    </>
  );
}
