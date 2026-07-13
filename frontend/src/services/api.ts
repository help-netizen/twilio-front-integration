import axios from 'axios';
import type {
    Call, CallsResponse, ActiveCallsResponse, ByContactResponse,
    CallEventsResponse, CallMedia,
} from '../types/models';
import { getAuthHeaders, getKeycloak } from '../auth/AuthProvider';
import { requireTwoFactor } from './twoFactorGate';

const API_BASE_URL = import.meta.env.VITE_API_URL || '/api';
const FEATURE_AUTH = import.meta.env.VITE_FEATURE_AUTH_ENABLED === 'true';

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
    async (error) => {
        const status = error.response?.status;
        const original = error.config;
        // AUTH-2FA-GATE (BUG-22 hotfix): a 401 PHONE_VERIFICATION_REQUIRED is NOT a
        // dead session — the token is fine, the DEVICE is untrusted. Dispatching
        // session-expired here sent the app to kc.login(); with a live SSO session
        // Keycloak bounced straight back → infinite reload loop + an otp/send per
        // cycle. Route it to the same global 2FA gate authedFetch uses, then retry
        // once with the fresh trust cookie. (Mirror of apiClient.ts authedFetch.)
        if (status === 401 && error.response?.data?.code === 'PHONE_VERIFICATION_REQUIRED'
            && original && !(original as any).__tfaRetried) {
            (original as any).__tfaRetried = true;
            await requireTwoFactor();              // resolves once the device is trusted
            return apiClient.request(original);    // retry once with the new cookie
        }
        // A 401 on a cold page load is usually a token race / near-expiry, NOT a
        // dead session. Force-refresh the token and retry ONCE before declaring the
        // session expired — otherwise a deep-link refresh blanks the page (the
        // "session expired" symptom) while a warm client-nav works fine.
        if (status === 401 && FEATURE_AUTH && original && !(original as any).__authRetried) {
            (original as any).__authRetried = true;
            try {
                await getKeycloak().updateToken(-1); // force refresh
                const h = getAuthHeaders();
                if (h.Authorization) {
                    original.headers = original.headers || {};
                    original.headers.Authorization = h.Authorization;
                }
                return await apiClient.request(original); // retry once with a fresh token
            } catch {
                console.warn('[API] 401 — token refresh failed, session expired');
                window.dispatchEvent(new CustomEvent('auth:session-expired'));
            }
        } else if (status === 401) {
            // Refresh already attempted (or auth disabled) → genuine session end.
            console.warn('[API] 401 — session expired, redirecting to login');
            window.dispatchEvent(new CustomEvent('auth:session-expired'));
        } else if (status === 403) {
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

    /** Mark a contact as read (team-wide) */
    markContactRead: async (contactId: number): Promise<void> => {
        await apiClient.post(`/calls/contact/${contactId}/mark-read`);
    },

    /** Mark a contact as unread (team-wide) */
    markContactUnread: async (contactId: number): Promise<void> => {
        await apiClient.post(`/calls/contact/${contactId}/mark-unread`);
    },

    /** Mark a timeline as read (team-wide) */
    markTimelineRead: async (timelineId: number): Promise<void> => {
        await apiClient.post(`/calls/timeline/${timelineId}/mark-read`);
    },

    /** Mark a timeline as unread (team-wide) */
    markTimelineUnread: async (timelineId: number): Promise<void> => {
        await apiClient.post(`/calls/timeline/${timelineId}/mark-unread`);
    },
};

export default apiClient;
