import { useState } from 'react';
import { toast } from 'sonner';
import * as jobsApi from '../services/jobsApi';
import type { LocalJob } from '../services/jobsApi';

// ─── Types ───────────────────────────────────────────────────────────────────

interface UseJobsActionsParams {
    selectedJob: LocalJob | null;
    setSelectedJob: (j: LocalJob | null | ((prev: LocalJob | null) => LocalJob | null)) => void;
    setJobs: (fn: (prev: LocalJob[]) => LocalJob[]) => void;
    loadJobs: (offset: number) => void;
    offset: number;
}

// ─── Hook ────────────────────────────────────────────────────────────────────

export function useJobsActions({
    selectedJob, setSelectedJob, setJobs, loadJobs, offset,
}: UseJobsActionsParams) {
    // Note state
    const [noteText, setNoteText] = useState('');
    const [noteJobId, setNoteJobId] = useState<number | null>(null);

    const refreshSelected = async (id: number) => {
        try {
            const detail = await jobsApi.getJob(id);
            setSelectedJob(detail);
        } catch { /* ignore */ }
    };

    const handleCancel = async (id: number) => {
        if (!confirm('Cancel this job?')) return;
        try {
            await jobsApi.cancelJob(id);
            toast.success('Job canceled');
            loadJobs(offset);
            if (selectedJob?.id === id) refreshSelected(id);
        } catch (err) {
            toast.error('Failed to cancel job', { description: err instanceof Error ? err.message : '' });
        }
    };

    const handleMarkEnroute = async (id: number) => {
        try {
            await jobsApi.markEnroute(id);
            toast.success('Job marked as en-route');
            loadJobs(offset);
            if (selectedJob?.id === id) refreshSelected(id);
        } catch (err) {
            toast.error('Failed', { description: err instanceof Error ? err.message : '' });
        }
    };

    const handleMarkInProgress = async (id: number) => {
        try {
            await jobsApi.markInProgress(id);
            toast.success('Job started');
            loadJobs(offset);
            if (selectedJob?.id === id) refreshSelected(id);
        } catch (err) {
            toast.error('Failed', { description: err instanceof Error ? err.message : '' });
        }
    };

    const handleMarkComplete = async (id: number) => {
        try {
            await jobsApi.markComplete(id);
            toast.success('Job completed');
            loadJobs(offset);
            if (selectedJob?.id === id) refreshSelected(id);
        } catch (err) {
            toast.error('Failed', { description: err instanceof Error ? err.message : '' });
        }
    };

    const handleBlancStatusChange = async (id: number, newStatus: string) => {
        try {
            await jobsApi.updateBlancStatus(id, newStatus);
            toast.success(`Status → ${newStatus}`);
            loadJobs(offset);
            if (selectedJob?.id === id) refreshSelected(id);
        } catch (err) {
            toast.error('Status change failed', { description: err instanceof Error ? err.message : '' });
        }
    };

    const handleTagsChange = async (jobId: number, tagIds: number[]) => {
        try {
            const updated = await jobsApi.updateJobTags(jobId, tagIds);
            setJobs(prev => prev.map(j => j.id === jobId ? { ...j, tags: updated.tags } : j));
            if (selectedJob?.id === jobId) {
                setSelectedJob(prev => prev ? { ...prev, tags: updated.tags } : prev);
            }
        } catch (err) {
            toast.error('Failed to update tags', { description: err instanceof Error ? err.message : '' });
        }
    };

    const handleAddNote = async (files?: File[]) => {
        if (!noteJobId || (!noteText.trim() && (!files || files.length === 0))) return;
        try {
            await jobsApi.addJobNote(noteJobId, noteText.trim(), files);
            toast.success('Note added');
            setNoteText('');
            setNoteJobId(null);
            if (selectedJob?.id === noteJobId) refreshSelected(noteJobId);
        } catch (err) {
            toast.error('Failed to add note', { description: err instanceof Error ? err.message : '' });
        }
    };

    return {
        noteText, setNoteText,
        noteJobId, setNoteJobId,
        handleCancel,
        handleMarkEnroute,
        handleMarkInProgress,
        handleMarkComplete,
        handleBlancStatusChange,
        handleTagsChange,
        handleAddNote,
    };
}
