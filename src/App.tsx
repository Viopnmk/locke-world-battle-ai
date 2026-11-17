import { useCallback, useEffect, useMemo, useState } from 'react';
import { SpiritList } from './components/SpiritList';
import { SpiritDetail } from './components/SpiritDetail';
import { TypeCalculator } from './components/TypeCalculator';
import { AiPanel } from './components/AiPanel';
import { meta, searchSpirits, sortByDex, spirits, typeCounts } from './lib/spirits';
import type { Spirit } from './lib/types';
import { tint, typeColor } from './lib/typeChart';

type Tab = 'dex' | 'chart' | 'ai';

const TABS: { key: Tab; label: string; icon: JSX.Element }[] = [
  {
    key: 'dex',
    label: '图鉴',
    icon: (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H19v16H6.5A2.5 2.5 0 0 0 4 21.5V5.5Z" />
        <path d="M8 7h7M8 11h7" />
      </svg>
    ),
  },
  {
    key: 'chart',
    label: '克制',
    icon: (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M12 3v18M3 12h18" />
        <circle cx="12" cy="12" r="9" />
      </svg>
    ),
  },
  {
    key: 'ai',
    label: 'AI 分析',
    icon: (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M12 3.5 14 9l5.5 2-5.5 2-2 5.5-2-5.5L4.5 11 10 9l2-5.5Z" />
      </svg>
    ),
  },
];

/**
 * Hash routes so any view can be opened directly and shared on a phone:
 * #/ (图鉴) · #/chart (克制) · #/ai (AI) · #/spirit/<id> (图鉴详情)
 */
