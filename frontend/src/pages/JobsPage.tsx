import { useState, useEffect, useCallback } from 'react';
import { toast } from 'sonner';
import { useNavigate, useParams } from 'react-router-dom';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { Label } from '../components/ui/label';
import { Separator } from '../components/ui/separator';
import {
    Search, RefreshCw, ChevronLeft, ChevronRight, X, MapPin,
    User2, FileText, Play, CheckCircle2, Navigation, Ban,
    Loader2, StickyNote, CalendarClock, Phone, Mail, Tag, Briefcase,
    Calendar, ChevronDown, CornerDownLeft, ArrowUpDown, ArrowUp, ArrowDown,
} from 'lucide-react';
import { authedFetch } from '../services/apiClient';
import * as jobsApi from '../services/jobsApi';
import * as contactsApi from '../services/contactsApi';
import type { LocalJob, JobsListParams } from '../services/jobsApi';
import { formatPhone } from '../lib/formatPhone';
import {
    DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from '../components/ui/dropdown-menu';

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

const ALLOWED_TRANSITIONS: Record<string, string[]> = {
    'Submitted': ['Follow Up with Client', 'Waiting for parts', 'Canceled'],
    'Waiting for parts': ['Submitted', 'Follow Up with Client', 'Canceled'],
    'Follow Up with Client': ['Waiting for parts', 'Submitted', 'Canceled'],
    'Visit completed': ['Follow Up with Client', 'Job is Done', 'Canceled'],
    'Job is Done': ['Canceled'],
    'Rescheduled': ['Submitted', 'Canceled'],
    'Canceled': [],
};

// ─── Status helpers ──────────────────────────────────────────────────────────

const BLANC_STATUS_COLORS: Record<string, string> = {
    'Submitted': 'bg-blue-100 text-blue-800',
    'Waiting for parts': 'bg-amber-100 text-amber-800',
    'Follow Up with Client': 'bg-purple-100 text-purple-800',
    'Visit completed': 'bg-green-100 text-green-700',
    'Job is Done': 'bg-gray-200 text-gray-700',
    'Rescheduled': 'bg-orange-100 text-orange-800',
    'Canceled': 'bg-red-100 text-red-700',
};

const ZB_STATUS_COLORS: Record<string, string> = {
    scheduled: 'bg-blue-50 text-blue-600 border border-blue-200',
    'en-route': 'bg-amber-50 text-amber-600 border border-amber-200',
    'in-progress': 'bg-green-50 text-green-600 border border-green-200',
    complete: 'bg-gray-50 text-gray-600 border border-gray-200',
};

function BlancBadge({ status }: { status: string }) {
    const cls = BLANC_STATUS_COLORS[status] || 'bg-gray-100 text-gray-500';
    return (
        <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${cls}`}>
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

function formatDate(iso?: string | null): string {
    if (!iso) return '—';
    try {
        return new Intl.DateTimeFormat('en-US', {
            month: 'short', day: 'numeric', year: 'numeric',
            hour: 'numeric', minute: '2-digit',
        }).format(new Date(iso));
    } catch { return iso; }
}

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
    const [statusFilter, setStatusFilter] = useState<string>('');
    const [offset, setOffset] = useState(0);
    const [hasMore, setHasMore] = useState(false);
    const LIMIT = 50;

    // Sort
    const [sortBy, setSortBy] = useState<string>('created_at');
    const [sortOrder, setSortOrder] = useState<'asc' | 'desc'>('desc');

    // Contact info for detail panel
    const [contactInfo, setContactInfo] = useState<{ name: string; phone: string; email: string; id: number } | null>(null);

    const loadJobs = useCallback(async (newOffset = 0) => {
        setLoading(true);
        try {
            const params: JobsListParams = {
                limit: LIMIT,
                offset: newOffset,
            };
            if (statusFilter) params.blanc_status = statusFilter;
            if (searchQuery.trim()) params.search = searchQuery.trim();
            if (sortBy) params.sort_by = sortBy;
            if (sortOrder) params.sort_order = sortOrder;

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
    }, [statusFilter, searchQuery, sortBy, sortOrder]);

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
            <div className={`flex-1 flex flex-col border-r overflow-hidden ${selectedJob ? 'hidden md:flex' : 'flex'}`}>
                {/* Filters */}
                <div className="border-b p-4 space-y-3">
                    <div className="flex items-center justify-between">
                        <h2 className="text-xl font-semibold">Jobs</h2>
                        <Button variant="outline" size="sm" onClick={() => loadJobs(offset)} disabled={loading}>
                            <RefreshCw className={`size-4 mr-1 ${loading ? 'animate-spin' : ''}`} />
                            Refresh
                        </Button>
                    </div>
                    <div className="flex items-center gap-2">
                        <div className="relative flex-1">
                            <Search className="absolute left-2.5 top-2.5 size-4 text-muted-foreground" />
                            <Input
                                placeholder="Search jobs..."
                                value={searchQuery}
                                onChange={e => setSearchQuery(e.target.value)}
                                className="pl-9"
                            />
                        </div>
                        <select
                            value={statusFilter}
                            onChange={e => setStatusFilter(e.target.value)}
                            className="border rounded-md px-3 py-2 text-sm bg-white"
                        >
                            <option value="">All statuses</option>
                            {BLANC_STATUSES.map(s => (
                                <option key={s} value={s}>{s}</option>
                            ))}
                        </select>
                    </div>
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
                                    {[
                                        { key: 'job_number', label: '#' },
                                        { key: 'customer_name', label: 'Customer' },
                                        { key: 'service_name', label: 'Service' },
                                        { key: 'start_date', label: 'Date' },
                                        { key: 'blanc_status', label: 'Status' },
                                        { key: '', label: 'Techs' },
                                    ].map(col => (
                                        <th
                                            key={col.label}
                                            className={`px-4 py-2.5 font-medium ${col.key ? 'cursor-pointer select-none hover:bg-muted/30 transition-colors' : ''}`}
                                            onClick={() => {
                                                if (!col.key) return;
                                                if (sortBy === col.key) {
                                                    setSortOrder(prev => prev === 'asc' ? 'desc' : 'asc');
                                                } else {
                                                    setSortBy(col.key);
                                                    setSortOrder('asc');
                                                }
                                            }}
                                        >
                                            <span className="inline-flex items-center gap-1">
                                                {col.label}
                                                {col.key && (
                                                    sortBy === col.key
                                                        ? (sortOrder === 'asc'
                                                            ? <ArrowUp className="size-3.5 text-primary" />
                                                            : <ArrowDown className="size-3.5 text-primary" />)
                                                        : <ArrowUpDown className="size-3.5 text-muted-foreground/40" />
                                                )}
                                            </span>
                                        </th>
                                    ))}
                                </tr>
                            </thead>
                            <tbody>
                                {jobs.map(job => (
                                    <tr
                                        key={job.id}
                                        className={`border-b hover:bg-muted/30 cursor-pointer transition-colors ${selectedJob?.id === job.id ? 'bg-muted/50' : ''
                                            }`}
                                        onClick={() => handleSelectJob(job)}
                                    >
                                        <td className="px-4 py-2.5 font-mono text-xs text-muted-foreground">
                                            {job.job_number || '—'}
                                        </td>
                                        <td className="px-4 py-2.5">
                                            <div className="font-medium">{job.customer_name || '—'}</div>
                                            {job.customer_phone && (
                                                <div className="text-xs text-muted-foreground">{job.customer_phone}</div>
                                            )}
                                        </td>
                                        <td className="px-4 py-2.5">{job.service_name || '—'}</td>
                                        <td className="px-4 py-2.5 text-xs">{formatDate(job.start_date)}</td>
                                        <td className="px-4 py-2.5">
                                            <div className="flex flex-col gap-1">
                                                <BlancBadge status={job.blanc_status} />
                                                <ZbBadge status={job.zb_status} />
                                            </div>
                                        </td>
                                        <td className="px-4 py-2.5 text-xs text-muted-foreground">
                                            {job.assigned_techs?.map((p: any) => p.name).join(', ') || '—'}
                                        </td>
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
                                <div className="text-sm font-medium mt-1">{formatDate(job.created_at)}</div>
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
}

function JobDetailPanel({
    job, contactInfo, detailLoading,
    noteJobId, noteText, setNoteText, setNoteJobId,
    onClose, onBlancStatusChange, onAddNote,
    onMarkEnroute, onMarkInProgress, onMarkComplete, onCancel,
    navigate,
}: JobDetailPanelProps) {
    const [comments, setComments] = useState(job.comments || '');
    const [isFocused, setIsFocused] = useState(false);
    const [isEditingComments, setIsEditingComments] = useState(false);

    useEffect(() => {
        setComments(job.comments || '');
        setIsEditingComments(false);
    }, [job.id]);

    const handleSaveComments = async () => {
        setIsFocused(false);
        if (!comments.trim()) setIsEditingComments(false);
        // TODO: save comments via API when endpoint exists
    };

    return (
        <div className="w-full md:w-[440px] flex flex-col border-l bg-white overflow-hidden">
            {/* ── Header ── */}
            <div className="p-4 border-b">
                <div className="flex items-start justify-between mb-3">
                    <div className="flex-1">
                        <h3 className="font-semibold text-lg">
                            {contactInfo?.name || job.customer_name || `Job #${job.job_number || job.id}`}
                        </h3>
                    </div>
                    <Button variant="ghost" size="sm" onClick={onClose}>
                        <X className="size-4" />
                    </Button>
                </div>

                <div className="flex items-center gap-2 flex-wrap">
                    {/* Blanc status badge dropdown */}
                    <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                            <button className="inline-flex items-center gap-1 focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 rounded-sm">
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

                    {/* ZB status */}
                    {job.zb_status && <ZbBadge status={job.zb_status} />}

                    {/* Source badge */}
                    {job.job_source && (
                        <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium border bg-background">
                            {job.job_source}
                        </span>
                    )}

                    <span className="text-xs text-muted-foreground font-mono ml-auto">
                        #{job.job_number || job.id}
                    </span>
                </div>
            </div>

            {detailLoading ? (
                <div className="flex-1 flex items-center justify-center text-muted-foreground">
                    <Loader2 className="size-5 animate-spin mr-2" /> Loading...
                </div>
            ) : (
                <div className="flex-1 overflow-y-auto">
                    <div className="p-4 space-y-4">
                        {/* ── Contact Information ── */}
                        <div>
                            <h4 className="font-medium mb-3">Contact Information</h4>
                            <div className="space-y-3">
                                {/* Comments */}
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

                                {/* Phone */}
                                {(contactInfo?.phone || job.customer_phone) && (
                                    <div className="flex items-start gap-3">
                                        <Phone className="size-4 shrink-0 text-muted-foreground" />
                                        <div className="flex-1">
                                            <Label className="text-xs text-muted-foreground">Phone</Label>
                                            <div className="text-sm font-medium">
                                                <a href={`tel:${contactInfo?.phone || job.customer_phone}`} className="text-foreground no-underline hover:underline">
                                                    {formatPhone(contactInfo?.phone || job.customer_phone)}
                                                </a>
                                            </div>
                                        </div>
                                    </div>
                                )}

                                {/* Email */}
                                {(contactInfo?.email || job.customer_email) && (
                                    <div className="flex items-start gap-3">
                                        <Mail className="size-4 shrink-0 text-muted-foreground" />
                                        <div className="flex-1">
                                            <Label className="text-xs text-muted-foreground">Email</Label>
                                            <a href={`mailto:${contactInfo?.email || job.customer_email}`}
                                                className="text-sm font-medium text-foreground no-underline hover:underline block">
                                                {contactInfo?.email || job.customer_email}
                                            </a>
                                        </div>
                                    </div>
                                )}

                                {/* Address */}
                                {job.address && (
                                    <div className="flex items-start gap-3">
                                        <MapPin className="size-4 shrink-0 text-muted-foreground" />
                                        <div className="flex-1">
                                            <Label className="text-xs text-muted-foreground">Address</Label>
                                            <div className="text-sm font-medium mt-1">{job.address}</div>
                                        </div>
                                    </div>
                                )}

                                {/* Contact link */}
                                {contactInfo && (
                                    <div className="flex items-start gap-3">
                                        <User2 className="size-4 shrink-0 text-muted-foreground" />
                                        <div className="flex-1">
                                            <Label className="text-xs text-muted-foreground">Contact</Label>
                                            <span
                                                className="text-sm font-medium text-indigo-600 cursor-pointer hover:underline block"
                                                onClick={() => navigate(`/contacts/${contactInfo.id}`)}
                                            >
                                                {contactInfo.name}
                                            </span>
                                        </div>
                                    </div>
                                )}
                            </div>
                        </div>

                        <Separator />

                        {/* ── Job Details ── */}
                        <div>
                            <h4 className="font-medium mb-3">Job Details</h4>
                            <div className="space-y-3">
                                {/* Job Type */}
                                <div>
                                    <Label className="text-xs text-muted-foreground">Job Type</Label>
                                    <div className="text-sm font-medium mt-1">
                                        {job.job_type || job.service_name || <span className="text-muted-foreground">N/A</span>}
                                    </div>
                                </div>

                                {/* Description */}
                                <div>
                                    <Label className="text-xs text-muted-foreground">Description</Label>
                                    <div className="text-sm mt-1 whitespace-pre-wrap">
                                        {job.description || <span className="text-muted-foreground">N/A</span>}
                                    </div>
                                </div>
                            </div>
                        </div>

                        <Separator />

                        {/* ── Schedule (ZB data) ── */}
                        <div>
                            <h4 className="font-medium mb-3">Schedule</h4>
                            <div className="space-y-2">
                                <div className="flex items-center gap-2">
                                    <Briefcase className="size-4 text-muted-foreground" />
                                    <span className="text-sm">{job.service_name || '—'}</span>
                                </div>
                                <div className="flex items-center gap-2">
                                    <CalendarClock className="size-4 text-muted-foreground" />
                                    <span className="text-sm">{formatDate(job.start_date)}</span>
                                    {job.end_date && (
                                        <span className="text-xs text-muted-foreground">→ {formatDate(job.end_date)}</span>
                                    )}
                                </div>
                            </div>
                        </div>

                        {/* ── Status Transitions ── */}
                        <div>
                            <h4 className="font-medium mb-3">Change Status</h4>
                            {(() => {
                                const allowed = ALLOWED_TRANSITIONS[job.blanc_status] || [];
                                if (allowed.length === 0) {
                                    return <div className="text-xs text-muted-foreground">No transitions available</div>;
                                }
                                return (
                                    <div className="flex flex-wrap gap-1.5">
                                        {allowed.map(s => (
                                            <button key={s} onClick={() => onBlancStatusChange(job.id, s)}
                                                className={`text-xs px-2 py-1 rounded-md border transition-colors hover:opacity-80 ${BLANC_STATUS_COLORS[s] || 'bg-gray-100'}`}>
                                                → {s}
                                            </button>
                                        ))}
                                    </div>
                                );
                            })()}
                        </div>

                        {/* ── Assigned Techs ── */}
                        <div>
                            <h4 className="font-medium mb-3">Assigned Techs</h4>
                            {job.assigned_techs && job.assigned_techs.length > 0 ? (
                                <div className="space-y-1">
                                    {job.assigned_techs.map((p: any) => (
                                        <div key={p.id} className="flex items-center gap-2 text-sm">
                                            <User2 className="size-3.5 text-muted-foreground" /> {p.name}
                                        </div>
                                    ))}
                                </div>
                            ) : (
                                <div className="text-sm text-muted-foreground">No techs assigned</div>
                            )}
                        </div>

                        {/* ── Invoice ── */}
                        {job.invoice_total && (
                            <div>
                                <h4 className="font-medium mb-3">Invoice</h4>
                                <div className="text-sm">
                                    <span className="font-medium">${job.invoice_total}</span>
                                    {job.invoice_status && <span className="ml-2 text-muted-foreground">({job.invoice_status})</span>}
                                </div>
                            </div>
                        )}

                        {/* ── Territory ── */}
                        {job.territory && (
                            <div>
                                <h4 className="font-medium mb-3">Territory</h4>
                                <div className="text-sm">{job.territory}</div>
                            </div>
                        )}

                        {/* ── Metadata ── */}
                        <JobMetadataSection job={job} />

                        {/* ── Notes ── */}
                        {job.notes && job.notes.length > 0 && (
                            <>
                                <Separator />
                                <div>
                                    <h4 className="font-medium mb-3">Notes</h4>
                                    <div className="space-y-2">
                                        {job.notes.map((note, i) => (
                                            <div key={i} className="text-sm bg-muted/50 rounded-md p-2">
                                                <div>{note.text}</div>
                                                <div className="text-xs text-muted-foreground mt-1">{formatDate(note.created)}</div>
                                            </div>
                                        ))}
                                    </div>
                                </div>
                            </>
                        )}

                        {/* Add Note inline */}
                        {noteJobId === job.id ? (
                            <section className="space-y-2">
                                <textarea className="w-full border rounded-md p-2 text-sm min-h-[60px] resize-none"
                                    placeholder="Add a note..." value={noteText}
                                    onChange={e => setNoteText(e.target.value)} autoFocus />
                                <div className="flex gap-2">
                                    <Button size="sm" onClick={onAddNote} disabled={!noteText.trim()}>Save Note</Button>
                                    <Button size="sm" variant="ghost" onClick={() => { setNoteJobId(null); setNoteText(''); }}>Cancel</Button>
                                </div>
                            </section>
                        ) : null}
                    </div>
                </div>
            )}

            {/* ── Footer Actions ── */}
            <div className="p-4 border-t space-y-2">
                <Button variant="outline" size="sm" className="w-full justify-start"
                    onClick={() => setNoteJobId(job.id)}>
                    <StickyNote className="size-4 mr-2" /> Add Note
                </Button>

                {!job.zb_canceled && (
                    <div className="flex flex-wrap gap-2">
                        {job.zb_status === 'scheduled' && (
                            <>
                                <Button size="sm" variant="outline" onClick={() => onMarkEnroute(job.id)}>
                                    <Navigation className="size-4 mr-1" /> En-route
                                </Button>
                                <Button size="sm" variant="outline" onClick={() => onMarkInProgress(job.id)}>
                                    <Play className="size-4 mr-1" /> Start
                                </Button>
                            </>
                        )}
                        {job.zb_status === 'en-route' && (
                            <Button size="sm" variant="outline" onClick={() => onMarkInProgress(job.id)}>
                                <Play className="size-4 mr-1" /> Start
                            </Button>
                        )}
                        {(job.zb_status === 'in-progress' || job.zb_status === 'en-route' || job.zb_status === 'scheduled') && (
                            <Button size="sm" variant="outline" onClick={() => onMarkComplete(job.id)}>
                                <CheckCircle2 className="size-4 mr-1" /> Complete
                            </Button>
                        )}
                        {job.zb_status !== 'complete' && (
                            <Button size="sm" variant="destructive" onClick={() => onCancel(job.id)}>
                                <Ban className="size-4 mr-1" /> Cancel
                            </Button>
                        )}
                    </div>
                )}
            </div>
        </div>
    );
}

export default JobsPage;
