import { useMemo } from 'react';
import type { ResolvedSkill, Spirit } from '../lib/types';
import { defenceProfile, formatMultiplier, tint, typeColor } from '../lib/typeChart';
import { skillGroups, skillsOf, spirits } from '../lib/spirits';

const STAT_LABELS: { key: keyof Spirit['stats']; label: string; color: string }[] = [
  { key: 'hp', label: '生命', color: '#57a773' },
  { key: 'atk', label: '物攻', color: '#d2703f' },
  { key: 'def', label: '物防', color: '#5b86b8' },
  { key: 'spa', label: '魔攻', color: '#8a6bb5' },
  { key: 'spd', label: '魔防', color: '#3f9c9a' },
  { key: 'spe', label: '速度', color: '#c2607f' },
];

const STAT_MAX = Math.max(
  ...spirits.flatMap((s) => STAT_LABELS.map((l) => Number(s.stats[l.key]) || 0)),
  1,
);

const LEARN_LABEL: Record<number, string> = { 0: '等级', 1: '技能石', 2: '血脉' };

function TypeChip({ type }: { type: string }) {
  if (!type) return <span className="type-chip type-chip--sm type-chip--none">无系</span>;
  return (
    <span className="type-chip type-chip--sm" style={{ background: tint(typeColor(type), 0.16), color: typeColor(type) }}>
      {type}
    </span>
  );
}

function SkillRow({ skill }: { skill: ResolvedSkill }) {
  return (
    <li className="skill-row">
      <div className="skill-row__head">
        <span className="skill-row__name">{skill.name}</span>
        {skill.learn === 0 && skill.level !== undefined ? <span className="skill-row__lv">Lv.{skill.level}</span> : null}
        {skill.learn !== 0 ? <span className="skill-row__lv skill-row__lv--alt">{LEARN_LABEL[skill.learn]}</span> : null}
      </div>
      <div className="skill-row__meta">
        <TypeChip type={skill.type} />
        <span>{skill.category}</span>
        {skill.power !== null && skill.power !== undefined ? <span>威力 {skill.power}</span> : <span className="muted">无威力</span>}
        {skill.energy !== null && skill.energy !== undefined ? <span>能耗 {skill.energy}</span> : null}
      </div>
      {skill.effect ? <p className="skill-row__effect">{skill.effect}</p> : null}
    </li>
  );
}

interface Props {
  spirit: Spirit;
  onClose: () => void;
  onOpenType: (type: string) => void;
}

