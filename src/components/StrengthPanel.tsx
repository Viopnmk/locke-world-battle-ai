import { useEffect, useMemo, useState } from 'react';
import { spiritMetrics, STAT_KEYS, TIER_LABEL } from '../lib/analysis';
import type { Spirit } from '../lib/types';
import { formatMultiplier, tint, typeColor } from '../lib/typeChart';
import { analyzeSpirit, DEFAULT_MODEL, loadModels, type AiModel, type AiResult } from '../services/ai-client';
import { AiAnswer } from './AiAnswer';

interface Props {
  spirit: Spirit;
}

/** 单只精灵的确定性强度拆解 + Worker AI 深度解析。 */
export function StrengthPanel({ spirit }: Props) {
  const metrics = useMemo(() => spiritMetrics(spirit), [spirit]);
  const [models, setModels] = useState<AiModel[]>([]);
  const [model, setModel] = useState(DEFAULT_MODEL);
  const [result, setResult] = useState<AiResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    loadModels().then((m) => {
      if (!alive) return;
      setModels(m.models);
      setModel((cur) => (m.models.some((x) => x.id === cur) ? cur : m.defaultModel));
    });
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    setResult(null);
    setError(null);
  }, [spirit.id]);

  async function run() {
    setBusy(true);
    setError(null);
    try {
      setResult(await analyzeSpirit(spirit.id, model));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const tier = metrics.total.tier;

  return (
    <>
      <section className="panel">
        <h2 className="panel__title">
          强度分析 <span className="panel__hint">全图鉴 {metrics.total.population} 只内排名</span>
        </h2>

        <div className="tier-card">
          <span className={`tier-badge tier-badge--${tier}`}>{tier}</span>
          <div className="tier-card__text">
            <strong>
              {TIER_LABEL[tier]} · 总种族值 {metrics.total.value}
            </strong>
            <span>
              第 {metrics.total.rank} / {metrics.total.population} 名 · 超过 {metrics.total.percentile}% 的精灵
            </span>
          </div>
        </div>

        <div className="pct-grid">
          {STAT_KEYS.map((key) => {
            const s = metrics.stats[key];
            if (!s) return null;
            return (
              <div className="pct-row" key={key}>
                <span className="pct-row__label">{s.label}</span>
                <span className="pct-row__value">{s.value}</span>
                <span className="pct-row__bar">
                  <span style={{ width: `${Math.max(3, s.percentile)}%` }} />
                </span>
                <span className="pct-row__rank">
                  第{s.rank} · {s.percentile}%
                </span>
              </div>
            );
          })}
        </div>

        <div className="chip-line role-line">
          {metrics.roles.map((r) => (
            <span key={r} className="role-chip">
              {r}
            </span>
          ))}
        </div>
        <p className="calc__footnote">
          百分位 = 图鉴 662 只中不超过该数值的比例；定位标签按速度、输出与耐久百分位自动生成。
        </p>
      </section>

      <section className="panel">
        <h2 className="panel__title">
          进攻覆盖 <span className="panel__hint">{metrics.offence.typesWithDamagingSkill} 种属性有输出技能</span>
        </h2>
        <p className="ai__hint">
          对 18 种防守属性，可学技能最高能打出 ≥2 倍的共 <strong>{metrics.offence.strongCount}</strong> 种。
        </p>
        <div className="chip-line">
          {metrics.offence.strongAgainst.map((s) => (
            <span key={s.type} className="type-chip type-chip--sm" style={{ background: tint(typeColor(s.type), 0.16), color: typeColor(s.type) }}>
              {s.type} {formatMultiplier(s.multiplier)}
            </span>
          ))}
        </div>
        {metrics.offence.noAnswer.length ? (
          <>
            <h3 className="subhead">打不出克制（≤1 倍）</h3>
            <div className="chip-line">
              {metrics.offence.noAnswer.map((t) => (
                <span key={t} className="type-chip type-chip--sm type-chip--none">
                  {t}
                </span>
              ))}
            </div>
          </>
        ) : null}
      </section>

      <section className="panel">
        <h2 className="panel__title">
          技能池 <span className="panel__hint">{metrics.skills.total} 个可学技能</span>
        </h2>
        <div className="pool-stats">
          <div>
            <strong>{metrics.skills.damaging}</strong>
            <span>输出</span>
          </div>
          <div>
            <strong>{metrics.skills.support}</strong>
            <span>变化</span>
          </div>
          <div>
            <strong>{metrics.skills.byLearn.level}</strong>
            <span>升级</span>
          </div>
          <div>
            <strong>{metrics.skills.byLearn.stone}</strong>
            <span>技能石</span>
          </div>
          <div>
            <strong>{metrics.skills.byLearn.blood}</strong>
            <span>血脉</span>
          </div>
        </div>

        <h3 className="subhead">高威力技能</h3>
        <ul className="compact-skill-list">
          {metrics.skills.topPower.slice(0, 5).map((s) => (
            <li key={s.name}>
              <span className="compact-skill-list__name">{s.name}</span>
              <span className="muted">
                {s.type} · {s.category} · 威力{s.power}
                {s.energy ? ` · 能耗${s.energy}` : ''}
              </span>
            </li>
          ))}
        </ul>

        {metrics.skills.efficient.length ? (
          <>
            <h3 className="subhead">能耗效率最高</h3>
            <ul className="compact-skill-list">
              {metrics.skills.efficient.slice(0, 3).map((s) => (
                <li key={s.name}>
                  <span className="compact-skill-list__name">{s.name}</span>
                  <span className="muted">
                    威力{s.power} / 能耗{s.energy} · 效率 {s.ratio}
                  </span>
                </li>
              ))}
            </ul>
          </>
        ) : null}
      </section>

      <section className="panel panel--ai">
        <h2 className="panel__title">
          AI 深度解析 <span className="panel__hint">Workers AI · 免费额度</span>
        </h2>
        <p className="ai__lead">
          把这只精灵的已核验数据发给模型，让它写定位、配招和使用要点；数字仍以上面的图鉴计算为准。
        </p>
        <div className="ai__pickers ai__pickers--row">
          <label>
            <span>模型</span>
            <select value={model} onChange={(e) => setModel(e.target.value)} disabled={busy}>
              {(models.length ? models : [{ id: DEFAULT_MODEL, label: 'GPT-OSS 20B', note: '', recommended: true }]).map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                  {m.recommended ? ' · 推荐' : ''}
                </option>
              ))}
            </select>
          </label>
        </div>
        <button type="button" className="primary-button" onClick={run} disabled={busy}>
          {busy ? '模型分析中…（通常 3-10 秒）' : result ? '重新生成' : 'AI 深度解析'}
        </button>
        {error ? <p className="ai__error">{error}（上方确定性数据不受影响）</p> : null}
        {result ? <AiAnswer result={result} /> : null}
      </section>
    </>
  );
}
