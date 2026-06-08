import type {
    CallFlow, PhoneNumber, AudioAsset, RoutingLogEntry, AgentStatus,
    QueuedCall, DashboardKPI, ProviderInfo, ActiveCallInfo, UserGroup,
    OperationsDashboardData,
} from '../types/telephony';

import { authedFetch } from './apiClient';

// ─── API Base ─────────────────────────────────────────────────────────────────

const API_BASE = '/api';

async function apiFetch<T>(path: string, opts?: RequestInit): Promise<T> {
    const res = await authedFetch(`${API_BASE}${path}`, {
        ...opts,
        headers: {
            'Content-Type': 'application/json',
            ...(opts?.headers || {}),
        },
    });
    if (!res.ok) throw new Error(`API ${res.status}: ${res.statusText}`);
    const json = await res.json();
    return json.data !== undefined ? json.data : json;
}

// ─── Fallback mocks (used when API unavailable during dev) ────────────────────

const MOCK_AUDIO: AudioAsset[] = [
    { id: 'a-1', name: 'Welcome Greeting', category: 'greeting', duration_sec: 8, format: 'mp3', created_at: '2026-02-01' },
    { id: 'a-2', name: 'Hold Music – Jazz', category: 'hold_music', duration_sec: 180, format: 'mp3', created_at: '2026-01-15' },
    { id: 'a-3', name: 'Press 1 for Sales', category: 'ivr_prompt', duration_sec: 5, format: 'mp3', created_at: '2026-02-20' },
    { id: 'a-4', name: 'After Hours Message', category: 'greeting', duration_sec: 15, format: 'mp3', created_at: '2026-03-01' },
    { id: 'a-5', name: 'Thank You TTS', category: 'tts', duration_sec: 3, format: 'wav', created_at: '2026-03-05' },
];

const MOCK_ACTIVE_CALL: ActiveCallInfo = {
    call_sid: 'CA-mock-001', caller: 'John Miller', caller_name: 'John Miller',
    caller_phone: '+1 (555) 111-2222', agent: 'Sarah Johnson', duration_sec: 187,
    direction: 'inbound', status: 'connected', notes: ['Customer asking about repair ETA'],
    timeline: [
        { time: '11:20:15', event: 'Call received' },
        { time: '11:20:18', event: 'Greeting played' },
        { time: '11:20:35', event: 'Transferred to queue' },
        { time: '11:21:10', event: 'Agent answered' },
    ],
};

// ─── Simulated delay ──────────────────────────────────────────────────────

const delay = (ms = 200) => new Promise(r => setTimeout(r, ms));

// ─── API ──────────────────────────────────────────────────────────────────

