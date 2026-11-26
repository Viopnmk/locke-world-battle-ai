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
import { TeamMatchupPanel } from '../components/TeamMatchupPanel';

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
          每 {ROTATION_INTERVAL_HOURS} 小时由全图鉴（{meta.spiritCount} 条形态记录）重新组 3 套<strong>全新</strong>阵容：高爆发输出、均衡攻防、能量经济与持续作战。
          每套都写明<strong>起手第一只、敌方 18 系换宠与出招、六只分工与每人 4 个技能、逐只能量明细（上场 / 技能 / 回能 / 10 点上限）、六项团队配合分析、核心联动与 5 阶段战术链</strong>；
          特性与技能全部取自 BWIKI 原文，数字用「对战」页同一个本地引擎现算。
        </p>
        <div className="engine-pills">
          <span className="engine-pill">🔄 每 {ROTATION_INTERVAL_HOURS} 小时换 3 套</span>
          <span className="engine-pill">🥇 起手第一只</span>
          <span className="engine-pill">🛡️ 敌方 18 系换宠出招</span>
          <span className="engine-pill">🎯 六人分工 + 4 技能</span>
          <span className="engine-pill">⚡ 逐只能量明细</span>
          <span className="engine-pill">🧠 六项配合分析</span>
          <span className="engine-pill">🪜 5 阶段战术链</span>
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
        <h2 className="panel__title">这一轮的阵容与能量是怎么算出来的</h2>
        <ul>
          <li>
            由 <code>scripts/rotate-teams.ts</code> 生成（<code>npm run rotate:teams</code>）：先按战术方向在全图鉴做约束搜索
            （4 招打击面、共同弱点是否有队友以 ≤0.5 倍接住、六种分工、特性是否有触发源、能量能否在 10 点内打出），再做换人爬山。
          </li>
          <li>
            <strong>能量模型</strong>（<code>src/lib/energy.ts</code>）：每只精灵上限 10 点；普通精灵上场自带 10 点，
            「初始能量为0」的特性入场为 0（地脉 / 结晶水 / 散热 / 慢热型 / 盗魂铃），另有「突破上限」类特性单独处理。
            技能能耗来自图鉴 <code>energy</code> 字段，回能只有聚能（一回合 +5）、特性与技能三种来源，<strong>没有每回合自动回能</strong>。
            换人不额外扣能量、只花一回合（官方手册未写明扣能量，按待实测处理）。
          </li>
          <li>
            <strong>敌方 18 系换宠与出招</strong>（<code>src/lib/team-matchup.ts</code>）纯现算：对每个系，按「承受该系攻击的倍率 +
            4 招对它的最高克制倍率 + 速度 + 入场能量」给 6 只打分，取最高者上场、再取更抗的一只当退路；出招链只排该成员真实的
            4 个推荐技能，能量账一步步算（10 点上限、聚能 +5），「使用后消耗全部生命」的换命招不进链；全队没有 0.5 倍抗性时照实写。
            <code>npm run verify:matchups</code> 会把 3 套 × 18 系 = 54 条全部反算一遍。
          </li>
          <li>
            <strong>配招</strong>先点特性再挑招：特性要迸发 / 回能 / 0 费 / 某系技能，就把能点亮它的技能选进 4 招；
            点不亮就在卡片上写「本套未触发」。血脉技能互斥，一只精灵最多 1 个（<code>equip-rules.ts</code>）。
          </li>
          <li>
            <strong>联动</strong>只从原文能对上的模板生成：每条带 evidence（图鉴原句）与证据强度（verified / inferred）。
            「抬费」类特性只讲对手多付能量，不写成增伤；查不到因果的联动直接不生成。
          </li>
          <li>
            <strong>打击面</strong>一律按「推荐 4 招」算，另附「全学习面」作参考，两个口径不混写；同队不允许出现同图鉴编号的两个形态，
            68 只首领形态默认不进候选池（无法确认是否可上场 PvP，待核验）。
          </li>
          <li>
            生成器写完之前先跑 <code>scripts/lib/team-audit.ts</code> 全量校验（能量复算、特性可用性、血脉 ≤1、同 dex、定位冲突、联动证据），
            不通过就退出，旧数据不动；通过后先备份到 <code>src/data/.backup/</code> 再原子写入。
          </li>
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

      {/* 图鉴预览条：开头先让用户一眼看清这套阵容是哪六只 */}
      <div className="team-card__roster-strip" role="list" aria-label={`${preset.name} 的六只精灵`}>
        {preset.members.map((member) => {
          const spirit = presetSpirit(member.spiritId);
          if (!spirit) return null;
          const isLead = member.spiritId === preset.lead.spiritId;
          return (
            <button
              key={member.spiritId}
              type="button"
              role="listitem"
              className={`roster-strip__item${isLead ? ' is-lead' : ''}`}
              onClick={() => onOpenBuild(spirit)}
              aria-label={`${isLead ? '起手第一只 ' : ''}${spirit.name}，查看培养方案`}
            >
              <span className="roster-strip__thumb">
                <img src={spirit.avatar} alt={spirit.name} loading="lazy" decoding="async" />
                {isLead ? (
                  <span className="roster-strip__lead" aria-hidden="true">
                    首
                  </span>
                ) : null}
              </span>
              <span className="roster-strip__name">{shortName(spirit.name)}</span>
            </button>
          );
        })}
      </div>

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
          <small>4 招能打出 ×2 的属性</small>
          <em>学习面 {metrics.coverageLearnsetCount}/18</em>
        </div>
        <div className="team-metric">
          <strong>{preset.energySummary?.entryTotal ?? 60}</strong>
          <small>6 只上场能量合计</small>
          <em>平均 {preset.energySummary?.avgCost ?? '—'} 费 / 招</em>
        </div>
        <div className="team-metric">
          <strong>
            {preset.energySummary?.readyCount ?? 6}/6
          </strong>
          <small>入场即可出招</small>
          <em>{preset.energySummary?.gatherCount ? `${preset.energySummary.gatherCount} 只需聚能` : '无需聚能'}</em>
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

      {/* 敌方 18 系：换哪只、技能怎么放 */}
      <TeamMatchupPanel preset={preset} onOpenBuild={onOpenBuild} />

      {/* 能量分配 */}
      <section className="team-section team-energy" aria-label="能量分配">
        <h3 className="team-section__title">
          能量分配与剩余 <span>上场 / 技能 / 回能 / 10 点上限</span>
        </h3>
        <p className="team-energy__line">
          {preset.energySummary?.line ??
            '6 只入场能量合计 60 点，默认每只 10 点；聚能一回合 +5 点。'}
        </p>
        <ul className="energy-rows">
          {preset.members.map((member) => {
            const spirit = presetSpirit(member.spiritId);
            const en = member.energy;
            if (!spirit || !en) return null;
            return (
              <li key={`en-${member.spiritId}`} className={`energy-row energy-row--${en.status}`}>
                <div className="energy-row__head">
                  <strong>{shortName(spirit.name)}</strong>
                  <span className="energy-row__role">{member.role}</span>
                  <span className="energy-row__status">
                    {en.status === 'ready' ? '入场即出招' : en.status === 'gather' ? '需先聚能' : '入场打不出'}
                  </span>
                </div>
                <div className="energy-row__nums">
                  <span className="energy-chip energy-chip--entry">
                    上场 {en.entry}/{en.cap}
                  </span>
                  <span className="energy-chip">技能 {en.costs.join('/')} 费</span>
                  <span className="energy-chip">
                    首回合 {en.firstTurn ? `「${en.firstTurn.name}」剩 ${en.firstTurn.leftover}` : '无可用招'}
                  </span>
                  <span className="energy-chip">聚能 {en.gatherTurns} 回合</span>
                </div>
                <p className="energy-row__note">
                  <span>回能</span>
                  {en.recoveries.join('、') || '靠聚能 +5/回合'}；{en.caution}
                </p>
                <p className="energy-row__source">
                  {en.entryLabel}：{en.entryDetail}
                </p>
              </li>
            );
          })}
        </ul>
        <p className="team-energy__note">
          口径：普通精灵上场自带 10 点能量，「初始能量为0」类特性入场为 0；换人只花一回合、不额外扣能量（待实测）。
          恢复瓶回复量官方未公布，未计入。
        </p>
      </section>

      {/* 六项团队配合分析 */}
      {preset.analysis ? (
        <section className="team-section team-analysis" aria-label="团队配合分析">
          <h3 className="team-section__title">
            团队配合分析 <span>六项：输出 · 覆盖 · 防御 · 轮换 · 能量 · 反制</span>
          </h3>
          <ul className="analysis-list">
            {[
              ['①', preset.analysis.core],
              ['②', preset.analysis.coverage],
              ['③', preset.analysis.resilience],
              ['④', preset.analysis.rotation],
              ['⑤', preset.analysis.energy],
              ['⑥', preset.analysis.counters],
            ].map(([no, blk]) => {
              const b = blk as typeof preset.analysis.core;
              return (
                <li key={b.key} className={`analysis-block analysis-block--${b.key}`}>
                  <h4 className="analysis-block__title">
                    <span aria-hidden="true">{no as string}</span> {b.title}
                  </h4>
                  <p className="analysis-block__text">{b.text}</p>
                  <ul className="analysis-block__bullets">
                    {b.bullets.map((line) => (
                      <li key={line}>{line}</li>
                    ))}
                  </ul>
                </li>
              );
            })}
          </ul>
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
                    {member.energy ? (
                      <span className="team-member__energy">
                        <b>上场 {member.energy.entry}</b>
                        <span>技能 {member.energy.costs.join('/')} 费</span>
                        <span>{member.energy.firstTurn ? `首回合「${member.energy.firstTurn.name}」剩 ${member.energy.firstTurn.leftover}` : '首回合无招'}</span>
                      </span>
                    ) : null}
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
                  <p className={`team-member__trait team-member__trait--${member.traitStatus ?? 'conditional'}`}>
                    <span>特性</span> {member.traitSynergy}
                    {member.traitStatus === 'idle' ? <em className="trait-warn">本套未触发</em> : null}
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
