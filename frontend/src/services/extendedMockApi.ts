/**
 * Extended mock API for operations and admin pages
 */

const delay = (ms = 300) => new Promise(r => setTimeout(r, ms));

// ─── Phone Numbers ───────────────────────────────────────────────────────────

export interface PhoneNumber {
    id: string;
    number: string;
    friendly_name: string;
    provider: string;
    number_group_id: string;
    number_group_name: string;
    country: string;
    type: 'local' | 'toll_free' | 'mobile';
    inbound_status: 'active' | 'inactive' | 'pending';
    voice_webhook_status: 'configured' | 'not_configured' | 'error';
    last_inbound_call: string | null;
    created_at: string;
}

const mockPhoneNumbers: PhoneNumber[] = [
    { id: 'pn-1', number: '+16175551234', friendly_name: 'Main Line', provider: 'Twilio', number_group_id: 'pg-1', number_group_name: 'Dispatch', country: 'US', type: 'local', inbound_status: 'active', voice_webhook_status: 'configured', last_inbound_call: '2026-03-08T11:30:00Z', created_at: '2025-06-01T00:00:00Z' },
    { id: 'pn-2', number: '+16175555678', friendly_name: 'Sales Line', provider: 'Twilio', number_group_id: 'pg-1', number_group_name: 'Dispatch', country: 'US', type: 'local', inbound_status: 'active', voice_webhook_status: 'configured', last_inbound_call: '2026-03-08T10:15:00Z', created_at: '2025-06-15T00:00:00Z' },
    { id: 'pn-3', number: '+18005559999', friendly_name: 'Toll Free', provider: 'Twilio', number_group_id: 'pg-2', number_group_name: 'Support', country: 'US', type: 'toll_free', inbound_status: 'active', voice_webhook_status: 'configured', last_inbound_call: '2026-03-07T16:45:00Z', created_at: '2025-08-01T00:00:00Z' },
    { id: 'pn-4', number: '+16175550000', friendly_name: 'Emergency', provider: 'Twilio', number_group_id: '', number_group_name: '— Unassigned', country: 'US', type: 'local', inbound_status: 'inactive', voice_webhook_status: 'not_configured', last_inbound_call: null, created_at: '2026-01-15T00:00:00Z' },
    { id: 'pn-5', number: '+447911123456', friendly_name: 'UK Support', provider: 'Twilio', number_group_id: 'pg-2', number_group_name: 'Support', country: 'GB', type: 'mobile', inbound_status: 'active', voice_webhook_status: 'configured', last_inbound_call: '2026-03-06T09:00:00Z', created_at: '2025-11-01T00:00:00Z' },
];

// ─── Audio Assets ────────────────────────────────────────────────────────────

export interface AudioAsset {
    id: string;
    name: string;
    category: 'greeting' | 'voicemail_greeting' | 'hold_music' | 'tts_template';
    duration_sec: number;
    format: string;
    usage_count: number;
    used_in_flows: string[];
    uploaded_by: string;
    created_at: string;
}

const mockAudioAssets: AudioAsset[] = [
    { id: 'aa-1', name: 'Welcome Greeting', category: 'greeting', duration_sec: 8, format: 'mp3', usage_count: 2, used_in_flows: ['Main Routing'], uploaded_by: 'admin', created_at: '2026-01-10T00:00:00Z' },
    { id: 'aa-2', name: 'After Hours Message', category: 'greeting', duration_sec: 15, format: 'mp3', usage_count: 1, used_in_flows: ['After Hours Flow'], uploaded_by: 'admin', created_at: '2026-01-10T00:00:00Z' },
    { id: 'aa-3', name: 'Voicemail Prompt', category: 'voicemail_greeting', duration_sec: 6, format: 'mp3', usage_count: 3, used_in_flows: ['Main Routing', 'After Hours Flow'], uploaded_by: 'admin', created_at: '2026-01-10T00:00:00Z' },
    { id: 'aa-4', name: 'Hold Music - Jazz', category: 'hold_music', duration_sec: 120, format: 'mp3', usage_count: 1, used_in_flows: ['Main Routing'], uploaded_by: 'admin', created_at: '2026-02-01T00:00:00Z' },
    { id: 'aa-5', name: 'Hold Music - Classical', category: 'hold_music', duration_sec: 180, format: 'mp3', usage_count: 0, used_in_flows: [], uploaded_by: 'admin', created_at: '2026-02-15T00:00:00Z' },
    { id: 'aa-6', name: 'Business Hours TTS', category: 'tts_template', duration_sec: 0, format: 'tts', usage_count: 1, used_in_flows: ['Main Routing'], uploaded_by: 'admin', created_at: '2026-03-01T00:00:00Z' },
];

