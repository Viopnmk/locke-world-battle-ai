import { useMemo, useRef, useState } from 'react';
import { SpiritPicker } from '../components/SpiritPicker';
import { baseName, buildGuide, NATURE_SCALE_NOTE, PRESETS } from '../lib/build-guide';
import type { BuildSlot, PresetKey } from '../lib/build-guide';
import { meta, skillsOf, spirits, spiritsById } from '../lib/spirits';
import { tint, typeColor, typeMeta } from '../lib/typeChart';
import type { Skill, Spirit } from '../lib/types';

/** 默认展示参考截图里的那只：圣代甜甜（杨桃巧克力口味），编号 236 的形态之一。 */
const DEFAULT_ID = 'pet_000364';

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

const SLOT_ACCENT: Record<string, string> = {
  primary: '#b8892b',
  counter: '#b8332f',
  second: '#2f6d9e',
  support: '#63497f',
  fill: '#8a9089',
};

/** 2×2 技能方格：来源标签（升级/技能石/XX血脉）、槽位角色、图标、能耗、威力/状态、属性+技能名。 */
function SkillSlot({
  slot,
  bloodName,
  active,
  onJump,
}: {
  slot: BuildSlot;
  bloodName: string | null;
  active: boolean;
  onJump: (skillId: string) => void;
}) {
  const skill = slot.skill;
  const color = typeColor(skill.type);
  const sourceText = slot.source === '血脉' ? `${bloodName ?? ''}血脉` : slot.source;
  const damaging = isDamaging(skill);
  const accent = SLOT_ACCENT[slot.kind] ?? SLOT_ACCENT.fill;
  return (
    <button
      type="button"
      className={`skill-slot${active ? ' is-active' : ''}`}
      onClick={() => onJump(skill.id)}
      title={skill.effect || skill.name}
      aria-label={`${slot.slot}：${skill.name}（${sourceText}），点按查看说明`}
    >
      <span
        className={`skill-slot__source skill-slot__source--l${slot.source === '升级' ? 0 : slot.source === '技能石' ? 1 : 2}`}
      >
        {sourceText}
      </span>
      <span className="skill-slot__role" style={{ color: accent }}>
        {slot.slot}
      </span>
      <span className="skill-slot__body">
        <span className="skill-slot__icon" style={{ background: tint(color, 0.12) }}>
          {skill.icon ? (
            <img src={skill.icon} alt="" loading="lazy" decoding="async" />
          ) : (
            <CategoryGlyph category={skill.category} />
          )}
        </span>
        <span className="skill-slot__stats">
          <span className="skill-slot__stat skill-slot__stat--energy">
            <span aria-hidden="true">★</span> {skill.energy ?? '—'}
          </span>
          <span className="skill-slot__stat" aria-label={damaging ? `威力 ${skill.power}` : '状态技能'}>
            <CategoryGlyph category={skill.category} />
            {damaging ? skill.power : '状态'}
          </span>
        </span>
      </span>
      <span className="skill-slot__name">
        <TypeGlyph type={skill.type} size={12} />
        <span>{skill.name}</span>
      </span>
    </button>
  );
}

interface Props {
  spiritId: string | null;
  /** 选宠器开关由 URL 历史驱动（#/build[/<id>]/pick），左滑返回能回到搜索界面。 */
  pickOpen: boolean;
  onOpenPick: () => void;
  onClosePick: () => void;
  onPick: (spirit: Spirit) => void;
}

