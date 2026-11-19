import { useEffect, useMemo, useState } from 'react';
import {
  CATEGORY_LABEL,
  memberSpirits,
  presetSpirit,
  previousRound,
  resolveMemberSkill,
  ROTATION_INTERVAL_HOURS,
  ROTATION_NEXT_AT,
  ROTATION_ROUND,
  ROTATION_UPDATED_AT,
  shortName,
  TEAM_PRESETS,
} from '../lib/team-presets';
import type { TeamPreset } from '../lib/team-types';
import { names, teamPlanMetrics } from '../lib/team-plan';
import { meta } from '../lib/spirits';
import type { Spirit } from '../lib/types';
import { tint, typeColor } from '../lib/typeChart';

type Filter = 'all' | string;

interface Props {
  onOpenBuild: (spirit: Spirit) => void;
  onImport: (team: Spirit[], side: 'mine' | 'enemy', presetId: string) => void;
}

/** 2026-11-19T11:35:00+08:00 → 11/19 11:35（北京时间） */
function beijingShort(iso: string): string {
  return `${iso.slice(5, 7)}/${iso.slice(8, 10)} ${iso.slice(11, 16)}`;
}

/** 距离下次轮换还有多久 */
function countdownText(nextIso: string, now: number): string {
  const diff = new Date(nextIso).getTime() - now;
  if (!Number.isFinite(diff)) return '时间待定';
  if (diff <= 0) return '正在等待下一轮生成';
  const totalMinutes = Math.floor(diff / 60000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours >= 1) return `还剩 ${hours} 小时 ${minutes} 分`;
  return `还剩 ${minutes} 分`;
}

