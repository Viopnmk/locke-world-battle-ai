import { useEffect, useMemo, useState } from 'react';
import {
  buildTeamMatchup,
  energyLabel,
  fmtMult,
  planOf,
  weakestType,
} from '../lib/team-matchup';
import type { MatchupCandidate, TypeMatchupPlan } from '../lib/team-matchup';
import { presetSpirit, shortName } from '../lib/team-presets';
import type { TeamPreset } from '../lib/team-types';
import { tint, typeColor } from '../lib/typeChart';
import type { Spirit } from '../lib/types';

interface Props {
  preset: TeamPreset;
  onOpenBuild: (spirit: Spirit) => void;
}

/** 加减分写成「承伤 ×0.5 +5」，负分带负号，用户能自己复算 */
function scoreText(c: MatchupCandidate): string {
  return c.scoreParts
    .map((p) => `${p.label} ${p.points >= 0 ? '+' : ''}${p.points}`)
    .join(' · ');
}

function MultChip({ label, value, good }: { label: string; value: number; good: boolean }) {
  return (
    <span className={`matchup-mult${good ? ' is-good' : value >= 2 ? ' is-bad' : ''}`}>
      {label} {fmtMult(value)}
    </span>
  );
}

/**
 * 敌方 18 系：敌方上哪个系，就从本套 6 只里换哪只、4 招按什么顺序放。
 * 全部由 team-matchup.ts 现算 —— 48 小时轮换换队后自动跟着变。
 */