// ─── Provider Settings ───────────────────────────────────────────────────────

export interface ProviderInfo {
    name: string;
    status: 'connected' | 'disconnected' | 'error';
    connection_health: 'healthy' | 'degraded' | 'down';
    last_webhook_received: string | null;
    last_sync: string | null;
    account_sid: string;
    webhook_url: string;
    webhook_signature_valid: boolean;
    numbers_synced: number;
    last_errors: { message: string; timestamp: string }[];
}

const mockProvider: ProviderInfo = {
    name: 'Twilio', status: 'connected', connection_health: 'healthy',
    last_webhook_received: '2026-03-08T12:30:00Z', last_sync: '2026-03-08T12:00:00Z',
    account_sid: 'AC***************************1234',
    webhook_url: 'https://abc-metrics.fly.dev/api/voice/inbound',
    webhook_signature_valid: true, numbers_synced: 5,
    last_errors: [
        { message: 'Timeout on number sync for +447911123456', timestamp: '2026-03-07T09:15:00Z' },
    ],
};

// ─── Routing Logs ────────────────────────────────────────────────────────────

export interface RoutingLogEntry {
    id: string;
    started_at: string;
    caller: string;
    caller_name: string | null;
    called_number: string;
    number_group: string;
    resolved_flow: string;
    flow_version: number;
    result: 'connected' | 'voicemail' | 'abandoned' | 'failed';
    path: string[];
    latency_ms: number;
    provider_status: string;
    error: string | null;
}

const mockRoutingLogs: RoutingLogEntry[] = [
    { id: 'rl-1', started_at: '2026-03-08T12:30:00Z', caller: '+15551234567', caller_name: 'John Smith', called_number: '+16175551234', number_group: 'Dispatch', resolved_flow: 'Main Routing', flow_version: 3, result: 'connected', path: ['Start', 'Business Hours', 'Welcome', 'Dispatch Team'], latency_ms: 45, provider_status: '200 OK', error: null },
    { id: 'rl-2', started_at: '2026-03-08T12:15:00Z', caller: '+15559876543', caller_name: null, called_number: '+16175551234', number_group: 'Dispatch', resolved_flow: 'Main Routing', flow_version: 3, result: 'voicemail', path: ['Start', 'Business Hours', 'Welcome', 'Dispatch Team', 'Hold Queue', 'Voicemail'], latency_ms: 38, provider_status: '200 OK', error: null },
    { id: 'rl-3', started_at: '2026-03-08T11:50:00Z', caller: '+15551112233', caller_name: 'Jane Doe', called_number: '+18005559999', number_group: 'Support', resolved_flow: 'After Hours Flow', flow_version: 1, result: 'voicemail', path: ['Start', 'Voicemail'], latency_ms: 22, provider_status: '200 OK', error: null },
    { id: 'rl-4', started_at: '2026-03-08T11:30:00Z', caller: '+15554445566', caller_name: null, called_number: '+16175555678', number_group: 'Dispatch', resolved_flow: 'Main Routing', flow_version: 3, result: 'abandoned', path: ['Start', 'Business Hours', 'Welcome', 'Dispatch Team', 'Hold Queue'], latency_ms: 40, provider_status: '200 OK', error: null },
    { id: 'rl-5', started_at: '2026-03-08T10:00:00Z', caller: '+15557778899', caller_name: 'Bob', called_number: '+16175550000', number_group: '— Unassigned', resolved_flow: '—', flow_version: 0, result: 'failed', path: [], latency_ms: 5, provider_status: '404', error: 'No flow assigned to number group' },
];

// ─── Queue / Operations ──────────────────────────────────────────────────────

export interface QueuedCall {
    id: string;
    caller_phone: string;
    caller_name: string | null;
    called_number: string;
    number_group: string;
    flow_step: string;
    queued_since: string;
    wait_time_sec: number;
    position: number;
    status: 'queued' | 'offering' | 'reconnecting';
    badges: string[];
}

export interface AgentStatus {
    id: string;
    name: string;
    status: 'online' | 'busy' | 'offline' | 'on_call';
    user_group: string;
    current_calls: number;
    device_ready: boolean;
}

export interface LiveCall {
    id: string;
    caller: string;
    caller_name: string | null;
    callee: string;
    agent: string;
    duration_sec: number;
    state: 'ringing' | 'connected' | 'on_hold';
    number_group: string;
}