export function TeamsPage({ onOpenBuild, onImport }: Props) {
  const [filter, setFilter] = useState<Filter>('all');
  const [now, setNow] = useState(() => Date.now());
  const prev = previousRound();

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);

  const list = useMemo(
    () => (filter === 'all' ? TEAM_PRESETS : TEAM_PRESETS.filter((t) => t.id === filter)),
    [filter],
  );

  return (
    <div className="teams">
      <section className="panel panel--engine teams__intro">
        <h2 className="panel__title">
          阵容推荐 <span className="panel__hint">48 小时自动轮换</span>
        </h2>
        <p className="ai__lead">
          每 {ROTATION_INTERVAL_HOURS} 小时由全图鉴（{meta.spiritCount} 条形态记录）重新组 3 套<strong>全新</strong>阵容：
          3 种不同打法，18 只互不重复的精灵。每套都写明<strong>起手第一只、六只分工与每人 4 个技能、核心联动、以及从开局到逆风局的 5 阶段战术链</strong>；
          特性与技能全部取自 BWIKI 原文，数字用「对战」页同一个本地引擎现算。
        </p>
        <div className="engine-pills">
          <span className="engine-pill">🔄 每 {ROTATION_INTERVAL_HOURS} 小时换 3 套</span>
          <span className="engine-pill">🥇 起手第一只</span>
          <span className="engine-pill">🎯 六人分工 + 4 技能</span>
          <span className="engine-pill">🧠 5 阶段战术链</span>
          <span className="engine-pill">⚡ 一键导入对战</span>
        </div>
      </section>

      <section className="panel rotation-bar" aria-label="轮换状态">
        <div className="rotation-bar__head">
          <span className="rotation-badge">第 {ROTATION_ROUND} 轮推荐</span>
          <span className="rotation-bar__time">北京时间 {beijingShort(ROTATION_UPDATED_AT)} 更新</span>
        </div>
        <p className="rotation-bar__next">
          <span aria-hidden="true">🔄</span> {ROTATION_INTERVAL_HOURS} 小时自动轮换 · 下次更新{' '}
          {beijingShort(ROTATION_NEXT_AT)}（{countdownText(ROTATION_NEXT_AT, now)}）
        </p>
        {prev ? (
          <p className="rotation-bar__prev">
            上一轮（第 {prev.round} 轮 · {prev.archetypes.map((a) => a.label).join(' / ')}）已归档，不再展示。
          </p>
        ) : null}

        <div className="chip-strip chip-strip--filters chip-strip--wrap" role="group" aria-label="本轮 3 套打法">
          <button
            type="button"
            className={`type-chip type-chip--pick team-filter${filter === 'all' ? ' is-active' : ''}`}
            onClick={() => setFilter('all')}
            aria-pressed={filter === 'all'}
          >
            全部 {TEAM_PRESETS.length} 套
          </button>
          {TEAM_PRESETS.map((t) => {
            const active = filter === t.id;
            return (
              <button
                key={t.id}
                type="button"
                className={`type-chip type-chip--pick team-filter${active ? ' is-active' : ''}`}
                onClick={() => setFilter(active ? 'all' : t.id)}
                aria-pressed={active}
              >
                {t.archetypeLabel} {t.name}
              </button>
            );
          })}
        </div>
      </section>

      {list.map((preset) => (
        <TeamCard key={preset.id} preset={preset} onOpenBuild={onOpenBuild} onImport={onImport} />
      ))}

      <section className="panel panel--quiet data-note">
        <h2 className="panel__title">这一轮的战术手册是怎么算出来的</h2>
        <ul>
          <li>
            由 <code>scripts/rotate-teams.ts</code> 生成（<code>npm run rotate:teams</code>）：先在全图鉴上按战术原型做约束搜索
            （打击面、共同弱点、每个弱点是否有队友以 ≤0.5 倍接住、六种分工是否都有人），再做爬山换人把最弱的一环换掉。
          </li>
          <li>
            <strong>起手第一只</strong>取队里的先手位，理由只用真实数字：速度在队内排第几、技能有没有先手/速度强化、本身有几个 ×2 弱点、其中有几个有队友能接。
          </li>
          <li>
            <strong>六人分工</strong>是 6! = 720 种角色分配里贴合度最高的一种；每人 4 个技能按「主攻 → 补盲 → 角色机制 → 防守/第二补盲」从该精灵自己的学习面（升级 / 技能石 / 血脉）里选。
            血脉技能互斥：一只精灵只有一个血脉，19 个血脉技能只能带 1 个，推荐里不会出现第二个。
          </li>
          <li>
            <strong>核心联动</strong>只写队内真实存在的关系：属性联防、状态接力、能耗压制、蓄力联动、残血反打、天气、换人惩罚、打击面互补——每条都点名技能、特性与数值，查不到就不写。
          </li>
          <li>
            <strong>5 阶段战术链</strong>（开局 / 第一阶段 / 中期 / 后期 / 逆风局）由当轮 6 只的速度、主招威力、共同弱点与换人盾现算，不套模板。
          </li>
          <li>每轮从 10 种战术原型里挑 3 种，且不与上一轮重复；上一轮的 18 只优先排除，只有凑不出合格阵容时才会放宽（卡片的「弱点」里会写明重叠了几只）。</li>
        </ul>
      </section>
    </div>
  );
}

