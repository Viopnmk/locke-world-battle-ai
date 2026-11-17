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

/**
 * 对位数据表：平均种族值、最快速度、逐格倍率矩阵。
 * 收藏在 details 里，手机上默认收起，展开也不会撑破屏幕（矩阵容器自己横向滚动）。
 */
export function TeamAnalysis({ mine, enemy, metrics }: Props) {
  return (
    <section className="panel">
      <h2 className="panel__title">
        对位数据 <span className="panel__hint">本地计算，可自行核对</span>
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

      <details className="matrix-details">
        <summary>展开对位矩阵（我方 × 敌方 倍率表）</summary>
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
      </details>

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
