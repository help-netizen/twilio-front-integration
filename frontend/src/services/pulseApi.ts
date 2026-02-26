import axios from 'axios';
import type { PulseTimelineResponse } from '../types/pulse';
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
    /** Get combined timeline (calls + messages) for a contact */
    getTimeline: async (contactId: number): Promise<PulseTimelineResponse> => {
        const response = await apiClient.get<PulseTimelineResponse>(`/pulse/timeline/${contactId}`);
        return response.data;
    },
    /** Get combined timeline (calls + messages) by timeline ID */
    getTimelineById: async (timelineId: number): Promise<PulseTimelineResponse> => {
        const response = await apiClient.get<PulseTimelineResponse>(`/pulse/timeline-by-id/${timelineId}`);
        return response.data;
    },
    /** Find or create a timeline for a phone number, optionally linking to a contact */
    ensureTimeline: async (phone: string, contactId?: number): Promise<{ timelineId: number; contactId: number | null; created: boolean }> => {
        const response = await apiClient.post<{ timelineId: number; contactId: number | null; created: boolean }>('/pulse/ensure-timeline', { phone, contactId });
        return response.data;
    },

    // ─── Action Required ───

    /** Mark thread as handled: clears action_required + closes open task */
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
};
