import { useCallback, useEffect, useMemo, useState } from 'react';
import { spirits } from '../lib/spirits';
import type { Spirit } from '../lib/types';
import { teamMetrics } from '../lib/analysis';
import { tint, typeColor } from '../lib/typeChart';
import {
  DEFAULT_MODEL,
  FALLBACK_MODELS,
  analyzeTeam,
  aiEndpoint,
  checkHealth,
  loadModels,
  type AiModel,
  type AiResult,
} from '../services/ai-client';
import { AiAnswer } from './AiAnswer';
import { SpiritPicker } from './SpiritPicker';
import { TeamAnalysis } from './TeamAnalysis';

const DEMO_MINE = ['迪莫', '喵喵', '水蓝蓝'];
const DEMO_ENEMY = ['火花', '雪影娃娃', '机械方方'];
const MAX_TEAM = 6;

const shortName = (name: string) => name.replace(/（[^）]*）/g, '');

function byName(name: string): Spirit | null {
  return spirits.find((s) => s.name === name) ?? null;
}

export function AiPanel() {
  const [mine, setMine] = useState<Spirit[]>([]);
  const [enemy, setEnemy] = useState<Spirit[]>([]);
  const [picker, setPicker] = useState<null | 'mine' | 'enemy'>(null);

  const [models, setModels] = useState<AiModel[]>(FALLBACK_MODELS);
  const [model, setModel] = useState(DEFAULT_MODEL);
  const [provider, setProvider] = useState('workers-ai');
  const [online, setOnline] = useState<'checking' | 'ok' | 'down'>('checking');

  const [result, setResult] = useState<AiResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    checkHealth()
      .then((h) => {
        if (!alive) return;
        setOnline('ok');
        setProvider(h.provider);
      })
      .catch(() => {
        if (alive) setOnline('down');
      });
    loadModels().then((m) => {
      if (!alive) return;
      setModels(m.models);
      setProvider(m.provider);
      setModel((cur) => (m.models.some((x) => x.id === cur) ? cur : m.defaultModel));
    });
    return () => {
      alive = false;
    };
  }, []);

  const metrics = useMemo(() => (mine.length && enemy.length ? teamMetrics(mine, enemy) : null), [mine, enemy]);

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

  async function run() {
    if (!mine.length || !enemy.length) return;
    setBusy(true);
    setError(null);
    try {
      const res = await analyzeTeam(
        mine.map((s) => s.id),
        enemy.map((s) => s.id),
        model,
      );
      setResult(res);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const canRun = mine.length > 0 && enemy.length > 0 && !busy;

  return (
    <div className="ai">
      <section className="panel">
        <h2 className="panel__title">
          双方阵容分析 <span className="panel__hint">Workers AI · 免费额度</span>
        </h2>
        <p className="ai__lead">
          先选我方与敌方各 1–6 只精灵：页面用图鉴数据算出对位矩阵、共同弱点与速度差；再由模型写阵容互补、首发与换人。
          模型只拿到服务器端核验过的数据，回答里的数字会再校验一遍。
        </p>
        <div className="ai__status">
          <span className={online === 'ok' ? 'dot dot--on' : online === 'down' ? 'dot dot--off' : 'dot'} aria-hidden="true" />
          {online === 'ok' ? 'Worker 在线' : online === 'down' ? 'Worker 暂时连不上 · 仅本地确定性格分析可用' : '正在检测 Worker…'}
          <span className="ai__model">{provider === 'openai-compatible' ? '外部网关（Worker 侧配置）' : 'Cloudflare Workers AI（无需 API Key）'}</span>
        </div>
        <p className="source-line">端点：{aiEndpoint}</p>
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

        {!mine.length || !enemy.length ? (
          <p className="ai__hint">两边各至少选 1 只，下面的对位矩阵和 AI 按钮才会启用。</p>
        ) : null}
      </section>

      {metrics ? <TeamAnalysis mine={mine} enemy={enemy} metrics={metrics} /> : null}

      <section className="panel panel--ai">
        <h2 className="panel__title">
          AI 战术分析 <span className="panel__hint">服务器端核验 + 数字溯源</span>
        </h2>
        <div className="ai__pickers ai__pickers--row">
          <label>
            <span>模型（可切换）</span>
            <select value={model} onChange={(e) => setModel(e.target.value)} disabled={busy}>
              {models.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                  {m.recommended ? ' · 推荐' : ''}
                </option>
              ))}
            </select>
          </label>
        </div>
        <p className="ai__hint">
          {models.find((m) => m.id === model)?.note ?? '免费模型'} · 通常 3–10 秒
        </p>

        <button type="button" className="primary-button" onClick={run} disabled={!canRun}>
          {busy ? '模型分析中…' : result ? '重新生成分析' : '生成 AI 战术分析'}
        </button>

        <details className="request-preview">
          <summary>查看将发送给 Worker 的数据</summary>
          <pre>
            {JSON.stringify(
              {
                mode: 'team',
                model,
                myTeam: mine.map((s) => s.name),
                enemyTeam: enemy.map((s) => s.name),
                note: '只传精灵名称/ID；种族值、技能与倍率由 Worker 从图鉴数据重新解析',
              },
              null,
              2,
            )}
          </pre>
        </details>

        {error ? (
          <div className="ai__error">
            <strong>{error}</strong>
            <p>本地确定性分析仍然有效；也可以换一个模型或稍后重试。</p>
          </div>
        ) : null}

        {result ? <AiAnswer result={result} /> : null}
      </section>

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