export const telephonyApi = {
    // Call Flows — real API
    listFlows: async (): Promise<CallFlow[]> => {
        try { return await apiFetch<CallFlow[]>('/call-flows'); }
        catch { await delay(); return []; }
    },
    getFlow: async (id: string): Promise<CallFlow | undefined> => {
        try { return await apiFetch<CallFlow>(`/call-flows/${id}`); }
        catch { await delay(); return undefined; }
    },
    saveFlow: async (id: string, graph: CallFlow['graph']): Promise<void> => {
        await apiFetch<void>(`/call-flows/${id}`, {
            method: 'PUT',
            body: JSON.stringify({ graph }),
        });
    },

    getUserGroup: async (id: string): Promise<UserGroup | undefined> => {
        try { return await apiFetch<UserGroup>(`/user-groups/${id}`); }
        catch { await delay(); return undefined; }
    },

    // Phone Numbers — real API (reads from Twilio-synced phone_number_settings)
    listNumbers: async (): Promise<PhoneNumber[]> => {
        try { return await apiFetch<PhoneNumber[]>('/phone-numbers'); }
        catch { await delay(); return []; }
    },

    // Audio — still mock (no backend yet)
    listAudio: async (): Promise<AudioAsset[]> => { await delay(); return MOCK_AUDIO; },

    // Logs — real API (calls table)
    listLogs: async (params: { dateFrom?: string; dateTo?: string; limit?: number; groupId?: string } = {}): Promise<RoutingLogEntry[]> => {
        const { dateFrom, dateTo, limit = 200, groupId } = params;
        const qs = new URLSearchParams();
        qs.set('limit', String(limit));
        qs.set('root_only', 'true');
        if (dateFrom) qs.set('date_from', dateFrom);
        if (dateTo) qs.set('date_to', dateTo);
        if (groupId) qs.set('group_id', groupId);
        const data = await apiFetch<{ calls: any[]; next_cursor: number | null; count: number }>(
            `/calls?${qs.toString()}`,
        );
        const calls = (data.calls || []).filter((c: any) => !c.parent_call_sid);
        return calls.map((c: any) => {
            let result: RoutingLogEntry['result'] = 'answered';
            if (c.status === 'failed') result = 'error';
            else if (c.status === 'busy' || c.status === 'no-answer' || c.status === 'canceled') result = 'abandoned';
            else if (c.status === 'completed' && !c.answered_at) result = 'voicemail';

            const startedAt = c.started_at || c.created_at;
            const answeredAt = c.answered_at;
            const latencyMs = startedAt && answeredAt
                ? Math.round(new Date(answeredAt).getTime() - new Date(startedAt).getTime())
                : 0;

            const flowPath: string[] = Array.isArray(c.flow_path) && c.flow_path.length > 0
                ? c.flow_path
                : [c.direction === 'inbound' ? 'Inbound' : 'Outbound'];
            if (flowPath.length === 1) {
                if (c.status === 'completed' && c.answered_at) flowPath.push('Connected');
                if (c.duration_sec && c.duration_sec > 0) flowPath.push('In Call');
                flowPath.push(c.status === 'completed' ? 'Completed' : c.status);
            }

            return {
                id: String(c.id),
                session_id: c.call_sid || '',
                caller: c.from_number || '',
                number_called: c.to_number || '',
                group_id: c.routing_group?.id || null,
                group_name: c.routing_group?.name || null,
                result,
                duration_sec: c.duration_sec || 0,
                timestamp: startedAt || '',
                flow_path: flowPath,
                latency_ms: latencyMs,
                direction: c.direction || 'inbound',
                contact_name: c.contact?.full_name || null,
            } as RoutingLogEntry;
        });
    },

    // Provider — real API. Number inventory comes from F017 phone_number_settings.
    getProvider: async (): Promise<ProviderInfo> => {
        return apiFetch<ProviderInfo>('/telephony/provider');
    },

    // Operations — group-aware API
    getOperationsDashboard: async (): Promise<OperationsDashboardData> => {
        return apiFetch<OperationsDashboardData>('/calls/operations-dashboard');
    },
    transferCall: async (callSid: string, targetUserId: string): Promise<void> => {
        await apiFetch<void>(`/calls/${encodeURIComponent(callSid)}/transfer`, {
            method: 'POST',
            body: JSON.stringify({ target_user_id: targetUserId }),
        });
    },
    getAgents: async (): Promise<AgentStatus[]> => {
        const data = await telephonyApi.getOperationsDashboard();
        return data.agents;
    },
    getQueue: async (): Promise<QueuedCall[]> => {
        const data = await telephonyApi.getOperationsDashboard();
        return data.queue;
    },
    getKpis: async (): Promise<DashboardKPI[]> => {
        const data = await telephonyApi.getOperationsDashboard();
        return data.kpis;
    },
    getActiveCall: async (_id: string): Promise<ActiveCallInfo> => { await delay(); return MOCK_ACTIVE_CALL; },

    // Telephony Overview — real API
    getOverview: async (): Promise<{ user_groups_count: number; phone_numbers_count: number; call_flows_count: number }> => {
        try { return await apiFetch('/telephony/overview'); }
        catch { return { user_groups_count: 0, phone_numbers_count: 0, call_flows_count: 0 }; }
    },
};
