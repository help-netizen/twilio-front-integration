import { useEffect, useMemo, useRef, useState } from 'react';
import { Plus, Clock, Loader2 } from 'lucide-react';
import { searchEstimateItemPresets, type EstimateItemPreset } from '../../services/estimateItemPresetsApi';

interface Props {
    disabled?: boolean;
    /** Called when user picks an existing preset. Combobox passes the full preset. */
    onPickPreset: (preset: EstimateItemPreset) => void | Promise<void>;
    /** Called when user chooses to create a brand-new item. Combobox passes the typed name. */
    onCreateNew: (name: string) => void | Promise<void>;
}

function money(value: number): string {
    return '$' + Number(value || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function ItemPresetSearchCombobox({ disabled, onPickPreset, onCreateNew }: Props) {
    const [query, setQuery] = useState('');
    const [open, setOpen] = useState(false);
    const [loading, setLoading] = useState(false);
    const [presets, setPresets] = useState<EstimateItemPreset[]>([]);
    const [highlighted, setHighlighted] = useState(0);
    const inputRef = useRef<HTMLInputElement>(null);
    const boxRef = useRef<HTMLDivElement>(null);

    // Debounced search
    useEffect(() => {
        if (!open) return;
        let cancelled = false;
        const t = setTimeout(async () => {
            setLoading(true);
            try {
                const items = await searchEstimateItemPresets(query.trim(), 10);
                if (!cancelled) {
                    setPresets(items);
                    setHighlighted(0);
                }
            } catch {
                // Silent — combobox stays open with "no items"
            } finally {
                if (!cancelled) setLoading(false);
            }
        }, 200);
        return () => { cancelled = true; clearTimeout(t); };
    }, [query, open]);

    // Click outside to close
    useEffect(() => {
        if (!open) return;
        const handler = (e: MouseEvent) => {
            if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
        };
        document.addEventListener('mousedown', handler);
        return () => document.removeEventListener('mousedown', handler);
    }, [open]);

    const trimmed = query.trim();
    const exactMatch = useMemo(
        () => presets.find(p => p.name.toLowerCase() === trimmed.toLowerCase()),
        [presets, trimmed],
    );
    const canCreate = trimmed.length > 0 && !exactMatch;
    // Order in dropdown: presets first, then "Create new" row (if applicable).
    const totalRows = presets.length + (canCreate ? 1 : 0);

    const pickPreset = async (preset: EstimateItemPreset) => {
        await onPickPreset(preset);
        setQuery('');
        setOpen(false);
    };
    const createNew = async () => {
        if (!trimmed) return;
        await onCreateNew(trimmed);
        setQuery('');
        setOpen(false);
    };
    const activateAt = async (idx: number) => {
        if (idx < presets.length) await pickPreset(presets[idx]);
        else if (canCreate) await createNew();
    };

    return (
        <div ref={boxRef} className="relative w-full max-w-md">
            <div className="relative">
                <Plus className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-[#5f7085] pointer-events-none" />
                <input
                    ref={inputRef}
                    type="text"
                    value={query}
                    disabled={disabled}
                    placeholder="Search saved items or type to create new…"
                    title="Find a previously used item or create a new one — it will be saved for future estimates"
                    onFocus={() => setOpen(true)}
                    onChange={e => { setQuery(e.target.value); if (!open) setOpen(true); }}
                    onKeyDown={(e) => {
                        if (e.key === 'ArrowDown') {
                            e.preventDefault();
                            setHighlighted(h => Math.min(h + 1, totalRows - 1));
                        } else if (e.key === 'ArrowUp') {
                            e.preventDefault();
                            setHighlighted(h => Math.max(h - 1, 0));
                        } else if (e.key === 'Enter') {
                            e.preventDefault();
                            activateAt(highlighted);
                        } else if (e.key === 'Escape') {
                            setOpen(false);
                        }
                    }}
                    className="h-9 w-full rounded-[10px] border-[1.5px] border-[#d8e0ea] bg-white pl-9 pr-3 text-sm outline-none focus-visible:border-[#172033] disabled:opacity-50"
                />
            </div>

            {open && (
                <div className="absolute left-0 right-0 top-full mt-1 z-30 max-h-80 overflow-y-auto rounded-xl border border-[#d8e0ea] bg-white shadow-md">
                    {loading && presets.length === 0 && (
                        <div className="flex items-center gap-2 px-4 py-3 text-xs text-[#5f7085]">
                            <Loader2 className="size-3.5 animate-spin" />
                            Searching…
                        </div>
                    )}
                    {!loading && presets.length === 0 && !trimmed && (
                        <div className="px-4 py-3 text-xs text-[#5f7085]">
                            No saved items yet. Type a name to create one.
                        </div>
                    )}
                    {!loading && presets.length === 0 && trimmed && !canCreate && (
                        <div className="px-4 py-3 text-xs text-[#5f7085]">No matches.</div>
                    )}

                    {!trimmed && presets.length > 0 && (
                        <div className="flex items-center gap-1.5 px-4 pt-2 pb-1 text-[10px] uppercase tracking-wider text-[#5f7085]">
                            <Clock className="size-3" /> Frequently used
                        </div>
                    )}

                    {presets.map((p, idx) => (
                        <button
                            key={p.id}
                            type="button"
                            onMouseDown={(e) => { e.preventDefault(); pickPreset(p); }}
                            onMouseEnter={() => setHighlighted(idx)}
                            className={`w-full text-left px-4 py-2 text-sm flex items-center justify-between gap-3 ${
                                highlighted === idx ? 'bg-[#f3f6f9]' : 'hover:bg-[#f3f6f9]'
                            }`}
                        >
                            <div className="min-w-0">
                                <div className="font-medium truncate">{p.name}</div>
                                {p.description && (
                                    <div className="text-xs text-[#5f7085] truncate">{p.description}</div>
                                )}
                            </div>
                            <div className="text-sm font-mono whitespace-nowrap shrink-0">{money(p.default_unit_price)}</div>
                        </button>
                    ))}

                    {canCreate && (
                        <>
                            {presets.length > 0 && <div className="border-t border-[#d8e0ea]" />}
                            <button
                                type="button"
                                onMouseDown={(e) => { e.preventDefault(); createNew(); }}
                                onMouseEnter={() => setHighlighted(presets.length)}
                                className={`w-full text-left px-4 py-2 text-sm flex items-start gap-2 ${
                                    highlighted === presets.length ? 'bg-blue-50' : 'hover:bg-blue-50'
                                }`}
                            >
                                <Plus className="size-4 mt-0.5 text-blue-600 shrink-0" />
                                <div className="min-w-0">
                                    <div className="text-blue-600 font-medium">
                                        Create new “{trimmed}”
                                    </div>
                                    <div className="text-xs text-[#5f7085]">
                                        Will be saved to the catalog for future estimates
                                    </div>
                                </div>
                            </button>
                        </>
                    )}
                </div>
            )}
        </div>
    );
}