export interface DashboardKPIs {
    active_calls_now: number;
    calls_in_queue: number;
    longest_wait_sec: number;
    missed_today: number;
    avg_answer_time_sec: number;
    agents_online: number;
}

const mockQueuedCalls: QueuedCall[] = [
    { id: 'qc-1', caller_phone: '+15551234567', caller_name: 'John Smith', called_number: '+16175551234', number_group: 'Dispatch', flow_step: 'Hold Queue', queued_since: '2026-03-08T12:28:00Z', wait_time_sec: 145, position: 1, status: 'queued', badges: ['repeat caller'] },
    { id: 'qc-2', caller_phone: '+15559876543', caller_name: null, called_number: '+16175551234', number_group: 'Dispatch', flow_step: 'Hold Queue', queued_since: '2026-03-08T12:30:00Z', wait_time_sec: 85, position: 2, status: 'offering', badges: [] },
    { id: 'qc-3', caller_phone: '+15551112233', caller_name: 'Jane Doe', called_number: '+18005559999', number_group: 'Support', flow_step: 'Support Queue', queued_since: '2026-03-08T12:31:00Z', wait_time_sec: 42, position: 1, status: 'queued', badges: ['VIP'] },
];

const mockAgents: AgentStatus[] = [
    { id: 'ag-1', name: 'Alex Johnson', status: 'online', user_group: 'Dispatch', current_calls: 0, device_ready: true },
    { id: 'ag-2', name: 'Maria Garcia', status: 'on_call', user_group: 'Dispatch', current_calls: 1, device_ready: true },
    { id: 'ag-3', name: 'Sam Lee', status: 'online', user_group: 'Support', current_calls: 0, device_ready: true },
    { id: 'ag-4', name: 'Chris Brown', status: 'busy', user_group: 'Dispatch', current_calls: 0, device_ready: false },
    { id: 'ag-5', name: 'Taylor Davis', status: 'offline', user_group: 'Support', current_calls: 0, device_ready: false },
];

const mockLiveCalls: LiveCall[] = [
    { id: 'lc-1', caller: '+15553334444', caller_name: 'Mike Wilson', callee: '+16175551234', agent: 'Maria Garcia', duration_sec: 245, state: 'connected', number_group: 'Dispatch' },
];

const mockDashboardKPIs: DashboardKPIs = {
    active_calls_now: 1, calls_in_queue: 3, longest_wait_sec: 145, missed_today: 4, avg_answer_time_sec: 18, agents_online: 3,
};

// ─── Active Call ─────────────────────────────────────────────────────────────

export interface ActiveCallInfo {
    id: string;
    caller_phone: string;
    caller_name: string | null;
    called_number: string;
    number_group: string;
    state: 'connecting' | 'ringing' | 'connected' | 'on_hold' | 'ended';
    duration_sec: number;
    is_recording: boolean;
    agent: string;
    matched_entity: { type: string; id: string; name: string } | null;
    queue_source: string | null;
    flow_path: string[];
    notes: string;
    previous_calls: number;
}

const mockActiveCall: ActiveCallInfo = {
    id: 'lc-1', caller_phone: '+15553334444', caller_name: 'Mike Wilson',
    called_number: '+16175551234', number_group: 'Dispatch',
    state: 'connected', duration_sec: 245, is_recording: true,
    agent: 'Maria Garcia',
    matched_entity: { type: 'Contact', id: 'ct-42', name: 'Mike Wilson' },
    queue_source: 'Dispatch Queue', flow_path: ['Start', 'Business Hours', 'Welcome', 'Dispatch Team'],
    notes: '', previous_calls: 3,
};

// ─── Exports ─────────────────────────────────────────────────────────────────

export const extendedMockApi = {
    async getPhoneNumbers(): Promise<PhoneNumber[]> { await delay(); return mockPhoneNumbers; },
    async getAudioAssets(): Promise<AudioAsset[]> { await delay(); return mockAudioAssets; },
    async getProviderInfo(): Promise<ProviderInfo> { await delay(); return mockProvider; },
    async getRoutingLogs(): Promise<RoutingLogEntry[]> { await delay(); return mockRoutingLogs; },
    async getQueuedCalls(): Promise<QueuedCall[]> { await delay(); return mockQueuedCalls; },
    async getAgents(): Promise<AgentStatus[]> { await delay(); return mockAgents; },
    async getLiveCalls(): Promise<LiveCall[]> { await delay(); return mockLiveCalls; },
    async getDashboardKPIs(): Promise<DashboardKPIs> { await delay(); return mockDashboardKPIs; },
    async getActiveCall(callId: string): Promise<ActiveCallInfo> { await delay(); return mockActiveCall; },
};
