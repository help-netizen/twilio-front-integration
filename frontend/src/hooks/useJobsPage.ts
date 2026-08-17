import { useCallback } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import type { LocalJob } from '../services/jobsApi';
import { useJobsData } from './useJobsData';
import { useJobDetail } from './useJobDetail';
import { useJobsExport } from './useJobsExport';
import { useRealtimeEvents } from './useRealtimeEvents';

// ─── Hook ────────────────────────────────────────────────────────────────────

export function useJobsPage() {
    const navigate = useNavigate();
    const { seq: urlSeq } = useParams<{ seq?: string }>();

    // Selection is derived from URL (single source of truth).
    // JOB-NUMBERING-001: the /jobs/:seq param is the per-company job_seq. It drives
    // the detail fetch (via /api/jobs/by-seq); every mutation keys off the resolved job.id.
    const selectedJobSeq = urlSeq ? parseInt(urlSeq, 10) : null;

    // Compose sub-hooks
    const data = useJobsData();

    const detail = useJobDetail({
        jobSeq: selectedJobSeq,
        onJobMutated: useCallback(() => { void data.resetJobs(); }, [data.resetJobs]),
    });

    // Export covers the entire selected date range, ignoring on-screen
    // list filters — see useJobsExport for rationale.
    const exportHook = useJobsExport({
        sortBy: data.sortBy,
        sortOrder: data.sortOrder,
        startDate: data.startDate,
        endDate: data.endDate,
    });

    // ─── Selection / Navigation ──────────────────────────────────────

    const handleSelectJob = useCallback((job: LocalJob) => {
        // Canonical per-company URL when we have the seq; fall back to the id shim
        // (redirects to /jobs/:seq) for the rare job that lacks one.
        navigate(job.job_seq != null ? `/jobs/${job.job_seq}` : `/jobs/by-id/${job.id}`, { replace: true });
    }, [navigate]);

    const handleCloseDetail = useCallback(() => {
        navigate('/jobs', { replace: true });
    }, [navigate]);

    // ─── SSE invalidation: reset the scoped list from REST ───────────

    const handleJobUpdated = useCallback((updatedJob: LocalJob) => {
        if (!updatedJob?.id) return;
        data.updateJob(updatedJob.id, () => updatedJob);
        // Also update selected job via useJobDetail
        detail.handleJobUpdated(updatedJob);
        // SSE fields can affect the active predicate or sort tuple.
        void data.resetJobs();
    }, [data.resetJobs, data.updateJob, detail.handleJobUpdated]);

    useRealtimeEvents({
        onJobUpdated: useCallback(() => {
            void data.resetJobs();
        }, [data.resetJobs]),
    });

    // ─── Return (same surface as before) ─────────────────────────────

    return {
        // Data (from useJobsData)
        ...data,
        // Selection — expose detail.job as selectedJob for backward compat
        selectedJob: detail.job,
        detailLoading: detail.detailLoading,
        contactInfo: detail.contactInfo,
        handleSelectJob,
        handleCloseDetail,

        // Actions (from useJobDetail)
        noteText: detail.noteText,
        setNoteText: detail.setNoteText,
        noteJobId: detail.noteJobId,
        setNoteJobId: detail.setNoteJobId,
        handleCancel: detail.handleCancel,
        handleBlancStatusChange: detail.handleBlancStatusChange,
        handleTagsChange: detail.handleTagsChange,
        handleAddNote: detail.handleAddNote,
        afterMutation: detail.afterMutation,

        // Export (from useJobsExport)
        ...exportHook,

        // Job update handler
        handleJobUpdated,

        // Navigation
        navigate,
    };
}
