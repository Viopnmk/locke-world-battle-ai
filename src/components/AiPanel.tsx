import { useMemo, useState } from 'react';
import { aiConfig, analyzeBattle, analyzeLocally, buildPrompt, isAiConfigured, AiNotConfiguredError } from '../services/ai-client';
import type { BattleAnalysis } from '../services/ai-client';
import { skillGroups, skillsOf, spirits, spiritsById, sortByDex } from '../lib/spirits';
import type { Spirit } from '../lib/types';

const ordered = sortByDex(spirits);

function options() {
  return ordered.map((s) => ({ id: s.id, label: `No.${s.dex} ${s.name}（${s.type.join('/')}）` }));
}

export function AiPanel() {
  const [attackerId, setAttackerId] = useState(ordered[0]?.id ?? '');
  const [defenderId, setDefenderId] = useState(ordered[1]?.id ?? ordered[0]?.id ?? '');
  const [analysis, setAnalysis] = useState<BattleAnalysis | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [showPrompt, setShowPrompt] = useState(false);

  const attacker = spiritsById.get(attackerId) as Spirit | undefined;
  const defender = spiritsById.get(defenderId) as Spirit | undefined;

  const prompt = useMemo(() => {
    if (!attacker || !defender) return '';
    return buildPrompt({ attacker: { spirit: attacker, skills: skillsOf(attacker) }, defender: { spirit: defender, skills: skillsOf(defender) } });
  }, [attacker, defender]);

  async function run() {
    if (!attacker || !defender) return;
    setBusy(true);
    setError(null);
    const req = { attacker: { spirit: attacker, skills: skillsOf(attacker) }, defender: { spirit: defender, skills: skillsOf(defender) } };
    try {
      const result = isAiConfigured ? await analyzeBattle(req) : analyzeLocally(req);
      setAnalysis(result);
    } catch (e) {
      if (e instanceof AiNotConfiguredError) {
        setAnalysis(analyzeLocally(req));
        setError('还没接模型端点，先给出本地速算结果。');
      } else {
        setError(e instanceof Error ? e.message : String(e));
        setAnalysis(analyzeLocally(req));
      }
    } finally {
      setBusy(false);
    }
  }

  const attackerGroups = attacker ? skillGroups(skillsOf(attacker)) : [];

  return (
    <div className="ai">
      <section className="panel">
        <h2 className="panel__title">
          AI 对战分析 <span className="panel__hint">Phase 2 入口</span>
        </h2>
        <p className="ai__lead">
          模型端点由 <code>VITE_AI_ENDPOINT</code> / <code>VITE_AI_MODEL</code> 注入，密钥放在 Cloudflare Worker 一侧，
          仓库里没有任何 key。端点未配置时，下面的结论全部由图鉴数据本地算出（会明确标注“本地速算”）。
        </p>
        <div className="ai__status">
          <span className={isAiConfigured ? 'dot dot--on' : 'dot'} aria-hidden="true" />
          {isAiConfigured ? `已配置端点：${aiConfig.endpoint}` : '未配置模型端点 · 使用本地速算'}
          <span className="ai__model">模型：{aiConfig.model}</span>
        </div>

        <div className="ai__pickers">
          <label>
            <span>我方精灵</span>
            <select value={attackerId} onChange={(e) => setAttackerId(e.target.value)}>
              {options().map((o) => (
                <option key={o.id} value={o.id}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>对手精灵</span>
            <select value={defenderId} onChange={(e) => setDefenderId(e.target.value)}>
              {options().map((o) => (
                <option key={o.id} value={o.id}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>
        </div>

        {attackerGroups.length ? (
          <p className="ai__hint">
            我方可用技能 {attackerGroups.reduce((n, g) => n + g.skills.length, 0)} 个（来自图鉴学习面）
          </p>
        ) : null}

        <button type="button" className="primary-button" onClick={run} disabled={busy || !attacker || !defender}>
          {busy ? '分析中…' : '生成对战分析'}
        </button>
        <button type="button" className="ghost-button" onClick={() => setShowPrompt((v) => !v)}>
          {showPrompt ? '收起将要发送的提示词' : '查看将要发送的提示词'}
        </button>
        {showPrompt ? <pre className="prompt-preview">{prompt || '选好双方精灵后显示'}</pre> : null}
        {error ? <p className="ai__error">{error}</p> : null}
      </section>

      {analysis ? (
        <section className="panel">
          <h2 className="panel__title">
            分析结果 <span className="panel__hint">{analysis.origin === 'model' ? '模型输出' : '本地速算（未接模型）'}</span>
          </h2>
          <p className="ai__headline">{analysis.headline}</p>
          {analysis.matchup.length ? (
            <ul className="ai__list">
              {analysis.matchup.map((m) => (
                <li key={m}>{m}</li>
              ))}
            </ul>
          ) : null}
          {analysis.skillNotes.length ? (
            <>
              <h3 className="ai__subhead">推荐技能</h3>
              <ul className="ai__list">
                {analysis.skillNotes.map((m) => (
                  <li key={m}>{m}</li>
                ))}
              </ul>
            </>
          ) : null}
          {analysis.cautions.length ? (
            <>
              <h3 className="ai__subhead">风险提示</h3>
              <ul className="ai__list">
                {analysis.cautions.map((m) => (
                  <li key={m}>{m}</li>
                ))}
              </ul>
            </>
          ) : null}
        </section>
      ) : null}

      <section className="panel panel--quiet">
        <h2 className="panel__title">Phase 2 接口约定</h2>
        <pre className="prompt-preview">
{`POST \${VITE_AI_ENDPOINT}/analyze
{ "model": "\${VITE_AI_MODEL}", "prompt": "<buildPrompt() 结果>" }
→ { "headline": string, "matchup": string[], "skillNotes": string[], "cautions": string[] }`}
        </pre>
        <p className="source-line">实现文件：src/services/ai-client.ts（含 prompt 构造与本地兜底分析）</p>
      </section>
    </div>
  );
}
