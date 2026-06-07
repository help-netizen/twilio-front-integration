// ─── Call Flow Types (no versioning — always single current state) ─────────

export type CallFlowNodeKind =
    | 'start' | 'greeting' | 'menu' | 'queue' | 'branch'
    | 'transfer' | 'voicemail' | 'hangup' | 'play_audio' | 'collect_input'
    | 'vapi_agent'
    | 'final';

export interface NodeKindMeta {
    label: string;
    color: string;
    icon: string;
}

export const NODE_KIND_META: Record<CallFlowNodeKind, NodeKindMeta> = {
    start: { label: 'Start', color: '#10b981', icon: '▶' },
    greeting: { label: 'Greeting', color: '#6366f1', icon: '👋' },
    menu: { label: 'IVR Menu', color: '#8b5cf6', icon: '📋' },
    queue: { label: 'Queue', color: '#f59e0b', icon: '📞' },
    branch: { label: 'Branch', color: '#3b82f6', icon: '🔀' },
    transfer: { label: 'Transfer', color: '#06b6d4', icon: '↗️' },
    voicemail: { label: 'Voicemail', color: '#ef4444', icon: '📩' },
    hangup: { label: 'Hang Up', color: '#6b7280', icon: '📵' },
    play_audio: { label: 'Play Audio', color: '#ec4899', icon: '🔊' },
    collect_input: { label: 'Collect Input', color: '#14b8a6', icon: '⌨️' },
    vapi_agent: { label: 'VAPI AI Agent', color: '#7c3aed', icon: '🤖' },
    final: { label: 'Final', color: '#9ca3af', icon: '⏹' },
};

export interface CallFlowNode {
    id: string;
    name: string;
    kind: CallFlowNodeKind;
    isInitial?: boolean;
    protected?: boolean;
    config?: Record<string, unknown>;
    // blanc metadata
    system?: boolean;
    immutable?: boolean;
    deletable?: boolean;
    renamable?: boolean;
    draggable?: boolean;
    uiTerminal?: boolean;
    hidden?: boolean;
    labelExpr?: string;
    groupRef?: string;
    /** Provider name (e.g. 'vapi') — used by AI node kinds */
    provider?: string;
    /** Reference to node config in call_flow_node_configs table */
    configRef?: string;
}

export interface CallFlowTransition {
    id: string;
    from_state_id: string;
    to_state_id: string;
    event_key?: string;
    label?: string;
    // blanc metadata
    system?: boolean;
    immutable?: boolean;
    deletable?: boolean;
    hidden?: boolean;
    insertable?: boolean;
    insertMode?: string;
    edgeLabel?: string;
    branchKey?: string;
    edgeRole?: string;
    transitionMode?: string;
    condExpr?: string;
}

export interface CallFlowGraph {
    states: CallFlowNode[];
    transitions: CallFlowTransition[];
}

export interface CallFlow {
    id: string;
    name: string;
    description: string;
    status: 'active';
    created_at: string;
    updated_at: string;
    graph: CallFlowGraph;
    validation: {
        valid: boolean;
        errors: { message: string }[];
        warnings: { message: string }[];
    };
}

export interface UserGroup {
    id: string;
    name: string;
    desc: string;
    strategy: string;
    members: { id: string; name: string; status: string }[];
    numbers: { id: string; number: string; friendly_name: string }[];
    schedule: {
        timezone: string;
        hours: { day: string; open: string; close: string }[];
    };
    flow: CallFlow | null;
}

// ─── Telephony domain types ───────────────────────────────────────────────────

export interface PhoneNumber {
    id: string;
    number: string;
    friendly_name: string;
    provider: string;
    status: 'active' | 'inactive' | 'pending';
    group_id?: string | null;
    group?: string;
    webhook_configured: boolean;
    last_call_at?: string;
}

export interface AudioAsset {
    id: string;
    name: string;
    category: 'greeting' | 'hold_music' | 'ivr_prompt' | 'tts';
    duration_sec: number;
    format: string;
    created_at: string;
}

export interface RoutingLogEntry {
    id: string;
    session_id: string;
    caller: string;
    number_called: string;
    group_id?: string | null;
    group_name?: string | null;
    result: 'answered' | 'voicemail' | 'abandoned' | 'error';
    duration_sec: number;
    timestamp: string;
    flow_path: string[];
    latency_ms: number;
    error?: string;
    direction?: 'inbound' | 'outbound';
    contact_name?: string | null;
}

export interface AgentStatus {
    id: string;
    name: string;
    status: 'available' | 'on_call' | 'away' | 'offline';
    current_call?: string;
    device_ready: boolean;
    group_id?: string;
    group_name?: string;
    phone_calls_allowed?: boolean;
}

export interface QueuedCall {
    id: string;
    caller: string;
    caller_name?: string;
    queue_name: string;
    group_id?: string;
    group_name?: string;
    called_number?: string;
    call_sid?: string;
    wait_seconds: number;
    priority: 'normal' | 'high' | 'vip';
}

export interface DashboardKPI {
    label: string;
    value: string | number;
    change?: string;
    trend?: 'up' | 'down' | 'flat';
}

export interface ProviderInfo {
    name: string;
    status: 'connected' | 'error' | 'pending';
    account_sid?: string;
    numbers_synced: number;
    last_sync?: string;
    error_log: string[];
}

export interface ActiveCallInfo {
    call_sid: string;
    caller: string;
    caller_name: string;
    caller_phone: string;
    agent: string;
    duration_sec: number;
    direction: 'inbound' | 'outbound';
    status: 'connected' | 'on_hold' | 'transferring';
    notes: string[];
    timeline: { time: string; event: string }[];
}

export interface OperationCall {
    call_sid: string;
    caller: string;
    caller_name?: string | null;
    called_number: string;
    status: string;
    agent_user_id?: string | null;
    wait_seconds: number;
    duration_sec: number;
    current_node_id?: string | null;
    current_node_kind?: string | null;
    flow_path: string[];
}

export interface OperationGroup {
    id: string;
    name: string;
    reachable: boolean;
    agents: AgentStatus[];
    active_calls: OperationCall[];
    queued_calls: OperationCall[];
    waiting_count: number;
    longest_wait_seconds: number;
}

export interface OperationsDashboardData {
    groups: OperationGroup[];
    agents: AgentStatus[];
    queue: QueuedCall[];
    kpis: DashboardKPI[];
}
