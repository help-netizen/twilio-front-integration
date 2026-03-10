import type {
    CallFlow, PhoneNumber, AudioAsset, RoutingLogEntry, AgentStatus,
    QueuedCall, DashboardKPI, ProviderInfo, ActiveCallInfo,
} from '../types/telephony';
import { createSkeletonFlow } from '../utils/skeletonFlow';

// ─── Call Flows (no versioning) ────────────────────────────────────────────

const MOCK_FLOWS: CallFlow[] = [
    {
        id: 'cf-1',
        name: 'Sales Team Flow',
        description: 'Skeleton v2 call flow for Sales Team group',
        status: 'published',
        created_at: '2026-02-15',
        updated_at: '2026-03-10',
        graph: createSkeletonFlow('Sales Team'),
        validation: { valid: true, errors: [], warnings: [] },
    },
    {
        id: 'cf-2',
        name: 'Support Team Flow',
        description: 'Skeleton v2 call flow for Support Team group',
        status: 'draft',
        created_at: '2026-03-01',
        updated_at: '2026-03-10',
        graph: createSkeletonFlow('Support Team'),
        validation: { valid: true, errors: [], warnings: [] },
    },
];

// ─── Phone Numbers ────────────────────────────────────────────────────────

const MOCK_NUMBERS: PhoneNumber[] = [
    { id: 'pn-1', number: '+1 (617) 555-0101', friendly_name: 'Main Line', provider: 'Twilio', status: 'active', group: 'Inbound', webhook_configured: true, last_call_at: '2026-03-08 11:23' },
    { id: 'pn-2', number: '+1 (617) 555-0102', friendly_name: 'Sales Line', provider: 'Twilio', status: 'active', group: 'Sales', webhook_configured: true, last_call_at: '2026-03-08 09:15' },
    { id: 'pn-3', number: '+1 (617) 555-0103', friendly_name: 'Support Line', provider: 'Twilio', status: 'active', group: 'Support', webhook_configured: true },
    { id: 'pn-4', number: '+1 (617) 555-0104', friendly_name: 'Test Number', provider: 'Twilio', status: 'inactive', webhook_configured: false },
];

// ─── Audio Assets ─────────────────────────────────────────────────────────

const MOCK_AUDIO: AudioAsset[] = [
    { id: 'a-1', name: 'Welcome Greeting', category: 'greeting', duration_sec: 8, format: 'mp3', created_at: '2026-02-01' },
    { id: 'a-2', name: 'Hold Music – Jazz', category: 'hold_music', duration_sec: 180, format: 'mp3', created_at: '2026-01-15' },
    { id: 'a-3', name: 'Press 1 for Sales', category: 'ivr_prompt', duration_sec: 5, format: 'mp3', created_at: '2026-02-20' },
    { id: 'a-4', name: 'After Hours Message', category: 'greeting', duration_sec: 15, format: 'mp3', created_at: '2026-03-01' },
    { id: 'a-5', name: 'Thank You TTS', category: 'tts', duration_sec: 3, format: 'wav', created_at: '2026-03-05' },
];

// ─── Routing Logs ─────────────────────────────────────────────────────────

const MOCK_LOGS: RoutingLogEntry[] = [
    { id: 'rl-1', session_id: 'sess-a1', caller: '+1 (555) 123-4567', number_called: '+1 (617) 555-0101', result: 'answered', duration_sec: 245, timestamp: '2026-03-08 11:23:15', flow_path: ['Start', 'Greeting', 'Menu', 'Queue', 'Agent'], latency_ms: 320 },
    { id: 'rl-2', session_id: 'sess-a2', caller: '+1 (555) 234-5678', number_called: '+1 (617) 555-0102', result: 'voicemail', duration_sec: 62, timestamp: '2026-03-08 11:18:42', flow_path: ['Start', 'Greeting', 'Hours Check', 'Voicemail'], latency_ms: 180 },
    { id: 'rl-3', session_id: 'sess-a3', caller: '+1 (555) 345-6789', number_called: '+1 (617) 555-0101', result: 'abandoned', duration_sec: 30, timestamp: '2026-03-08 10:55:01', flow_path: ['Start', 'Greeting', 'Queue'], latency_ms: 220 },
    { id: 'rl-4', session_id: 'sess-a4', caller: '+1 (555) 456-7890', number_called: '+1 (617) 555-0103', result: 'error', duration_sec: 0, timestamp: '2026-03-08 10:32:18', flow_path: ['Start'], latency_ms: 5200, error: 'Queue timeout exceeded' },
];

