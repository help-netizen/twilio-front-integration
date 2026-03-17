import { useState } from 'react';
import { toast } from 'sonner';
import { Button } from '../ui/button';
import { Separator } from '../ui/separator';
import {
    RefreshCw, Loader2, ArrowUp, ArrowDown,
    SlidersHorizontal, Download,
} from 'lucide-react';
import {
    Popover, PopoverContent, PopoverTrigger,
} from '../ui/popover';
import { Checkbox } from '../ui/checkbox';
import type { ColumnDef } from './jobHelpers';

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

// ─── Component ───────────────────────────────────────────────────────────────

export function JobsHeader({
    loading,
    exporting,
    filteredJobsCount,
    visibleFields,
    allColumns,
    allFieldKeys,
    onRefresh,
    onExportCSV,
    onSaveFields,
}: JobsHeaderProps) {
    const [fieldsOpen, setFieldsOpen] = useState(false);
    const [pendingFields, setPendingFields] = useState<string[]>([]);
    const [savingFields, setSavingFields] = useState(false);

    return (
        <div className="flex items-center justify-between">
            <h2 className="text-xl font-semibold">Jobs</h2>
            <div className="flex items-center gap-1">
                {/* Fields config */}
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
                        <div className="max-h-80 overflow-auto p-1">
                            {/* Visible fields (ordered) */}
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
                                        <div className="flex gap-0.5 opacity-0 group-hover:opacity-100">
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
                            {/* Hidden fields */}
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
                        <div className="px-3 py-2 border-t flex gap-2 justify-end">
                            <Button variant="ghost" size="sm" onClick={() => setFieldsOpen(false)}>Cancel</Button>
                            <Button size="sm" disabled={savingFields || pendingFields.length === 0} onClick={async () => {
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
                            }}>
                                {savingFields ? <Loader2 className="size-4 animate-spin mr-1" /> : null}
                                Save
                            </Button>
                        </div>
                    </PopoverContent>
                </Popover>
                <Button variant="outline" size="sm" onClick={onRefresh} disabled={loading}>
                    <RefreshCw className={`size-4 mr-1 ${loading ? 'animate-spin' : ''}`} />
                    Refresh
                </Button>
                <Button variant="outline" size="sm" onClick={onExportCSV} disabled={filteredJobsCount === 0 || exporting}>
                    {exporting ? <Loader2 className="size-4 mr-1 animate-spin" /> : <Download className="size-4 mr-1" />}
                    Export
                </Button>
            </div>
        </div>
    );
}
