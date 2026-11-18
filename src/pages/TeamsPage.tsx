import { useMemo, useState } from 'react';
import {
  CATEGORY_LABEL,
  memberSpirits,
  presetSpirit,
  resolveMemberSkill,
  shortName,
  TEAM_PRESETS,
} from '../lib/team-presets';
import type { TeamCategory, TeamPreset } from '../lib/team-presets';
import { names, teamPlanMetrics } from '../lib/team-plan';
import { meta } from '../lib/spirits';
import type { Spirit } from '../lib/types';
import { tint, typeColor } from '../lib/typeChart';

type Filter = 'all' | TeamCategory;

const FILTERS: { key: Filter; label: string }[] = [
  { key: 'all', label: '全部' },
  { key: 'weather', label: '天气体系' },
  { key: 'rush', label: '速攻压制' },
  { key: 'grind', label: '消耗联防' },
];

interface Props {
  onOpenBuild: (spirit: Spirit) => void;
  onImport: (team: Spirit[], side: 'mine' | 'enemy', presetId: string) => void;
}

export function TeamsPage({ onOpenBuild, onImport }: Props) {
  const [filter, setFilter] = useState<Filter>('all');
  const list = useMemo(
    () => (filter === 'all' ? TEAM_PRESETS : TEAM_PRESETS.filter((t) => t.category === filter)),
    [filter],
  );

  return (
    <div className="teams">
      <section className="panel panel--engine teams__intro">
        <h2 className="panel__title">
          阵容推荐 <span className="panel__hint">特性 × 技能联动</span>
        </h2>
        <p className="ai__lead">
          {TEAM_PRESETS.length} 套成型队伍，每一套的天气、异常、特性与技能都取自图鉴里的 {meta.spiritCount} 条形态记录，
          数字用「对战」页同一个本地引擎现算。点队伍里的名字直接跳到它的<strong>培养方案</strong>，
          或者一键导入对战页看逐只对位。
        </p>
        <div className="engine-pills">
          <span className="engine-pill">🧬 特性与技能都标了出处</span>
          <span className="engine-pill">📐 数据面板现算</span>
          <span className="engine-pill">⚡ 一键导入对战</span>
        </div>
      </section>

      <div className="chip-strip chip-strip--filters" role="group" aria-label="按打法筛选阵容">
        {FILTERS.map((f) => {
          const active = filter === f.key;
          const count = f.key === 'all' ? TEAM_PRESETS.length : TEAM_PRESETS.filter((t) => t.category === f.key).length;
          return (
            <button
              key={f.key}
              type="button"
              className={`type-chip type-chip--pick team-filter${active ? ' is-active' : ''}`}
              onClick={() => setFilter(f.key)}
              aria-pressed={active}
            >
              {f.label} {count}
            </button>
          );
        })}
      </div>

      {list.map((preset) => (
        <TeamCard key={preset.id} preset={preset} onOpenBuild={onOpenBuild} onImport={onImport} />
      ))}

      <section className="panel panel--quiet data-note">
        <h2 className="panel__title">怎么读这些队伍</h2>
        <ul>
          <li>每张卡里的「核心联动」一步一步写清：谁开天气／叠异常，哪条特性在哪一步生效，接哪个技能。</li>
          <li>「数据面板」的种族值、速度、物魔分工、共同弱点、克制覆盖面，全部由本页现算，和「对战」页同一套引擎。</li>
          <li>「共同弱点」照实显示——天气队多为单属性，弱点是成组出现的，卡里同时给出队内谁能抗这一系。</li>
          <li>技能数值（属性·威力·能耗）直接来自该精灵自己的学习面，技能石与血脉技能也已计入。</li>
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

  return (
    <article className="panel team-card" aria-labelledby={`team-${preset.id}`}>
      <header className="team-card__head">
        <div className="team-card__title">
          <p className="team-card__kicker">
            {CATEGORY_LABEL[preset.category]} · {preset.sub}
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

      <section className="team-section">
        <h3 className="team-section__title">
          核心联动 <span>特性 × 技能，按出手顺序</span>
        </h3>
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
      </section>

      <section className="team-section">
        <h3 className="team-section__title">
          配队逻辑 <span>为什么是这 6 只</span>
        </h3>
        <ul className="team-plan">
          {preset.plan.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
        <p className="team-risk">
          <span>代价</span>
          {preset.risk}
        </p>
      </section>

      <section className="team-section">
        <h3 className="team-section__title">
          六人配置 <span>点名字看培养方案</span>
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

                <details className="team-member__more">
                  <summary>
                    特性 × 技能 <span>{member.skills.length}</span>
                  </summary>
                  <p className="team-member__trait">
                    {spirit.trait ? (
                      <>
                        「{spirit.trait.name}」{spirit.trait.effect}
                      </>
                    ) : (
                      '图鉴未提供特性'
                    )}
                  </p>
                  <ul className="team-member__skills">
                    {member.skills.map((ref) => {
                      const sk = resolveMemberSkill(spirit, ref.name);
                      return (
                        <li key={ref.name}>
                          <span className="team-member__skill-name">
                            {ref.name}
                            {sk ? (
                              <em>
                                {sk.type}·{sk.category}
                                {sk.power ? ` · 威力${sk.power}` : ''}
                                {sk.energy ? ` · 能耗${sk.energy}` : ''}
                              </em>
                            ) : null}
                          </span>
                          <span className="team-member__skill-why">{ref.why}</span>
                        </li>
                      );
                    })}
                  </ul>
                </details>
              </li>
            );
          })}
        </ul>
      </section>

      <section className="team-section">
        <h3 className="team-section__title">
          对抗数据 <span>共同弱点与抗性</span>
        </h3>
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
      </section>

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
