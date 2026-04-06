import { useState } from 'react';
import { toast } from 'sonner';
import { Button } from '../ui/button';
import { Separator } from '../ui/separator';
import {
    Loader2, ArrowUp, ArrowDown,
    SlidersHorizontal, Download, X,
} from 'lucide-react';
import {
    Popover, PopoverContent, PopoverTrigger,
} from '../ui/popover';
import { Checkbox } from '../ui/checkbox';
import type { ColumnDef } from './jobHelpers';
import { isMobileViewport } from '../../hooks/useViewportSafePosition';

// ─── Types ───────────────────────────────────────────────────────────────────

interface JobsHeaderProps {
    loading: boolean;
    exporting: boolean;
    filteredJobsCount: number;
    visibleFields: string[];
    allColumns: Record<string, ColumnDef>;
    allFieldKeys: string[];
    onRefresh: () => void;
    onExportCSV: () => void;
    onSaveFields: (fields: string[]) => Promise<void>;
}

// ─── Fields Popover (reusable, placed inside toolbar) ────────────────────────

export function JobsFieldsButton({
    visibleFields, allColumns, allFieldKeys, onSaveFields,
}: Pick<JobsHeaderProps, 'visibleFields' | 'allColumns' | 'allFieldKeys' | 'onSaveFields'>) {
    const [fieldsOpen, setFieldsOpen] = useState(false);
    const [pendingFields, setPendingFields] = useState<string[]>([]);
    const [savingFields, setSavingFields] = useState(false);

    const handleOpen = () => {
        setPendingFields([...visibleFields]);
        setFieldsOpen(true);
    };

    const handleSave = async () => {
        setSavingFields(true);
        try {
            await onSaveFields(pendingFields);
            setFieldsOpen(false);
            toast.success('Column config saved');
        } catch (e: any) {
            toast.error('Failed to save', { description: e.message });
        } finally {
            setSavingFields(false);
        }
    };

    const fieldsContent = (
        <>
            <div className="max-h-80 overflow-auto p-1">
                {pendingFields.map((fk, idx) => {
                    const col = allColumns[fk];
                    if (!col) return null;
                    return (
                        <div key={fk} className="flex items-center gap-2 px-2 py-1.5 rounded hover:bg-muted/50 group">
                            <Checkbox
                                checked={true}
                                onCheckedChange={() => {
                                    setPendingFields(prev => prev.filter(k => k !== fk));
                                }}
                                className="size-4"
                            />
                            <span className="flex-1 text-sm">{col.label}</span>
                            <div className="flex gap-0.5 opacity-0 group-hover:opacity-100 max-md:opacity-100">
                                <button
                                    className="p-0.5 rounded hover:bg-muted disabled:opacity-30"
                                    disabled={idx === 0}
                                    onClick={() => {
                                        setPendingFields(prev => {
                                            const n = [...prev];
                                            [n[idx - 1], n[idx]] = [n[idx], n[idx - 1]];
                                            return n;
                                        });
                                    }}
                                >
                                    <ArrowUp className="size-3" />
                                </button>
                                <button
                                    className="p-0.5 rounded hover:bg-muted disabled:opacity-30"
                                    disabled={idx === pendingFields.length - 1}
                                    onClick={() => {
                                        setPendingFields(prev => {
                                            const n = [...prev];
                                            [n[idx], n[idx + 1]] = [n[idx + 1], n[idx]];
                                            return n;
                                        });
                                    }}
                                >
                                    <ArrowDown className="size-3" />
                                </button>
                            </div>
                        </div>
                    );
                })}
                {allFieldKeys.filter((k: string) => !pendingFields.includes(k)).length > 0 && (
                    <>
                        <Separator className="my-1" />
                        <div className="px-2 py-1 text-xs text-muted-foreground font-medium">Hidden</div>
                    </>
                )}
                {allFieldKeys.filter((k: string) => !pendingFields.includes(k)).map(fk => {
                    const col = allColumns[fk];
                    return (
                        <div key={fk} className="flex items-center gap-2 px-2 py-1.5 rounded hover:bg-muted/50">
                            <Checkbox
                                checked={false}
                                onCheckedChange={() => {
                                    setPendingFields(prev => [...prev, fk]);
                                }}
                                className="size-4"
                            />
                            <span className="flex-1 text-sm text-muted-foreground">{col.label}</span>
                        </div>
                    );
                })}
            </div>
            <div className="px-3 py-2 border-t flex gap-2 justify-end" style={{ paddingBottom: 'max(8px, env(safe-area-inset-bottom))' }}>
                <Button variant="ghost" size="sm" onClick={() => setFieldsOpen(false)}>Cancel</Button>
                <Button size="sm" disabled={savingFields || pendingFields.length === 0} onClick={handleSave}>
                    {savingFields ? <Loader2 className="size-4 animate-spin mr-1" /> : null}
                    Save
                </Button>
            </div>
        </>
    );

    const isMobile = isMobileViewport();

    if (isMobile) {
        return (
            <>
                <Button variant="outline" size="sm" onClick={handleOpen}>
                    <SlidersHorizontal className="size-4 mr-1" />
                    Fields
                </Button>
                {fieldsOpen && (
                    <>
                        <div className="blanc-mobile-sheet-backdrop" onClick={() => setFieldsOpen(false)} />
                        <div className="blanc-mobile-sheet">
                            <div className="blanc-mobile-sheet-header">
                                <span className="text-sm font-semibold" style={{ color: 'var(--blanc-ink-1)' }}>Visible Fields</span>
                                <button onClick={() => setFieldsOpen(false)} className="p-1.5 rounded-lg" style={{ color: 'var(--blanc-ink-3)' }}><X className="size-4" /></button>
                            </div>
                            {fieldsContent}
                        </div>
                    </>
                )}
            </>
        );
    }

    return (
        <Popover open={fieldsOpen} onOpenChange={(open) => {
            setFieldsOpen(open);
            if (open) setPendingFields([...visibleFields]);
        }}>
            <PopoverTrigger asChild>
                <Button variant="outline" size="sm">
                    <SlidersHorizontal className="size-4 mr-1" />
                    Fields
                </Button>
            </PopoverTrigger>
            <PopoverContent className="w-72 p-0" align="end">
                <div className="px-3 py-2 border-b font-medium text-sm">Visible Fields</div>
                {fieldsContent}
            </PopoverContent>
        </Popover>
    );
}

// ─── Header (Title + Export button only) ─────────────────────────────────────

export function JobsHeader({
    exporting,
    filteredJobsCount,
    onExportCSV,
}: JobsHeaderProps) {
    return (
        <div className="flex items-center justify-between w-full">
            <h1 className="blanc-heading blanc-heading-lg">Jobs</h1>
            <Button onClick={onExportCSV} disabled={filteredJobsCount === 0 || exporting}>
                {exporting ? <Loader2 className="size-4 mr-1 animate-spin" /> : <Download className="size-4 mr-1" />}
                Export CSV
            </Button>
        </div>
    );
}
