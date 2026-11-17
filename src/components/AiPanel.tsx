import { useCallback, useMemo, useRef, useState } from 'react';
import { meta, spirits } from '../lib/spirits';
import type { Spirit } from '../lib/types';
import { teamMetrics } from '../lib/analysis';
import { teamBrief } from '../lib/tactics';
import { tint, typeColor } from '../lib/typeChart';
import {
  DEFAULT_MODEL,
  FALLBACK_MODELS,
  analyzeTeam,
  aiEndpoint,
  loadModels,
  type AiModel,
  type AiResult,
} from '../services/ai-client';
import { AiAnswer } from './AiAnswer';
import { AnalystView, ThreatBoard } from './AnalystView';
import { LocalBriefView } from './LocalBriefView';
import { SpiritPicker } from './SpiritPicker';
import { TeamAnalysis } from './TeamAnalysis';

const DEMO_MINE = ['迪莫', '喵喵', '水蓝蓝'];
const DEMO_ENEMY = ['火花', '雪影娃娃', '机械方方'];
const MAX_TEAM = 6;

const shortName = (name: string) => name.replace(/（[^）]*）/g, '');

function byName(name: string): Spirit | null {
  return spirits.find((s) => s.name === name) ?? null;
}

/**
 * 对战页：本地战术引擎为主（离线、0 延迟），云端大模型只是可选的润色层，
 * 折叠在 details 里，默认不发起任何网络请求。
 */
