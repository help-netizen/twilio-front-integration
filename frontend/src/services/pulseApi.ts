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
};
