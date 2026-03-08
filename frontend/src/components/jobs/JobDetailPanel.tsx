import { useState, useEffect } from 'react';
import { Separator } from '../ui/separator';
import { Loader2 } from 'lucide-react';
import type { LocalJob, JobTag } from '../../services/jobsApi';
import { JobDetailHeader } from './JobDetailHeader';
import { JobActionBar } from './JobActionBar';
import { JobInfoSections } from './JobInfoSections';
import { JobMetadataSection } from './JobMetadataSection';
import { JobStatusTags } from './JobStatusTags';
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
}

// ─── Component ───────────────────────────────────────────────────────────────

export function JobDetailPanel({
    job, contactInfo, detailLoading,
    noteJobId, noteText, setNoteText, setNoteJobId,
    onClose, onBlancStatusChange, onAddNote,
    onMarkEnroute, onMarkInProgress, onMarkComplete, onCancel,
    navigate, allTags, onTagsChange,
}: JobDetailPanelProps) {
    const [showMobileNotes, setShowMobileNotes] = useState(false);

    useEffect(() => {
        setShowMobileNotes(false);
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
                        <JobInfoSections job={job} contactInfo={contactInfo} />

                        {/* ── Mobile-only: Description, Comments, Metadata, Notes ── */}
                        <div className="md:hidden space-y-6">
                            <Separator />
                            <JobDescription job={job} />
                            <JobComments job={job} />
                            <JobMetadataSection job={job} />
                            <JobNotesList job={job} />
                            <JobMobileAddNote {...noteProps} />
                        </div>
                    </div>
                )}
            </div>

            {/* ═══ RIGHT COLUMN (desktop only) ═══ */}
            <div className="w-full md:w-1/2 flex-col overflow-hidden border-l hidden md:flex">
                <div className="border-b p-4 flex items-center justify-between">
                    <h3 className="text-lg font-semibold">Details and Notes</h3>
                </div>

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
            </div>
        </div>
    );
}