export function TeamMatchupPanel({ preset, onOpenBuild }: Props) {
  const plans = useMemo(() => buildTeamMatchup(preset), [preset]);
  const weakest = useMemo(() => weakestType(plans), [plans]);
  const [type, setType] = useState(weakest);

  useEffect(() => {
    setType(weakest);
  }, [weakest]);

  const plan: TypeMatchupPlan = planOf(plans, type);
  const pickSpirit = presetSpirit(plan.pick.spiritId);
  const backupSpirit = presetSpirit(plan.backup.spiritId);

  return (
    <section className="team-section team-matchup" aria-label="敌方 18 系对阵：换宠与出招">
      <h3 className="team-section__title">
        敌方 18 系 · 换宠 &amp; 出招 <span>点系别 → 换谁上场、4 招怎么放</span>
      </h3>
      <p className="matchup__lead">
        默认点开<strong>{weakest}系</strong>（本套最没把握的一系）。打分 = 承伤倍率 + 反打倍率 + 速度 + 入场能量，
        全部按这套 6 只的真实数据和图鉴 18 系克制表现算。
      </p>

      <div className="matchup-grid" role="group" aria-label="选择敌方系别">
        {plans.map((p) => {
          const active = p.type === plan.type;
          const color = typeColor(p.type);
          return (
            <button
              key={p.type}
              type="button"
              className={`matchup-cell${active ? ' is-active' : ''}`}
              style={
                active
                  ? { background: color, color: '#fffdf8', borderColor: color }
                  : { background: tint(color, 0.13), color, borderColor: tint(color, 0.28) }
              }
              onClick={() => setType(p.type)}
              aria-pressed={active}
              aria-label={`敌方 ${p.type} 系：换 ${shortName(p.pick.name)}`}
            >
              <span className="matchup-cell__type">{p.type}</span>
              <span className="matchup-cell__pick" style={active ? { color: 'rgba(255,253,248,0.9)' } : undefined}>
                {shortName(p.pick.name)}
              </span>
            </button>
          );
        })}
      </div>

      <div className="matchup-detail">
        <div className="matchup-detail__head">
          <button
            type="button"
            className="matchup-avatar"
            onClick={() => pickSpirit && onOpenBuild(pickSpirit)}
            aria-label={`查看 ${plan.pick.name} 的培养方案`}
          >
            <img src={plan.pick.avatar} alt="" loading="lazy" decoding="async" />
          </button>
          <div className="matchup-detail__id">
            <button
              type="button"
              className="matchup-name"
              onClick={() => pickSpirit && onOpenBuild(pickSpirit)}
            >
              {shortName(plan.pick.name)}
              <span aria-hidden="true">›</span>
            </button>
            <div className="matchup-detail__tags">
              <span
                className="matchup-role"
                style={{ background: tint(typeColor(plan.pick.types[0]), 0.14), color: typeColor(plan.pick.types[0]) }}
              >
                {plan.pick.role}
              </span>
              {plan.pick.types.map((t) => (
                <span
                  key={t}
                  className="type-chip type-chip--sm"
                  style={{ background: tint(typeColor(t), 0.16), color: typeColor(t) }}
                >
                  {t}
                </span>
              ))}
              <span className="matchup-detail__stat">
                速 {plan.pick.speed ?? '—'} · {energyLabel(plan.pick.energyStatus)}
              </span>
            </div>
          </div>
          <div className="matchup-detail__mults">
            <MultChip label="承伤" value={plan.pick.defMultiplier} good={plan.pick.defMultiplier <= 0.5} />
            <MultChip label="反打" value={plan.pick.atkMultiplier} good={plan.pick.atkMultiplier >= 2} />
          </div>
        </div>

        <p className="matchup-score">
          <span>本方总分 {plan.pick.score}</span>
          {scoreText(plan.pick)}
        </p>

        {plan.switchInNote ? (
          <p className="matchup-swift">
            <span aria-hidden="true">⚡</span> {plan.switchInNote}
          </p>
        ) : null}

        <ol className="matchup-steps">
          {plan.steps.map((step) => (
            <li key={`${step.no}-${step.label}`} className={`matchup-step matchup-step--${step.kind}`}>
              <span className="matchup-step__no" aria-hidden="true">
                {step.no}
              </span>
              <div className="matchup-step__body">
                <div className="matchup-step__head">
                  <span className="matchup-step__label">{step.label}</span>
                  {step.skill ? (
                    <>
                      <strong className="matchup-step__skill">{step.skill.name}</strong>
                      <span
                        className="matchup-step__meta"
                        style={{ background: tint(typeColor(step.skill.type), 0.12), color: typeColor(step.skill.type) }}
                      >
                        {step.skill.type}·{step.skill.category}
                        {step.skill.power ? `·威力${step.skill.power}` : ''}
                        {`·${step.skill.energy}费`}
                      </span>
                    </>
                  ) : null}
                </div>
                <p className="matchup-step__text">{step.text}</p>
                {step.effect ? <p className="matchup-step__effect">图鉴：{step.effect}</p> : null}
              </div>
            </li>
          ))}
        </ol>

        <p className="matchup-caution">
          <span aria-hidden="true">⚠️</span> {plan.caution}
        </p>

        {backupSpirit ? (
          <button type="button" className="matchup-backup" onClick={() => onOpenBuild(backupSpirit)}>
            <span className="matchup-backup__tag">备选退路</span>
            <img src={backupSpirit.avatar} alt="" loading="lazy" decoding="async" />
            <span className="matchup-backup__body">
              <strong>{shortName(backupSpirit.name)}</strong>
              <small>
                {plan.backup.role} · 承 {fmtMult(plan.backup.defMultiplier)} · 反{' '}
                {fmtMult(plan.backup.atkMultiplier)}
                {plan.backup.coreSkill ? `（${plan.backup.coreSkill.name}）` : ''}
              </small>
            </span>
            <span className="matchup-backup__go" aria-hidden="true">
              ›
            </span>
          </button>
        ) : null}
      </div>

      <details className="team-fold matchup-fold">
        <summary>
          查看全部 18 系速览 <span>换谁 + 核心招，点一行切过去看详细出招</span>
        </summary>
        <ul className="matchup-list">
          {plans.map((p) => {
            const active = p.type === plan.type;
            return (
              <li key={p.type}>
                <button
                  type="button"
                  className={`matchup-row${active ? ' is-active' : ''}`}
                  onClick={() => setType(p.type)}
                  aria-pressed={active}
                >
                  <span
                    className="matchup-row__type"
                    style={{ background: tint(typeColor(p.type), 0.16), color: typeColor(p.type) }}
                  >
                    {p.type}
                  </span>
                  <span className="matchup-row__pick">
                    {shortName(p.pick.name)}
                    <small>
                      承 {fmtMult(p.pick.defMultiplier)} · 反 {fmtMult(p.pick.atkMultiplier)}
                    </small>
                  </span>
                  <span className="matchup-row__skill">
                    {p.quick}
                    <small>{p.pick.score} 分</small>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      </details>
    </section>
  );
}
