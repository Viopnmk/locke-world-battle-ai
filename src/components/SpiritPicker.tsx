import { useEffect, useMemo, useState } from 'react';
import { searchSpirits, sortByDex, spirits } from '../lib/spirits';
import type { Spirit } from '../lib/types';
import { tint, typeColor } from '../lib/typeChart';

interface Props {
  open: boolean;
  title: string;
  excludeIds: string[];
  onPick: (spirit: Spirit) => void;
  onClose: () => void;
}

const PAGE = 40;

/** 全屏挑选器：搜索 662 只图鉴 + 高种族值快捷选择。 */
export function SpiritPicker({ open, title, excludeIds, onPick, onClose }: Props) {
  const [query, setQuery] = useState('');
  const [limit, setLimit] = useState(PAGE);

  useEffect(() => {
    if (open) {
      setQuery('');
      setLimit(PAGE);
    }
  }, [open]);

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  const excluded = useMemo(() => new Set(excludeIds), [excludeIds]);
  const results = useMemo(() => {
    const list = query.trim() ? searchSpirits(query, null) : sortByDex(spirits);
    return list.filter((s) => !excluded.has(s.id));
  }, [query, excluded]);

  const quick = useMemo(
    () =>
      [...spirits]
        .filter((s) => !excluded.has(s.id))
        .sort((a, b) => (b.stats.total ?? 0) - (a.stats.total ?? 0))
        .slice(0, 6),
    [excluded],
  );

  if (!open) return null;

  const view = results.slice(0, limit);

  return (
    <div className="picker" role="dialog" aria-label={title}>
      <header className="picker__bar">
        <button type="button" className="icon-button" onClick={onClose} aria-label="关闭选择器">
          <span aria-hidden="true">✕</span>
        </button>
        <span className="picker__title">{title}</span>
        <span className="picker__count">{results.length} 只可选</span>
      </header>

      <div className="picker__scroll">
        <div className="search-bar search-bar--picker">
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <circle cx="11" cy="11" r="7" />
            <path d="m20 20-3.6-3.6" />
          </svg>
          <input
            type="search"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setLimit(PAGE);
            }}
            placeholder="搜索名称 / 编号，如 迪莫、001"
            enterKeyHint="search"
            aria-label="搜索精灵"
            autoFocus
          />
          {query ? (
            <button type="button" className="search-bar__clear" onClick={() => setQuery('')} aria-label="清空搜索">
              ×
            </button>
          ) : null}
        </div>

        {!query ? (
          <section className="picker__quick">
            <h3>高种族值快捷选择</h3>
            <div className="quick-grid">
              {quick.map((s) => (
                <button key={s.id} type="button" className="quick-card" onClick={() => onPick(s)}>
                  <img src={s.avatar} alt="" loading="lazy" decoding="async" />
                  <span>
                    <strong>{s.name}</strong>
                    <small>
                      {s.type.join('/')} · {s.stats.total ?? '—'}
                    </small>
                  </span>
                </button>
              ))}
            </div>
          </section>
        ) : null}

        <div className="picker__list">
          {view.map((s) => (
            <button key={s.id} type="button" className="picker__item" onClick={() => onPick(s)}>
              <img src={s.avatar} alt="" loading="lazy" decoding="async" />
              <span className="picker__item-main">
                <span className="picker__item-name">
                  No.{s.dex} {s.name}
                </span>
                <span className="picker__item-types">
                  {s.type.map((t) => (
                    <span key={t} className="type-chip type-chip--sm" style={{ background: tint(typeColor(t), 0.16), color: typeColor(t) }}>
                      {t}
                    </span>
                  ))}
                </span>
              </span>
              <span className="picker__item-total">{s.stats.total ?? '—'}</span>
            </button>
          ))}
          {view.length === 0 ? <p className="empty-state">没有匹配的精灵</p> : null}
          {results.length > view.length ? (
            <button type="button" className="load-more" onClick={() => setLimit((n) => n + PAGE)}>
              加载更多（还有 {results.length - view.length} 只）
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
