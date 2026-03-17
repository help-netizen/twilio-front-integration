import { useState } from 'react';
import { toast } from 'sonner';
import { authedFetch } from '../services/apiClient';
import type { LocalJob } from '../services/jobsApi';

// ─── Types ───────────────────────────────────────────────────────────────────

interface UseJobsExportParams {
    filteredJobs: LocalJob[];
    searchQuery: string;
    sortBy: string;
    sortOrder: 'asc' | 'desc';
    onlyOpen: boolean;
    startDate?: string;
    endDate?: string;
    statusFilter: string[];
    jobTypeFilter: string[];
    providerFilter: string[];
    tagFilter: number[];
    sourceFilter: string[];
}

// ─── Hook ────────────────────────────────────────────────────────────────────

export function useJobsExport({
    filteredJobs, searchQuery, sortBy, sortOrder,
    onlyOpen, startDate, endDate,
    statusFilter, jobTypeFilter, providerFilter, tagFilter, sourceFilter,
}: UseJobsExportParams) {
    const [exporting, setExporting] = useState(false);

    const handleExportCSV = async () => {
        if (filteredJobs.length === 0) return;
        setExporting(true);
        try {
            const qs = new URLSearchParams();
            if (searchQuery.trim()) qs.set('search', searchQuery.trim());
            if (sortBy) qs.set('sort_by', sortBy);
            if (sortOrder) qs.set('sort_order', sortOrder);
            if (onlyOpen) qs.set('only_open', 'true');
            if (startDate) qs.set('start_date', startDate);
            if (endDate) qs.set('end_date', endDate);
            if (statusFilter.length > 0) qs.set('blanc_status', statusFilter.join(','));
            if (jobTypeFilter.length > 0) qs.set('service_name', jobTypeFilter.join(','));
            if (providerFilter.length > 0) qs.set('provider', providerFilter.join(','));
            if (tagFilter.length > 0) qs.set('tag_ids', tagFilter.join(','));
            qs.set('limit', '10000');
            qs.set('offset', '0');

            const res = await authedFetch(`/api/jobs?${qs.toString()}`);
            const json = await res.json();
            console.log('[Export] Fetched from backend:', { url: `/api/jobs?${qs.toString()}`, ok: json.ok, count: json.data?.results?.length, total: json.data?.total });
            if (!json.ok) throw new Error(json.error || 'Export failed');
            const allJobs: LocalJob[] = json.data.results || [];

            // Apply client-side source filter
            let exportJobs = allJobs;
            if (sourceFilter.length > 0) {
                exportJobs = exportJobs.filter(j => j.job_source && sourceFilter.includes(j.job_source));
            }

            const headers = [
                'Job #', 'Tags', 'Job Type', 'Job End',
                'Status', 'Tech', 'Amount Paid', 'Job Date',
                'Claim ID and Other',
            ];

            const formatDateOnly = (d?: string) => {
                if (!d) return '';
                try {
                    return new Date(d).toLocaleDateString('en-US', {
                        month: '2-digit', day: '2-digit', year: '2-digit',
                    });
                } catch { return ''; }
            };

            const csvRows = exportJobs.map(j => [
                j.job_number || '',
                (j.tags || []).map(t => t.name).join(', '),
                j.service_name || j.job_type || '',
                formatDateOnly(j.end_date),
                j.blanc_status || '',
                (j.assigned_techs || []).map(t => t.name).filter(Boolean).join(', '),
                j.invoice_total || '',
                formatDateOnly(j.start_date),
                j.metadata ? Object.values(j.metadata).filter(v => v != null && v !== '').join('; ') : '',
            ]);

            const escape = (val: string) => {
                if (val.includes(',') || val.includes('"') || val.includes('\n')) {
                    return `"${val.replace(/"/g, '""')}"`;
                }
                return val;
            };

            const csv = [
                headers.map(escape).join(','),
                ...csvRows.map(row => row.map(escape).join(',')),
            ].join('\n');

            const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `jobs_export_${new Date().toISOString().slice(0, 10)}.csv`;
            a.click();
            URL.revokeObjectURL(url);
        } catch (err) {
            toast.error('Export failed', { description: err instanceof Error ? err.message : '' });
        } finally {
            setExporting(false);
        }
    };

    return { exporting, handleExportCSV };
}
