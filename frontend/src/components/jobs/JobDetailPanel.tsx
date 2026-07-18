import { useState, useEffect } from 'react';
import { Loader2 } from 'lucide-react';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '../ui/tabs';
import type { LocalJob, JobTag } from '../../services/jobsApi';
import { JobDetailHeader } from './JobDetailHeader';
import { JobOpsSection } from './JobStatusTags';
import { JobInfoSections } from './JobInfoSections';
import { JobMetadataSection } from './JobMetadataSection';
import { JobFinancialsTab } from './JobFinancialsTab';
import { JobDescription } from './JobDescription';
import { NotesHistoryTabs } from '../shared/NotesHistoryTabs';
import { useAuthz } from '../../hooks/useAuthz';
import {
    Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from '../ui/dialog';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface JobDetailPanelProps {
    job: LocalJob;
    contactInfo: { id: number; name: string; phone?: string; email?: string } | null;
    detailLoading: boolean;
    noteJobId?: number | null;
    noteText?: string;
    setNoteText?: (v: string) => void;
    setNoteJobId?: (v: number | null) => void;
    onClose: () => void;
    onBlancStatusChange: (id: number, s: string) => void;
    onAddNote?: (files?: File[]) => void;
    onMarkEnroute: (id: number) => void;
    onMarkInProgress: (id: number) => void;
    onMarkComplete: (id: number) => void;
    onCancel: (id: number, reason: string) => Promise<boolean> | boolean;
    navigate: (path: string) => void;
    allTags: JobTag[];
    onTagsChange: (jobId: number, tagIds: number[]) => void;
    onJobUpdated?: (updatedJob: LocalJob) => void;
    /** Refresh the job after the "On the way" notification (ONWAY-001). */
    onNotified?: (id: number) => void;
    onCopy?: () => void;
}

// ─── Component ───────────────────────────────────────────────────────────────

export function JobDetailPanel({
    job, contactInfo, detailLoading,
    onClose: _onClose, onBlancStatusChange,
    onMarkEnroute, onMarkInProgress, onMarkComplete, onCancel,
    navigate, allTags, onTagsChange, onJobUpdated, onNotified, onCopy,
}: JobDetailPanelProps) {
    const [rightTab, setRightTab] = useState<'notes' | 'financials'>('notes');
    const [cancelOpen, setCancelOpen] = useState(false);
    const [cancelReason, setCancelReason] = useState('');
    const [cancelSubmitting, setCancelSubmitting] = useState(false);
    const { hasAnyPermission } = useAuthz();
    // Finance surface renders only with finance visibility (PF007)
    const canViewFinancials = hasAnyPermission('financial_data.view', 'estimates.view', 'invoices.view');

    useEffect(() => {
        setRightTab('notes');
    }, [job.id]);

    const requestCancel = (_id?: number) => {
        setCancelReason('');
        setCancelOpen(true);
    };

    const submitCancel = async () => {
        const reason = cancelReason.trim();
        if (!reason || cancelSubmitting) return;
        setCancelSubmitting(true);
        const ok = await onCancel(job.id, reason);
        setCancelSubmitting(false);
        if (ok) {
            setCancelOpen(false);
            setCancelReason('');
        }
    };

    const closeCancelDialog = (open: boolean) => {
        if (cancelSubmitting) return;
        setCancelOpen(open);
        if (!open) setCancelReason('');
    };

    const opsProps = { job, allTags, onTagsChange, onMarkEnroute, onMarkInProgress, onMarkComplete, onCancel: requestCancel, onNotified };

    return (
        <div className="flex flex-col md:flex-row h-full overflow-hidden">
            {/* ═══ LEFT COLUMN — Identity, Ops, Info ═══ */}
            <div className="w-full md:w-1/2 flex flex-col overflow-y-auto">
                {/* Identity: eyebrow, title, customer */}
                <JobDetailHeader
                    job={job}
                    contactInfo={contactInfo}
                    navigate={navigate}
                    onBlancStatusChange={onBlancStatusChange}
                    onCancel={requestCancel}
                    onCopy={onCopy}
                />

                {/* Ops: status + tags + action chips — all in one compact band */}
                <JobOpsSection {...opsProps} />

                {/* Logistics + contact info */}
                {detailLoading ? (
                    <div className="flex-1 flex items-center justify-center" style={{ color: 'var(--blanc-ink-3)' }}>
                        <Loader2 className="size-5 animate-spin mr-2" /> Loading…
                    </div>
                ) : (
                    <>
                        <JobInfoSections job={job} contactInfo={contactInfo} onJobUpdated={onJobUpdated} />

                        {/* Mobile-only: description, notes, metadata, financials */}
                        <div className="md:hidden px-5 pb-6 space-y-5">
                            <JobDescription job={job} />
                            <NotesHistoryTabs entityType="job" entityId={job.id} onNoteAdded={onJobUpdated ? () => onJobUpdated(job) : undefined} />
                            <JobMetadataSection job={job} />
                            {canViewFinancials && (
                                <>
                                    <p className="blanc-eyebrow pt-2">Estimates &amp; Invoices</p>
                                    <JobFinancialsTab
                                        jobId={job.id}
                                        leadSerialId={job.lead_serial_id}
                                        contactEmail={contactInfo?.email}
                                        hasContact={Boolean(contactInfo?.id || job.contact_id)}
                                    />
                                </>
                            )}
                        </div>
                    </>
                )}
            </div>

            {/* ═══ RIGHT COLUMN (desktop only) — Notes & Financials ═══ */}
            <div
                className="w-full md:w-1/2 flex-col overflow-y-auto hidden md:flex"
                style={{ borderLeft: '1px solid var(--blanc-line)' }}
            >
                <Tabs value={rightTab} onValueChange={v => setRightTab(v as 'notes' | 'financials')} className="flex flex-col h-full">
                    <div className="shrink-0" style={{ padding: '8px 16px 0' }}>
                        <TabsList className="h-9">
                            <TabsTrigger value="notes" className="text-xs">Details</TabsTrigger>
                            {canViewFinancials && <TabsTrigger value="financials" className="text-xs">Finance</TabsTrigger>}
                        </TabsList>
                    </div>

                    <TabsContent value="notes" className="flex-1 flex flex-col mt-0 min-h-0 data-[state=inactive]:hidden">
                        <div className="flex-1 overflow-y-auto p-4 space-y-5">
                            <JobDescription job={job} />
                            <NotesHistoryTabs entityType="job" entityId={job.id} onNoteAdded={onJobUpdated ? () => onJobUpdated(job) : undefined} />
                            <JobMetadataSection job={job} />
                        </div>
                    </TabsContent>

                    {canViewFinancials && (
                        <TabsContent value="financials" className="flex-1 flex flex-col mt-0 data-[state=inactive]:hidden">
                            <JobFinancialsTab
                                jobId={job.id}
                                leadSerialId={job.lead_serial_id}
                                contactEmail={contactInfo?.email}
                                hasContact={Boolean(contactInfo?.id || job.contact_id)}
                            />
                        </TabsContent>
                    )}
                </Tabs>
            </div>

            <Dialog open={cancelOpen} onOpenChange={closeCancelDialog}>
                <DialogContent className="sm:max-w-md">
                    <DialogHeader>
                        <DialogTitle>Cancel Job</DialogTitle>
                        <DialogDescription>
                            Confirm cancellation and enter the reason for canceling this job.
                        </DialogDescription>
                    </DialogHeader>
                    <div className="space-y-1.5 py-2">
                        <label className="blanc-eyebrow" htmlFor="job-cancel-reason">Cancel reason</label>
                        <textarea
                            id="job-cancel-reason"
                            value={cancelReason}
                            onChange={(e) => setCancelReason(e.target.value)}
                            placeholder="Enter the reason this job is being canceled..."
                            rows={4}
                            disabled={cancelSubmitting}
                            className="w-full rounded-lg border border-[var(--blanc-line)] bg-transparent px-3 py-2 text-sm placeholder:text-[var(--blanc-ink-3)] focus:outline-none focus:ring-1 focus:ring-[var(--blanc-line)] resize-none disabled:opacity-60"
                        />
                    </div>
                    <DialogFooter className="gap-2 sm:gap-0">
                        <button
                            type="button"
                            disabled={cancelSubmitting}
                            onClick={() => closeCancelDialog(false)}
                            className="px-4 py-2 text-sm rounded-lg border border-[var(--blanc-line)] hover:bg-[rgba(25,25,25,0.03)] transition-colors disabled:opacity-50"
                            style={{ color: 'var(--blanc-ink-2)' }}
                        >
                            Keep Job
                        </button>
                        <button
                            type="button"
                            disabled={!cancelReason.trim() || cancelSubmitting}
                            onClick={submitCancel}
                            className="px-4 py-2 text-sm rounded-lg border border-red-200 font-medium hover:bg-red-50 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                            style={{ color: '#dc2626' }}
                        >
                            {cancelSubmitting ? 'Canceling...' : 'Cancel Job'}
                        </button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </div>
    );
}
