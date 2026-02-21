import { useState, useEffect, useCallback } from 'react';
import { toast } from 'sonner';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import {
    Search, RefreshCw, ChevronLeft, ChevronRight, X, MapPin,
    User2, FileText, Play, CheckCircle2, Navigation, Ban,
    Loader2, StickyNote, CalendarClock,
} from 'lucide-react';
import * as jobsApi from '../services/jobsApi';
import * as contactsApi from '../services/contactsApi';
import type { LocalJob, JobsListParams } from '../services/jobsApi';

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
    const [searchParams] = useSearchParams();

    // Filters
    const [searchQuery, setSearchQuery] = useState('');
    const [statusFilter, setStatusFilter] = useState<string>('');
    const [offset, setOffset] = useState(0);
    const [hasMore, setHasMore] = useState(false);
    const LIMIT = 50;

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
    }, [statusFilter, searchQuery]);

    useEffect(() => { loadJobs(0); }, [loadJobs]);

    const handleSelectJob = async (job: LocalJob) => {
        setSelectedJob(job);
        setDetailLoading(true);
        setContactInfo(null);
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

    // Auto-select job from URL ?selected=ID
    useEffect(() => {
        const selectedId = searchParams.get('selected');
        if (selectedId && jobs.length > 0 && !selectedJob) {
            const job = jobs.find(j => j.id === parseInt(selectedId, 10));
            if (job) handleSelectJob(job);
        }
    }, [jobs, searchParams]);

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
                                    <th className="px-4 py-2.5 font-medium">#</th>
                                    <th className="px-4 py-2.5 font-medium">Customer</th>
                                    <th className="px-4 py-2.5 font-medium">Service</th>
                                    <th className="px-4 py-2.5 font-medium">Date</th>
                                    <th className="px-4 py-2.5 font-medium">Status</th>
                                    <th className="px-4 py-2.5 font-medium">Techs</th>
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
                <div className="w-full md:w-[440px] flex flex-col border-l bg-white overflow-hidden">
                    {/* Header */}
                    <div className="border-b px-4 py-3 flex items-center justify-between">
                        <div>
                            <div className="font-semibold text-lg">
                                Job #{selectedJob.job_number || selectedJob.id}
                            </div>
                            <div className="flex items-center gap-2 mt-1">
                                <BlancBadge status={selectedJob.blanc_status} />
                                <ZbBadge status={selectedJob.zb_status} />
                            </div>
                        </div>
                        <Button variant="ghost" size="icon" onClick={() => setSelectedJob(null)}>
                            <X className="size-4" />
                        </Button>
                    </div>

                    {detailLoading ? (
                        <div className="flex-1 flex items-center justify-center text-muted-foreground">
                            <Loader2 className="size-5 animate-spin mr-2" /> Loading...
                        </div>
                    ) : (
                        <div className="flex-1 overflow-auto p-4 space-y-5">
                            {/* Customer */}
                            <section>
                                <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2">Customer</h3>
                                <div className="space-y-1">
                                    {contactInfo ? (
                                        <>
                                            <div className="flex items-center gap-2">
                                                <User2 className="size-4 text-muted-foreground" />
                                                <span
                                                    className="font-medium text-indigo-600 cursor-pointer hover:underline"
                                                    onClick={() => navigate(`/contacts/${contactInfo.id}`)}
                                                >
                                                    {contactInfo.name}
                                                </span>
                                            </div>
                                            {contactInfo.phone && (
                                                <div className="text-sm text-muted-foreground pl-6">{contactInfo.phone}</div>
                                            )}
                                            {contactInfo.email && (
                                                <div className="text-sm text-muted-foreground pl-6">{contactInfo.email}</div>
                                            )}
                                        </>
                                    ) : (
                                        <>
                                            <div className="flex items-center gap-2">
                                                <User2 className="size-4 text-muted-foreground" />
                                                <span className="font-medium">{selectedJob.customer_name || '—'}</span>
                                            </div>
                                            {selectedJob.customer_phone && (
                                                <div className="text-sm text-muted-foreground pl-6">{selectedJob.customer_phone}</div>
                                            )}
                                            {selectedJob.customer_email && (
                                                <div className="text-sm text-muted-foreground pl-6">{selectedJob.customer_email}</div>
                                            )}
                                        </>
                                    )}
                                </div>
                            </section>

                            {/* Service & Schedule */}
                            <section>
                                <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2">Service</h3>
                                <div className="space-y-1">
                                    <div className="flex items-center gap-2">
                                        <FileText className="size-4 text-muted-foreground" />
                                        <span>{selectedJob.service_name || '—'}</span>
                                    </div>
                                    <div className="flex items-center gap-2">
                                        <CalendarClock className="size-4 text-muted-foreground" />
                                        <span className="text-sm">{formatDate(selectedJob.start_date)}</span>
                                        {selectedJob.end_date && (
                                            <span className="text-xs text-muted-foreground">→ {formatDate(selectedJob.end_date)}</span>
                                        )}
                                    </div>
                                    {selectedJob.address && (
                                        <div className="flex items-start gap-2">
                                            <MapPin className="size-4 text-muted-foreground mt-0.5" />
                                            <span className="text-sm">{selectedJob.address}</span>
                                        </div>
                                    )}
                                </div>
                            </section>

                            {/* Blanc Status — Manual Transitions */}
                            <section>
                                <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2">Change Status</h3>
                                {(() => {
                                    const allowed = ALLOWED_TRANSITIONS[selectedJob.blanc_status] || [];
                                    if (allowed.length === 0) {
                                        return <div className="text-xs text-muted-foreground">No transitions available</div>;
                                    }
                                    return (
                                        <div className="flex flex-wrap gap-1.5">
                                            {allowed.map(s => (
                                                <button
                                                    key={s}
                                                    onClick={() => handleBlancStatusChange(selectedJob.id, s)}
                                                    className={`text-xs px-2 py-1 rounded-md border transition-colors hover:opacity-80 ${BLANC_STATUS_COLORS[s] || 'bg-gray-100'
                                                        }`}
                                                >
                                                    → {s}
                                                </button>
                                            ))}
                                        </div>
                                    );
                                })()}
                            </section>

                            {/* Assigned Techs */}
                            <section>
                                <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2">Assigned Techs</h3>
                                {selectedJob.assigned_techs && selectedJob.assigned_techs.length > 0 ? (
                                    <div className="space-y-1">
                                        {selectedJob.assigned_techs.map((p: any) => (
                                            <div key={p.id} className="flex items-center gap-2 text-sm">
                                                <User2 className="size-3.5 text-muted-foreground" />
                                                {p.name}
                                            </div>
                                        ))}
                                    </div>
                                ) : (
                                    <div className="text-sm text-muted-foreground">No techs assigned</div>
                                )}
                            </section>

                            {/* Invoice */}
                            {selectedJob.invoice_total && (
                                <section>
                                    <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2">Invoice</h3>
                                    <div className="text-sm">
                                        <span className="font-medium">${selectedJob.invoice_total}</span>
                                        {selectedJob.invoice_status && (
                                            <span className="ml-2 text-muted-foreground">({selectedJob.invoice_status})</span>
                                        )}
                                    </div>
                                </section>
                            )}

                            {/* Territory */}
                            {selectedJob.territory && (
                                <section>
                                    <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2">Territory</h3>
                                    <div className="text-sm">{selectedJob.territory}</div>
                                </section>
                            )}

                            {/* Notes */}
                            {selectedJob.notes && selectedJob.notes.length > 0 && (
                                <section>
                                    <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2">Notes</h3>
                                    <div className="space-y-2">
                                        {selectedJob.notes.map((note, i) => (
                                            <div key={i} className="text-sm bg-muted/50 rounded-md p-2">
                                                <div>{note.text}</div>
                                                <div className="text-xs text-muted-foreground mt-1">{formatDate(note.created)}</div>
                                            </div>
                                        ))}
                                    </div>
                                </section>
                            )}

                            {/* Add Note */}
                            {noteJobId === selectedJob.id ? (
                                <section className="space-y-2">
                                    <textarea
                                        className="w-full border rounded-md p-2 text-sm min-h-[60px] resize-none"
                                        placeholder="Add a note..."
                                        value={noteText}
                                        onChange={e => setNoteText(e.target.value)}
                                        autoFocus
                                    />
                                    <div className="flex gap-2">
                                        <Button size="sm" onClick={handleAddNote} disabled={!noteText.trim()}>Save Note</Button>
                                        <Button size="sm" variant="ghost" onClick={() => { setNoteJobId(null); setNoteText(''); }}>Cancel</Button>
                                    </div>
                                </section>
                            ) : null}
                        </div>
                    )}

                    {/* Action Buttons */}
                    <div className="border-t p-3 space-y-2">
                        {/* Add Note button */}
                        <Button
                            variant="outline"
                            size="sm"
                            className="w-full justify-start"
                            onClick={() => setNoteJobId(selectedJob.id)}
                        >
                            <StickyNote className="size-4 mr-2" /> Add Note
                        </Button>

                        {/* Zenbooker status transition buttons */}
                        {!selectedJob.zb_canceled && (
                            <div className="flex flex-wrap gap-2">
                                {selectedJob.zb_status === 'scheduled' && (
                                    <>
                                        <Button size="sm" variant="outline" onClick={() => handleMarkEnroute(selectedJob.id)}>
                                            <Navigation className="size-4 mr-1" /> En-route
                                        </Button>
                                        <Button size="sm" variant="outline" onClick={() => handleMarkInProgress(selectedJob.id)}>
                                            <Play className="size-4 mr-1" /> Start
                                        </Button>
                                    </>
                                )}
                                {selectedJob.zb_status === 'en-route' && (
                                    <Button size="sm" variant="outline" onClick={() => handleMarkInProgress(selectedJob.id)}>
                                        <Play className="size-4 mr-1" /> Start
                                    </Button>
                                )}
                                {(selectedJob.zb_status === 'in-progress' || selectedJob.zb_status === 'en-route' || selectedJob.zb_status === 'scheduled') && (
                                    <Button size="sm" variant="outline" onClick={() => handleMarkComplete(selectedJob.id)}>
                                        <CheckCircle2 className="size-4 mr-1" /> Complete
                                    </Button>
                                )}
                                {selectedJob.zb_status !== 'complete' && (
                                    <Button size="sm" variant="destructive" onClick={() => handleCancel(selectedJob.id)}>
                                        <Ban className="size-4 mr-1" /> Cancel
                                    </Button>
                                )}
                            </div>
                        )}
                    </div>
                </div>
            )}
        </div>
    );
}

export default JobsPage;
