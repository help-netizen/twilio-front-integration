import { useMemo, useState } from 'react';
import { Search } from 'lucide-react';
import type { MarketplaceApp } from '../../../services/marketplaceApi';
import { appGradient, appMonogram, categoryLabel, CATEGORY_ORDER, Stars } from './marketplaceUi';
import { MarketplaceAppCard } from './MarketplaceAppCard';

const SORTS = [
    { id: 'rate', label: 'Top rated' },
    { id: 'popular', label: 'Most reviewed' },
    { id: 'name', label: 'Name' },
] as const;
type SortId = typeof SORTS[number]['id'];

const FEATURED_KEY = 'chatgpt-crm-mcp';

export function MarketplaceGrid({ apps, onOpen }: { apps: MarketplaceApp[]; onOpen: (app: MarketplaceApp) => void }) {
    const [query, setQuery] = useState('');
    const [activeCat, setActiveCat] = useState<string>('all');
    const [sortIdx, setSortIdx] = useState(0);
    const sort: SortId = SORTS[sortIdx].id;

    // Category chips present in the catalog, in canonical order, with counts.
    const cats = useMemo(() => {
        const counts = new Map<string, number>();
        apps.forEach(a => counts.set(a.category, (counts.get(a.category) ?? 0) + 1));
        const ordered = [...CATEGORY_ORDER.filter(c => counts.has(c)), ...[...counts.keys()].filter(c => !CATEGORY_ORDER.includes(c))];
        return ordered.map(c => ({ id: c, label: categoryLabel(c), count: counts.get(c) ?? 0 }));
    }, [apps]);

    const featured = useMemo(() => apps.find(a => a.app_key === FEATURED_KEY) ?? null, [apps]);

    const filtered = useMemo(() => {
        const q = query.trim().toLowerCase();
        const list = apps.filter(a =>
            (activeCat === 'all' || a.category === activeCat) &&
            (!q || `${a.name} ${a.provider_name} ${a.short_description} ${categoryLabel(a.category)}`.toLowerCase().includes(q)));
        return list.sort((a, b) =>
            sort === 'rate' ? (b.avg_rating ?? 0) - (a.avg_rating ?? 0) || b.rating_count - a.rating_count
                : sort === 'popular' ? b.rating_count - a.rating_count
                    : a.name.localeCompare(b.name));
    }, [apps, query, activeCat, sort]);

    // Group by category when browsing "all" (with a search-independent group order).
    const groups = useMemo(() => {
        const keys = activeCat === 'all' ? cats.map(c => c.id) : [activeCat];
        return keys.map(cat => ({ cat, rows: filtered.filter(a => a.category === cat) })).filter(g => g.rows.length > 0);
    }, [filtered, cats, activeCat]);

    return (
        <div>
            {/* search + sort */}
            <div className="mb-3.5 flex flex-wrap items-center gap-3">
                <label className="flex min-w-[220px] flex-1 items-center gap-2.5 rounded-2xl bg-[var(--blanc-surface-strong)] px-4 py-3" style={{ boxShadow: '0 1px 2px rgba(25,25,25,.04)' }}>
                    <Search className="size-[18px] shrink-0 text-[var(--blanc-ink-3)]" aria-hidden />
                    <input value={query} onChange={e => setQuery(e.target.value)} placeholder="Search apps, e.g. leads, payments, calls…"
                        aria-label="Search marketplace apps" className="w-full border-0 bg-transparent text-[15px] text-[var(--blanc-ink-1)] outline-none" />
                </label>
                <button type="button" onClick={() => setSortIdx(i => (i + 1) % SORTS.length)}
                    className="rounded-2xl bg-[var(--blanc-surface-strong)] px-4 py-3 text-[14px] font-semibold text-[var(--blanc-ink-2)]" style={{ boxShadow: '0 1px 2px rgba(25,25,25,.04)' }}>
                    Sort: <b className="text-[var(--blanc-ink-1)]">{SORTS[sortIdx].label}</b> ▾
                </button>
            </div>

            {/* category tiles */}
            <div className="mb-5 flex gap-2 overflow-x-auto pb-2" style={{ scrollbarWidth: 'none' }}>
                <CatChip on={activeCat === 'all'} label="All" count={apps.length} onClick={() => setActiveCat('all')} />
                {cats.map(c => <CatChip key={c.id} on={activeCat === c.id} label={c.label} count={c.count} onClick={() => setActiveCat(c.id)} />)}
            </div>

            {/* featured hero */}
            {featured && activeCat === 'all' && !query && (
                <button type="button" onClick={() => onOpen(featured)}
                    className="mb-6 flex w-full items-center gap-6 overflow-hidden rounded-[22px] px-7 py-6 text-left"
                    style={{ background: 'linear-gradient(120deg,#efe6ff 0%,#f6f1ff 46%,#F6F6F6 100%)' }}>
                    <div className="grid h-24 w-24 shrink-0 place-items-center rounded-3xl text-[40px] font-bold text-white"
                        style={{ background: appGradient(featured), fontFamily: 'var(--blanc-font-heading)', boxShadow: '0 10px 24px rgba(127,66,225,.30)' }} aria-hidden>
                        {featured.logo_url ? <img src={featured.logo_url} alt="" className="h-full w-full rounded-3xl object-contain" /> : appMonogram(featured.name)}
                    </div>
                    <div className="min-w-0 flex-1">
                        <h2 className="text-[22px] font-bold leading-tight tracking-[-.01em] text-[var(--blanc-ink-1)]" style={{ fontFamily: 'var(--blanc-font-heading)' }}>{featured.name}</h2>
                        <p className="mt-1.5 max-w-[560px] text-[15px] text-[var(--blanc-ink-2)]">{featured.short_description}</p>
                        <div className="mt-3 flex items-center gap-3">
                            <span className="rounded-xl bg-[var(--blanc-accent)] px-4 py-2 text-[14px] font-semibold text-white">View app</span>
                            {featured.rating_count > 0 && (
                                <span className="flex items-center gap-1.5 text-[13px]"><Stars value={featured.avg_rating ?? 0} /> <b className="text-[var(--blanc-ink-1)]">{(featured.avg_rating ?? 0).toFixed(1)}</b> <span className="text-[var(--blanc-ink-3)]">· {featured.rating_count} ratings</span></span>
                            )}
                        </div>
                    </div>
                </button>
            )}

            {/* grouped grid */}
            {groups.length === 0 ? (
                <p className="py-12 text-center text-[var(--blanc-ink-3)]">No apps match your search.</p>
            ) : groups.map(({ cat, rows }) => (
                <section key={cat} className="mb-2">
                    <div className="mb-3.5 mt-6 flex items-baseline gap-2.5">
                        <h3 className="text-[16px] font-bold text-[var(--blanc-ink-1)]" style={{ fontFamily: 'var(--blanc-font-heading)' }}>{categoryLabel(cat)}</h3>
                        <span className="text-[13px] text-[var(--blanc-ink-3)]">{rows.length} app{rows.length > 1 ? 's' : ''}</span>
                    </div>
                    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
                        {rows.map(a => <MarketplaceAppCard key={a.app_key} app={a} onOpen={onOpen} />)}
                    </div>
                </section>
            ))}
        </div>
    );
}

function CatChip({ on, label, count, onClick }: { on: boolean; label: string; count: number; onClick: () => void }) {
    return (
        <button type="button" onClick={onClick}
            className={`flex-none whitespace-nowrap rounded-full px-3.5 py-2 text-[13px] font-semibold transition-colors ${
                on ? 'bg-[var(--blanc-accent-soft)] text-[var(--blanc-accent-ink,#5b2bb0)]' : 'bg-[var(--blanc-surface-strong)] text-[var(--blanc-ink-2)] hover:text-[var(--blanc-ink-1)]'}`}
            style={!on ? { boxShadow: '0 1px 2px rgba(25,25,25,.04)' } : undefined}>
            {label} <span className={`ml-1 text-[11px] ${on ? 'opacity-65' : 'text-[var(--blanc-ink-3)]'}`}>{count}</span>
        </button>
    );
}
