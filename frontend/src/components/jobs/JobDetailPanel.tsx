import { useState, useEffect } from 'react';
import { Loader2 } from 'lucide-react';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '../ui/tabs';
import type { LocalJob, JobTag } from '../../services/jobsApi';
import { JobDetailHeader } from './JobDetailHeader';
import { JobOpsSection } from './JobStatusTags';
import { JobInfoSections } from './JobInfoSections';
import { JobMetadataSection } from './JobMetadataSection';
import { JobFinancialsTab } from './JobFinancialsTab';
import {
    JobDescription, JobComments, JobNotesList,
    JobAddNote, JobMobileAddNote,
} from './JobNotesSection';

// ─── Types ───────────────────────────────────────────────────────────────────

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
    onAddNote: (files?: File[]) => void;
    onMarkEnroute: (id: number) => void;
    onMarkInProgress: (id: number) => void;
    onMarkComplete: (id: number) => void;
    onCancel: (id: number) => void;
    navigate: (path: string) => void;
    allTags: JobTag[];
    onTagsChange: (jobId: number, tagIds: number[]) => void;
    onJobUpdated?: (updatedJob: LocalJob) => void;
}

// ─── Component ───────────────────────────────────────────────────────────────

export function JobDetailPanel({
    job, contactInfo, detailLoading,
    noteJobId, noteText, setNoteText, setNoteJobId,
    onClose: _onClose, onBlancStatusChange, onAddNote,
    onMarkEnroute, onMarkInProgress, onMarkComplete, onCancel,
    navigate, allTags, onTagsChange, onJobUpdated,
}: JobDetailPanelProps) {
    const [rightTab, setRightTab] = useState<'notes' | 'financials'>('notes');

    useEffect(() => {
        setRightTab('notes');
    }, [job.id]);

    const noteProps = { job, noteJobId, noteText, setNoteText, setNoteJobId, onAddNote };
    const opsProps = { job, allTags, onTagsChange, onMarkEnroute, onMarkInProgress, onMarkComplete, onCancel };

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

                        {/* Mobile-only: comments, description, notes, metadata, financials */}
                        <div className="md:hidden px-5 pb-6 space-y-5">
                            <JobDescription job={job} />
                            <JobComments job={job} />
                            <JobNotesList job={job} />
                            <JobMetadataSection job={job} />
                            <JobMobileAddNote {...noteProps} />
                            <p className="blanc-eyebrow pt-2">Estimates &amp; Invoices</p>
                            <JobFinancialsTab jobId={job.id} />
                        </div>
                    </>
                )}
            </div>

            {/* ═══ RIGHT COLUMN (desktop only) — Notes & Financials ═══ */}
            <div
                className="w-full md:w-1/2 flex-col overflow-y-auto hidden md:flex"
                style={{ borderLeft: '1px solid rgba(117, 106, 89, 0.07)' }}
            >
                <Tabs value={rightTab} onValueChange={v => setRightTab(v as 'notes' | 'financials')} className="flex flex-col h-full">
                    <div className="shrink-0" style={{ padding: '8px 16px 0' }}>
                        <TabsList className="h-9">
                            <TabsTrigger value="notes" className="text-xs">Details</TabsTrigger>
                            <TabsTrigger value="financials" className="text-xs">Finance</TabsTrigger>
                        </TabsList>
                    </div>

                    <TabsContent value="notes" className="flex-1 flex flex-col mt-0 min-h-0 data-[state=inactive]:hidden">
                        <div className="flex-1 overflow-y-auto p-4 space-y-5">
                            <JobDescription job={job} />
                            <JobComments job={job} />
                            <JobNotesList job={job} />
                            <JobMetadataSection job={job} />
                        </div>
                        <JobAddNote {...noteProps} />
                    </TabsContent>

                    <TabsContent value="financials" className="flex-1 flex flex-col mt-0 data-[state=inactive]:hidden">
                        <JobFinancialsTab jobId={job.id} />
                    </TabsContent>
                </Tabs>
            </div>
        </div>
    );
}
