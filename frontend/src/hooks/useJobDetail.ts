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
import { useRealtimeEvents } from './useRealtimeEvents';

// ─── Types ───────────────────────────────────────────────────────────────────

interface ContactInfo {
    id: number;
    name: string;
    phone?: string;
    email?: string;
    /** Contact's second number + its stored label — the job card mirrors the
        contact card and shows EVERY phone (masked viewers tell them apart by
        the labels, since masking collapses both to one masked dial). */
    secondary_phone?: string;
    secondary_phone_name?: string;
}

interface UseJobDetailParams {
    /** Resolve by GLOBAL id — the payment detail panel (the schedule deep-link now uses jobSeq). */
    jobId?: number | null;
    /** JOB-NUMBERING-001: resolve by per-company job_seq — the /jobs/:seq page. Provide
        exactly one of jobId/jobSeq; either drives ONLY the initial fetch — every refetch
        and mutation below keys off the resolved job.id. */
    jobSeq?: number | null;
    /** Fired when the job fetch fails (404/403) — e.g. a stale or forbidden deep link. */
    onNotFound?: (ref: number) => void;
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
    handleCancel: (id: number, reason: string) => Promise<boolean>;
    handleTagsChange: (jobId: number, tagIds: number[]) => void;
    handleJobUpdated: (updatedJob: LocalJob) => void;
    /** Refresh the job (+ notify parent) after an out-of-band mutation, e.g. ONWAY notify. */
    afterMutation: (id: number) => void;
}

// ─── Hook ────────────────────────────────────────────────────────────────────

export function useJobDetail({ jobId = null, jobSeq = null, onJobMutated, onNotFound }: UseJobDetailParams): UseJobDetailResult {
    const [job, setJob] = useState<LocalJob | null>(null);
    const [detailLoading, setDetailLoading] = useState(false);
    const [contactInfo, setContactInfo] = useState<ContactInfo | null>(null);
    const [allTags, setAllTags] = useState<JobTag[]>([]);

    // Note state
    const [noteText, setNoteText] = useState('');
    const [noteJobId, setNoteJobId] = useState<number | null>(null);

    // ─── Fetch job + contact on jobId change ─────────────────────────

    useEffect(() => {
        const ref = jobSeq ?? jobId; // the URL reference: seq (/jobs/:seq) or id (schedule/payment)
        if (ref == null) {
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
                const detail = jobSeq != null
                    ? await jobsApi.getJobBySeq(jobSeq)
                    : await jobsApi.getJob(jobId!);
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
                            secondary_phone: c.secondary_phone || '',
                            secondary_phone_name: c.secondary_phone_name || '',
                        });
                    } catch { /* no contact found */ }
                }
            } catch {
                if (!cancelled) { setJob(null); onNotFound?.(ref); }
            }
            finally {
                if (!cancelled) setDetailLoading(false);
            }
        })();

        return () => { cancelled = true; };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [jobId, jobSeq]);

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

    const handleCancel = useCallback(async (id: number, reason: string) => {
        try {
            await jobsApi.cancelJob(id, reason);
            toast.success('Job canceled');
            afterMutation(id);
            return true;
        } catch (err) {
            toast.error('Failed to cancel job', { description: err instanceof Error ? err.message : '' });
            return false;
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

    // ─── SSE invalidation: refetch the currently visible scoped job ──

    const handleJobUpdated = useCallback((updatedJob: LocalJob) => {
        if (!updatedJob?.id) return;
        setJob(prev => prev?.id === updatedJob.id ? updatedJob : prev);
    }, []);

    useRealtimeEvents({
        onJobUpdated: useCallback(() => {
            // Refetch by the loaded job's real id; before it resolves, the id param
            // (id-callers pass a real id — the seq page passes jobSeq, so this stays
            // null until the job loads, which is the correct "nothing to refetch yet").
            const id = job?.id ?? jobId;
            if (id) void refreshJob(id);
        }, [job?.id, jobId, refreshJob]),
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
        handleCancel,
        handleTagsChange,
        handleJobUpdated,
        afterMutation,
    };
}
