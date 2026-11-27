import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { SpiritList } from './components/SpiritList';
import { SpiritDetail } from './components/SpiritDetail';
import { TypeCalculator } from './components/TypeCalculator';
import { AiPanel } from './components/AiPanel';
import { BuildPage } from './pages/BuildPage';
import { TeamsPage } from './pages/TeamsPage';
import { meta, searchSpirits, sortByDex, spirits, typeCounts } from './lib/spirits';
import type { Spirit } from './lib/types';
import { tint, typeColor } from './lib/typeChart';

type Tab = 'dex' | 'chart' | 'build' | 'teams' | 'ai';

/** 从「阵容推荐」导入对战时，把 6 只精灵和预设 id 一起交给对战页。 */
export interface AiSeed {
  mine: Spirit[];
  enemy: Spirit[];
  presetId: string | null;
  side: 'mine' | 'enemy';
  nonce: number;
}

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
    key: 'build',
    label: '培养',
    icon: (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M12 21v-7" />
        <path d="M12 14c0-4 2.5-7 7-7 0 4-2.7 7-7 7Z" />
        <path d="M12 14C12 10.7 9.6 8 5 8c0 3.6 2.7 6 7 6Z" />
        <path d="M6 21h12" />
      </svg>
    ),
  },
  {
    key: 'teams',
    label: '阵容',
    icon: (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <circle cx="8" cy="9" r="2.6" />
        <circle cx="16" cy="9" r="2.6" />
        <path d="M3.5 19c0-2.5 2-4.3 4.5-4.3S12.5 16.5 12.5 19" />
        <path d="M11.5 19c0-2.5 2-4.3 4.5-4.3s4.5 1.8 4.5 4.3" />
      </svg>
    ),
  },
  {
    key: 'ai',
    label: '对战',
    icon: (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M12 3.5 14 9l5.5 2-5.5 2-2 5.5-2-5.5L4.5 11 10 9l2-5.5Z" />
      </svg>
    ),
  },
];

interface Route {
  tab: Tab;
  spiritId: string | null;
  buildId: string | null;
  /** 培养页的选宠器也是历史栈里的一层：#/build/pick · #/build/<id>/pick */
  buildPick: boolean;
}

/**
 * Hash routes so any view can be opened directly and shared on a phone:
 * #/ (图鉴) · #/chart (克制) · #/build[/<id>] (培养方案) · #/build[/<id>]/pick (选宠器) · #/ai (AI) · #/spirit/<id> (图鉴详情)
 */
