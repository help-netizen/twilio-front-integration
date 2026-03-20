import { useState, useEffect, useCallback } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import * as jobsApi from '../services/jobsApi';
import * as contactsApi from '../services/contactsApi';
import type { LocalJob } from '../services/jobsApi';
import { useJobsData, LIMIT } from './useJobsData';
import { useJobsActions } from './useJobsActions';
import { useJobsExport } from './useJobsExport';
import { useRealtimeEvents, type SSEJobUpdatedEvent } from './useRealtimeEvents';

// ─── Hook ────────────────────────────────────────────────────────────────────

export function useJobsPage() {
    const navigate = useNavigate();
    const { jobId: urlJobId } = useParams<{ jobId?: string }>();

    // Selection state
    const [selectedJob, setSelectedJob] = useState<LocalJob | null>(null);
    const [detailLoading, setDetailLoading] = useState(false);
    const [contactInfo, setContactInfo] = useState<{ name: string; phone: string; email: string; id: number } | null>(null);

    // Compose sub-hooks
    const data = useJobsData();
    const actions = useJobsActions({
        selectedJob,
        setSelectedJob,
        setJobs: data.setJobs,
        loadJobs: data.loadJobs,
        offset: data.offset,
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

    const handleSelectJob = async (job: LocalJob) => {
        setSelectedJob(job);
        setDetailLoading(true);
        setContactInfo(null);
        navigate(`/jobs/${job.id}`, { replace: true });
        try {
            const detail = await jobsApi.getJob(job.id);
            setSelectedJob(detail);
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
        if (urlJobId && !selectedJob && !data.loading) {
            const id = parseInt(urlJobId, 10);
            const job = data.jobs.find(j => j.id === id);
            if (job) {
                handleSelectJob(job);
            } else if (data.jobs.length > 0) {
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
    }, [urlJobId, data.jobs, data.loading]);

    // ─── SSE: update job in-place when backend syncs from ZB ─────────
    const handleJobUpdated = useCallback((updatedJob: LocalJob) => {
        if (!updatedJob?.id) return;
        setSelectedJob(prev => prev?.id === updatedJob.id ? updatedJob : prev);
        data.setJobs(prev => prev.map(j => j.id === updatedJob.id ? updatedJob : j));
    }, [data.setJobs]);

    useRealtimeEvents({
        onJobUpdated: useCallback((event: SSEJobUpdatedEvent) => {
            const job = event.job as LocalJob;
            handleJobUpdated(job);
        }, [handleJobUpdated]),
    });

    // ─── Return ──────────────────────────────────────────────────────

    return {
        // Data (from useJobsData)
        ...data,
        limit: LIMIT,

        // Selection
        selectedJob,
        detailLoading,
        contactInfo,
        handleSelectJob,
        handleCloseDetail,

        // Actions (from useJobsActions)
        ...actions,

        // Export (from useJobsExport)
        ...exportHook,

        // Job update handler
        handleJobUpdated,

        // Navigation
        navigate,
    };
}
