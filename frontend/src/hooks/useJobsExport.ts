import { useState } from 'react';
import { toast } from 'sonner';
import { authedFetch } from '../services/apiClient';
import type { LocalJob } from '../services/jobsApi';
import { useCompanyTime } from '../lib/companyTime';

// ─── Types ───────────────────────────────────────────────────────────────────

interface UseJobsExportParams {
    sortBy: string;
    sortOrder: 'asc' | 'desc';
    startDate?: string;
    endDate?: string;
}

// ─── Hook ────────────────────────────────────────────────────────────────────

export function useJobsExport({
    sortBy, sortOrder, startDate, endDate,
}: UseJobsExportParams) {
    const { format } = useCompanyTime();
    const [exporting, setExporting] = useState(false);

    const handleExportCSV = async () => {
        setExporting(true);
        try {
            // Export covers the entire selected date range — UI list filters
            // (search, only_open, status, type, provider, tag, source) are
            // intentionally NOT applied so the CSV is a complete picture for
            // the period. Sort is preserved for ordering only.
            // The list endpoint caps `limit` at 500, so page through the whole
            // date range by offset and accumulate — a period can legitimately
            // hold more than 500 jobs and the CSV must be the complete picture.
            const PAGE = 500;
            const exportJobs: LocalJob[] = [];
            for (let offset = 0, guard = 0; guard < 400; guard++, offset += PAGE) {
                const qs = new URLSearchParams();
                if (sortBy) qs.set('sort_by', sortBy);
                if (sortOrder) qs.set('sort_order', sortOrder);
                if (startDate) qs.set('start_date', startDate);
                if (endDate) qs.set('end_date', endDate);
                qs.set('limit', String(PAGE));
                qs.set('offset', String(offset));

                const res = await authedFetch(`/api/jobs?${qs.toString()}`);
                const json = await res.json();
                if (!json.ok) throw new Error(json.error || 'Export failed');
                const page: LocalJob[] = json.data?.results || [];
                exportJobs.push(...page);
                if (page.length < PAGE) break; // last page reached
            }

            const headers = [
                'Job #', 'Tags', 'Job Type', 'Job End',
                'Status', 'Tech', 'Amount Paid', 'Job Date',
                'Claim ID and Other',
            ];

            const formatDateOnly = (d?: string) => {
                if (!d) return '';
                try {
                    return format(d, {
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
                j.amount_paid || '',
                formatDateOnly(j.start_date),
                j.metadata ? Object.values(j.metadata).filter(v => v != null && v !== '').join('; ') : '',
            ]);

            // Cells may be numbers after the job-pool money derivation
            // (amount_paid) — coerce before string ops ("O.includes is not
            // a function" in the minified prod bundle).
            const escape = (raw: string | number | null | undefined) => {
                const val = String(raw ?? '');
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