// ─── Provider ─────────────────────────────────────────────────────────────

const MOCK_PROVIDER: ProviderInfo = {
    name: 'Twilio', status: 'connected', account_sid: 'AC****abcd1234', numbers_synced: 4,
    last_sync: '2026-03-08 06:00:00', error_log: [],
};

// ─── Agents ───────────────────────────────────────────────────────────────

const MOCK_AGENTS: AgentStatus[] = [
    { id: 'ag-1', name: 'Sarah Johnson', status: 'available', device_ready: true },
    { id: 'ag-2', name: 'Mike Chen', status: 'on_call', current_call: '+1 (555) 123-4567', device_ready: true },
    { id: 'ag-3', name: 'Lisa Park', status: 'away', device_ready: true },
    { id: 'ag-4', name: 'Tom Rivera', status: 'available', device_ready: false },
];

// ─── Queue ────────────────────────────────────────────────────────────────

const MOCK_QUEUE: QueuedCall[] = [
    { id: 'qc-1', caller: '+1 (555) 111-2222', caller_name: 'John Miller', queue_name: 'General', wait_seconds: 45, priority: 'normal' },
    { id: 'qc-2', caller: '+1 (555) 333-4444', caller_name: 'VIP Client', queue_name: 'General', wait_seconds: 120, priority: 'vip' },
    { id: 'qc-3', caller: '+1 (555) 555-6666', queue_name: 'Support', wait_seconds: 15, priority: 'high' },
];

// ─── KPIs ─────────────────────────────────────────────────────────────────

const MOCK_KPIS: DashboardKPI[] = [
    { label: 'Total Calls Today', value: 47, change: '+12%', trend: 'up' },
    { label: 'Avg Wait Time', value: '1m 23s', change: '-8%', trend: 'down' },
    { label: 'Answer Rate', value: '92%', change: '+3%', trend: 'up' },
    { label: 'Active Now', value: 3, trend: 'flat' },
    { label: 'In Queue', value: 3, change: '+1', trend: 'up' },
    { label: 'Missed Today', value: 4, change: '-2', trend: 'down' },
];

// ─── Active Call ──────────────────────────────────────────────────────────

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
    // Call Flows
    listFlows: async (): Promise<CallFlow[]> => { await delay(); return MOCK_FLOWS; },
    getFlow: async (id: string): Promise<CallFlow | undefined> => { await delay(); return MOCK_FLOWS.find(f => f.id === id); },
    saveFlow: async (_id: string, _graph: CallFlow['graph']): Promise<void> => { await delay(); },

    // Phone Numbers
    listNumbers: async (): Promise<PhoneNumber[]> => { await delay(); return MOCK_NUMBERS; },

    // Audio
    listAudio: async (): Promise<AudioAsset[]> => { await delay(); return MOCK_AUDIO; },

    // Logs
    listLogs: async (): Promise<RoutingLogEntry[]> => { await delay(); return MOCK_LOGS; },

    // Provider
    getProvider: async (): Promise<ProviderInfo> => { await delay(); return MOCK_PROVIDER; },

    // Operations
    getAgents: async (): Promise<AgentStatus[]> => { await delay(); return MOCK_AGENTS; },
    getQueue: async (): Promise<QueuedCall[]> => { await delay(); return MOCK_QUEUE; },
    getKpis: async (): Promise<DashboardKPI[]> => { await delay(); return MOCK_KPIS; },
    getActiveCall: async (_id: string): Promise<ActiveCallInfo> => { await delay(); return MOCK_ACTIVE_CALL; },
};
