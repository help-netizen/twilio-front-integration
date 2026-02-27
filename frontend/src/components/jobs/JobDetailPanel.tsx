import { useState, useEffect } from 'react';
import { Button } from '../ui/button';
import { Label } from '../ui/label';
import { Separator } from '../ui/separator';
import {
    X, MapPin, User2, FileText, Play, CheckCircle2, Navigation, Ban,
    Loader2, Phone, Mail, Tag, Calendar, ChevronDown, CornerDownLeft, Plus, CircleDot,
} from 'lucide-react';
import { authedFetch } from '../../services/apiClient';
import type { LocalJob, JobTag } from '../../services/jobsApi';
import { formatPhone } from '../../lib/formatPhone';
import {
    DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from '../ui/dropdown-menu';
import { ClickToCallButton } from '../softphone/ClickToCallButton';
import { OpenTimelineButton } from '../softphone/OpenTimelineButton';
import {
    BLANC_STATUSES, formatSchedule,
    TagBadge, BlancBadge, ZbBadge,
} from './jobHelpers';

// ─── Metadata Section ────────────────────────────────────────────────────────

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

export interface JobDetailPanelProps {
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

export function JobDetailPanel({
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
                                                <OpenTimelineButton
                                                    phone={contactInfo?.phone || job.customer_phone || ''}
                                                    contactId={contactInfo?.id}
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
