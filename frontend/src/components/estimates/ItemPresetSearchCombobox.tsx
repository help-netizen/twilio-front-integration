import { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronRight, Clock, Layers, Loader2, Plus } from 'lucide-react';
import { searchEstimateItemPresets, type EstimateItemPreset } from '../../services/estimateItemPresetsApi';
import {
    listCategoryTree,
    listGroups,
    listItems,
    type PriceBookCategoryNode,
    type PriceBookGroup,
    type PriceBookItem,
} from '../../services/priceBookApi';
import { categoryPath, categoryPathLabel, flattenCategoryTree } from './priceBookBrowseModel';

interface Props {
    disabled?: boolean;
    /** Called when user picks an existing preset. Combobox passes the full preset. */
    onPickPreset: (preset: EstimateItemPreset) => void | Promise<void>;
    /** Called when user chooses to create a brand-new item. Combobox passes the typed name. */
    onCreateNew: (name: string) => void | Promise<void>;
    /** PRICEBOOK-001: when set, the dropdown also offers Price Book groups; picking
     *  one expands it into its items on the parent (bulk add). */
    onPickGroup?: (groupId: number) => void | Promise<void>;
}

function money(value: number): string {
    return '$' + Number(value || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function itemAsPreset(item: PriceBookItem): EstimateItemPreset {
    return {
        id: item.id,
        name: item.name,
        description: item.description,
        default_quantity: item.default_quantity ?? 1,
        default_unit_price: item.default_unit_price ?? 0,
        default_taxable: item.default_taxable,
        category_id: item.category_id,
        code: item.code,
        unit: item.unit,
        usage_count: 0,
        last_used_at: null,
        archived_at: item.archived_at,
        created_at: '',
        updated_at: '',
    };
}

export function ItemPresetSearchCombobox({ disabled, onPickPreset, onCreateNew, onPickGroup }: Props) {
    const [query, setQuery] = useState('');
    const [open, setOpen] = useState(false);
    const [loading, setLoading] = useState(false);
    const [presets, setPresets] = useState<EstimateItemPreset[]>([]);
    const [groups, setGroups] = useState<PriceBookGroup[]>([]);
    const [tree, setTree] = useState<PriceBookCategoryNode[]>([]);
    const [categoryId, setCategoryId] = useState<number | null>(null);
    const [uncategorized, setUncategorized] = useState(false);
    const [highlighted, setHighlighted] = useState(0);
    const boxRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        if (!open || tree.length) return;
        let cancelled = false;
        listCategoryTree()
            .then(categories => { if (!cancelled) setTree(categories); })
            .catch(() => { /* global search remains available */ });
        return () => { cancelled = true; };
    }, [open, tree.length]);

    const trimmed = query.trim();
    useEffect(() => {
        if (!open) return;
        let cancelled = false;
        const timer = setTimeout(async () => {
            setLoading(true);
            try {
                let items: EstimateItemPreset[];
                if (trimmed) {
                    items = await searchEstimateItemPresets(trimmed, 50);
                } else if (uncategorized) {
                    items = (await listItems({ uncategorized: true, limit: 1000 })).map(itemAsPreset);
                } else if (categoryId != null) {
                    items = (await listItems({ category_id: categoryId, limit: 1000 })).map(itemAsPreset);
                } else {
                    items = await searchEstimateItemPresets('', 10);
                }
                if (!cancelled) {
                    setPresets(items);
                    setHighlighted(0);
                }
                if (onPickGroup) {
                    try {
                        const nextGroups = await listGroups({
                            search: trimmed,
                            category_id: trimmed ? null : categoryId,
                            uncategorized: !trimmed && uncategorized,
                        });
                        const limit = trimmed || (categoryId == null && !uncategorized) ? 5 : 1000;
                        if (!cancelled) setGroups(nextGroups.slice(0, limit));
                    } catch { /* item browsing still works */ }
                } else if (!cancelled) {
                    setGroups([]);
                }
            } catch {
                if (!cancelled) setPresets([]);
            } finally {
                if (!cancelled) setLoading(false);
            }
        }, 200);
        return () => { cancelled = true; clearTimeout(timer); };
    }, [trimmed, open, categoryId, uncategorized, onPickGroup]);

    useEffect(() => {
        if (!open) return;
        const handler = (event: MouseEvent) => {
            if (boxRef.current && !boxRef.current.contains(event.target as Node)) setOpen(false);
        };
        document.addEventListener('mousedown', handler);
        return () => document.removeEventListener('mousedown', handler);
    }, [open]);

    const flatTree = useMemo(() => flattenCategoryTree(tree), [tree]);
    const currentCategory = categoryId == null ? null : flatTree.find(category => category.id === categoryId) || null;
    const categoryRows = uncategorized ? [] : (currentCategory ? currentCategory.children : tree);
    const breadcrumbs = currentCategory ? categoryPath(tree, currentCategory.id) : [];
    const exactMatch = useMemo(
        () => presets.find(preset => preset.name.toLowerCase() === trimmed.toLowerCase()),
        [presets, trimmed],
    );
    const canCreate = trimmed.length > 0 && !exactMatch;
    const hasUncategorizedRow = !trimmed && categoryId == null && !uncategorized;
    const browseRowCount = trimmed ? 0 : categoryRows.length + (hasUncategorizedRow ? 1 : 0);
    const groupOffset = browseRowCount;
    const presetOffset = groupOffset + groups.length;
    const createOffset = presetOffset + presets.length;
    const totalRows = createOffset + (canCreate ? 1 : 0);

    const resetBrowse = () => { setCategoryId(null); setUncategorized(false); };
    const browseCategory = (id: number) => { setCategoryId(id); setUncategorized(false); };
    const pickPreset = async (preset: EstimateItemPreset) => {
        await onPickPreset(preset);
        setQuery(''); resetBrowse(); setOpen(false);
    };
    const createNew = async () => {
        if (!trimmed) return;
        await onCreateNew(trimmed);
        setQuery(''); resetBrowse(); setOpen(false);
    };
    const pickGroup = async (groupId: number) => {
        if (onPickGroup) await onPickGroup(groupId);
        setQuery(''); resetBrowse(); setOpen(false);
    };
    const activateAt = async (index: number) => {
        if (index < browseRowCount) {
            if (hasUncategorizedRow && index === 0) { setUncategorized(true); setCategoryId(null); return; }
            const category = categoryRows[index - (hasUncategorizedRow ? 1 : 0)];
            if (category) browseCategory(category.id);
        } else if (index < presetOffset) {
            await pickGroup(groups[index - groupOffset].id);
        } else if (index < createOffset) {
            await pickPreset(presets[index - presetOffset]);
        } else if (canCreate) await createNew();
    };

    return (
        <div ref={boxRef} className="relative w-full max-w-md">
            <div className="relative">
                <Plus className="absolute left-3 top-1/2 -translate-y-1/2 size-4 pointer-events-none" style={{ color: 'var(--blanc-ink-3)' }} />
                <input
                    type="text"
                    value={query}
                    disabled={disabled}
                    placeholder="Search or browse the price book…"
                    title="Search all saved items, or browse categories and subcategories"
                    onFocus={() => setOpen(true)}
                    onChange={event => { setQuery(event.target.value); if (!open) setOpen(true); }}
                    onKeyDown={(event) => {
                        if (event.key === 'ArrowDown' && totalRows > 0) {
                            event.preventDefault(); setHighlighted(value => Math.min(value + 1, totalRows - 1));
                        } else if (event.key === 'ArrowUp') {
                            event.preventDefault(); setHighlighted(value => Math.max(value - 1, 0));
                        } else if (event.key === 'Enter' && totalRows > 0) {
                            event.preventDefault(); activateAt(highlighted);
                        } else if (event.key === 'Backspace' && !query && (uncategorized || categoryId != null)) {
                            event.preventDefault();
                            if (uncategorized || currentCategory?.parent_id == null) resetBrowse();
                            else browseCategory(currentCategory.parent_id);
                        } else if (event.key === 'Escape') setOpen(false);
                    }}
                    className="h-9 w-full rounded-[10px] border-[1.5px] border-[var(--blanc-line)] bg-transparent pl-9 pr-3 text-sm text-[var(--blanc-ink-1)] outline-none focus-visible:border-[var(--blanc-ink-2)] disabled:opacity-50"
                />
            </div>

            {open && (
                <div className="absolute left-0 right-0 top-full mt-1 z-30 max-h-80 overflow-y-auto rounded-xl border border-[var(--blanc-line)] shadow-md" style={{ background: 'var(--blanc-panel-surface,#fffdf9)' }}>
                    {!trimmed && (
                        <div className="flex flex-wrap items-center gap-1 px-4 py-2 text-xs" style={{ color: 'var(--blanc-ink-3)' }} aria-label="Category breadcrumb">
                            <button type="button" className="hover:underline" onMouseDown={event => { event.preventDefault(); resetBrowse(); }}>All categories</button>
                            {uncategorized && <><ChevronRight className="size-3" /><span style={{ color: 'var(--blanc-ink-1)' }}>Uncategorized</span></>}
                            {breadcrumbs.map(category => (
                                <span key={category.id} className="contents">
                                    <ChevronRight className="size-3" />
                                    <button type="button" className="hover:underline" style={{ color: category.id === categoryId ? 'var(--blanc-ink-1)' : undefined }} onMouseDown={event => { event.preventDefault(); browseCategory(category.id); }}>{category.name}</button>
                                </span>
                            ))}
                        </div>
                    )}

                    {loading && presets.length === 0 && (
                        <div className="flex items-center gap-2 px-4 py-3 text-xs" style={{ color: 'var(--blanc-ink-3)' }}>
                            <Loader2 className="size-3.5 animate-spin" /> Loading…
                        </div>
                    )}

                    {!trimmed && categoryId == null && !uncategorized && (
                        <button type="button" onMouseEnter={() => setHighlighted(0)} onMouseDown={event => { event.preventDefault(); setUncategorized(true); setCategoryId(null); }} className="w-full px-4 py-2 text-left text-sm" style={{ background: highlighted === 0 ? 'rgba(25,25,25,0.06)' : 'transparent' }}>
                            <div className="flex items-center justify-between gap-3"><span>Uncategorized</span><ChevronRight className="size-4" style={{ color: 'var(--blanc-ink-3)' }} /></div>
                            <div className="text-xs" style={{ color: 'var(--blanc-ink-3)' }}>Legacy saved items</div>
                        </button>
                    )}
                    {!trimmed && categoryRows.map((category, index) => {
                        const rowIndex = index + (hasUncategorizedRow ? 1 : 0);
                        return (
                        <button key={category.id} type="button" onMouseEnter={() => setHighlighted(rowIndex)} onMouseDown={event => { event.preventDefault(); browseCategory(category.id); }} className="w-full px-4 py-2 text-left text-sm" style={{ background: highlighted === rowIndex ? 'rgba(25,25,25,0.06)' : 'transparent' }}>
                            <div className="flex items-center justify-between gap-3"><span className="truncate">{category.name}</span><ChevronRight className="size-4 shrink-0" style={{ color: 'var(--blanc-ink-3)' }} /></div>
                            {category.description && <div className="truncate text-xs" style={{ color: 'var(--blanc-ink-3)' }}>{category.description}</div>}
                        </button>
                    ); })}

                    {onPickGroup && groups.length > 0 && (
                        <>
                            <div className="flex items-center gap-1.5 px-4 pt-2 pb-1 text-[10px] uppercase tracking-wider" style={{ color: 'var(--blanc-ink-3)' }}><Layers className="size-3" /> Groups</div>
                            {groups.map((group, index) => (
                                <button key={`g${group.id}`} type="button" onMouseEnter={() => setHighlighted(groupOffset + index)} onMouseDown={event => { event.preventDefault(); pickGroup(group.id); }} className="w-full text-left px-4 py-2 text-sm flex items-center justify-between gap-3" style={{ background: highlighted === groupOffset + index ? 'rgba(25,25,25,0.06)' : 'transparent' }}>
                                    <div className="min-w-0"><div className="font-medium truncate" style={{ color: 'var(--blanc-ink-1)' }}>{group.name}</div><div className="text-xs truncate" style={{ color: 'var(--blanc-ink-3)' }}>{group.item_count ?? 0} item(s) — adds all</div></div>
                                    <div className="text-sm font-mono whitespace-nowrap shrink-0" style={{ color: 'var(--blanc-ink-1)' }}>{money(Number(group.total) || 0)}</div>
                                </button>
                            ))}
                        </>
                    )}

                    {!trimmed && categoryId == null && !uncategorized && presets.length > 0 && (
                        <div className="flex items-center gap-1.5 px-4 pt-2 pb-1 text-[10px] uppercase tracking-wider" style={{ color: 'var(--blanc-ink-3)' }}><Clock className="size-3" /> Frequently used</div>
                    )}
                    {!trimmed && (categoryId != null || uncategorized) && categoryRows.length === 0 && !loading && presets.length === 0 && (
                        <div className="px-4 py-3 text-xs" style={{ color: 'var(--blanc-ink-3)' }}>No items in this category.</div>
                    )}
                    {!loading && trimmed && presets.length === 0 && (
                        <div className="px-4 py-3 text-xs" style={{ color: 'var(--blanc-ink-3)' }}>No matches.</div>
                    )}

                    {presets.map((preset, index) => (
                        <button key={preset.id} type="button" onMouseDown={event => { event.preventDefault(); pickPreset(preset); }} onMouseEnter={() => setHighlighted(presetOffset + index)} className="w-full text-left px-4 py-2 text-sm flex items-center justify-between gap-3 transition-colors" style={{ background: highlighted === presetOffset + index ? 'rgba(25,25,25,0.06)' : 'transparent' }}>
                            <div className="min-w-0">
                                <div className="font-medium truncate" style={{ color: 'var(--blanc-ink-1)' }}>{preset.code && <span className="font-mono">{preset.code} · </span>}{preset.name}</div>
                                {preset.description && <div className="text-xs truncate" style={{ color: 'var(--blanc-ink-3)' }}>{preset.description}</div>}
                                {trimmed && <div className="text-xs truncate" style={{ color: 'var(--blanc-ink-3)' }}>{categoryPathLabel(tree, preset.category_id)}</div>}
                            </div>
                            <div className="text-sm font-mono whitespace-nowrap shrink-0" style={{ color: 'var(--blanc-ink-1)' }}>{money(preset.default_unit_price)}</div>
                        </button>
                    ))}

                    {canCreate && (
                        <button type="button" onMouseDown={event => { event.preventDefault(); createNew(); }} onMouseEnter={() => setHighlighted(createOffset)} className="w-full text-left px-4 py-2 text-sm flex items-start gap-2" style={{ background: highlighted === createOffset ? 'rgba(25,25,25,0.06)' : 'transparent' }}>
                            <Plus className="size-4 mt-0.5 shrink-0" style={{ color: 'var(--blanc-job)' }} />
                            <div className="min-w-0"><div className="font-medium" style={{ color: 'var(--blanc-job)' }}>Create new “{trimmed}”</div><div className="text-xs" style={{ color: 'var(--blanc-ink-3)' }}>Will be saved to the catalog for future estimates</div></div>
                        </button>
                    )}
                </div>
            )}
        </div>
    );
}
