import { useMemo, useState } from 'react';
import { SpiritPicker } from '../components/SpiritPicker';
import { baseName, buildGuide, NATURE_SCALE_NOTE, PRESETS } from '../lib/build-guide';
import type { BuildSlot, PresetKey } from '../lib/build-guide';
import { meta, skillsOf, spirits, spiritsById } from '../lib/spirits';
import { tint, typeColor, typeMeta } from '../lib/typeChart';
import type { Skill, Spirit } from '../lib/types';

/** 默认展示参考截图里的那只：圣代甜甜（杨桃巧克力口味），编号 236 的形态之一。 */
const DEFAULT_ID = 'pet_000364';

/** 顶栏快捷位：全图鉴总种族值最高的 6 个形态（同名形态只取一个）。 */
const FEATURED: Spirit[] = (() => {
  const seen = new Set<string>();
  const out: Spirit[] = [];
  for (const s of [...spirits].sort((a, b) => (b.stats.total ?? 0) - (a.stats.total ?? 0))) {
    const key = baseName(s.name);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
    if (out.length >= 6) break;
  }
  return out;
})();

function CategoryGlyph({ category }: { category: string }) {
  const common = {
    viewBox: '0 0 24 24',
    'aria-hidden': true as const,
    className: 'cat-glyph',
  };
  if (category === '物理') {
    return (
      <svg {...common}>
        <path d="M4 20 20 4" />
        <path d="M14 4h6v6" />
      </svg>
    );
  }
  if (category === '魔法') {
    return (
      <svg {...common}>
        <path d="M12 3l2.3 6.7L21 12l-6.7 2.3L12 21l-2.3-6.7L3 12l6.7-2.3z" />
      </svg>
    );
  }
  if (category === '防御') {
    return (
      <svg {...common}>
        <path d="M12 3.5 19 6.5v5.8c0 4.1-3 7.2-7 8.7-4-1.5-7-4.6-7-8.7V6.5z" />
      </svg>
    );
  }
  return (
    <svg {...common}>
      <circle cx="12" cy="12" r="7.5" />
      <path d="M12 8.5v7M8.5 12h7" />
    </svg>
  );
}

function TypeGlyph({ type, size = 14 }: { type: string; size?: number }) {
  const meta = typeMeta(type);
  if (meta?.icon) {
    return <img className="type-glyph" src={meta.icon} alt={type} width={size} height={size} loading="lazy" decoding="async" />;
  }
  return (
    <span className="type-glyph type-glyph--text" style={{ background: typeColor(type), width: size, height: size }}>
      {type.slice(0, 1)}
    </span>
  );
}

function isDamaging(skill: Skill) {
  return typeof skill.power === 'number' && skill.power > 0;
}

function SkillSlot({ slot }: { slot: BuildSlot }) {
  const skill = slot.skill;
  return (
    <div className="bslot" title={skill.effect || skill.name}>
      <span className={`bslot__source bslot__source--l${slot.source === '升级' ? 0 : slot.source === '技能石' ? 1 : 2}`}>
        {slot.source}
      </span>
      <div className="bslot__body">
        <span className="bslot__icon" style={{ background: tint(typeColor(skill.type), 0.12) }}>
          {skill.icon ? (
            <img src={skill.icon} alt="" loading="lazy" decoding="async" />
          ) : (
            <CategoryGlyph category={skill.category} />
          )}
        </span>
        <span className="bslot__stats">
          <span className="bslot__stat bslot__stat--energy">
            <span aria-hidden="true">★</span> {skill.energy ?? '—'}
          </span>
          <span
            className="bslot__stat"
            aria-label={isDamaging(skill) ? `威力 ${skill.power}` : '状态技能'}
          >
            <CategoryGlyph category={skill.category} />
            {isDamaging(skill) ? skill.power : '状态'}
          </span>
        </span>
      </div>
      <span className="bslot__name">
        <TypeGlyph type={skill.type} />
        <span>{skill.name}</span>
      </span>
      <span className="bslot__slot">{slot.slot}</span>
    </div>
  );
}

interface Props {
  spiritId: string | null;
  onPick: (spirit: Spirit) => void;
}

