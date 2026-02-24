import { useState, useEffect, useCallback, useMemo } from 'react';
import { toast } from 'sonner';
import { useNavigate, useParams } from 'react-router-dom';
import { Button } from '../components/ui/button';
import { Label } from '../components/ui/label';
import { Separator } from '../components/ui/separator';
import {
    RefreshCw, ChevronLeft, ChevronRight, X, MapPin,
    User2, FileText, Play, CheckCircle2, Navigation, Ban,
    Loader2, Phone, Mail, Tag,
    Calendar, ChevronDown, CornerDownLeft, ArrowUpDown, ArrowUp, ArrowDown,
    Plus, CircleDot, SlidersHorizontal,
} from 'lucide-react';
import { authedFetch } from '../services/apiClient';
import * as jobsApi from '../services/jobsApi';
import * as contactsApi from '../services/contactsApi';
import type { LocalJob, JobsListParams, JobTag } from '../services/jobsApi';
import { formatPhone } from '../lib/formatPhone';
import {
    DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from '../components/ui/dropdown-menu';
import { ClickToCallButton } from '../components/softphone/ClickToCallButton';
import { JobsFilters } from '../components/jobs/JobsFilters';
import {
    Popover, PopoverContent, PopoverTrigger,
} from '../components/ui/popover';
import { Checkbox } from '../components/ui/checkbox';

// ─── Constants ───────────────────────────────────────────────────────────────

const BLANC_STATUSES = [
    'Submitted',
    'Waiting for parts',
    'Follow Up with Client',
    'Visit completed',
    'Job is Done',
    'Rescheduled',
    'Canceled',
];



// ─── Status helpers ──────────────────────────────────────────────────────────

const BLANC_STATUS_COLORS: Record<string, string> = {
    'Submitted': '#3B82F6',
    'Waiting for parts': '#F59E0B',
    'Follow Up with Client': '#8B5CF6',
    'Visit completed': '#22C55E',
    'Job is Done': '#6B7280',
    'Rescheduled': '#F97316',
    'Canceled': '#EF4444',
};

function getContrastText(hex: string): string {
    const c = hex.replace('#', '');
    const r = parseInt(c.substring(0, 2), 16);
    const g = parseInt(c.substring(2, 4), 16);
    const b = parseInt(c.substring(4, 6), 16);
    return (0.299 * r + 0.587 * g + 0.114 * b) / 255 > 0.6 ? '#000' : '#fff';
}

function TagBadge({ tag, small }: { tag: JobTag; small?: boolean }) {
    const textColor = getContrastText(tag.color);
    const isWhite = tag.color.toLowerCase() === '#ffffff' || tag.color.toLowerCase() === '#fff';
    return (
        <span
            className={`inline-flex items-center rounded-full font-medium ${small ? 'px-2.5 py-0.5 text-xs' : 'px-3 py-1 text-sm'}`}
            style={{
                backgroundColor: tag.color,
                color: textColor,
                border: isWhite ? '1px solid #d1d5db' : 'none',
            }}
        >
            {tag.name}
        </span>
    );
}

const ZB_STATUS_COLORS: Record<string, string> = {
    scheduled: 'bg-blue-50 text-blue-600 border border-blue-200',
    'en-route': 'bg-amber-50 text-amber-600 border border-amber-200',
    'in-progress': 'bg-green-50 text-green-600 border border-green-200',
    complete: 'bg-gray-50 text-gray-600 border border-gray-200',
};

function BlancBadge({ status }: { status: string }) {
    const dotColor = BLANC_STATUS_COLORS[status] || '#9CA3AF';
    return (
        <span className="inline-flex items-center gap-1.5 px-1 py-0.5 text-sm font-medium text-gray-700">
            <span className="shrink-0 rounded-full" style={{ backgroundColor: dotColor, width: 10, height: 10 }} />
            {status}
        </span>
    );
}

function ZbBadge({ status }: { status: string }) {
    const cls = ZB_STATUS_COLORS[status] || 'bg-gray-50 text-gray-500 border border-gray-200';
    return (
        <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium ${cls}`}>
            zb: {status}
        </span>
    );
}

function formatSchedule(startIso?: string | null, endIso?: string | null): { date: string; time: string } {
    if (!startIso) return { date: '—', time: '' };
    try {
        const start = new Date(startIso);
        const date = new Intl.DateTimeFormat('en-US', {
            weekday: 'long', month: 'short', day: 'numeric', year: 'numeric',
        }).format(start);
        const startTime = new Intl.DateTimeFormat('en-US', {
            hour: 'numeric', minute: '2-digit',
        }).format(start);
        if (endIso) {
            const end = new Date(endIso);
            const endTime = new Intl.DateTimeFormat('en-US', {
                hour: 'numeric', minute: '2-digit',
            }).format(end);
            return { date, time: `${startTime} - ${endTime}` };
        }
        return { date, time: startTime };
    } catch { return { date: startIso, time: '' }; }
}

// ─── Column Definitions ──────────────────────────────────────────────────────

interface ColumnDef {
    key: string;
    label: string;
    sortKey?: string;  // if sortable, which backend field to sort by
    width?: string;
    render: (job: LocalJob) => React.ReactNode;
}

const STATIC_COLUMNS: Record<string, ColumnDef> = {
    job_number: {
        key: 'job_number', label: '#', sortKey: 'job_number', width: 'w-20',
        render: (j) => <span className="font-mono text-xs text-muted-foreground">{j.job_number || '—'}</span>,
    },
    customer_name: {
        key: 'customer_name', label: 'Customer', sortKey: 'customer_name', width: 'w-48 max-w-[12rem]',
        render: (j) => (
            <div className="max-w-[12rem]">
                <div className="font-medium truncate">{j.customer_name || '—'}</div>
                {j.customer_phone && <div className="text-xs text-muted-foreground">{j.customer_phone}</div>}
            </div>
        ),
    },
    customer_phone: {
        key: 'customer_phone', label: 'Phone', sortKey: 'customer_phone',
        render: (j) => <span>{j.customer_phone || '—'}</span>,
    },
    customer_email: {
        key: 'customer_email', label: 'Email', sortKey: 'customer_email',
        render: (j) => <span className="truncate max-w-[10rem] block">{j.customer_email || '—'}</span>,
    },
    service_name: {
        key: 'service_name', label: 'Service', sortKey: 'service_name', width: 'w-40 max-w-[10rem]',
        render: (j) => <span className="truncate max-w-[10rem] block">{j.service_name || '—'}</span>,
    },
    blanc_status: {
        key: 'blanc_status', label: 'Status', sortKey: 'blanc_status',
        render: (j) => (
            <div className="flex flex-col gap-1">
                <BlancBadge status={j.blanc_status} />
                <ZbBadge status={j.zb_status} />
            </div>
        ),
    },
    zb_status: {
        key: 'zb_status', label: 'ZB Status', sortKey: 'zb_status',
        render: (j) => <ZbBadge status={j.zb_status} />,
    },
    tags: {
        key: 'tags', label: 'Tags',
        render: (j) => (
            <div className="flex flex-wrap gap-1" title={j.tags?.length ? j.tags.map((t: any) => t.name).join(', ') : ''}>
                {j.tags?.length ? j.tags.map((t: JobTag) => <TagBadge key={t.id} tag={t} small />) : <span className="text-xs text-muted-foreground">—</span>}
            </div>
        ),
    },
    assigned_techs: {
        key: 'assigned_techs', label: 'Techs',
        render: (j) => <span>{j.assigned_techs?.map((p: any) => p.name).join(', ') || '—'}</span>,
    },
    start_date: {
        key: 'start_date', label: 'Schedule', sortKey: 'start_date',
        render: (j) => {
            const s = formatSchedule(j.start_date, j.end_date);
            return <div className="text-xs"><div className="whitespace-nowrap">{s.date}</div>{s.time && <div className="text-muted-foreground whitespace-nowrap">{s.time}</div>}</div>;
        },
    },
    address: {
        key: 'address', label: 'Address', sortKey: 'address',
        render: (j) => <span className="line-clamp-2 text-xs">{j.address || '—'}</span>,
    },
    territory: {
        key: 'territory', label: 'Territory', sortKey: 'territory',
        render: (j) => <span className="line-clamp-2 text-xs">{j.territory || '—'}</span>,
    },
    invoice_total: {
        key: 'invoice_total', label: 'Invoice', sortKey: 'invoice_total',
        render: (j) => <span>{j.invoice_total != null ? `$${Number(j.invoice_total).toFixed(2)}` : '—'}</span>,
    },
    invoice_status: {
        key: 'invoice_status', label: 'Inv. Status', sortKey: 'invoice_status',
        render: (j) => <span>{j.invoice_status || '—'}</span>,
    },
    job_type: {
        key: 'job_type', label: 'Job Type', sortKey: 'job_type',
        render: (j) => <span>{j.job_type || '—'}</span>,
    },
    description: {
        key: 'description', label: 'Description', sortKey: 'description',
        render: (j) => <span className="line-clamp-2 text-xs">{j.description || '—'}</span>,
    },
    comments: {
        key: 'comments', label: 'Comments', sortKey: 'comments',
        render: (j) => <span className="line-clamp-2 text-xs">{j.comments || '—'}</span>,
    },
    job_source: {
        key: 'job_source', label: 'Source', sortKey: 'job_source',
        render: (j) => j.job_source ? (
            <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-muted">{j.job_source}</span>
        ) : <span className="text-xs text-muted-foreground">—</span>,
    },
    created_at: {
        key: 'created_at', label: 'Created', sortKey: 'created_at',
        render: (j) => <span className="text-xs whitespace-nowrap">{formatSchedule(j.created_at).date}</span>,
    },
    updated_at: {
        key: 'updated_at', label: 'Updated', sortKey: 'updated_at',
        render: (j) => <span className="text-xs whitespace-nowrap">{formatSchedule(j.updated_at).date}</span>,
    },
};

/** Build a dynamic column for a metadata custom field */
function makeMetaColumn(apiName: string, displayName: string): ColumnDef {
    return {
        key: `meta:${apiName}`,
        label: displayName,
        sortKey: `meta:${apiName}`,
        render: (j) => {
            const val = j.metadata?.[apiName];
            return <span className="line-clamp-2 text-xs">{val || '—'}</span>;
        },
    };
}

const STATIC_FIELD_KEYS = Object.keys(STATIC_COLUMNS);
const DEFAULT_VISIBLE_FIELDS = ['job_number', 'customer_name', 'service_name', 'blanc_status', 'tags', 'assigned_techs', 'start_date'];

// ─── Jobs Page ───────────────────────────────────────────────────────────────

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
    const LIMIT = 50;

    // Filters
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

    const handleSelectJob = async (job: LocalJob) => {
        setSelectedJob(job);
        setDetailLoading(true);
        setContactInfo(null);
        navigate(`/jobs/${job.id}`, { replace: true });
        try {
            const detail = await jobsApi.getJob(job.id);
            setSelectedJob(detail);
            // Fetch linked Blanc contact if available
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
                // Job not in current page — fetch directly
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

    // ---------- Actions ----------

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
            // Update local state
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
                <div className="flex-1 overflow-auto">
                    {loading ? (
                        <div className="flex items-center justify-center h-40 text-muted-foreground">
                            <Loader2 className="size-5 animate-spin mr-2" /> Loading jobs...
                        </div>
                    ) : jobs.length === 0 ? (
                        <div className="flex items-center justify-center h-40 text-muted-foreground">
                            No jobs found
                        </div>
                    ) : (
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
                                                onClick={() => {
                                                    if (!col.sortKey) return;
                                                    if (sortBy === col.sortKey) {
                                                        setSortOrder(prev => prev === 'asc' ? 'desc' : 'asc');
                                                    } else {
                                                        setSortBy(col.sortKey);
                                                        setSortOrder('asc');
                                                    }
                                                }}
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
                                {filteredJobs.map(job => (
                                    <tr
                                        key={job.id}
                                        className={`border-b hover:bg-muted/30 cursor-pointer transition-colors ${selectedJob?.id === job.id ? 'bg-muted/50' : ''}`}
                                        onClick={() => handleSelectJob(job)}
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
                    )}
                </div>

                {/* Pagination */}
                <div className="border-t px-4 py-2 flex items-center justify-between text-sm text-muted-foreground">
                    <span>{totalCount > 0 ? `${offset + 1}–${offset + jobs.length} from ${totalCount} jobs` : '0 jobs'}</span>
                    <div className="flex items-center gap-1">
                        <Button variant="ghost" size="sm" disabled={offset === 0} onClick={() => loadJobs(Math.max(0, offset - LIMIT))}>
                            <ChevronLeft className="size-4" />
                        </Button>
                        <Button variant="ghost" size="sm" disabled={!hasMore} onClick={() => loadJobs(offset + LIMIT)}>
                            <ChevronRight className="size-4" />
                        </Button>
                    </div>
                </div>
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
// ─── Metadata Section (reuses lead-form settings) ────────────────────────────

interface CustomFieldDef {
    id: string;
    display_name: string;
    api_name: string;
    field_type: string;
    is_system: boolean;
    sort_order: number;
}

function JobMetadataSection({ job }: { job: LocalJob }) {
    const [customFields, setCustomFields] = useState<CustomFieldDef[]>([]);

    useEffect(() => {
        authedFetch('/api/settings/lead-form')
            .then(r => r.json())
            .then(data => {
                if (data.success) {
                    setCustomFields(data.customFields.filter((f: CustomFieldDef) => !f.is_system));
                }
            })
            .catch(() => { });
    }, []);

    const meta = job.metadata || {};
    const hasAny = job.job_source || job.created_at || customFields.some(f => meta[f.api_name]);

    if (!hasAny) return null;

    return (
        <>
            <Separator />
            <div>
                <h4 className="font-medium mb-3">Metadata</h4>
                <div className="space-y-3">
                    {/* Source */}
                    {job.job_source && (
                        <div className="flex items-start gap-3">
                            <Tag className="size-4 shrink-0 text-muted-foreground" />
                            <div className="flex-1">
                                <Label className="text-xs text-muted-foreground">Source</Label>
                                <div className="text-sm font-medium mt-1">{job.job_source}</div>
                            </div>
                        </div>
                    )}

                    {/* Created */}
                    {job.created_at && (
                        <div className="flex items-start gap-3">
                            <Calendar className="size-4 shrink-0 text-muted-foreground" />
                            <div className="flex-1">
                                <Label className="text-xs text-muted-foreground">Created Date</Label>
                                <div className="text-sm font-medium mt-1">{formatSchedule(job.created_at).date}</div>
                            </div>
                        </div>
                    )}

                    {/* Custom fields from settings */}
                    {customFields.map(field => (
                        <div key={field.id} className="flex items-start gap-3">
                            <FileText className="size-4 shrink-0 text-muted-foreground" />
                            <div className="flex-1">
                                <Label className="text-xs text-muted-foreground">{field.display_name}</Label>
                                <div className="text-sm font-medium mt-1 whitespace-pre-wrap">
                                    {meta[field.api_name] || <span className="text-muted-foreground">N/A</span>}
                                </div>
                            </div>
                        </div>
                    ))}
                </div>
            </div>
        </>
    );
}

// ─── Job Detail Panel ────────────────────────────────────────────────────────

interface JobDetailPanelProps {
    job: LocalJob;
    contactInfo: { id: number; name: string; phone?: string; email?: string } | null;
    detailLoading: boolean;
    noteJobId: number | null;
    noteText: string;
    setNoteText: (v: string) => void;
    setNoteJobId: (v: number | null) => void;
    onClose: () => void;
    onBlancStatusChange: (id: number, s: string) => void;
    onAddNote: () => void;
    onMarkEnroute: (id: number) => void;
    onMarkInProgress: (id: number) => void;
    onMarkComplete: (id: number) => void;
    onCancel: (id: number) => void;
    navigate: (path: string) => void;
    allTags: JobTag[];
    onTagsChange: (jobId: number, tagIds: number[]) => void;
}

function JobDetailPanel({
    job, contactInfo, detailLoading,
    noteJobId, noteText, setNoteText, setNoteJobId,
    onClose, onBlancStatusChange, onAddNote,
    onMarkEnroute, onMarkInProgress, onMarkComplete, onCancel,
    navigate, allTags, onTagsChange,
}: JobDetailPanelProps) {
    const [comments, setComments] = useState(job.comments || '');
    const [isFocused, setIsFocused] = useState(false);
    const [isEditingComments, setIsEditingComments] = useState(false);
    const [showMobileNotes, setShowMobileNotes] = useState(false);

    useEffect(() => {
        setComments(job.comments || '');
        setIsEditingComments(false);
        setShowMobileNotes(false);
    }, [job.id]);

    const handleSaveComments = async () => {
        setIsFocused(false);
        if (!comments.trim()) setIsEditingComments(false);
        // TODO: save comments via API when endpoint exists
    };

    // ── Shared sub-components ──

    const renderDescription = () => (
        <div>
            <h3 className="text-sm font-semibold text-muted-foreground mb-3">Description</h3>
            <div className="p-3 bg-muted rounded-lg">
                <p className="text-sm whitespace-pre-wrap">{job.description || 'No description'}</p>
            </div>
        </div>
    );

    const renderComments = () => (
        <div>
            <h3 className="text-sm font-semibold text-muted-foreground mb-3">Comments</h3>
            {(comments.trim() || isEditingComments) ? (
                <div className="relative bg-rose-50 rounded-lg border border-rose-100 py-1 px-2">
                    <textarea
                        ref={el => { if (el) { el.style.height = 'auto'; el.style.height = `${el.scrollHeight}px`; } }}
                        className="w-full text-sm resize-none bg-transparent border-none outline-none min-h-[24px] pr-16 leading-6"
                        value={comments}
                        onChange={e => setComments(e.target.value)}
                        onFocus={() => setIsFocused(true)}
                        onBlur={handleSaveComments}
                        onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSaveComments(); } }}
                        placeholder="Add comments..."
                        rows={1}
                        autoFocus={isEditingComments}
                        style={{ height: 'auto', minHeight: '24px' }}
                        onInput={e => { const t = e.target as HTMLTextAreaElement; t.style.height = 'auto'; t.style.height = `${t.scrollHeight}px`; }}
                    />
                    {isFocused && (
                        <Button size="sm" className="absolute top-1 right-1.5 h-6 px-2 text-xs"
                            onMouseDown={e => e.preventDefault()} onClick={handleSaveComments}>
                            <CornerDownLeft className="size-3 mr-1" /> Enter
                        </Button>
                    )}
                </div>
            ) : (
                <button onClick={() => { setIsEditingComments(true); setIsFocused(true); }}
                    className="text-sm text-muted-foreground hover:text-foreground transition-colors underline decoration-dashed decoration-1 underline-offset-4">
                    + Add comment
                </button>
            )}
        </div>
    );

    const renderNotes = () => (
        <div>
            <h3 className="text-sm font-semibold text-muted-foreground mb-3">
                Job Notes ({job.notes?.length || 0})
            </h3>
            <div className="space-y-3">
                {job.notes && job.notes.length > 0 ? job.notes.map((note: any, i: number) => (
                    <div key={note.id || i} className="p-3 bg-muted rounded-lg space-y-2">
                        {note.text && <p className="text-sm whitespace-pre-wrap">{note.text}</p>}
                        {note.images && note.images.length > 0 && (
                            <div className="flex flex-wrap gap-2">
                                {note.images.map((url: string, j: number) => (
                                    <a key={j} href={url} target="_blank" rel="noopener noreferrer">
                                        <img
                                            src={url}
                                            alt={`Note image ${j + 1}`}
                                            className="w-24 h-24 object-cover rounded-md border hover:opacity-80 transition-opacity"
                                        />
                                    </a>
                                ))}
                            </div>
                        )}
                        {note.files && note.files.length > 0 && (
                            <div className="flex flex-wrap gap-2">
                                {note.files.map((url: string, j: number) => (
                                    <a key={j} href={url} target="_blank" rel="noopener noreferrer"
                                        className="text-xs text-primary hover:underline">
                                        📎 File {j + 1}
                                    </a>
                                ))}
                            </div>
                        )}
                        {note.created && (
                            <p className="text-xs text-muted-foreground">{formatSchedule(note.created).date}</p>
                        )}
                        {!note.text && (!note.images || note.images.length === 0) && (
                            <p className="text-xs text-muted-foreground italic">Empty note</p>
                        )}
                    </div>
                )) : (
                    <p className="text-sm text-muted-foreground">No notes yet</p>
                )}
            </div>
        </div>
    );

    const renderAddNote = () => (
        <div className="border-t bg-background p-4 space-y-3">
            <textarea
                className="w-full border rounded-md px-3 py-2 text-sm resize-none min-h-[80px]"
                placeholder="Write a note..."
                value={noteJobId === job.id ? noteText : ''}
                onChange={e => { setNoteJobId(job.id); setNoteText(e.target.value); }}
                onFocus={() => { if (noteJobId !== job.id) setNoteJobId(job.id); }}
                onKeyDown={e => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); onAddNote(); } }}
            />
            <div className="flex items-center justify-between">
                <p className="text-xs text-muted-foreground">⌘ + Enter to submit</p>
                <Button size="sm" onClick={onAddNote} disabled={!noteText.trim() || noteJobId !== job.id}>
                    <Plus className="size-4 mr-1" /> Add Note
                </Button>
            </div>
        </div>
    );


    return (
        <div className="flex-1 flex flex-col md:flex-row overflow-hidden">
            {/* ═══ LEFT COLUMN ═══ */}
            <div className="w-full md:w-1/2 flex flex-col overflow-hidden border-l">
                {/* Blue gradient header */}
                <div className="bg-gradient-to-r from-blue-500 to-blue-600 p-5 text-white group/header">
                    {/* First line: Service name + close/back */}
                    <div className="flex items-center justify-between mb-2">
                        <Button variant="ghost" size="sm" className="md:hidden text-white hover:bg-white/20" onClick={onClose}>
                            ← Back
                        </Button>
                        <h2 className="text-2xl font-bold hidden md:flex items-center gap-2">
                            {job.zenbooker_job_id ? (
                                <a
                                    href={`https://zenbooker.com/app?view=jobs&view-job=${job.zenbooker_job_id}`}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="font-mono text-blue-100 hover:text-white hover:underline"
                                    onClick={(e) => e.stopPropagation()}
                                >
                                    #{job.job_number || job.id}
                                </a>
                            ) : (
                                <span className="font-mono text-blue-100">#{job.job_number || job.id}</span>
                            )}
                            {job.service_name || 'Job'}
                        </h2>
                        <div className="flex items-center gap-1 ml-auto">
                            <Button variant="ghost" size="sm"
                                className="md:hidden text-white hover:bg-white/20"
                                onClick={() => setShowMobileNotes(!showMobileNotes)}>
                                <FileText className="size-4 mr-1" /> Notes
                            </Button>
                            <Button variant="ghost" size="sm"
                                className="text-white hover:bg-white/20 opacity-0 group-hover/header:opacity-100 transition-opacity hidden md:inline-flex"
                                onClick={onClose}>
                                <X className="size-4" />
                            </Button>
                        </div>
                    </div>
                    {/* Mobile title */}
                    <h2 className="text-2xl font-bold mb-2 md:hidden">{job.service_name || 'Job'}</h2>

                    <p className="text-blue-100 flex items-center gap-2">
                        {contactInfo ? (
                            <span
                                className="hover:text-white hover:underline cursor-pointer transition-colors"
                                onClick={() => navigate(`/contacts/${contactInfo.id}`)}
                            >
                                {contactInfo.name}
                            </span>
                        ) : (
                            job.customer_name || '—'
                        )}
                        {job.job_source && (
                            <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-white/20 text-white">
                                {job.job_source}
                            </span>
                        )}
                    </p>
                </div>

                {/* Action buttons bar */}
                {!job.zb_canceled && (
                    <div className="flex items-center gap-2 px-4 py-3 border-b bg-background">
                        {job.zb_status === 'en-route' && (
                            <Button variant="outline" size="default" className="gap-2 opacity-50 cursor-default" disabled>
                                <Navigation className="size-4" />
                                <span className="hidden sm:inline">En-route</span>
                            </Button>
                        )}
                        {job.zb_status === 'scheduled' && (
                            <Button variant="outline" size="default" className="gap-2"
                                onClick={() => onMarkEnroute(job.id)}>
                                <Navigation className="size-4" />
                                <span className="hidden sm:inline">En-route</span>
                            </Button>
                        )}
                        {(job.zb_status === 'scheduled' || job.zb_status === 'en-route') && (
                            <Button size="default" className="gap-2 flex-1 bg-orange-500 hover:bg-orange-600 text-white"
                                onClick={() => onMarkInProgress(job.id)}>
                                <Play className="size-4" />
                                Start Job
                            </Button>
                        )}
                        {job.zb_status === 'in-progress' && (
                            <Button variant="outline" size="default" className="gap-2 opacity-50 cursor-default" disabled>
                                <Play className="size-4" />
                                <span className="hidden sm:inline">In Progress</span>
                            </Button>
                        )}
                        {(job.zb_status === 'in-progress' || job.zb_status === 'en-route' || job.zb_status === 'scheduled') && (
                            <Button variant="outline" size="default" className="gap-2"
                                onClick={() => onMarkComplete(job.id)}>
                                <CheckCircle2 className="size-4" />
                                <span className="hidden sm:inline">Complete</span>
                            </Button>
                        )}
                        {job.zb_status !== 'complete' && (
                            <Button variant="destructive" size="sm" className="gap-1 ml-auto"
                                onClick={() => onCancel(job.id)}>
                                <Ban className="size-3.5" />
                            </Button>
                        )}
                    </div>
                )}

                {/* Scrollable content */}
                {detailLoading ? (
                    <div className="flex-1 flex items-center justify-center text-muted-foreground">
                        <Loader2 className="size-5 animate-spin mr-2" /> Loading...
                    </div>
                ) : (
                    <div className="flex-1 overflow-y-auto p-6 space-y-6">
                        {/* ── Schedule ── */}
                        <div>
                            <h3 className="text-sm font-semibold text-muted-foreground mb-3">Schedule</h3>
                            <div className="space-y-3">
                                <div className="flex items-center gap-3">
                                    <div className="size-10 rounded-lg bg-muted flex items-center justify-center">
                                        <Calendar className="size-5 text-muted-foreground" />
                                    </div>
                                    <div>
                                        <p className="text-xs text-muted-foreground">Date & Time</p>
                                        {job.start_date ? (
                                            <>
                                                <p className="font-medium">
                                                    {new Date(job.start_date).toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric', year: 'numeric' })}
                                                </p>
                                                <p className="text-sm text-muted-foreground">
                                                    {new Date(job.start_date).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true })}
                                                    {job.end_date && ` - ${new Date(job.end_date).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true })}`}
                                                </p>
                                            </>
                                        ) : (
                                            <p className="font-medium text-muted-foreground">Not scheduled</p>
                                        )}
                                    </div>
                                </div>

                                {(job.address || job.territory) && (
                                    <div className="flex items-start gap-3">
                                        <div className="size-10 rounded-lg bg-muted flex items-center justify-center">
                                            <MapPin className="size-5 text-muted-foreground" />
                                        </div>
                                        <div>
                                            <p className="text-xs text-muted-foreground">
                                                Service Area{job.territory ? `: ${job.territory}` : ''}
                                            </p>
                                            {job.address && <p className="font-medium">{job.address}</p>}
                                        </div>
                                    </div>
                                )}
                            </div>
                        </div>

                        {/* ── Assigned Providers ── */}
                        <div>
                            <h3 className="text-sm font-semibold text-muted-foreground mb-3">Assigned Providers</h3>
                            {job.assigned_techs && job.assigned_techs.length > 0 ? (
                                <div className="space-y-2">
                                    {job.assigned_techs.map((p: any) => (
                                        <div key={p.id} className="flex items-center gap-3 p-3 bg-muted rounded-lg">
                                            <div className="size-10 rounded-full bg-primary/10 flex items-center justify-center">
                                                <User2 className="size-5 text-primary" />
                                            </div>
                                            <div className="flex-1">
                                                <p className="font-medium">{p.name}</p>
                                            </div>
                                        </div>
                                    ))}
                                </div>
                            ) : (
                                <div className="text-sm text-muted-foreground">No providers assigned</div>
                            )}
                        </div>

                        {/* ── Customer ── */}
                        <div>
                            <h3 className="text-sm font-semibold text-muted-foreground mb-3">Customer</h3>
                            <div className="space-y-3">
                                {(contactInfo?.email || job.customer_email) && (
                                    <div className="flex items-center gap-3">
                                        <div className="size-10 rounded-lg bg-muted flex items-center justify-center">
                                            <Mail className="size-5 text-muted-foreground" />
                                        </div>
                                        <div>
                                            <p className="text-xs text-muted-foreground">Email</p>
                                            <p className="font-medium">
                                                <a href={`mailto:${contactInfo?.email || job.customer_email}`}
                                                    className="text-foreground no-underline hover:underline">
                                                    {contactInfo?.email || job.customer_email}
                                                </a>
                                            </p>
                                        </div>
                                    </div>
                                )}
                                {(contactInfo?.phone || job.customer_phone) && (
                                    <div className="flex items-center gap-3">
                                        <div className="size-10 rounded-lg bg-muted flex items-center justify-center">
                                            <Phone className="size-5 text-muted-foreground" />
                                        </div>
                                        <div>
                                            <p className="text-xs text-muted-foreground">Phone</p>
                                            <div className="flex items-center gap-1">
                                                <a href={`tel:${contactInfo?.phone || job.customer_phone}`}
                                                    className="font-medium text-foreground no-underline hover:underline">
                                                    {formatPhone(contactInfo?.phone || job.customer_phone)}
                                                </a>
                                                <ClickToCallButton
                                                    phone={contactInfo?.phone || job.customer_phone || ''}
                                                    contactName={contactInfo?.name || job.customer_name || undefined}
                                                />
                                            </div>
                                        </div>
                                    </div>
                                )}
                            </div>
                        </div>

                        {/* ── Invoice ── */}
                        {job.invoice_total && (
                            <div>
                                <h3 className="text-sm font-semibold text-muted-foreground mb-3">Invoice</h3>
                                <div className="border rounded-lg p-4 space-y-3">
                                    <div className="flex items-center justify-between">
                                        <span className="font-semibold">Total</span>
                                        <span className="text-xl font-bold">${job.invoice_total}</span>
                                    </div>
                                    {job.invoice_status && (
                                        <div className="flex items-center justify-between">
                                            <span className="text-sm text-muted-foreground">Status</span>
                                            <span className="text-xs px-2 py-0.5 rounded-md bg-secondary">{job.invoice_status}</span>
                                        </div>
                                    )}
                                </div>
                            </div>
                        )}


                        {/* ── Mobile-only: Description, Comments, Metadata, Notes ── */}
                        <div className="md:hidden space-y-6">
                            <Separator />
                            {renderDescription()}
                            {renderComments()}
                            <JobMetadataSection job={job} />
                            {renderNotes()}
                            <div className="space-y-2">
                                <textarea
                                    className="w-full border rounded-md px-3 py-2 text-sm resize-none min-h-[60px]"
                                    placeholder="Write a note..."
                                    value={noteJobId === job.id ? noteText : ''}
                                    onChange={e => { setNoteJobId(job.id); setNoteText(e.target.value); }}
                                    onFocus={() => { if (noteJobId !== job.id) setNoteJobId(job.id); }}
                                />
                                <Button size="sm" onClick={onAddNote} disabled={!noteText.trim() || noteJobId !== job.id}>
                                    <Plus className="size-4 mr-1" /> Add Note
                                </Button>
                            </div>
                        </div>
                    </div>
                )}
            </div>

            {/* ═══ RIGHT COLUMN (desktop only) ═══ */}
            <div className="w-full md:w-1/2 flex-col overflow-hidden border-l hidden md:flex">
                <div className="border-b p-4 flex items-center justify-between">
                    <h3 className="text-lg font-semibold">Details and Notes</h3>
                </div>

                {/* Status row */}
                <div className="flex items-center gap-2 px-4 py-3">
                    <CircleDot className="size-4 text-muted-foreground shrink-0" />
                    <span className="text-sm text-muted-foreground font-medium shrink-0">Status:</span>
                    <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                            <button className="inline-flex items-center gap-1 focus:outline-none rounded-sm">
                                <BlancBadge status={job.blanc_status} />
                                <ChevronDown className="size-3 text-muted-foreground" />
                            </button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="start">
                            {BLANC_STATUSES.map(s => (
                                <DropdownMenuItem
                                    key={s}
                                    onClick={() => onBlancStatusChange(job.id, s)}
                                    className={s === job.blanc_status ? 'bg-accent' : ''}
                                >
                                    {s}
                                </DropdownMenuItem>
                            ))}
                        </DropdownMenuContent>
                    </DropdownMenu>
                    {job.zb_status && <ZbBadge status={job.zb_status} />}
                </div>

                {/* Tag selector */}
                <div className="flex items-center gap-2 px-4 py-3 flex-wrap">
                    <Tag className="size-4 text-muted-foreground shrink-0" />
                    <span className="text-sm text-muted-foreground font-medium shrink-0">Tags:</span>
                    {job.tags && job.tags.length > 0 && job.tags.map((t: JobTag) => (
                        <button
                            key={t.id}
                            onClick={() => {
                                const newIds = (job.tags || []).filter(x => x.id !== t.id).map(x => x.id);
                                onTagsChange(job.id, newIds);
                            }}
                            className="group relative"
                            title={`Remove "${t.name}"`}
                        >
                            <TagBadge tag={t} />
                            <span className="absolute -top-1.5 -right-1.5 size-4 bg-destructive text-white rounded-full text-[9px] leading-4 text-center hidden group-hover:block">×</span>
                        </button>
                    ))}
                    <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                            <button className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-xs text-muted-foreground hover:bg-muted transition-colors">
                                <Plus className="size-3" /> Add
                            </button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="start" className="w-56 max-h-72 overflow-y-auto p-1">
                            {(() => {
                                const assignedIds = new Set((job.tags || []).map(t => t.id));
                                const activeTags = allTags.filter(t => t.is_active);
                                const inactiveAssigned = allTags.filter(t => !t.is_active && assignedIds.has(t.id));
                                const combined = [...activeTags, ...inactiveAssigned];
                                return combined.map(t => {
                                    const isAssigned = assignedIds.has(t.id);
                                    const isInactive = !t.is_active;
                                    return (
                                        <DropdownMenuItem
                                            key={t.id}
                                            disabled={isInactive && !isAssigned}
                                            onClick={() => {
                                                if (isInactive && !isAssigned) return;
                                                const currentIds = (job.tags || []).map(x => x.id);
                                                const newIds = isAssigned
                                                    ? currentIds.filter(id => id !== t.id)
                                                    : [...currentIds, t.id];
                                                onTagsChange(job.id, newIds);
                                            }}
                                        >
                                            <span className="flex items-center gap-2 w-full">
                                                <span
                                                    className={`size-3 rounded-full shrink-0 ${isInactive ? 'opacity-40' : ''}`}
                                                    style={{ backgroundColor: t.color }}
                                                />
                                                <span className={`flex-1 ${isInactive ? 'text-muted-foreground' : ''}`}>
                                                    {t.name}
                                                    {isInactive && <span className="text-[10px] ml-1 text-muted-foreground">(Archived)</span>}
                                                </span>
                                                {isAssigned && <CheckCircle2 className="size-3.5 text-primary" />}
                                            </span>
                                        </DropdownMenuItem>
                                    );
                                });
                            })()}
                        </DropdownMenuContent>
                    </DropdownMenu>
                </div>

                <div className="flex-1 overflow-y-auto p-4 space-y-6">
                    {renderDescription()}
                    {renderComments()}
                    <JobMetadataSection job={job} />
                    {renderNotes()}
                </div>

                {renderAddNote()}
            </div>
        </div>
    );
}


export default JobsPage;
