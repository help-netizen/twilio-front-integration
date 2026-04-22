import { useCallback } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import type { LocalJob } from '../services/jobsApi';
import { useJobsData, LIMIT } from './useJobsData';
import { useJobDetail } from './useJobDetail';
import { useJobsExport } from './useJobsExport';
import { useRealtimeEvents, type SSEJobUpdatedEvent } from './useRealtimeEvents';

// ─── Hook ────────────────────────────────────────────────────────────────────

export function useJobsPage() {
    const navigate = useNavigate();
    const { jobId: urlJobId } = useParams<{ jobId?: string }>();

    // Selection is derived from URL (single source of truth).
    // This avoids a race where closing the panel set local state to null
    // while URL still held the ID, causing a useEffect to reopen it.
    const selectedJobId = urlJobId ? parseInt(urlJobId, 10) : null;

    // Compose sub-hooks
    const data = useJobsData();

    const detail = useJobDetail({
        jobId: selectedJobId,
        onJobMutated: useCallback(() => data.loadJobs(data.offset), [data.loadJobs, data.offset]),
    });

    const exportHook = useJobsExport({
        filteredJobs: data.filteredJobs,
        searchQuery: data.searchQuery,
        sortBy: data.sortBy,
        sortOrder: data.sortOrder,
        onlyOpen: data.onlyOpen,
        startDate: data.startDate,
        endDate: data.endDate,
        statusFilter: data.statusFilter,
        jobTypeFilter: data.jobTypeFilter,
        providerFilter: data.providerFilter,
        tagFilter: data.tagFilter,
        sourceFilter: data.sourceFilter,
    });

    // ─── Selection / Navigation ──────────────────────────────────────

    const handleSelectJob = useCallback((job: LocalJob) => {
        navigate(`/jobs/${job.id}`, { replace: true });
    }, [navigate]);

    const handleCloseDetail = useCallback(() => {
        navigate('/jobs', { replace: true });
    }, [navigate]);

    // ─── SSE: update list in-place when backend syncs ────────────────
    // (useJobDetail handles SSE for the selected job internally)

    const handleJobUpdated = useCallback((updatedJob: LocalJob) => {
        if (!updatedJob?.id) return;
        // Update list
        data.setJobs(prev => prev.map(j => j.id === updatedJob.id ? updatedJob : j));
        // Also update selected job via useJobDetail
        detail.handleJobUpdated(updatedJob);
    }, [data.setJobs, detail.handleJobUpdated]);

    useRealtimeEvents({
        onJobUpdated: useCallback((event: SSEJobUpdatedEvent) => {
            handleJobUpdated(event.job as LocalJob);
        }, [handleJobUpdated]),
    });

    // ─── Return (same surface as before) ─────────────────────────────

    return {
        // Data (from useJobsData)
        ...data,
        limit: LIMIT,

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
        handleMarkEnroute: detail.handleMarkEnroute,
        handleMarkInProgress: detail.handleMarkInProgress,
        handleMarkComplete: detail.handleMarkComplete,
        handleBlancStatusChange: detail.handleBlancStatusChange,
        handleTagsChange: detail.handleTagsChange,
        handleAddNote: detail.handleAddNote,

        // Export (from useJobsExport)
        ...exportHook,

        // Job update handler
        handleJobUpdated,

        // Navigation
        navigate,
    };
}