export function BuildPage({ spiritId, onPick }: Props) {
  const [preset, setPreset] = useState<PresetKey>('burst');
  const [pickerOpen, setPickerOpen] = useState(false);

  const selected = (spiritId ? spiritsById.get(spiritId) : undefined) ?? spiritsById.get(DEFAULT_ID) ?? spirits[0];
  const guide = useMemo(() => buildGuide(selected, preset), [selected, preset]);
  const learnable = useMemo(() => skillsOf(selected), [selected]);

  const strip = useMemo(() => {
    const rest = FEATURED.filter((s) => s.id !== selected.id);
    return [selected, ...rest].slice(0, 7);
  }, [selected]);

  const formTag = selected.formLabel || '';

  return (
    <div className="build">
      <div className="build__strip" role="group" aria-label="快捷选择精灵">
        {strip.map((s) => (
          <button
            key={s.id}
            type="button"
            className={`quick-tile${s.id === selected.id ? ' is-active' : ''}`}
            onClick={() => onPick(s)}
            aria-pressed={s.id === selected.id}
            aria-label={s.name}
          >
            <img src={s.avatar} alt="" loading="lazy" decoding="async" />
          </button>
        ))}
        <button type="button" className="quick-tile quick-tile--search" onClick={() => setPickerOpen(true)} aria-label="搜索全部精灵">
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <circle cx="11" cy="11" r="7" />
            <path d="m20 20-3.6-3.6" />
          </svg>
          <span>搜索</span>
        </button>
      </div>

      <article className="build-card">
        <div className="build-card__head">
          <div className="build-card__who">
            {formTag ? <span className="build-card__form">{formTag}</span> : null}
            <img className="build-card__avatar" src={selected.avatar} alt={`${selected.name} 头像`} decoding="async" />
            <span className="build-card__name">{baseName(selected.name)}</span>
            <span className="build-card__types">
              {selected.type.map((t) => (
                <span key={t} className="type-chip type-chip--sm" style={{ background: tint(typeColor(t), 0.16), color: typeColor(t) }}>
                  <TypeGlyph type={t} size={13} />
                  {t}
                </span>
              ))}
            </span>
            <span className="build-card__role">
              {guide.roleLabel} · {guide.presetLabel}
            </span>
          </div>

          <div className="build-card__skills">
            {guide.slots.map((slot) => (
              <SkillSlot key={slot.skill.id} slot={slot} />
            ))}
          </div>
        </div>

        <section className="build-row">
          <h3 className="build-row__title">
            <span className="build-row__dot" aria-hidden="true" />
            性格 <small>{NATURE_SCALE_NOTE}</small>
          </h3>
          <p className="nature-pill">
            <strong>{guide.nature.main.nature.name}</strong>
            <span>
              「{guide.nature.main.nature.up} <em className="up">+10%</em>，{guide.nature.main.nature.down}{' '}
              <em className="down">-10%</em>」
            </span>
          </p>
          <p className="build-note">备选：{guide.nature.alt.nature.name}（{guide.nature.alt.line}）</p>
        </section>

        <section className="build-row">
          <h3 className="build-row__title">
            <span className="build-row__dot" aria-hidden="true" />
            个体值
          </h3>
          <div className="iv-row">
            {guide.ivs.map((iv) => (
              <span key={iv.key} className="iv-pill" title={iv.reason}>
                {iv.label}
              </span>
            ))}
          </div>
        </section>

        <section className="build-row">
          <h3 className="build-row__title">
            <span className="build-row__dot" aria-hidden="true" />
            改血脉 <small>血脉技能 Lv.{guide.bloodline.main.level ?? 15} 解锁</small>
          </h3>
          <div className="blood-main">
            <span className={`blood-tag blood-tag--${guide.bloodline.main.kind === '功能' ? 'utility' : 'damage'}`}>
              {guide.bloodline.main.blood}血脉
            </span>
            <span className="blood-skill">
              <TypeGlyph type={guide.bloodline.main.skill.type} />
              <strong>{guide.bloodline.main.skill.name}</strong>
              <small>
                {guide.bloodline.main.skill.category}
                {isDamaging(guide.bloodline.main.skill)
                  ? ` · 威力 ${guide.bloodline.main.skill.power} / 能耗 ${guide.bloodline.main.skill.energy}`
                  : ' · 变化'}
              </small>
            </span>
          </div>
          <p className="build-reason">{guide.bloodline.explanation}</p>
          <div className="blood-options">
            {guide.bloodline.options
              .filter((o) => o.skill.id !== guide.bloodline.main.skill.id)
              .slice(0, 3)
              .map((o) => (
                <span key={`${o.blood}-${o.skill.id}`} className="blood-option">
                  <TypeGlyph type={o.skill.type} size={12} />
                  {o.blood} · {o.skill.name}
                </span>
              ))}
          </div>
          <p className="build-note">{guide.bloodline.note}</p>
        </section>

        <details className="build-detail">
          <summary>
            详细模式 · 搭配理由
            <span aria-hidden="true">›</span>
          </summary>
          <div className="build-detail__body">
            <div className="preset-switch" role="group" aria-label="切换培养流派">
              {PRESETS.map((p) => (
                <button
                  key={p.key}
                  type="button"
                  className={`preset-button${preset === p.key ? ' is-active' : ''}`}
                  onClick={() => setPreset(p.key)}
                  aria-pressed={preset === p.key}
                >
                  <strong>{p.label}</strong>
                  <small>{p.hint}</small>
                </button>
              ))}
            </div>

            <ul className="reason-list">
              {guide.slots.map((slot) => (
                <li key={slot.skill.id}>
                  <b>
                    {slot.slot} · {slot.skill.name}
                  </b>
                  <span>{slot.reason}</span>
                  {slot.skill.effect ? <em>{slot.skill.effect}</em> : null}
                </li>
              ))}
            </ul>

            <ul className="reason-list">
              <li>
                <b>性格 · {guide.nature.main.nature.name}</b>
                <span>{guide.nature.main.reason}</span>
              </li>
              <li>
                <b>性格备选 · {guide.nature.alt.nature.name}</b>
                <span>{guide.nature.alt.reason}</span>
              </li>
              {guide.ivs.map((iv) => (
                <li key={iv.key}>
                  <b>个体值 · {iv.label}</b>
                  <span>{iv.reason}</span>
                </li>
              ))}
            </ul>

            <ul className="reason-list">
              {guide.summary.map((line) => (
                <li key={line}>
                  <span>{line}</span>
                </li>
              ))}
            </ul>

            <p className="build-note">
              本页 {learnable.length} 个可学技能全部来自 BWIKI 学习面（等级 {learnable.filter((s) => s.learn === 0).length} ·
              技能石 {learnable.filter((s) => s.learn === 1).length} · 血脉 {learnable.filter((s) => s.learn === 2).length}）；
              性格提升/降低项来自 Wiki 性格页，百分比口径来自游戏内说明。
            </p>
          </div>
        </details>
      </article>

      <section className="panel panel--quiet build__note">
        <h2 className="panel__title">这套方案是怎么来的</h2>
        <ul>
          <li>技能：按本系主攻 → 换属性副攻 → 补盲 → 变化排序，只用它自己学习面里的技能，评分 = 威力（含能耗修正）× 本系 × 类别 × 属性克制收益 × 特性协同。</li>
          <li>性格：只改两项，+10% 给主输出或速度/生命，-10% 给用不上的那项；个体值只点 3 项，不摊薄。</li>
          <li>血脉：每个学习面在 18 系别血脉 + 普通血脉下各继承一个血脉技能（Wiki 模块原文），按流派挑最贴的那个。</li>
          <li>数据：BWIKI「精灵列表」「性格」「技能」「血脉技能」模块，抓取于 {meta.fetchedAt.slice(0, 10)}，与图鉴页同一套 JSON。</li>
        </ul>
      </section>

      <SpiritPicker
        open={pickerOpen}
        title="选择精灵"
        excludeIds={[]}
        onPick={(s) => {
          setPickerOpen(false);
          onPick(s);
        }}
        onClose={() => setPickerOpen(false)}
      />
    </div>
  );
}