function readHash(): Route {
  const raw = window.location.hash.replace(/^#\/?/, '');
  if (raw.startsWith('spirit/')) return { tab: 'dex', spiritId: raw.slice('spirit/'.length), buildId: null, buildPick: false };
  if (raw === 'build' || raw.startsWith('build/')) {
    const segs = raw.slice('build'.length).split('/').filter(Boolean);
    const buildPick = segs[segs.length - 1] === 'pick';
    const buildId = segs.find((s) => s !== 'pick') ?? null;
    return { tab: 'build', spiritId: null, buildId, buildPick };
  }
  if (raw === 'chart') return { tab: 'chart', spiritId: null, buildId: null, buildPick: false };
  if (raw === 'teams') return { tab: 'teams', spiritId: null, buildId: null, buildPick: false };
  if (raw === 'ai') return { tab: 'ai', spiritId: null, buildId: null, buildPick: false };
  return { tab: 'dex', spiritId: null, buildId: null, buildPick: false };
}

const routeKey = (r: Route) => `${r.tab}|${r.spiritId ?? ''}|${r.buildId ?? ''}`;

export default function App() {
  const initial = readHash();
  const [tab, setTab] = useState<Tab>(initial.tab);
  const [buildId, setBuildId] = useState<string | null>(initial.buildId);
  const [buildPick, setBuildPick] = useState(initial.buildPick);
  /** 只有真正换页（换板块 / 换精灵）才回顶；仅开/关选宠器时不动滚动位置，避免 iOS 返回时画面抽动。 */
  const routeKeyRef = useRef(routeKey(initial));
  const [aiSeed, setAiSeed] = useState<AiSeed | null>(null);
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
      setBuildId(r.buildId);
      setBuildPick(r.buildPick);
      setSelected(r.spiritId ? spirits.find((s) => s.id === r.spiritId) ?? null : null);
      const key = routeKey(r);
      if (key !== routeKeyRef.current) {
        routeKeyRef.current = key;
        window.scrollTo({ top: 0 });
      }
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
    setBuildPick(false);
    go(`#/spirit/${spirit.id}`);
  }, [go]);

  const closeSpirit = useCallback(() => {
    setSelected(null);
    go('#/');
  }, [go]);

  /** 图鉴详情 → 培养方案：保留这只精灵，切到 #/build/<id>。 */
  const openBuild = useCallback(
    (spirit: Spirit) => {
      setSelected(null);
      setTab('build');
      setBuildId(spirit.id);
      setBuildPick(false);
      go(`#/build/${spirit.id}`);
    },
    [go],
  );

  /** 选宠器也是一条独立历史：从 #/build/<id> push 出 #/build/<id>/pick，左滑返回才回得到搜索界面。 */
  const openBuildPick = useCallback(() => {
    setTab('build');
    setBuildPick(true);
    go(`#/build${buildId ? `/${buildId}` : ''}/pick`);
  }, [buildId, go]);

  /** 关闭选宠器：直接回到培养页，不依赖 history.back()（直接打开 /pick 分享链接时也能正常退出）。 */
  const closeBuildPick = useCallback(() => {
    setBuildPick(false);
    go(`#/build${buildId ? `/${buildId}` : ''}`);
  }, [buildId, go]);

  const pickBuildSpirit = useCallback(
    (spirit: Spirit) => {
      setBuildId(spirit.id);
      setBuildPick(false);
      go(`#/build/${spirit.id}`);
    },
    [go],
  );

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

  /** 阵容推荐 → 对战：#/ai 里直接填好 6 只（另一侧为空时先放同一套，方便马上看对位），并带上预设 id。 */
  const importTeam = useCallback(
    (team: Spirit[], side: 'mine' | 'enemy', presetId: string) => {
      setAiSeed((prev) => {
        const keep = prev ?? { mine: [], enemy: [], presetId: null, side, nonce: 0 };
        const mine = side === 'mine' ? team : keep.mine.length ? keep.mine : team;
        const enemy = side === 'enemy' ? team : keep.enemy.length ? keep.enemy : team;
        return { mine, enemy, presetId, side, nonce: keep.nonce + 1 };
      });
      setSelected(null);
      setTab('ai');
      setBuildPick(false);
      go('#/ai');
    },
    [go],
  );

  /** 阵容推荐 → 培养方案：和从图鉴点进去是同一条路。 */
  const openBuildFromTeams = useCallback(
    (spirit: Spirit) => {
      setSelected(null);
      setTab('build');
      setBuildId(spirit.id);
      setBuildPick(false);
      go(`#/build/${spirit.id}`);
    },
    [go],
  );

  function changeTab(next: Tab) {
    const hash =
      next === 'chart'
        ? '#/chart'
        : next === 'build'
          ? `#/build${buildId ? `/${buildId}` : ''}`
          : next === 'ai'
            ? '#/ai'
            : next === 'teams'
              ? '#/teams'
              : '#/';
    if (next === 'dex') setSelected(null);
    setTab(next);
    setBuildPick(false);
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

        {tab === 'build' ? (
          <BuildPage
            spiritId={buildId}
            pickOpen={buildPick}
            onOpenPick={openBuildPick}
            onClosePick={closeBuildPick}
            onPick={pickBuildSpirit}
          />
        ) : null}
        {tab === 'chart' ? <TypeCalculator onOpenType={openType} /> : null}
        {tab === 'teams' ? <TeamsPage onOpenBuild={openBuildFromTeams} onImport={importTeam} /> : null}
        {tab === 'ai' ? <AiPanel seed={aiSeed} /> : null}
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

      {selected ? (
        <SpiritDetail spirit={selected} onClose={closeSpirit} onOpenType={openType} onOpenBuild={openBuild} />
      ) : null}
    </div>
  );
}
