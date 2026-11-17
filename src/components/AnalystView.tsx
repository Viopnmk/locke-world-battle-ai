import type { AnalystNote, ThreatLine } from '../lib/tactics';

const pctText = (n: number) => `${Math.round(n)}%`;

/**
 * 敌方威胁小结：每只敌方一行，写清「最高一击打谁多少 %、能 1–2 击带走我方几只」。
 * 数字全部来自本地伤害估算（src/lib/damage.ts），口径写在小字里。
 */
export function ThreatBoard({ threats, note }: { threats: ThreatLine[]; note: string }) {
  if (!threats.length) return null;
  return (
    <section className="panel analyst-panel">
      <h2 className="panel__title">
        敌方威胁小结 <span className="panel__hint">按能带走我方几只排序</span>
      </h2>
      <ul className="threat-list">
        {threats.map((t) => {
          const [head, ...rest] = t.line.split('：');
          return (
            <li key={t.enemyId} className="threat-item">
              <p className="threat-item__line">
                <strong>{head}</strong>
                {rest.length ? `：${rest.join('：')}` : ''}
              </p>
              {t.top ? (
                <div className="threat-item__meta">
                  <span className="threat-item__pct">{pctText(t.top.percent)}</span>
                  <span className="threat-item__meta-text">
                    最高一击 · 打 {t.top.allyName}
                    {t.top.skillName ? ` ·「${t.top.skillName}」` : ''}
                  </span>
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
      <p className="analyst__note">{note}</p>
    </section>
  );
}

/** 📝 分析师点评：总体判断 + 我方王牌 / 最大威胁 / 应对建议 / 首发建议 */
export function AnalystView({ note }: { note: AnalystNote }) {
  return (
    <section className="panel analyst-panel">
      <h2 className="panel__title">📝 分析师点评</h2>

      <div className="verdict">
        <div className="verdict__score">
          <strong>{note.percent}%</strong>
          <span className={note.percent >= 54 ? 'is-mine' : note.percent <= 46 ? 'is-enemy' : ''}>{note.lean}</span>
        </div>
        <div className="verdict__meter" aria-hidden="true">
          <span className="verdict__fill" style={{ width: `${Math.min(100, Math.max(0, note.percent))}%` }} />
          <span className="verdict__mid" />
        </div>
        <p className="verdict__hint">四项加权胜率倾向 · 50% 为完全持平</p>
      </div>

      <ul className="verdict__lines">
        {note.summary.map((line, i) => (
          <li key={`verdict-${i}`}>{line}</li>
        ))}
      </ul>

      <div className="factor-grid">
        {note.factors.map((f) => (
          <div key={f.key} className={`factor factor--${f.side}`}>
            <div className="factor__top">
              <span className="factor__label">{f.label}</span>
              <strong className="factor__value">{f.percent}</strong>
            </div>
            <p className="factor__detail">{f.detail}</p>
          </div>
        ))}
      </div>

      {note.blocks.map((block) => (
        <section className="analyst-block" key={block.key}>
          <h3 className="analyst-block__title">{block.title}</h3>
          <ul className="analyst-block__lines">
            {block.lines.map((line, i) => (
              <li key={`${block.key}-${i}`}>{line}</li>
            ))}
          </ul>
        </section>
      ))}
    </section>
  );
}