function readHash(): { tab: Tab; spiritId: string | null } {
  const raw = window.location.hash.replace(/^#\/?/, '');
  if (raw.startsWith('spirit/')) return { tab: 'dex', spiritId: raw.slice('spirit/'.length) };
  if (raw === 'chart') return { tab: 'chart', spiritId: null };
  if (raw === 'ai') return { tab: 'ai', spiritId: null };
  return { tab: 'dex', spiritId: null };
}

export default function App() {
  const initial = readHash();
  const [tab, setTab] = useState<Tab>(initial.tab);
  const [query, setQuery] = useState('');
  const [typeFilter, setTypeFilter] = useState<string | null>(null);
  const [selected, setSelected] = useState<Spirit | null>(
    initial.spiritId ? spirits.find((s) => s.id === initial.spiritId) ?? null : null,
  );

  const counts = useMemo(() => typeCounts(), []);
  const filtered = useMemo(() => sortByDex(searchSpirits(query, typeFilter)), [query, typeFilter]);

  useEffect(() => {
    const onHash = () => {
      const r = readHash();
      setTab(r.tab);
      setSelected(r.spiritId ? spirits.find((s) => s.id === r.spiritId) ?? null : null);
      window.scrollTo({ top: 0 });
    };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  const go = useCallback((hash: string) => {
    if (window.location.hash === hash) return;
    window.location.hash = hash;
  }, []);

  const openSpirit = useCallback((spirit: Spirit) => {
    setSelected(spirit);
    go(`#/spirit/${spirit.id}`);
  }, [go]);

  const closeSpirit = useCallback(() => {
    setSelected(null);
    go('#/');
  }, [go]);

  useEffect(() => {
    window.scrollTo({ top: 0 });
  }, [tab]);

  useEffect(() => {
    document.body.classList.toggle('is-locked', selected !== null);
    return () => document.body.classList.remove('is-locked');
  }, [selected]);

  function openType(type: string) {
    setSelected(null);
    setTab('dex');
    setTypeFilter(type);
    setQuery('');
    go('#/');
  }

  function changeTab(next: Tab) {
    const hash = next === 'chart' ? '#/chart' : next === 'ai' ? '#/ai' : '#/';
    if (next === 'dex') setSelected(null);
    setTab(next);
    go(hash);
  }

  return (
    <div className="app">
      <header className="app__header">
        <div>
          <h1>洛克对战助手</h1>
          <p>
            {meta.spiritCount} 只精灵 · 数据 {meta.fetchedAt.slice(5, 10)} 抓取
          </p>
        </div>
        <span className="app__badge">数据来自 BWIKI</span>
      </header>

      <main className="app__main">
        {tab === 'dex' ? (
          <>
            <div className="search-bar">
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <circle cx="11" cy="11" r="7" />
                <path d="m20 20-3.6-3.6" />
              </svg>
              <input
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="搜索名称 / 编号，如 迪莫、001"
                enterKeyHint="search"
                aria-label="搜索精灵"
              />
              {query ? (
                <button type="button" className="search-bar__clear" onClick={() => setQuery('')} aria-label="清空搜索">
                  ×
                </button>
              ) : null}
            </div>

            <div className="chip-strip chip-strip--filters" role="group" aria-label="按属性筛选">
              <button
                type="button"
                className={`type-chip type-chip--pick${typeFilter === null ? ' is-active' : ''}`}
                onClick={() => setTypeFilter(null)}
                style={typeFilter === null ? { background: '#2f3a35', color: '#fff', borderColor: '#2f3a35' } : undefined}
              >
                全部 {spirits.length}
              </button>
              {counts.map(({ type, count }) => {
                const active = typeFilter === type;
                return (
                  <button
                    key={type}
                    type="button"
                    className={`type-chip type-chip--pick${active ? ' is-active' : ''}`}
                    onClick={() => setTypeFilter(active ? null : type)}
                    style={active ? { background: typeColor(type), color: '#fff', borderColor: typeColor(type) } : { background: tint(typeColor(type), 0.14), color: typeColor(type) }}
                    aria-pressed={active}
                  >
                    {type} {count}
                  </button>
                );
              })}
            </div>

            <p className="list-meta">
              {typeFilter ? `${typeFilter}系 ` : ''}
              {query ? `“${query}” ` : ''}
              共 {filtered.length} 只
              {filtered.length !== spirits.length ? ` / 全图鉴 ${spirits.length} 只` : ''}
            </p>

            <SpiritList spirits={filtered} onOpen={openSpirit} emptyHint="没有匹配的精灵，换个名字或取消属性筛选试试" />

            <section className="panel panel--quiet data-note">
              <h2 className="panel__title">数据说明</h2>
              <ul>
                <li>
                  共 {meta.spiritCount} 只形态（图鉴页面标注 {meta.pageReportedCount}），抓取时间 {meta.fetchedAt.replace('T', ' ')}。
                </li>
                <li>字段：编号、属性、特性与效果、六项种族值、身高体重、蛋组、骑乘、介绍、学习面（技能/等级/技能石/血脉）。</li>
                <li>未公开字段（命中率等）保持空白，没有用默认值补齐；技能 PP 本作以能耗计，不存在该字段。</li>
                <li>
                  原始来源：
                  {meta.sources.map((s, i) => (
                    <span key={s.url}>
                      {i > 0 ? ' · ' : ''}
                      <a href={s.url} target="_blank" rel="noreferrer">
                        {s.name}
                      </a>
                    </span>
                  ))}
                </li>
                <li>非官方工具，数据版权归 BWIKI 与游戏方所有。</li>
              </ul>
            </section>
          </>
        ) : null}

        {tab === 'chart' ? <TypeCalculator onOpenType={openType} /> : null}
        {tab === 'ai' ? <AiPanel /> : null}
      </main>

      <nav className="tabbar" aria-label="主导航">
        {TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            className={`tabbar__item${tab === t.key ? ' is-active' : ''}`}
            onClick={() => changeTab(t.key)}
            aria-current={tab === t.key ? 'page' : undefined}
          >
            {t.icon}
            <span>{t.label}</span>
          </button>
        ))}
      </nav>

      {selected ? <SpiritDetail spirit={selected} onClose={closeSpirit} onOpenType={openType} /> : null}
    </div>
  );
}
