import type { AiResult, AiVerification } from '../services/ai-client';

export function VerificationBadge({ verification }: { verification: AiVerification }) {
  const issues = [
    ...(verification.unverifiedNumbers ?? []).map((n) => `数字 ${n}`),
    ...(verification.typeIssues ?? []).map((t) => `属性「${t}系」`),
    ...(verification.unknownTerms ?? []).map((t) => `${t.kind}「${t.term}」`),
    ...(verification.outOfTeam ?? []).map((n) => `阵容外精灵「${n}」`),
    ...(verification.switchIssues ?? []).map(
      (x) => `对「${x.enemy}」换上「${x.member}」与对位表矛盾（攻 ×${x.attack} / 受 ×${x.threat}）`,
    ),
  ];

  if (verification.grounded) {
    return (
      <span className="verify verify--ok">
        ✓ 已溯源 · 检查了 {verification.numbersChecked} 个数字，未见编造
      </span>
    );
  }

  return (
    <details className="verify verify--warn">
      <summary>⚠ {issues.length} 处未能在图鉴事实中溯源</summary>
      <ul>
        {issues.map((t) => (
          <li key={t}>{t}</li>
        ))}
      </ul>
      <p>模型输出了事实之外的数字/名称，阅读时请以本页确定性计算为准。</p>
    </details>
  );
}

interface Props {
  result: AiResult;
}

/** 统一渲染 Worker 返回的分段回答 + 校验徽章 + 用量。 */
export function AiAnswer({ result }: Props) {
  const { answer, verification } = result;
  const headlineRepeated = answer.sections[0]?.lines[0] === answer.headline;
  return (
    <div className="ai-answer">
      <div className="ai-answer__meta">
        <span className="tag tag--model">{result.modelLabel}</span>
        <span className="muted">{(result.elapsedMs / 1000).toFixed(1)}s</span>
        {result.usage?.neurons ? <span className="muted">· {Math.round(result.usage.neurons)} neurons</span> : null}
        {verification.retried ? <span className="muted">· 已自动纠正一次</span> : null}
      </div>

      {headlineRepeated ? null : <p className="ai-answer__headline">{answer.headline}</p>}

      {answer.sections.map((s, i) => (
        <section key={`${s.title}-${i}`} className="ai-answer__section">
          <h3>{s.title}</h3>
          <ul>
            {s.lines.map((line, j) => (
              <li key={`${line}-${j}`}>{line}</li>
            ))}
          </ul>
        </section>
      ))}

      <VerificationBadge verification={verification} />

      {verification.grounded ? null : (
        <details className="raw-text">
          <summary>查看模型原始回答</summary>
          <pre>{answer.text}</pre>
        </details>
      )}
    </div>
  );
}