export function BuildPage({ spiritId, pickOpen, onOpenPick, onClosePick, onPick }: Props) {
  const [preset, setPreset] = useState<PresetKey>('burst');
  /** 只有用户主动点开选宠器才重置搜索词；历史回退回到 #/build/.../pick 时保留原来的搜索结果。 */
  const [pickNonce, setPickNonce] = useState(0);
  /** 点了 2×2 里的技能格：高亮并滚到对应的那条说明。 */
  const [activeSkill, setActiveSkill] = useState<string | null>(null);
  const noteRefs = useRef<Record<string, HTMLLIElement | null>>({});

  const openPick = () => {
    setPickNonce((n) => n + 1);
    onOpenPick();
  };

  const jumpToNote = (skillId: string) => {
    setActiveSkill(skillId);
    noteRefs.current[skillId]?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  };

  const selected = (spiritId ? spiritsById.get(spiritId) : undefined) ?? spiritsById.get(DEFAULT_ID) ?? spirits[0];
  const guide = useMemo(() => buildGuide(selected, preset), [selected, preset]);
  const learnable = useMemo(() => skillsOf(selected), [selected]);

  const formTag = selected.formLabel || '';

  return (
    <div className="build">
      <div className="build__bar">
        <button type="button" className="build__search" onClick={openPick} aria-label="搜索全部精灵">
          <span className="build__search-icon" aria-hidden="true">
            <svg viewBox="0 0 24 24">
              <circle cx="11" cy="11" r="7" />
              <path d="m20 20-3.6-3.6" />
            </svg>
          </span>
          <span className="build__search-text">
            <strong>搜索精灵</strong>
            <small>全图鉴 {spirits.length} 种 · 点这里换精灵</small>
          </span>
        </button>
        <button
          type="button"
          className="build__current"
          onClick={openPick}
          aria-label={`当前精灵：${baseName(selected.name)}，点击切换`}
          title={`当前：${selected.name}（点击切换）`}
        >
          <img src={selected.avatar} alt="" decoding="async" />
        </button>
      </div>

      <article className="build-card">
        <div className="build-hero">
          <div className="build-hero__side">
            {formTag ? <span className="build-card__form">{formTag}</span> : null}
            <img
              className="build-hero__avatar"
              src={selected.avatar}
              alt={`${selected.name} 头像`}
              decoding="async"
            />
            <span className="build-card__name">{baseName(selected.name)}</span>
            <span className="build-card__dex">No.{selected.dex}</span>
            <span className="build-card__types">
              {selected.type.map((t) => (
                <span key={t} className="type-chip type-chip--sm" style={{ background: tint(typeColor(t), 0.16), color: typeColor(t) }}>
                  <TypeGlyph type={t} size={12} />
                  {t}
                </span>
              ))}
            </span>
            <span className="build-card__role">
              {guide.roleLabel} · {guide.presetLabel}
            </span>
            {guide.aligned ? (
              <span
                className="build-card__sync"
                title={`四招取自阵容推荐《${guide.aligned.teamName}》（第 ${guide.aligned.round} 轮 · ${guide.aligned.role}），同技能同顺序`}
              >
                阵容同款
              </span>
            ) : null}
          </div>

          <div className="build-grid" aria-label="四个携带技能，点按查看说明">
            {guide.slots.map((slot) => (
              <SkillSlot
                key={slot.skill.id}
                slot={slot}
                bloodName={guide.bloodline.main.equipped ? guide.bloodline.main.blood : null}
                active={activeSkill === slot.skill.id}
                onJump={jumpToNote}
              />
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

        <section className="skill-notes" aria-label="防御弱点与技能说明">
          <div className="skill-notes__head">
            <h3 className="skill-notes__title">
              <span aria-hidden="true">🛡</span> 防御弱点 & 技能说明 <em>({guide.slots.length})</em>
            </h3>
            <span className="skill-notes__weak">
              {guide.weaknesses.length
                ? guide.weaknesses.map((w) => (
                    <span
                      key={w.type}
                      className="weak-chip"
                      style={{ color: typeColor(w.type), borderColor: tint(typeColor(w.type), 0.35) }}
                    >
                      <TypeGlyph type={w.type} size={11} />
                      {w.type} ×{w.multiplier}
                    </span>
                  ))
                : '克制表里没有 ×2 弱点'}
            </span>
          </div>
          <p className="skill-notes__counter">
            {guide.counter.locked
              ? `反克制位：${guide.counter.locked.type}系 ×2 克制 ${guide.counter.locked.covered.join('、')}（第 ${guide.counter.locked.slotIndex} 格${guide.counter.locked.fromBlood ? ' · 血脉' : ''}）`
              : guide.aligned
                ? `反克制位：与阵容推荐同款四招，按「${guide.aligned.role}」的分工没带 ×2 反克招`
                : guide.counter.hasWeakness
                  ? '反克制位：可学池无 ×2 反克招，改成补盲'
                  : '反克制位：没有弱点，不设'}
          </p>
          <ol className="skill-notes__list">
            {guide.slots.map((slot, index) => (
              <li
                key={slot.skill.id}
                ref={(el) => {
                  noteRefs.current[slot.skill.id] = el;
                }}
                className={`skill-note${activeSkill === slot.skill.id ? ' is-active' : ''}`}
              >
                <p className="skill-note__head">
                  <span
                    className="skill-note__idx"
                    style={{ background: SLOT_ACCENT[slot.kind] ?? SLOT_ACCENT.fill }}
                  >
                    {index + 1}
                  </span>
                  <span
                    className="skill-note__slot"
                    style={{ color: SLOT_ACCENT[slot.kind] ?? SLOT_ACCENT.fill }}
                  >
                    {slot.slot}
                  </span>
                  <span className="skill-note__type">
                    <TypeGlyph type={slot.skill.type} size={11} />
                    {slot.skill.type}
                  </span>
                  <strong className="skill-note__name">{slot.skill.name}</strong>
                  <span className="skill-note__src">
                    {slot.source === '血脉'
                      ? `${guide.bloodline.main.blood ?? ''}血脉`
                      : slot.source}
                  </span>
                </p>
                <p className="skill-note__reason">{slot.reason}</p>
              </li>
            ))}
          </ol>
        </section>

        <section className="build-row">
          <h3 className="build-row__title">
            <span className="build-row__dot" aria-hidden="true" />
            改血脉{' '}
            <small>
              {guide.bloodline.main.equipped
                ? `只带 1 个 · 占第 ${guide.bloodline.main.slotIndex} 格 · Lv.${guide.bloodline.main.level ?? 15} 解锁`
                : '本方案不改血脉 · 不带血脉技能'}
            </small>
          </h3>
          {guide.bloodline.main.equipped ? (
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
          ) : (
            <div className="blood-main blood-main--none">
              <span className="blood-tag blood-tag--none">保持普通血脉</span>
              <span className="blood-skill">
                <TypeGlyph type={guide.bloodline.main.skill.type} />
                <strong>不走血脉技能</strong>
                <small>
                  最高收益只到「{guide.bloodline.main.skill.name}」（{guide.bloodline.main.blood}血脉），
                  不如现技能，不占技能位
                </small>
              </span>
            </div>
          )}
          <p className="build-reason">{guide.bloodline.explanation}</p>
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
          <li>
            技能：这只精灵在当期阵容推荐里时，四招直接取阵容推荐为它选的那 4 个（同技能、同顺序），48 小时轮换产出新阵容后培养页自动跟着变；其余精灵按「本系主攻 → 反克制（×2 打穿克制自己的属性，优先异属性）→ 第二本系/补盲 → 辅助」排序，被已经在场的招完全压制的技能（又贵又弱）不进推荐。
          </li>
          <li>反克制：只认 BWIKI 克制表真实倍率，可学池（升级 / 技能石 / 19 个血脉候选）里没有 ×2 反克招时，就诚实改成补盲并在说明里写清楚，不编一个克制关系。</li>
          <li>性格：只改两项，+10% 给主输出或速度/生命，-10% 给用不上的那项；个体值只点 3 项，不摊薄。</li>
          <li>血脉：一只精灵只有一个血脉，18 系别血脉 + 普通血脉的 19 个血脉技能只能选 1 个；全库先按同一条规则择优保留 1 个，其余血脉技能直接不进候选池。常规学习面反制不了弱点时，这唯一名额优先给能反制的血脉技。</li>
          <li>数据：BWIKI「精灵列表」「性格」「技能」「血脉技能」模块，抓取于 {meta.fetchedAt.slice(0, 10)}，与图鉴页同一套 JSON。</li>
        </ul>
      </section>

      <SpiritPicker
        open={pickOpen}
        title="选择精灵"
        excludeIds={[]}
        freshKey={pickNonce}
        memoKey="build-pick"
        onPick={onPick}
        onClose={onClosePick}
      />
    </div>
  );
}
