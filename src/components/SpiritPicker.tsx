import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { searchSpirits, sortByDex, spirits } from '../lib/spirits';
import type { Spirit } from '../lib/types';
import { tint, typeColor } from '../lib/typeChart';

interface Props {
  open: boolean;
  title: string;
  excludeIds: string[];
  onPick: (spirit: Spirit) => void;
  onClose: () => void;
  /** 每次用户主动打开选宠器时递增：清空搜索词并回到列表顶部。历史回退重新打开时不变，保留上次搜索结果。 */
  freshKey?: number;
  /**
   * 给了这个键才记忆列表状态（搜索词、已加载条数、滚动位置），
   * 用于「点进某只精灵后左滑返回」时停在原处。不给则每次打开都从顶部开始。
   */
  memoKey?: string;
}

const PAGE = 40;

/** 组件会被卸载（切 tab）再回来，所以记忆放在模块级缓存里，按 memoKey 区分列表上下文。 */
interface PickerMemo {
  /** 上次「主动打开」时的 freshKey；-1 表示还没打开过。 */
  freshKey: number;
  query: string;
  limit: number;
  scrollTop: number;
}

const pickerMemos = new Map<string, PickerMemo>();

function memoFor(key: string): PickerMemo {
  let memo = pickerMemos.get(key);
  if (!memo) {
    memo = { freshKey: -1, query: '', limit: PAGE, scrollTop: 0 };
    pickerMemos.set(key, memo);
  }
  return memo;
}

/** 触屏设备（iPhone/iPad）不自动聚焦搜索框：软键盘弹出会把画面顶起，左滑返回时也会抽动。 */
function isTouchDevice() {
  if (typeof window === 'undefined') return false;
  const coarse = window.matchMedia?.('(pointer: coarse)')?.matches ?? false;
  return coarse || (navigator.maxTouchPoints ?? 0) > 0;
}

/** 全屏挑选器：搜索 662 只图鉴 + 高种族值快捷选择。 */
export function SpiritPicker({ open, title, excludeIds, onPick, onClose, freshKey = 0, memoKey }: Props) {
  const [query, setQuery] = useState('');
  const [limit, setLimit] = useState(PAGE);
  const [autoFocus] = useState(() => !isTouchDevice());
  const scrollRef = useRef<HTMLDivElement | null>(null);
  /** 已算出但还没落到 DOM 上的目标滚动位置；落稳后清空。 */
  const restoreRef = useRef<number | null>(null);
  const memo = useMemo(() => (memoKey ? memoFor(memoKey) : null), [memoKey]);

  // 主动打开（freshKey 变化）→ 清空搜索词、回到顶部；历史回退（freshKey 未变）→ 恢复上次的搜索结果与滚动位置。
  useEffect(() => {
    if (!open) return undefined;
    if (!memo) {
      // 没有记忆键：行为保持原样，每次打开都是干净的列表。
      setQuery('');
      setLimit(PAGE);
      restoreRef.current = 0;
      return undefined;
    }
    if (memo.freshKey !== freshKey) {
      memo.freshKey = freshKey;
      memo.query = '';
      memo.limit = PAGE;
      memo.scrollTop = 0;
      setQuery('');
      setLimit(PAGE);
      restoreRef.current = 0;
    } else {
      setQuery(memo.query);
      setLimit(memo.limit);
      restoreRef.current = memo.scrollTop;
    }

    // DOM 重新挂载后列表高度要等一帧才量得准（图片是固定尺寸，行高稳定），多补两帧再落一次。
    const apply = () => {
      const el = scrollRef.current;
      const target = restoreRef.current;
      if (!el || target === null) return;
      el.scrollTop = target;
      if (Math.abs(el.scrollTop - target) < 1) restoreRef.current = null;
    };
    apply();
    const raf1 = requestAnimationFrame(apply);
    const raf2 = requestAnimationFrame(() => requestAnimationFrame(apply));
    return () => {
      cancelAnimationFrame(raf1);
      cancelAnimationFrame(raf2);
    };
  }, [open, freshKey, memo]);

  // limit 变化（加载更多 / 恢复）后补一次，确保新挂载的列表先撑开再定位。
  useLayoutEffect(() => {
    if (!open) return;
    const el = scrollRef.current;
    const target = restoreRef.current;
    if (!el || target === null) return;
    el.scrollTop = target;
    if (Math.abs(el.scrollTop - target) < 1) restoreRef.current = null;
  }, [open, limit, query]);

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

  const changeQuery = (next: string) => {
    setQuery(next);
    setLimit(PAGE);
    if (memo) {
      memo.query = next;
      memo.limit = PAGE;
      memo.scrollTop = 0;
    }
  };

  const loadMore = () => {
    const next = limit + PAGE;
    setLimit(next);
    if (memo) memo.limit = next;
  };

  const pick = (spirit: Spirit) => {
    if (memo) {
      memo.query = query;
      memo.limit = limit;
      memo.scrollTop = scrollRef.current?.scrollTop ?? memo.scrollTop;
      memo.freshKey = freshKey;
    }
    onPick(spirit);
  };

  return (
    <div className="picker" role="dialog" aria-label={title}>
      <header className="picker__bar">
        <button type="button" className="icon-button" onClick={onClose} aria-label="关闭选择器">
          <span aria-hidden="true">✕</span>
        </button>
        <span className="picker__title">{title}</span>
        <span className="picker__count">{results.length} 只可选</span>
      </header>

      <div
        className="picker__scroll"
        ref={scrollRef}
        onScroll={(e) => {
          if (memo) memo.scrollTop = e.currentTarget.scrollTop;
        }}
      >
        <div className="search-bar search-bar--picker">
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <circle cx="11" cy="11" r="7" />
            <path d="m20 20-3.6-3.6" />
          </svg>
          <input
            type="search"
            value={query}
            onChange={(e) => changeQuery(e.target.value)}
            placeholder="搜索名称 / 编号，如 迪莫、001"
            enterKeyHint="search"
            aria-label="搜索精灵"
            autoFocus={autoFocus}
          />
          {query ? (
            <button type="button" className="search-bar__clear" onClick={() => changeQuery('')} aria-label="清空搜索">
              ×
            </button>
          ) : null}
        </div>

        {!query ? (
          <section className="picker__quick">
            <h3>高种族值快捷选择</h3>
            <div className="quick-grid">
              {quick.map((s) => (
                <button key={s.id} type="button" className="quick-card" onClick={() => pick(s)}>
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
            <button key={s.id} type="button" className="picker__item" onClick={() => pick(s)}>
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
            <button type="button" className="load-more" onClick={loadMore}>
              加载更多（还有 {results.length - view.length} 只）
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