export function SpiritDetail({ spirit, onClose, onOpenType }: Props) {
  const skills = useMemo(() => skillsOf(spirit), [spirit]);
  const groups = useMemo(() => skillGroups(skills), [skills]);
  const profile = useMemo(() => defenceProfile(spirit.type), [spirit.type]);
  const wikiUrl = `https://wiki.biligame.com/nrc/${encodeURIComponent(spirit.page)}`;

  return (
    <div className="detail" role="dialog" aria-label={`${spirit.name} 图鉴`}>
      <header className="detail__bar">
        <button type="button" className="icon-button" onClick={onClose} aria-label="返回列表">
          <span aria-hidden="true">←</span>
        </button>
        <span className="detail__bar-title">No.{spirit.dex} {spirit.name}</span>
        <a className="icon-button" href={wikiUrl} target="_blank" rel="noreferrer" aria-label="在 BWIKI 打开原始页面">
          <span aria-hidden="true">↗</span>
        </a>
      </header>

      <div className="detail__scroll">
        <section
          className="detail__hero"
          style={{ background: `linear-gradient(150deg, ${tint(typeColor(spirit.type[0]), 0.22)}, #fffdf8 70%)` }}
        >
          <img className="detail__avatar" src={spirit.avatar} alt={`${spirit.name} 头像`} loading="eager" decoding="async" />
          <div className="detail__hero-text">
            <h1>{spirit.name}</h1>
            <div className="detail__types">
              {spirit.type.map((t) => (
                <button
                  key={t}
                  type="button"
                  className="type-chip"
                  style={{ background: tint(typeColor(t), 0.18), color: typeColor(t) }}
                  onClick={() => onOpenType(t)}
                >
                  {t}系
                </button>
              ))}
              {spirit.season ? <span className="tag">{spirit.season}</span> : null}
              {spirit.stage ? <span className="tag">进化阶段 {spirit.stage}</span> : null}
            </div>
            <p className="detail__desc">{spirit.desc}</p>
          </div>
        </section>

        <section className="panel">
          <h2 className="panel__title">
            种族值 <span className="panel__hint">Wiki 原值</span>
          </h2>
          <div className="stat-grid">
            {STAT_LABELS.map(({ key, label, color }) => {
              const value = Number(spirit.stats[key]) || 0;
              return (
                <div className="stat" key={key}>
                  <span className="stat__label">{label}</span>
                  <span className="stat__value">{spirit.stats[key] ?? '—'}</span>
                  <span className="stat__bar">
                    <span style={{ width: `${Math.min(100, (value / STAT_MAX) * 100)}%`, background: color }} />
                  </span>
                </div>
              );
            })}
          </div>
          <div className="stat-total">
            <span>总种族值</span>
            <strong>{spirit.stats.total ?? '—'}</strong>
          </div>
        </section>

        {spirit.trait ? (
          <section className="panel">
            <h2 className="panel__title">特性</h2>
            <p className="trait-name">{spirit.trait.name}</p>
            <p className="trait-effect">{spirit.trait.effect || '（Wiki 未提供效果文本）'}</p>
          </section>
        ) : null}

        <section className="panel">
          <h2 className="panel__title">属性受击</h2>
          <div className="match-summary">
            <div>
              <h3>弱于</h3>
              <div className="chip-line">
                {profile.weak.length
                  ? profile.weak.map((w) => (
                      <span key={w.type} className="type-chip type-chip--sm" style={{ background: '#fdecec', color: '#b8332f' }}>
                        {w.type} {formatMultiplier(w.multiplier)}
                      </span>
                    ))
                  : <span className="muted">无</span>}
              </div>
            </div>
            <div>
              <h3>抵抗</h3>
              <div className="chip-line">
                {profile.resist.length
                  ? profile.resist.map((r) => (
                      <span key={r.type} className="type-chip type-chip--sm" style={{ background: '#e9f2fb', color: '#2f6d9e' }}>
                        {r.type} {formatMultiplier(r.multiplier)}
                      </span>
                    ))
                  : <span className="muted">无</span>}
              </div>
            </div>
          </div>
        </section>

        <section className="panel">
          <h2 className="panel__title">
            可学技能 <span className="panel__hint">{skills.length} 个</span>
          </h2>
          {groups.length === 0 ? (
            <p className="muted">Wiki 数据模块里没有这只精灵的学习面。</p>
          ) : (
            groups.map((g) => (
              <div className="skill-group" key={g.key}>
                <h3 className="skill-group__title">
                  {g.title} <span>{g.hint}</span>
                </h3>
                <ul className="skill-list">
                  {g.skills.map((s) => (
                    <SkillRow key={`${s.id}-${s.learn}`} skill={s} />
                  ))}
                </ul>
              </div>
            ))
          )}
        </section>

        <section className="panel panel--quiet">
          <h2 className="panel__title">基础信息</h2>
          <dl className="info-grid">
            <div>
              <dt>编号</dt>
              <dd>No.{spirit.dex}</dd>
            </div>
            <div>
              <dt>身高</dt>
              <dd>{spirit.height?.raw ?? '—'}</dd>
            </div>
            <div>
              <dt>体重</dt>
              <dd>{spirit.weight?.raw ?? '—'}</dd>
            </div>
            <div>
              <dt>蛋组</dt>
              <dd>{spirit.eggGroups.length ? spirit.eggGroups.join(' / ') : '—'}</dd>
            </div>
            <div>
              <dt>骑乘</dt>
              <dd>{spirit.rideable ? (spirit.doubleRide ? '可骑乘 · 可同乘' : '可骑乘') : '不可骑乘'}</dd>
            </div>
            <div>
              <dt>形态</dt>
              <dd>{spirit.formLabel || (spirit.form === 'main' ? '普通形态' : spirit.form || '—')}</dd>
            </div>
          </dl>
          <p className="source-line">
            数据来源：
            <a href={wikiUrl} target="_blank" rel="noreferrer">
              BWIKI · {spirit.page}
            </a>
          </p>
        </section>
      </div>
    </div>
  );
}

