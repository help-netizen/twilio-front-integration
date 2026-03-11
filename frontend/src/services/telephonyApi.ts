import type {
    CallFlow, PhoneNumber, AudioAsset, RoutingLogEntry, AgentStatus,
    QueuedCall, DashboardKPI, ProviderInfo, ActiveCallInfo,
} from '../types/telephony';
import { createSkeletonFlow as _createSkeletonFlow } from '../utils/skeletonFlow';
void _createSkeletonFlow; // suppress unused — still needed for future mock fallback

// ─── API Base ─────────────────────────────────────────────────────────────────

const API_BASE = '/api';

async function apiFetch<T>(path: string, opts?: RequestInit): Promise<T> {
    const token = localStorage.getItem('keycloak_token') || '';
    const res = await fetch(`${API_BASE}${path}`, {
        ...opts,
        headers: {
            'Content-Type': 'application/json',
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
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

const MOCK_LOGS: RoutingLogEntry[] = [
    { id: 'rl-1', session_id: 'sess-a1', caller: '+1 (555) 123-4567', number_called: '+1 (617) 555-0101', result: 'answered', duration_sec: 245, timestamp: '2026-03-08 11:23:15', flow_path: ['Start', 'Greeting', 'Menu', 'Queue', 'Agent'], latency_ms: 320 },
    { id: 'rl-2', session_id: 'sess-a2', caller: '+1 (555) 234-5678', number_called: '+1 (617) 555-0102', result: 'voicemail', duration_sec: 62, timestamp: '2026-03-08 11:18:42', flow_path: ['Start', 'Greeting', 'Hours Check', 'Voicemail'], latency_ms: 180 },
    { id: 'rl-3', session_id: 'sess-a3', caller: '+1 (555) 345-6789', number_called: '+1 (617) 555-0101', result: 'abandoned', duration_sec: 30, timestamp: '2026-03-08 10:55:01', flow_path: ['Start', 'Greeting', 'Queue'], latency_ms: 220 },
    { id: 'rl-4', session_id: 'sess-a4', caller: '+1 (555) 456-7890', number_called: '+1 (617) 555-0103', result: 'error', duration_sec: 0, timestamp: '2026-03-08 10:32:18', flow_path: ['Start'], latency_ms: 5200, error: 'Queue timeout exceeded' },
];

const MOCK_PROVIDER: ProviderInfo = {
    name: 'Twilio', status: 'connected', account_sid: 'AC****abcd1234', numbers_synced: 4,
    last_sync: '2026-03-08 06:00:00', error_log: [],
};

const MOCK_AGENTS: AgentStatus[] = [
    { id: 'ag-1', name: 'Sarah Johnson', status: 'available', device_ready: true },
    { id: 'ag-2', name: 'Mike Chen', status: 'on_call', current_call: '+1 (555) 123-4567', device_ready: true },
    { id: 'ag-3', name: 'Lisa Park', status: 'away', device_ready: true },
    { id: 'ag-4', name: 'Tom Rivera', status: 'available', device_ready: false },
];

const MOCK_QUEUE: QueuedCall[] = [
    { id: 'qc-1', caller: '+1 (555) 111-2222', caller_name: 'John Miller', queue_name: 'General', wait_seconds: 45, priority: 'normal' },
    { id: 'qc-2', caller: '+1 (555) 333-4444', caller_name: 'VIP Client', queue_name: 'General', wait_seconds: 120, priority: 'vip' },
    { id: 'qc-3', caller: '+1 (555) 555-6666', queue_name: 'Support', wait_seconds: 15, priority: 'high' },
];

const MOCK_KPIS: DashboardKPI[] = [
    { label: 'Total Calls Today', value: 47, change: '+12%', trend: 'up' },
    { label: 'Avg Wait Time', value: '1m 23s', change: '-8%', trend: 'down' },
    { label: 'Answer Rate', value: '92%', change: '+3%', trend: 'up' },
    { label: 'Active Now', value: 3, trend: 'flat' },
    { label: 'In Queue', value: 3, change: '+1', trend: 'up' },
    { label: 'Missed Today', value: 4, change: '-2', trend: 'down' },
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
        try {
            await apiFetch<void>(`/call-flows/${id}`, {
                method: 'PUT',
                body: JSON.stringify({ graph }),
            });
        } catch { /* silent fallback in dev */ }
    },

    // Phone Numbers — real API (reads from Twilio-synced phone_number_settings)
    listNumbers: async (): Promise<PhoneNumber[]> => {
        try { return await apiFetch<PhoneNumber[]>('/phone-numbers'); }
        catch { await delay(); return []; }
    },

    // Audio — still mock (no backend yet)
    listAudio: async (): Promise<AudioAsset[]> => { await delay(); return MOCK_AUDIO; },

    // Logs — still mock
    listLogs: async (): Promise<RoutingLogEntry[]> => { await delay(); return MOCK_LOGS; },

    // Provider — still mock
    getProvider: async (): Promise<ProviderInfo> => { await delay(); return MOCK_PROVIDER; },

    // Operations — still mock
    getAgents: async (): Promise<AgentStatus[]> => { await delay(); return MOCK_AGENTS; },
    getQueue: async (): Promise<QueuedCall[]> => { await delay(); return MOCK_QUEUE; },
    getKpis: async (): Promise<DashboardKPI[]> => { await delay(); return MOCK_KPIS; },
    getActiveCall: async (_id: string): Promise<ActiveCallInfo> => { await delay(); return MOCK_ACTIVE_CALL; },

    // Telephony Overview — real API
    getOverview: async (): Promise<{ user_groups_count: number; phone_numbers_count: number; call_flows_count: number }> => {
        try { return await apiFetch('/telephony/overview'); }
        catch { return { user_groups_count: 0, phone_numbers_count: 0, call_flows_count: 0 }; }
    },
};
