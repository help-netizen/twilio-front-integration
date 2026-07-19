import axios from 'axios';
import type { PulseTimelinePageResponse } from '../types/pulse';
import { getAuthHeaders } from '../auth/AuthProvider';

const API_BASE_URL = import.meta.env.VITE_API_URL || '/api';

const apiClient = axios.create({
    baseURL: API_BASE_URL,
    headers: { 'Content-Type': 'application/json' },
});

apiClient.interceptors.request.use((config) => {
    const authHeaders = getAuthHeaders();
    if (authHeaders.Authorization) {
        config.headers.Authorization = authHeaders.Authorization;
    }
    return config;
});

export const pulseApi = {
    /** Get a newest-to-oldest page of the combined timeline. */
    getTimelinePage: async (opts: {
        mode: 'timeline' | 'contact';
        key: number;
        before?: string;
        signal?: AbortSignal;
    }): Promise<PulseTimelinePageResponse> => {
        const path = opts.mode === 'timeline'
            ? `/pulse/timeline-by-id/${opts.key}`
            : `/pulse/timeline/${opts.key}`;
        const response = await apiClient.get<PulseTimelinePageResponse>(path, {
            params: { limit: 20, ...(opts.before ? { before: opts.before } : {}) },
            signal: opts.signal,
        });
        return response.data;
    },
    /** Find or create a timeline for a phone number, optionally linking to a contact */
    ensureTimeline: async (phone: string, contactId?: number): Promise<{ timelineId: number; contactId: number | null; created: boolean }> => {
        const response = await apiClient.post<{ timelineId: number; contactId: number | null; created: boolean }>('/pulse/ensure-timeline', { phone, contactId });
        return response.data;
    },

    // ─── Action Required ───

    /** Clear a taskless manual Action Required flag. Task rows use /api/tasks/:id. */
    markHandled: async (timelineId: number): Promise<void> => {
        await apiClient.post(`/pulse/threads/${timelineId}/mark-handled`);
    },
    /** Snooze thread until a specific time */
    snoozeThread: async (timelineId: number, snoozedUntil: string): Promise<void> => {
        await apiClient.post(`/pulse/threads/${timelineId}/snooze`, { snoozed_until: snoozedUntil });
    },
    /** Assign owner to thread */
    assignThread: async (timelineId: number, ownerUserId: string): Promise<void> => {
        await apiClient.post(`/pulse/threads/${timelineId}/assign`, { owner_user_id: ownerUserId });
    },
    /** Create a task on a thread (also sets action_required) */
    createTask: async (timelineId: number, data: { title: string; description?: string; priority?: string; due_at?: string }): Promise<any> => {
        const response = await apiClient.post(`/pulse/threads/${timelineId}/tasks`, data);
        return response.data;
    },
    /** Manually set Action Required on a thread */
    setActionRequired: async (timelineId: number): Promise<void> => {
        await apiClient.post(`/pulse/threads/${timelineId}/set-action-required`);
    },
};
