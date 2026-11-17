import { useMemo } from 'react';
import type { Spirit } from '../lib/types';
import { tint, typeColor } from '../lib/typeChart';

interface Props {
  spirit: Spirit;
  onOpen: (spirit: Spirit) => void;
}

export function SpiritCard({ spirit, onOpen }: Props) {
  const [first] = spirit.type;
  const accent = typeColor(first);
  return (
    <button
      type="button"
      className="spirit-card"
      onClick={() => onOpen(spirit)}
      style={{ background: `linear-gradient(135deg, ${tint(accent, 0.1)}, #fffdf8 62%)` }}
      aria-label={`查看 ${spirit.name} 的图鉴`}
    >
      <span className="spirit-card__avatar" aria-hidden="true">
        <img src={spirit.avatar} alt="" loading="lazy" decoding="async" />
      </span>
      <span className="spirit-card__main">
        <span className="spirit-card__top">
          <span className="spirit-card__dex">No.{spirit.dex}</span>
          {spirit.season ? <span className="spirit-card__season">{spirit.season}</span> : null}
        </span>
        <span className="spirit-card__name">{spirit.name}</span>
        <span className="spirit-card__types">
          {spirit.type.map((t) => (
            <span key={t} className="type-chip type-chip--sm" style={{ background: tint(typeColor(t), 0.16), color: typeColor(t) }}>
              {t}
            </span>
          ))}
        </span>
      </span>
      <span className="spirit-card__total">
        <strong>{spirit.stats.total ?? '—'}</strong>
        <small>种族值</small>
      </span>
    </button>
  );
}

interface ListProps {
  spirits: Spirit[];
  onOpen: (spirit: Spirit) => void;
  emptyHint: string;
}

export function SpiritList({ spirits, onOpen, emptyHint }: ListProps) {
  const view = useMemo(() => spirits.slice(0, 120), [spirits]);
  if (spirits.length === 0) {
    return <p className="empty-state">{emptyHint}</p>;
  }
  return (
    <div className="spirit-list">
      {view.map((s) => (
        <SpiritCard key={s.id} spirit={s} onOpen={onOpen} />
      ))}
      {spirits.length > view.length ? (
        <p className="list-more">还有 {spirits.length - view.length} 只，输入名称或筛选属性继续缩小范围</p>
      ) : null}
    </div>
  );
}
