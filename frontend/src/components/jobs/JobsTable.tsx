import { Button } from '../ui/button';
import {
    ChevronLeft, ChevronRight, Loader2,
    ArrowUpDown, ArrowUp, ArrowDown,
} from 'lucide-react';
import type { LocalJob } from '../../services/jobsApi';
import type { ColumnDef } from './jobHelpers';

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
    offset: number;
    totalCount: number;
    hasMore: boolean;
    limit: number;
    onLoadJobs: (offset: number) => void;
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
    offset,
    totalCount,
    hasMore,
    limit,
    onLoadJobs,
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
        return (
            <div className="flex-1 flex items-center justify-center h-40 text-muted-foreground">
                No jobs found
            </div>
        );
    }

    return (
        <>
            {/* Table */}
            <div className="flex-1 overflow-auto">
                <table className="w-full text-sm">
                    <thead className="bg-white sticky top-0 z-10 shadow-[0_1px_0_0_hsl(var(--border))]">
                        <tr className="border-b text-left">
                            {visibleFields.map(fk => {
                                const col = allColumns[fk];
                                if (!col) return null;
                                return (
                                    <th
                                        key={fk}
                                        className={`px-4 py-2.5 font-medium ${col.width || ''} ${col.sortKey ? 'cursor-pointer select-none hover:bg-muted/30 transition-colors' : ''}`}
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
                        </tr>
                    </thead>
                    <tbody>
                        {jobs.map(job => (
                            <tr
                                key={job.id}
                                className={`border-b hover:bg-muted/30 cursor-pointer transition-colors ${selectedJobId === job.id ? 'bg-muted/50' : ''}`}
                                onClick={() => onSelectJob(job)}
                            >
                                {visibleFields.map(fk => {
                                    const col = allColumns[fk];
                                    if (!col) return null;
                                    return <td key={fk} className="px-4 py-2.5">{col.render(job)}</td>;
                                })}
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>

            {/* Pagination */}
            <div className="border-t px-4 py-2 flex items-center justify-between text-sm text-muted-foreground">
                <span>{totalCount > 0 ? `${offset + 1}–${offset + jobs.length} from ${totalCount} jobs` : '0 jobs'}</span>
                <div className="flex items-center gap-1">
                    <Button variant="ghost" size="sm" disabled={offset === 0} onClick={() => onLoadJobs(Math.max(0, offset - limit))}>
                        <ChevronLeft className="size-4" />
                    </Button>
                    <Button variant="ghost" size="sm" disabled={!hasMore} onClick={() => onLoadJobs(offset + limit)}>
                        <ChevronRight className="size-4" />
                    </Button>
                </div>
            </div>
        </>
    );
}
