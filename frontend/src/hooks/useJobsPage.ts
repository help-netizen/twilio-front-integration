import { useState, useEffect, useCallback, useMemo } from 'react';
import { toast } from 'sonner';
import { useNavigate, useParams } from 'react-router-dom';
import { authedFetch } from '../services/apiClient';
import * as jobsApi from '../services/jobsApi';
import * as contactsApi from '../services/contactsApi';
import type { LocalJob, JobsListParams, JobTag } from '../services/jobsApi';
import {
    STATIC_COLUMNS, STATIC_FIELD_KEYS, DEFAULT_VISIBLE_FIELDS,
    makeMetaColumn, type ColumnDef,
} from '../components/jobs/jobHelpers';

// ─── Constants ───────────────────────────────────────────────────────────────

const LIMIT = 50;

// ─── Hook ────────────────────────────────────────────────────────────────────

export function useJobsPage() {
    const [jobs, setJobs] = useState<LocalJob[]>([]);
    const [loading, setLoading] = useState(true);
    const [selectedJob, setSelectedJob] = useState<LocalJob | null>(null);
    const [detailLoading, setDetailLoading] = useState(false);
    const [totalCount, setTotalCount] = useState(0);

    const navigate = useNavigate();
    const { jobId: urlJobId } = useParams<{ jobId?: string }>();

    // Filters
    const [searchQuery, setSearchQuery] = useState('');
    const [offset, setOffset] = useState(0);
    const [hasMore, setHasMore] = useState(false);
    const [statusFilter, setStatusFilter] = useState<string[]>([]);
    const [providerFilter, setProviderFilter] = useState<string[]>([]);
    const [sourceFilter, setSourceFilter] = useState<string[]>([]);
    const [jobTypeFilter, setJobTypeFilter] = useState<string[]>([]);
    const [tagFilter, setTagFilter] = useState<number[]>([]);
    const [onlyOpen, setOnlyOpen] = useState(false);
    const [startDate, setStartDate] = useState<string | undefined>(undefined);
    const [endDate, setEndDate] = useState<string | undefined>(undefined);

    // Tag catalog
    const [allTags, setAllTags] = useState<JobTag[]>([]);

    // Sort
    const [sortBy, setSortBy] = useState<string>('created_at');
    const [sortOrder, setSortOrder] = useState<'asc' | 'desc'>('desc');

    // Contact info for detail panel
    const [contactInfo, setContactInfo] = useState<{ name: string; phone: string; email: string; id: number } | null>(null);

    // Column config
    const [visibleFields, setVisibleFields] = useState<string[]>(DEFAULT_VISIBLE_FIELDS);

    // Custom fields for dynamic metadata columns
    const [customFields, setCustomFields] = useState<Array<{ api_name: string; display_name: string; is_system: boolean }>>([]);

    // Note
    const [noteText, setNoteText] = useState('');
    const [noteJobId, setNoteJobId] = useState<number | null>(null);

    // Export
    const [exporting, setExporting] = useState(false);

    // ─── Derived data ────────────────────────────────────────────────

    // Build full column map: static + dynamic metadata
    const allColumns = useMemo<Record<string, ColumnDef>>(() => {
        const cols: Record<string, ColumnDef> = { ...STATIC_COLUMNS };
        for (const cf of customFields) {
            if (cf.is_system) continue;
            cols[`meta:${cf.api_name}`] = makeMetaColumn(cf.api_name, cf.display_name);
        }
        return cols;
    }, [customFields]);

    const allFieldKeys = useMemo(() => {
        return [...STATIC_FIELD_KEYS, ...customFields.filter(f => !f.is_system).map(f => `meta:${f.api_name}`)];
    }, [customFields]);

    // Client-side filtering (only for filters not yet supported server-side)
    const filteredJobs = useMemo(() => {
        let result = jobs;
        if (sourceFilter.length > 0) {
            result = result.filter(j => j.job_source && sourceFilter.includes(j.job_source));
        }
        return result;
    }, [jobs, sourceFilter]);

    // ─── Data Loading ────────────────────────────────────────────────

    const loadJobs = useCallback(async (newOffset = 0) => {
        setLoading(true);
        try {
            const params: JobsListParams = {
                limit: LIMIT,
                offset: newOffset,
            };
            if (searchQuery.trim()) params.search = searchQuery.trim();
            if (sortBy) params.sort_by = sortBy;
            if (sortOrder) params.sort_order = sortOrder;
            if (onlyOpen) params.only_open = true;
            if (startDate) params.start_date = startDate;
            if (endDate) params.end_date = endDate;
            if (statusFilter.length > 0) params.blanc_status = statusFilter.join(',');
            if (jobTypeFilter.length > 0) params.service_name = jobTypeFilter.join(',');
            if (providerFilter.length > 0) params.provider = providerFilter.join(',');
            if (tagFilter.length > 0) params.tag_ids = tagFilter.join(',');

            const data = await jobsApi.listJobs(params);
            setJobs(data.results || []);
            setHasMore(data.has_more);
            setTotalCount(data.total);
            setOffset(newOffset);
        } catch (error) {
            toast.error('Failed to load jobs', {
                description: error instanceof Error ? error.message : 'Unknown error',
            });
        } finally {
            setLoading(false);
        }
    }, [searchQuery, sortBy, sortOrder, onlyOpen, startDate, endDate, statusFilter, jobTypeFilter, providerFilter, tagFilter]);

    // Load tag catalog + custom fields on mount
    useEffect(() => {
        jobsApi.listJobTags().then(setAllTags).catch(() => { });
        authedFetch('/api/settings/lead-form')
            .then(r => r.json())
            .then(data => {
                if (data.success) setCustomFields(data.customFields || []);
            })
            .catch(() => { });
    }, []);

    // Load column config on mount
    useEffect(() => {
        jobsApi.getJobsListFields()
            .then(fields => {
                if (fields.length > 0) setVisibleFields(fields);
            })
            .catch(() => { });
    }, []);

    useEffect(() => { loadJobs(0); }, [loadJobs]);

    // ─── Selection / Navigation ──────────────────────────────────────

    const handleSelectJob = async (job: LocalJob) => {
        setSelectedJob(job);
        setDetailLoading(true);
        setContactInfo(null);
        navigate(`/jobs/${job.id}`, { replace: true });
        try {
            const detail = await jobsApi.getJob(job.id);
            setSelectedJob(detail);
            if (detail.contact_id) {
                try {
                    const resp = await contactsApi.getContact(detail.contact_id);
                    const c = resp.data.contact;
                    setContactInfo({ name: c.full_name || '—', phone: c.phone_e164 || '', email: c.email || '', id: c.id });
                } catch { /* no contact found */ }
            }
        } catch {
            // Keep the list-version
        } finally {
            setDetailLoading(false);
        }
    };

    const handleCloseDetail = () => {
        setSelectedJob(null);
        setContactInfo(null);
        navigate('/jobs', { replace: true });
    };

    // Auto-select job from URL /jobs/:jobId
    useEffect(() => {
        if (urlJobId && !selectedJob && !loading) {
            const id = parseInt(urlJobId, 10);
            const job = jobs.find(j => j.id === id);
            if (job) {
                handleSelectJob(job);
            } else if (jobs.length > 0) {
                (async () => {
                    setDetailLoading(true);
                    try {
                        const detail = await jobsApi.getJob(id);
                        setSelectedJob(detail);
                        if (detail.contact_id) {
                            try {
                                const resp = await contactsApi.getContact(detail.contact_id);
                                const c = resp.data.contact;
                                setContactInfo({ name: c.full_name || '—', phone: c.phone_e164 || '', email: c.email || '', id: c.id });
                            } catch { }
                        }
                    } catch { /* not found */ }
                    finally { setDetailLoading(false); }
                })();
            }
        }
    }, [urlJobId, jobs, loading]);

    // ─── Actions ─────────────────────────────────────────────────────

    const refreshSelected = async (id: number) => {
        try {
            const detail = await jobsApi.getJob(id);
            setSelectedJob(detail);
        } catch { /* ignore */ }
    };

    const handleCancel = async (id: number) => {
        if (!confirm('Cancel this job?')) return;
        try {
            await jobsApi.cancelJob(id);
            toast.success('Job canceled');
            loadJobs(offset);
            if (selectedJob?.id === id) refreshSelected(id);
        } catch (err) {
            toast.error('Failed to cancel job', { description: err instanceof Error ? err.message : '' });
        }
    };

    const handleMarkEnroute = async (id: number) => {
        try {
            await jobsApi.markEnroute(id);
            toast.success('Job marked as en-route');
            loadJobs(offset);
            if (selectedJob?.id === id) refreshSelected(id);
        } catch (err) {
            toast.error('Failed', { description: err instanceof Error ? err.message : '' });
        }
    };

    const handleMarkInProgress = async (id: number) => {
        try {
            await jobsApi.markInProgress(id);
            toast.success('Job started');
            loadJobs(offset);
            if (selectedJob?.id === id) refreshSelected(id);
        } catch (err) {
            toast.error('Failed', { description: err instanceof Error ? err.message : '' });
        }
    };

    const handleMarkComplete = async (id: number) => {
        try {
            await jobsApi.markComplete(id);
            toast.success('Job completed');
            loadJobs(offset);
            if (selectedJob?.id === id) refreshSelected(id);
        } catch (err) {
            toast.error('Failed', { description: err instanceof Error ? err.message : '' });
        }
    };

    const handleBlancStatusChange = async (id: number, newStatus: string) => {
        try {
            await jobsApi.updateBlancStatus(id, newStatus);
            toast.success(`Status → ${newStatus}`);
            loadJobs(offset);
            if (selectedJob?.id === id) refreshSelected(id);
        } catch (err) {
            toast.error('Status change failed', { description: err instanceof Error ? err.message : '' });
        }
    };

    const handleTagsChange = async (jobId: number, tagIds: number[]) => {
        try {
            const updated = await jobsApi.updateJobTags(jobId, tagIds);
            setJobs(prev => prev.map(j => j.id === jobId ? { ...j, tags: updated.tags } : j));
            if (selectedJob?.id === jobId) {
                setSelectedJob(prev => prev ? { ...prev, tags: updated.tags } : prev);
            }
        } catch (err) {
            toast.error('Failed to update tags', { description: err instanceof Error ? err.message : '' });
        }
    };

    const handleAddNote = async () => {
        if (!noteJobId || !noteText.trim()) return;
        try {
            await jobsApi.addJobNote(noteJobId, noteText.trim());
            toast.success('Note added');
            setNoteText('');
            setNoteJobId(null);
            if (selectedJob?.id === noteJobId) refreshSelected(noteJobId);
        } catch (err) {
            toast.error('Failed to add note', { description: err instanceof Error ? err.message : '' });
        }
    };

    // ─── Sort handler ────────────────────────────────────────────────
    const handleSortChange = (field: string, order: 'asc' | 'desc') => {
        setSortBy(field);
        setSortOrder(order);
    };

    // ─── CSV Export ──────────────────────────────────────────────────

    const handleExportCSV = async () => {
        if (filteredJobs.length === 0) return;
        setExporting(true);
        try {
            // Fetch ALL matching jobs from backend (no limit)
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

    // ─── Column config save ──────────────────────────────────────────

    const saveVisibleFields = async (fields: string[]) => {
        await jobsApi.saveJobsListFields(fields);
        setVisibleFields(fields);
    };

    // ─── Return ──────────────────────────────────────────────────────

    return {
        // Data
        jobs,
        filteredJobs,
        loading,
        selectedJob,
        detailLoading,
        totalCount,
        offset,
        hasMore,
        contactInfo,
        allTags,
        allColumns,
        allFieldKeys,
        visibleFields,
        exporting,
        limit: LIMIT,

        // Filters
        searchQuery, setSearchQuery,
        statusFilter, setStatusFilter,
        providerFilter, setProviderFilter,
        sourceFilter, setSourceFilter,
        jobTypeFilter, setJobTypeFilter,
        tagFilter, setTagFilter,
        onlyOpen, setOnlyOpen,
        startDate, setStartDate,
        endDate, setEndDate,

        // Sort
        sortBy,
        sortOrder,
        handleSortChange,

        // Note
        noteText, setNoteText,
        noteJobId, setNoteJobId,

        // Actions
        loadJobs,
        handleSelectJob,
        handleCloseDetail,
        handleCancel,
        handleMarkEnroute,
        handleMarkInProgress,
        handleMarkComplete,
        handleBlancStatusChange,
        handleTagsChange,
        handleAddNote,
        handleExportCSV,
        saveVisibleFields,
        navigate,
    };
}