export function AiPanel() {
  const [mine, setMine] = useState<Spirit[]>([]);
  const [enemy, setEnemy] = useState<Spirit[]>([]);
  const [picker, setPicker] = useState<null | 'mine' | 'enemy'>(null);

  const briefRef = useRef<HTMLDivElement | null>(null);

  /* 云端大模型（可选）——只有展开 details 才会拉模型列表 */
  const [cloudOpen, setCloudOpen] = useState(false);
  const [models, setModels] = useState<AiModel[]>(FALLBACK_MODELS);
  const [model, setModel] = useState(DEFAULT_MODEL);
  const [cloudLoaded, setCloudLoaded] = useState(false);

  const [result, setResult] = useState<AiResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const ready = mine.length > 0 && enemy.length > 0;

  /** 本地引擎：两边各 1 只起就有结论，纯计算，数据变了立刻重算 */
  const analysis = useMemo(() => {
    if (!ready) return null;
    const t0 = performance.now();
    const metrics = teamMetrics(mine, enemy);
    const brief = teamBrief(mine, enemy, metrics);
    const ms = Math.max(0.1, Math.round((performance.now() - t0) * 10) / 10);
    return { metrics, brief, ms };
  }, [mine, enemy, ready]);

  const resetResult = () => {
    setResult(null);
    setError(null);
  };

  const addSpirit = useCallback(
    (s: Spirit) => {
      const side = picker;
      if (!side) return;
      const setter = side === 'mine' ? setMine : setEnemy;
      setter((prev) => (prev.length >= MAX_TEAM || prev.some((x) => x.id === s.id) ? prev : [...prev, s]));
      setPicker(null);
      resetResult();
    },
    [picker],
  );

  const removeSpirit = (side: 'mine' | 'enemy', id: string) => {
    const setter = side === 'mine' ? setMine : setEnemy;
    setter((prev) => prev.filter((s) => s.id !== id));
    resetResult();
  };

  const fillDemo = () => {
    setMine(DEMO_MINE.map(byName).filter((s): s is Spirit => s !== null));
    setEnemy(DEMO_ENEMY.map(byName).filter((s): s is Spirit => s !== null));
    resetResult();
  };

  const clearAll = () => {
    setMine([]);
    setEnemy([]);
    resetResult();
  };

  function openCloud() {
    setCloudOpen(true);
    if (cloudLoaded) return;
    setCloudLoaded(true);
    loadModels().then((m) => {
      setModels(m.models);
      setModel((cur) => (m.models.some((x) => x.id === cur) ? cur : m.defaultModel));
    });
  }

  async function runCloud() {
    if (!mine.length || !enemy.length) return;
    setBusy(true);
    setError(null);
    try {
      setResult(await analyzeTeam(mine.map((s) => s.id), enemy.map((s) => s.id), model));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  function scrollToBrief() {
    briefRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  return (
    <div className="ai">
      <section className="panel panel--engine">
        <h2 className="panel__title">
          本地实战分析引擎 <span className="panel__hint">图鉴直算 · 离线可用</span>
        </h2>
        <p className="ai__lead">
          选好双方阵容，页面直接用内置的 {meta.spiritCount} 只形态种族值、18 系倍率表和全部可学技能算出首发、
          逐只应对与联防盲区。<strong>不联网、不排队、打开就有结果</strong>，手机流量或弱网下同样可用。
        </p>
        <div className="engine-pills">
          <span className="engine-pill">⚡ 0 延迟计算</span>
          <span className="engine-pill">📴 离线可用</span>
          <span className="engine-pill">🔢 数字全部来自图鉴</span>
        </div>
      </section>

      <section className="panel">
        <div className="team-head">
          <h2 className="panel__title team-head__title">
            阵容选择 <span className="panel__hint">{mine.length} vs {enemy.length}</span>
          </h2>
          <div className="team-head__actions">
            <button type="button" className="link-button" onClick={fillDemo}>
              填入示例
            </button>
            {mine.length || enemy.length ? (
              <button type="button" className="link-button" onClick={clearAll}>
                清空
              </button>
            ) : null}
          </div>
        </div>

        <TeamSlots
          label="我方阵容"
          accent="mine"
          team={mine}
          onAdd={() => setPicker('mine')}
          onRemove={(id) => removeSpirit('mine', id)}
        />
        <TeamSlots
          label="敌方阵容"
          accent="enemy"
          team={enemy}
          onAdd={() => setPicker('enemy')}
          onRemove={(id) => removeSpirit('enemy', id)}
        />

        <button type="button" className="primary-button" onClick={scrollToBrief} disabled={!ready}>
          {ready ? '⚡ 生成本地实战分析' : '两边各选 1 只后即可生成'}
        </button>
        <p className="ai__hint">
          {ready ? '阵容一改，下面的分析即时重算（点按钮直接跳过去）。' : '两边各至少选 1 只精灵。'}
        </p>
      </section>

      {analysis ? (
        <>
          <section className="panel panel--engine-result" ref={briefRef} id="local-battle-brief">
            <div className="engine-result__head">
              <h2 className="panel__title">本地实战分析</h2>
              <span className="engine-result__stamp">
                {analysis.ms}ms ·{' '}
                {analysis.brief.threats.length +
                  analysis.brief.analyst.blocks.reduce((n, b) => n + b.lines.length, 0) +
                  analysis.brief.sections.reduce((n, s) => n + s.lines.length, 0)}{' '}
                条结论
              </span>
            </div>
            <p className="local-brief__headline">{analysis.brief.headline}</p>
          </section>

          <ThreatBoard threats={analysis.brief.threats} note={analysis.brief.footnote} />

          <AnalystView note={analysis.brief.analyst} />

          <section className="panel panel--engine-result">
            <LocalBriefView
              brief={{ ...analysis.brief, footnote: analysis.brief.estimateNote }}
              showHeadline={false}
            />
          </section>
        </>
      ) : null}

      {analysis ? <TeamAnalysis mine={mine} enemy={enemy} metrics={analysis.metrics} /> : null}

      <details
        className="cloud-ai"
        open={cloudOpen}
        onToggle={(e) => {
          const opened = (e.currentTarget as HTMLDetailsElement).open;
          setCloudOpen(opened);
          if (opened) openCloud();
        }}
      >
        <summary>
          可选：连接云端大模型
          <span className="cloud-ai__sub">不在系统里排队，只给文字加解说；需要能访问 workers.dev</span>
        </summary>
        <div className="cloud-ai__body">
          <p className="ai__lead">
            本页所有结论已经由本地引擎给出。这里的模型只把同样的数据写成更像解说的句子，数字仍以本地计算为准；
            连不上也不影响上面的分析。
          </p>
          <label className="cloud-ai__model">
            <span>模型</span>
            <select value={model} onChange={(e) => setModel(e.target.value)} disabled={busy}>
              {models.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                  {m.recommended ? ' · 推荐' : ''}
                </option>
              ))}
            </select>
          </label>
          <button type="button" className="ghost-button" onClick={runCloud} disabled={!ready || busy}>
            {busy ? '模型分析中…' : '调用云端模型再写一遍'}
          </button>
          <p className="source-line">端点：{aiEndpoint}</p>

          {error ? (
            <div className="ai__error">
              <p>云端模型没连上：{error}</p>
              <p>不影响使用——上面的本地分析已经算完，无需重试。</p>
            </div>
          ) : null}

          {result ? <AiAnswer result={result} /> : null}
        </div>
      </details>

      <SpiritPicker
        open={picker !== null}
        title={picker === 'mine' ? '选择我方精灵' : '选择敌方精灵'}
        excludeIds={(picker === 'mine' ? mine : enemy).map((s) => s.id)}
        onPick={addSpirit}
        onClose={() => setPicker(null)}
      />
    </div>
  );
}

function TeamSlots({
  label,
  accent,
  team,
  onAdd,
  onRemove,
}: {
  label: string;
  accent: 'mine' | 'enemy';
  team: Spirit[];
  onAdd: () => void;
  onRemove: (id: string) => void;
}) {
  return (
    <div className={`team-block team-block--${accent}`}>
      <h3 className="team-block__label">
        {label} <span>{team.length}/{MAX_TEAM}</span>
      </h3>
      <ul className="team-slots">
        {team.map((s) => (
          <li key={s.id} className="team-chip">
            <span className="team-chip__main">
              <strong>{shortName(s.name)}</strong>
              <small>
                {s.type.map((t) => (
                  <span key={t} className="type-chip type-chip--xs" style={{ background: tint(typeColor(t), 0.16), color: typeColor(t) }}>
                    {t}
                  </span>
                ))}
                <span className="team-chip__total">总{s.stats.total ?? '—'}</span>
              </small>
            </span>
            <button type="button" className="team-chip__remove" onClick={() => onRemove(s.id)} aria-label={`移除 ${s.name}`}>
              ✕
            </button>
          </li>
        ))}
        {team.length < MAX_TEAM ? (
          <li className="team-add-wrap">
            <button type="button" className="team-add" onClick={onAdd}>
              + 选择精灵
            </button>
          </li>
        ) : null}
      </ul>
    </div>
  );
}
