import { useState, useEffect } from 'react';
import { Separator } from '../ui/separator';
import { Loader2 } from 'lucide-react';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '../ui/tabs';
import type { LocalJob, JobTag } from '../../services/jobsApi';
import { JobDetailHeader } from './JobDetailHeader';
import { JobActionBar } from './JobActionBar';
import { JobInfoSections } from './JobInfoSections';
import { JobMetadataSection } from './JobMetadataSection';
import { JobStatusTags } from './JobStatusTags';
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
    onAddNote: () => void;
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
    onClose, onBlancStatusChange, onAddNote,
    onMarkEnroute, onMarkInProgress, onMarkComplete, onCancel,
    navigate, allTags, onTagsChange, onJobUpdated,
}: JobDetailPanelProps) {
    const [showMobileNotes, setShowMobileNotes] = useState(false);
    const [rightTab, setRightTab] = useState<'details' | 'financials'>('details');

    useEffect(() => {
        setShowMobileNotes(false);
        setRightTab('details');
    }, [job.id]);

    const noteProps = { job, noteJobId, noteText, setNoteText, setNoteJobId, onAddNote };

    return (
        <div className="flex-1 flex flex-col md:flex-row overflow-hidden">
            {/* ═══ LEFT COLUMN ═══ */}
            <div className="w-full md:w-1/2 flex flex-col overflow-hidden border-l">
                <JobDetailHeader
                    job={job}
                    contactInfo={contactInfo}
                    showMobileNotes={showMobileNotes}
                    setShowMobileNotes={setShowMobileNotes}
                    onClose={onClose}
                    navigate={navigate}
                />

                <JobActionBar
                    job={job}
                    onMarkEnroute={onMarkEnroute}
                    onMarkInProgress={onMarkInProgress}
                    onMarkComplete={onMarkComplete}
                    onCancel={onCancel}
                />

                {/* Scrollable content */}
                {detailLoading ? (
                    <div className="flex-1 flex items-center justify-center text-muted-foreground">
                        <Loader2 className="size-5 animate-spin mr-2" /> Loading...
                    </div>
                ) : (
                    <div className="flex-1 overflow-y-auto p-6 space-y-6">
                        <JobInfoSections job={job} contactInfo={contactInfo} onJobUpdated={onJobUpdated} />

                        {/* ── Mobile-only: Description, Comments, Metadata, Notes, Financials ── */}
                        <div className="md:hidden space-y-6">
                            <Separator />
                            <JobDescription job={job} />
                            <JobComments job={job} />
                            <JobMetadataSection job={job} />
                            <JobNotesList job={job} />
                            <JobMobileAddNote {...noteProps} />
                            <Separator />
                            <p className="text-sm font-semibold">Estimates &amp; Invoices</p>
                            <JobFinancialsTab jobId={job.id} />
                        </div>
                    </div>
                )}
            </div>

            {/* ═══ RIGHT COLUMN (desktop only) ═══ */}
            <div className="w-full md:w-1/2 flex-col overflow-hidden border-l hidden md:flex">
                <Tabs value={rightTab} onValueChange={v => setRightTab(v as 'details' | 'financials')} className="flex flex-col h-full">
                    <div className="border-b px-4 pt-2 shrink-0">
                        <TabsList className="h-9">
                            <TabsTrigger value="details" className="text-xs">Details &amp; Notes</TabsTrigger>
                            <TabsTrigger value="financials" className="text-xs">Estimates &amp; Invoices</TabsTrigger>
                        </TabsList>
                    </div>

                    <TabsContent value="details" className="flex-1 flex flex-col overflow-hidden mt-0 data-[state=inactive]:hidden">
                        <JobStatusTags
                            job={job}
                            allTags={allTags}
                            onBlancStatusChange={onBlancStatusChange}
                            onTagsChange={onTagsChange}
                        />

                        <div className="flex-1 overflow-y-auto p-4 space-y-6">
                            <JobDescription job={job} />
                            <JobComments job={job} />
                            <JobMetadataSection job={job} />
                            <JobNotesList job={job} />
                        </div>

                        <JobAddNote {...noteProps} />
                    </TabsContent>

                    <TabsContent value="financials" className="flex-1 flex flex-col overflow-hidden mt-0 data-[state=inactive]:hidden">
                        <JobFinancialsTab jobId={job.id} />
                    </TabsContent>
                </Tabs>
            </div>
        </div>
    );
}