function TeamCard({
  preset,
  onOpenBuild,
  onImport,
}: {
  preset: TeamPreset;
  onOpenBuild: (spirit: Spirit) => void;
  onImport: (team: Spirit[], side: 'mine' | 'enemy', presetId: string) => void;
}) {
  const metrics = useMemo(() => teamPlanMetrics(preset), [preset]);
  const team = useMemo(() => memberSpirits(preset), [preset]);
  const leadSpirit = presetSpirit(preset.lead.spiritId);
  const leadMember = preset.members.find((m) => m.spiritId === preset.lead.spiritId);

  return (
    <article className="panel team-card" aria-labelledby={`team-${preset.id}`}>
      <header className="team-card__head">
        <div className="team-card__title">
          <p className="team-card__kicker">
            {CATEGORY_LABEL[preset.category] ?? preset.archetypeLabel} · {preset.sub}
          </p>
          <h2 id={`team-${preset.id}`}>{preset.name}</h2>
        </div>
        <span className="team-card__size">6 只</span>
      </header>

      <p className="team-card__summary">{preset.summary}</p>

      <div className="team-card__tags">
        {preset.tags.map((tag) => (
          <span key={tag} className="team-tag">
            {tag}
          </span>
        ))}
      </div>

      {/* 数据面板：全部现算 */}
      <div className="team-metrics" aria-label="队伍数据面板">
        <div className="team-metric">
          <strong>{metrics.avgTotal}</strong>
          <small>平均种族值</small>
          <em>
            {metrics.totalRange.min}~{metrics.totalRange.max}
          </em>
        </div>
        <div className="team-metric">
          <strong>{metrics.fastest ? metrics.fastest.spe : '—'}</strong>
          <small>最快速度</small>
          <em>{metrics.fastest ? shortName(metrics.fastest.name) : '—'}</em>
        </div>
        <div className="team-metric">
          <strong>
            {metrics.physical.length} · {metrics.special.length} · {metrics.balanced.length}
          </strong>
          <small>物攻 / 魔攻 / 均衡</small>
          <em>{metrics.speedTiers.fast >= 3 ? '高速线厚' : metrics.speedTiers.fast ? '有快攻点' : '慢速队'}</em>
        </div>
        <div className="team-metric">
          <strong>
            {metrics.coverageCount}/{18}
          </strong>
          <small>能打出 ≥2 倍的属性</small>
        </div>
      </div>

      {/* 起手第一只 */}
      {leadSpirit ? (
        <section className="team-section team-lead" aria-label="起手第一只">
          <div className="team-lead__badge">起手第一只</div>
          <div className="team-lead__head">
            <button
              type="button"
              className="team-lead__avatar"
              onClick={() => onOpenBuild(leadSpirit)}
              aria-label={`查看 ${leadSpirit.name} 的培养方案`}
            >
              <img src={leadSpirit.avatar} alt="" loading="lazy" decoding="async" />
            </button>
            <div className="team-lead__id">
              <button type="button" className="team-lead__name" onClick={() => onOpenBuild(leadSpirit)}>
                {shortName(leadSpirit.name)}
                <span aria-hidden="true">›</span>
              </button>
              <div className="team-lead__tags">
                <span className="team-member__role" style={{ background: tint(typeColor(leadSpirit.type[0]), 0.16), color: typeColor(leadSpirit.type[0]) }}>
                  {leadMember?.role ?? '先手'}
                </span>
                {leadMember?.duty ? <span className="team-lead__duty">{leadMember.duty}</span> : null}
                {leadSpirit.type.map((t) => (
                  <span key={t} className="type-chip type-chip--sm" style={{ background: tint(typeColor(t), 0.16), color: typeColor(t) }}>
                    {t}
                  </span>
                ))}
                <span className="team-lead__stat">速 {leadSpirit.stats.spe ?? '—'}</span>
              </div>
            </div>
          </div>
          <p className="team-lead__why">{preset.lead.why}</p>
          <div className="team-lead__openers">
            {preset.lead.openers.map((op, i) => (
              <div key={`${op.name}-${i}`} className="lead-opener">
                <span className="lead-opener__no">{i === 0 ? '先' : '再'}</span>
                <div className="lead-opener__body">
                  <strong>{op.name}</strong>
                  <small>{op.why}</small>
                </div>
              </div>
            ))}
          </div>
          <p className="team-lead__caution">
            <span aria-hidden="true">⚠️</span> {preset.lead.caution}
          </p>
        </section>
      ) : null}

      {/* 5 阶段战术链 */}
      <section className="team-section">
        <h3 className="team-section__title">
          完整团队战术配合链 <span>开局 → 第一阶段 → 中期 → 后期 → 逆风局</span>
        </h3>
        <ol className="battle-plan">
          {preset.battlePlan.map((phase, i) => (
            <li key={phase.key} className={`battle-phase battle-phase--${phase.key}`}>
              <div className="battle-phase__head">
                <span className="battle-phase__no">{i + 1}</span>
                <span className="battle-phase__label">{phase.label}</span>
                <strong className="battle-phase__title">{phase.title}</strong>
              </div>
              <p className="battle-phase__text">{phase.text}</p>
            </li>
          ))}
        </ol>
      </section>

      {/* 核心技能联动 */}
      <section className="team-section">
        <h3 className="team-section__title">
          核心技能联动 <span>特性 × 技能，全部来自图鉴原文</span>
        </h3>
        <ul className="team-synergies">
          {preset.synergies.map((syn) => (
            <li key={syn.title} className="team-synergy">
              <div className="team-synergy__title">
                <span aria-hidden="true">🔗</span> {syn.title}
              </div>
              <p className="team-synergy__text">{syn.text}</p>
              {syn.skills.length ? (
                <div className="team-synergy__chips">
                  {syn.skills.map((ref) => {
                    const spirit = presetSpirit(ref.spiritId);
                    return (
                      <span key={`${ref.spiritId}-${ref.name}`} className="team-synergy__chip">
                        {spirit ? shortName(spirit.name) : ref.spiritId} · {ref.name}
                      </span>
                    );
                  })}
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      </section>

      {/* 六人分工与 4 技能 */}
      <section className="team-section">
        <h3 className="team-section__title">
          六只精灵的团队分工 <span>每人 4 个推荐技能 · 点名字看培养方案</span>
        </h3>
        <ul className="team-roster">
          {preset.members.map((member) => {
            const spirit = presetSpirit(member.spiritId);
            if (!spirit) return null;
            const accent = typeColor(spirit.type[0]);
            return (
              <li key={member.spiritId} className="team-member">
                <button
                  type="button"
                  className="team-member__main"
                  onClick={() => onOpenBuild(spirit)}
                  aria-label={`查看 ${spirit.name} 的培养方案`}
                >
                  <span className="team-member__avatar" aria-hidden="true">
                    <img src={spirit.avatar} alt="" loading="lazy" decoding="async" />
                  </span>
                  <span className="team-member__body">
                    <span className="team-member__top">
                      <strong>{shortName(spirit.name)}</strong>
                      <span className="team-member__role" style={{ background: tint(accent, 0.14), color: accent }}>
                        {member.role}
                      </span>
                      {member.duty ? <span className="team-member__duty">{member.duty}</span> : null}
                    </span>
                    <span className="team-member__types">
                      {spirit.type.map((t) => (
                        <span
                          key={t}
                          className="type-chip type-chip--sm"
                          style={{ background: tint(typeColor(t), 0.16), color: typeColor(t) }}
                        >
                          {t}
                        </span>
                      ))}
                      <span className="team-member__total">总 {spirit.stats.total ?? '—'}</span>
                      <span className="team-member__spe">速 {spirit.stats.spe ?? '—'}</span>
                    </span>
                    <span className="team-member__note">{member.note}</span>
                  </span>
                  <span className="team-member__go" aria-hidden="true">
                    ›
                  </span>
                </button>

                <ul className="member-skills">
                  {member.skills.map((ref) => {
                    const sk = resolveMemberSkill(spirit, ref.name);
                    return (
                      <li key={ref.name} className="member-skill">
                        <div className="member-skill__head">
                          {ref.slot ? <span className="member-skill__slot">{ref.slot}</span> : null}
                          <strong className="member-skill__name">{ref.name}</strong>
                          {sk ? (
                            <span
                              className="member-skill__meta"
                              style={{ background: tint(typeColor(sk.type), 0.12), color: typeColor(sk.type) }}
                            >
                              {sk.type}·{sk.category}
                              {sk.power ? ` · 威力${sk.power}` : ''}
                              {typeof sk.energy === 'number' ? ` · 能耗${sk.energy}` : ''}
                            </span>
                          ) : null}
                        </div>
                        <p className="member-skill__why">{ref.why}</p>
                      </li>
                    );
                  })}
                </ul>
                {member.traitSynergy ? (
                  <p className="team-member__trait">
                    <span>特性</span> {member.traitSynergy}
                  </p>
                ) : null}
                <details className="team-member__more">
                  <summary>
                    完整特性原文 <span>图鉴</span>
                  </summary>
                  <p className="team-member__trait team-member__trait--raw">
                    {spirit.trait ? <>「{spirit.trait.name}」{spirit.trait.effect}</> : '图鉴未提供特性'}
                  </p>
                </details>
              </li>
            );
          })}
        </ul>
      </section>

      {/* 折叠：优势与弱点 */}
      <details className="team-fold">
        <summary>
          优势与弱点 <span>数据现算，弱点照实写</span>
        </summary>
        <ul className="team-pros">
          {preset.pros.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
        <p className="team-risk">
          <span>弱点</span>
          {preset.risk}
        </p>
      </details>

      {/* 折叠：对抗数据 */}
      <details className="team-fold">
        <summary>
          对抗数据 <span>共同弱点与抗性</span>
        </summary>
        <div className="team-matchups">
          <div className="team-matchups__block">
            <h4>共同弱点</h4>
            {metrics.sharedWeak.length ? (
              <ul>
                {metrics.weakAnswers.map((row) => {
                  const stat = metrics.sharedWeak.find((w) => w.type === row.type);
                  return (
                    <li key={row.type}>
                      <span
                        className="type-chip type-chip--sm"
                        style={{ background: tint(typeColor(row.type), 0.16), color: typeColor(row.type) }}
                      >
                        {row.type} ×{stat?.count ?? 0}
                      </span>
                      <span>
                        打中 {names(stat?.members ?? [])}；队内能抗：
                        <strong>{row.answers.length ? names(row.answers, 2) : '无'}</strong>
                      </span>
                    </li>
                  );
                })}
              </ul>
            ) : (
              <p className="muted">没有属性可以同时克制 2 只以上。</p>
            )}
          </div>
          <div className="team-matchups__block">
            <h4>共同抗性</h4>
            {metrics.sharedResist.length ? (
              <ul>
                {metrics.sharedResist.map((row) => (
                  <li key={row.type}>
                    <span
                      className="type-chip type-chip--sm"
                      style={{ background: tint(typeColor(row.type), 0.16), color: typeColor(row.type) }}
                    >
                      {row.type} ×{row.count}
                    </span>
                    <span>被 {names(row.members)} 抵抗</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="muted">没有两只是同一种抵抗。</p>
            )}
          </div>
        </div>
        {metrics.topPower ? (
          <p className="team-top-power">
            全队最高单发：<strong>{shortName(metrics.topPower.name)}</strong> 的 {metrics.topPower.skill}
            （{metrics.topPower.type}·威力{metrics.topPower.power}
            {metrics.topPower.energy ? `·能耗${metrics.topPower.energy}` : ''}）；六只各自最高威力技能的平均值{' '}
            <strong>{metrics.avgTopPower}</strong>。
          </p>
        ) : null}
      </details>

      {/* 折叠：配队逻辑 + 逐只联动 */}
      <details className="team-fold">
        <summary>
          配队逻辑与逐只特性 <span>为什么是这 6 只</span>
        </summary>
        <ul className="team-plan">
          {preset.plan.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
        <ol className="team-chain">
          {preset.chain.map((step, i) => {
            const spirit = presetSpirit(step.spiritId);
            const skill = spirit && step.skillName ? resolveMemberSkill(spirit, step.skillName) : null;
            return (
              <li key={`${step.spiritId}-${i}`}>
                <div className="team-chain__head">
                  <span className="team-chain__step">{i + 1}</span>
                  <strong className="team-chain__who">{spirit ? shortName(spirit.name) : step.spiritId}</strong>
                  {skill ? (
                    <span
                      className="team-chain__skill"
                      style={{ background: tint(typeColor(skill.type), 0.14), color: typeColor(skill.type) }}
                    >
                      {skill.name} · {skill.type}
                      {skill.power ? ` · 威力${skill.power}` : ''}
                      {skill.energy ? ` · 能耗${skill.energy}` : ''}
                    </span>
                  ) : null}
                </div>
                <p className="team-chain__text">{step.text}</p>
              </li>
            );
          })}
        </ol>
      </details>

      <div className="team-actions">
        <button type="button" className="primary-button" onClick={() => onImport(team, 'mine', preset.id)}>
          导入我方去对战 →
        </button>
        <button type="button" className="ghost-button" onClick={() => onImport(team, 'enemy', preset.id)}>
          设为敌方测试
        </button>
      </div>
    </article>
  );
}
