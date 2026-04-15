/**
 * useJobDetail — Standalone hook for a single job's detail state and actions.
 *
 * Fetches full LocalJob + contact info, manages note state, provides all
 * action callbacks that JobDetailPanel needs. Reusable on any page
 * (Jobs, Schedule, etc.) without coupling to list management.
 */

import { useState, useEffect, useCallback } from 'react';
import { toast } from 'sonner';
import * as jobsApi from '../services/jobsApi';
import * as contactsApi from '../services/contactsApi';
import type { LocalJob, JobTag } from '../services/jobsApi';
import { useRealtimeEvents, type SSEJobUpdatedEvent } from './useRealtimeEvents';

// ─── Types ───────────────────────────────────────────────────────────────────

interface ContactInfo {
    id: number;
    name: string;
    phone?: string;
    email?: string;
}

interface UseJobDetailParams {
    jobId: number | null;
    /** Called after any mutation so the parent can refresh its own list */
    onJobMutated?: () => void;
}

export interface UseJobDetailResult {
    job: LocalJob | null;
    detailLoading: boolean;
    contactInfo: ContactInfo | null;
    allTags: JobTag[];
    noteText: string;
    setNoteText: (v: string) => void;
    noteJobId: number | null;
    setNoteJobId: (v: number | null) => void;
    handleBlancStatusChange: (id: number, s: string) => void;
    handleAddNote: (files?: File[]) => void;
    handleMarkEnroute: (id: number) => void;
    handleMarkInProgress: (id: number) => void;
    handleMarkComplete: (id: number) => void;
    handleCancel: (id: number) => void;
    handleTagsChange: (jobId: number, tagIds: number[]) => void;
    handleJobUpdated: (updatedJob: LocalJob) => void;
}

// ─── Hook ────────────────────────────────────────────────────────────────────

export function useJobDetail({ jobId, onJobMutated }: UseJobDetailParams): UseJobDetailResult {
    const [job, setJob] = useState<LocalJob | null>(null);
    const [detailLoading, setDetailLoading] = useState(false);
    const [contactInfo, setContactInfo] = useState<ContactInfo | null>(null);
    const [allTags, setAllTags] = useState<JobTag[]>([]);

    // Note state
    const [noteText, setNoteText] = useState('');
    const [noteJobId, setNoteJobId] = useState<number | null>(null);

    // ─── Fetch job + contact on jobId change ─────────────────────────

    useEffect(() => {
        if (!jobId) {
            setJob(null);
            setContactInfo(null);
            setDetailLoading(false);
            return;
        }

        let cancelled = false;
        setDetailLoading(true);
        setContactInfo(null);

        (async () => {
            try {
                const detail = await jobsApi.getJob(jobId);
                if (cancelled) return;
                setJob(detail);

                if (detail.contact_id) {
                    try {
                        const resp = await contactsApi.getContact(detail.contact_id);
                        if (cancelled) return;
                        const c = resp.data.contact;
                        setContactInfo({
                            id: c.id,
                            name: c.full_name || '—',
                            phone: c.phone_e164 || '',
                            email: c.email || '',
                        });
                    } catch { /* no contact found */ }
                }
            } catch { /* job not found */ }
            finally {
                if (!cancelled) setDetailLoading(false);
            }
        })();

        return () => { cancelled = true; };
    }, [jobId]);

    // ─── Fetch tags once ─────────────────────────────────────────────

    useEffect(() => {
        jobsApi.listJobTags().then(setAllTags).catch(() => {});
    }, []);

    // ─── Refresh helper ──────────────────────────────────────────────

    const refreshJob = useCallback(async (id: number) => {
        try {
            const detail = await jobsApi.getJob(id);
            setJob(detail);
        } catch { /* ignore */ }
    }, []);

    const afterMutation = useCallback((id: number) => {
        refreshJob(id);
        onJobMutated?.();
    }, [refreshJob, onJobMutated]);

    // ─── Actions ─────────────────────────────────────────────────────

    const handleBlancStatusChange = useCallback(async (id: number, newStatus: string) => {
        try {
            await jobsApi.updateBlancStatus(id, newStatus);
            toast.success(`Status → ${newStatus}`);
            afterMutation(id);
        } catch (err) {
            toast.error('Status change failed', { description: err instanceof Error ? err.message : '' });
        }
    }, [afterMutation]);

    const handleMarkEnroute = useCallback(async (id: number) => {
        try {
            await jobsApi.markEnroute(id);
            toast.success('Job marked as en-route');
            afterMutation(id);
        } catch (err) {
            toast.error('Failed', { description: err instanceof Error ? err.message : '' });
        }
    }, [afterMutation]);

    const handleMarkInProgress = useCallback(async (id: number) => {
        try {
            await jobsApi.markInProgress(id);
            toast.success('Job started');
            afterMutation(id);
        } catch (err) {
            toast.error('Failed', { description: err instanceof Error ? err.message : '' });
        }
    }, [afterMutation]);

    const handleMarkComplete = useCallback(async (id: number) => {
        try {
            await jobsApi.markComplete(id);
            toast.success('Job completed');
            afterMutation(id);
        } catch (err) {
            toast.error('Failed', { description: err instanceof Error ? err.message : '' });
        }
    }, [afterMutation]);

    const handleCancel = useCallback(async (id: number) => {
        if (!confirm('Cancel this job?')) return;
        try {
            await jobsApi.cancelJob(id);
            toast.success('Job canceled');
            afterMutation(id);
        } catch (err) {
            toast.error('Failed to cancel job', { description: err instanceof Error ? err.message : '' });
        }
    }, [afterMutation]);

    const handleAddNote = useCallback(async (files?: File[]) => {
        if (!noteJobId || (!noteText.trim() && (!files || files.length === 0))) return;
        try {
            await jobsApi.addJobNote(noteJobId, noteText.trim(), files);
            toast.success('Note added');
            setNoteText('');
            setNoteJobId(null);
            refreshJob(noteJobId);
        } catch (err) {
            toast.error('Failed to add note', { description: err instanceof Error ? err.message : '' });
        }
    }, [noteJobId, noteText, refreshJob]);

    const handleTagsChange = useCallback(async (jId: number, tagIds: number[]) => {
        try {
            const updated = await jobsApi.updateJobTags(jId, tagIds);
            setJob(prev => prev?.id === jId ? { ...prev, tags: updated.tags } : prev);
        } catch (err) {
            toast.error('Failed to update tags', { description: err instanceof Error ? err.message : '' });
        }
    }, []);

    // ─── SSE: update job in-place on backend events ──────────────────

    const handleJobUpdated = useCallback((updatedJob: LocalJob) => {
        if (!updatedJob?.id) return;
        setJob(prev => prev?.id === updatedJob.id ? updatedJob : prev);
    }, []);

    useRealtimeEvents({
        onJobUpdated: useCallback((event: SSEJobUpdatedEvent) => {
            handleJobUpdated(event.job as LocalJob);
        }, [handleJobUpdated]),
    });

    return {
        job,
        detailLoading,
        contactInfo,
        allTags,
        noteText, setNoteText,
        noteJobId, setNoteJobId,
        handleBlancStatusChange,
        handleAddNote,
        handleMarkEnroute,
        handleMarkInProgress,
        handleMarkComplete,
        handleCancel,
        handleTagsChange,
        handleJobUpdated,
    };
}
