import axios from 'axios';
import type {
    Call, CallsResponse, ActiveCallsResponse, ByContactResponse,
    CallEventsResponse, CallMedia,
} from '../types/models';
import { getAuthHeaders } from '../auth/AuthProvider';

const API_BASE_URL = import.meta.env.VITE_API_URL || '/api';

const apiClient = axios.create({
    baseURL: API_BASE_URL,
    headers: { 'Content-Type': 'application/json' },
});

// Inject Keycloak Bearer token into every request when auth is enabled
apiClient.interceptors.request.use((config) => {
    const authHeaders = getAuthHeaders();
    if (authHeaders.Authorization) {
        config.headers.Authorization = authHeaders.Authorization;
    }
    return config;
});

// Handle 401 (expired/invalid token) and 403 (insufficient permissions)
apiClient.interceptors.response.use(
    (response) => response,
    (error) => {
        if (error.response?.status === 401) {
            // Session expired → redirect to login
            console.warn('[API] 401 — session expired, redirecting to login');
            window.dispatchEvent(new CustomEvent('auth:session-expired'));
        } else if (error.response?.status === 403) {
            // Access denied → notify UI
            const message = error.response?.data?.message || 'Access denied';
            console.warn('[API] 403 — access denied:', message);
            window.dispatchEvent(new CustomEvent('auth:access-denied', { detail: { message } }));
        }
        return Promise.reject(error);
    }
);

// Calls API (v3)
export const callsApi = {
    /** Cursor-paginated call list */
    getAll: async (cursor?: number, limit = 50): Promise<CallsResponse> => {
        const params: Record<string, any> = { limit };
        if (cursor) params.cursor = cursor;
        const response = await apiClient.get<CallsResponse>('/calls', { params });
        return response.data;
    },

    /** Active (non-final) calls */
    getActive: async (): Promise<ActiveCallsResponse> => {
        const response = await apiClient.get<ActiveCallsResponse>('/calls/active');
        return response.data;
    },

    /** Calls grouped by contact (conversations replacement) */
    getByContact: async (limit = 50, offset = 0, search?: string): Promise<ByContactResponse> => {
        const params: Record<string, any> = { limit, offset };
        if (search) params.search = search;
        const response = await apiClient.get<ByContactResponse>('/calls/by-contact', {
            params,
        });
        return response.data;
    },

    /** All calls for a specific contact */
    getByContactId: async (contactId: number): Promise<Call[]> => {
        const response = await apiClient.get<{ calls: Call[] }>(`/calls/contact/${contactId}`);
        return response.data.calls;
    },

    /** Single call by call_sid */
    getByCallSid: async (callSid: string): Promise<Call> => {
        const response = await apiClient.get<{ call: Call }>(`/calls/${callSid}`);
        return response.data.call;
    },

    /** Recordings + transcripts for a call */
    getMedia: async (callSid: string): Promise<CallMedia> => {
        const response = await apiClient.get<{ media: CallMedia }>(`/calls/${callSid}/media`);
        return response.data.media;
    },

    /** Event history for a call */
    getEvents: async (callSid: string): Promise<CallEventsResponse> => {
        const response = await apiClient.get<CallEventsResponse>(`/calls/${callSid}/events`);
        return response.data;
    },
};

export default apiClient;
