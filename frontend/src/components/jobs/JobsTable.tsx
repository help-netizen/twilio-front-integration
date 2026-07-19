import {
    Loader2,
    ArrowUpDown, ArrowUp, ArrowDown,
    MoreVertical, Copy,
} from 'lucide-react';
import type { LocalJob } from '../../services/jobsApi';
import type { ColumnDef } from './jobHelpers';
import {
    DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from '../ui/dropdown-menu';
import { LoadMoreFooter, type LoadMoreFooterProps } from '../lists/LoadMoreFooter';

// ─── Props ───────────────────────────────────────────────────────────────────

interface JobsTableProps {
    jobs: LocalJob[];
    loading: boolean;
    selectedJobId?: number | null;
    visibleFields: string[];
    allColumns: Record<string, ColumnDef>;
    sortBy: string;
    sortOrder: 'asc' | 'desc';
    onSortChange: (field: string, order: 'asc' | 'desc') => void;
    onSelectJob: (job: LocalJob) => void;
    footerProps: LoadMoreFooterProps;
    onCopyJob?: (job: LocalJob) => void;
}

// ─── Component ───────────────────────────────────────────────────────────────

export function JobsTable({
    jobs,
    loading,
    selectedJobId,
    visibleFields,
    allColumns,
    sortBy,
    sortOrder,
    onSortChange,
    onSelectJob,
    footerProps,
    onCopyJob,
}: JobsTableProps) {
    const handleHeaderClick = (col: ColumnDef) => {
        if (!col.sortKey) return;
        if (sortBy === col.sortKey) {
            onSortChange(col.sortKey, sortOrder === 'asc' ? 'desc' : 'asc');
        } else {
            onSortChange(col.sortKey, 'asc');
        }
    };

    // Loading state
    if (loading) {
        return (
            <div className="flex-1 flex items-center justify-center h-40 text-muted-foreground">
                <Loader2 className="size-5 animate-spin mr-2" /> Loading jobs...
            </div>
        );
    }

    // Empty state
    if (jobs.length === 0) {
        if (footerProps.state === 'error+retry') {
            return (
                <div className="flex-1 flex items-center justify-center h-40 text-muted-foreground">
                    <LoadMoreFooter {...footerProps} />
                </div>
            );
        }
        return (
            <div className="flex-1 flex items-center justify-center h-40 text-muted-foreground">
                No jobs found
            </div>
        );
    }

    return (
        <>
            {/* Table — ряды-тайлы на канвасе (LAYOUT-CANON правило 7, .blanc-table-tiles) */}
            <div className="flex-1 overflow-auto">
                <table className="w-full text-sm blanc-table-tiles">
                    <thead>
                        <tr className="text-left">
                            {visibleFields.map(fk => {
                                const col = allColumns[fk];
                                if (!col) return null;
                                return (
                                    <th
                                        key={fk}
                                        className={`px-4 py-1 ${col.width || ''} ${col.sortKey ? 'cursor-pointer select-none' : ''}`}
                                        onClick={() => handleHeaderClick(col)}
                                    >
                                        <span className="inline-flex items-center gap-1">
                                            {col.label}
                                            {col.sortKey && (
                                                sortBy === col.sortKey
                                                    ? (sortOrder === 'asc'
                                                        ? <ArrowUp className="size-3.5 text-primary" />
                                                        : <ArrowDown className="size-3.5 text-primary" />)
                                                    : <ArrowUpDown className="size-3.5 text-muted-foreground/40" />
                                            )}
                                        </span>
                                    </th>
                                );
                            })}
                            {onCopyJob && <th className="px-2 py-1 w-10" aria-label="Actions" />}
                        </tr>
                    </thead>
                    <tbody>
                        {jobs.map(job => (
                            <tr
                                key={job.id}
                                className={`cursor-pointer ${selectedJobId === job.id ? 'blanc-tile-row-selected' : ''}`}
                                onClick={() => onSelectJob(job)}
                            >
                                {visibleFields.map(fk => {
                                    const col = allColumns[fk];
                                    if (!col) return null;
                                    return <td key={fk} className="px-4 py-2.5">{col.render(job)}</td>;
                                })}
                                {onCopyJob && (
                                    <td className="px-2 py-2.5 w-10" onClick={e => e.stopPropagation()}>
                                        <DropdownMenu>
                                            <DropdownMenuTrigger asChild>
                                                <button
                                                    type="button"
                                                    aria-label="Job actions"
                                                    className="inline-flex items-center justify-center transition-opacity hover:opacity-70"
                                                    style={{ width: 28, height: 28, borderRadius: 8, color: 'var(--blanc-ink-3)' }}
                                                    onClick={e => e.stopPropagation()}
                                                >
                                                    <MoreVertical className="size-4" />
                                                </button>
                                            </DropdownMenuTrigger>
                                            <DropdownMenuContent align="end">
                                                <DropdownMenuItem onClick={() => onCopyJob(job)}>
                                                    <Copy className="size-4 mr-2" />Copy job
                                                </DropdownMenuItem>
                                            </DropdownMenuContent>
                                        </DropdownMenu>
                                    </td>
                                )}
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>

            <LoadMoreFooter {...footerProps} />
        </>
    );
}
