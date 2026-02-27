import { useState, useEffect, useCallback, useMemo } from 'react';
import { toast } from 'sonner';
import { useNavigate, useParams } from 'react-router-dom';
import { Button } from '../components/ui/button';
import { Separator } from '../components/ui/separator';
import {
    RefreshCw, Loader2, ArrowUp, ArrowDown,
    SlidersHorizontal,
} from 'lucide-react';
import { authedFetch } from '../services/apiClient';
import * as jobsApi from '../services/jobsApi';
import * as contactsApi from '../services/contactsApi';
import type { LocalJob, JobsListParams, JobTag } from '../services/jobsApi';
import { JobsFilters } from '../components/jobs/JobsFilters';
import { JobsTable } from '../components/jobs/JobsTable';
import { JobDetailPanel } from '../components/jobs/JobDetailPanel';
import {
    STATIC_COLUMNS, STATIC_FIELD_KEYS, DEFAULT_VISIBLE_FIELDS,
    makeMetaColumn, type ColumnDef,
} from '../components/jobs/jobHelpers';
import {
    Popover, PopoverContent, PopoverTrigger,
} from '../components/ui/popover';
import { Checkbox } from '../components/ui/checkbox';

// ─── Jobs Page ───────────────────────────────────────────────────────────────

const LIMIT = 50;

export function JobsPage() {
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

    // Tag catalog
    const [allTags, setAllTags] = useState<JobTag[]>([]);

    // Sort
    const [sortBy, setSortBy] = useState<string>('created_at');
    const [sortOrder, setSortOrder] = useState<'asc' | 'desc'>('desc');

    // Contact info for detail panel
    const [contactInfo, setContactInfo] = useState<{ name: string; phone: string; email: string; id: number } | null>(null);

    // Column config
    const [visibleFields, setVisibleFields] = useState<string[]>(DEFAULT_VISIBLE_FIELDS);
    const [fieldsOpen, setFieldsOpen] = useState(false);
    const [pendingFields, setPendingFields] = useState<string[]>([]);
    const [savingFields, setSavingFields] = useState(false);

    // Custom fields for dynamic metadata columns
    const [customFields, setCustomFields] = useState<Array<{ api_name: string; display_name: string; is_system: boolean }>>([]);

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
    }, [searchQuery, sortBy, sortOrder, onlyOpen, startDate, statusFilter, jobTypeFilter, providerFilter, tagFilter]);

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

    // Client-side filtering (only for filters not yet supported server-side)
    const filteredJobs = useMemo(() => {
        let result = jobs;
        if (sourceFilter.length > 0) {
            result = result.filter(j => j.job_source && sourceFilter.includes(j.job_source));
        }
        return result;
    }, [jobs, sourceFilter]);

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

    // ─── Note ────────────────────────────────────────────────────────
    const [noteText, setNoteText] = useState('');
    const [noteJobId, setNoteJobId] = useState<number | null>(null);

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

    // ─── Render ──────────────────────────────────────────────────────

    return (
        <div className="flex h-full overflow-hidden">
            {/* ── Left: Jobs List ─────────────────────────────────────── */}
            <div className={`flex flex-col border-r overflow-hidden ${selectedJob ? 'hidden md:flex md:w-[340px] md:flex-shrink-0' : 'flex flex-1'}`}>
                {/* Filters */}
                <div className="border-b p-4 space-y-3">
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
                                                await jobsApi.saveJobsListFields(pendingFields);
                                                setVisibleFields(pendingFields);
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
                            <Button variant="outline" size="sm" onClick={() => loadJobs(offset)} disabled={loading}>
                                <RefreshCw className={`size-4 mr-1 ${loading ? 'animate-spin' : ''}`} />
                                Refresh
                            </Button>
                        </div>
                    </div>
                    <JobsFilters
                        searchQuery={searchQuery}
                        onSearchChange={setSearchQuery}
                        statusFilter={statusFilter}
                        onStatusFilterChange={setStatusFilter}
                        providerFilter={providerFilter}
                        onProviderFilterChange={setProviderFilter}
                        sourceFilter={sourceFilter}
                        onSourceFilterChange={setSourceFilter}
                        jobTypeFilter={jobTypeFilter}
                        onJobTypeFilterChange={setJobTypeFilter}
                        startDate={startDate}
                        onStartDateChange={setStartDate}
                        onlyOpen={onlyOpen}
                        onOnlyOpenChange={setOnlyOpen}
                        tagFilter={tagFilter}
                        onTagFilterChange={setTagFilter}
                        allTags={allTags}
                        jobs={jobs}
                    />
                </div>

                {/* Table */}
                <JobsTable
                    jobs={filteredJobs}
                    loading={loading}
                    selectedJobId={selectedJob?.id}
                    visibleFields={visibleFields}
                    allColumns={allColumns}
                    sortBy={sortBy}
                    sortOrder={sortOrder}
                    onSortChange={handleSortChange}
                    onSelectJob={handleSelectJob}
                    offset={offset}
                    totalCount={totalCount}
                    hasMore={hasMore}
                    limit={LIMIT}
                    onLoadJobs={loadJobs}
                />
            </div>

            {/* ── Right: Detail Panel ─────────────────────────────────── */}
            {selectedJob && (
                <JobDetailPanel
                    job={selectedJob}
                    contactInfo={contactInfo}
                    detailLoading={detailLoading}
                    noteJobId={noteJobId}
                    noteText={noteText}
                    setNoteText={setNoteText}
                    setNoteJobId={setNoteJobId}
                    onClose={handleCloseDetail}
                    onBlancStatusChange={handleBlancStatusChange}
                    onAddNote={handleAddNote}
                    onMarkEnroute={handleMarkEnroute}
                    onMarkInProgress={handleMarkInProgress}
                    onMarkComplete={handleMarkComplete}
                    onCancel={handleCancel}
                    navigate={navigate}
                    allTags={allTags}
                    onTagsChange={handleTagsChange}
                />
            )}
        </div>
    );
}

export default JobsPage;
