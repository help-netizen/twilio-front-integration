import axios from 'axios';
import type {
    Call, CallsResponse, ActiveCallsResponse, ByContactResponse,
    CallEventsResponse, CallMedia,
} from '../types/models';

const API_BASE_URL = import.meta.env.VITE_API_URL || '/api';

const apiClient = axios.create({
    baseURL: API_BASE_URL,
    headers: { 'Content-Type': 'application/json' },
});

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
    getByContact: async (limit = 50, offset = 0): Promise<ByContactResponse> => {
        const response = await apiClient.get<ByContactResponse>('/calls/by-contact', {
            params: { limit, offset },
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
