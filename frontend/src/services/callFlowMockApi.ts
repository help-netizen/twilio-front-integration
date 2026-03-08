/**
 * Mock API for Call Flows — will be replaced with real API calls later.
 */
import type { CallFlow, CallFlowVersion, CallFlowGraph, CallFlowValidation } from '../types/callFlow';

const delay = (ms = 300) => new Promise(r => setTimeout(r, ms));

// ─── Sample graph ──────────────────────────────────────────────────────────────

const sampleGraph: CallFlowGraph = {
    initialStateId: 'n-start',
    states: [
        { id: 'n-start', name: 'Start', kind: 'start', isInitial: true },
        { id: 'n-bh', name: 'Business Hours', kind: 'business_hours_root', config: { schedule_id: 's-1' } },
        { id: 'n-greet', name: 'Welcome', kind: 'greeting', config: { tts_text: 'Thank you for calling ABC Homes.' } },
        { id: 'n-route', name: 'Dispatch Team', kind: 'route_user_group', config: { user_group_id: 'ug-1', offer_timeout_sec: 20 } },
        { id: 'n-queue', name: 'Hold Queue', kind: 'queue', config: { max_wait_sec: 120 } },
        { id: 'n-vm', name: 'Voicemail', kind: 'voicemail', config: { transcript_enabled: true } },
        { id: 'n-hangup', name: 'After Hours', kind: 'hangup' },
        { id: 'n-end', name: 'End', kind: 'final' },
    ],
    transitions: [
        { id: 't1', from_state_id: 'n-start', to_state_id: 'n-bh', event_key: 'NEXT', label: 'Start' },
        { id: 't2', from_state_id: 'n-bh', to_state_id: 'n-greet', event_key: 'ON_OPEN', label: 'Open' },
        { id: 't3', from_state_id: 'n-bh', to_state_id: 'n-hangup', event_key: 'ON_CLOSED', label: 'Closed' },
        { id: 't4', from_state_id: 'n-greet', to_state_id: 'n-route', event_key: 'NEXT', label: 'After greeting' },
        { id: 't5', from_state_id: 'n-route', to_state_id: 'n-end', event_key: 'OFFER_ACCEPTED', label: 'Answered' },
        { id: 't6', from_state_id: 'n-route', to_state_id: 'n-queue', event_key: 'OFFER_TIMEOUT', label: 'No answer' },
        { id: 't7', from_state_id: 'n-queue', to_state_id: 'n-end', event_key: 'OFFER_ACCEPTED', label: 'Connected' },
        { id: 't8', from_state_id: 'n-queue', to_state_id: 'n-vm', event_key: 'QUEUE_TIMEOUT', label: 'Queue timeout' },
        { id: 't9', from_state_id: 'n-vm', to_state_id: 'n-end', event_key: 'VOICEMAIL_SAVED', label: 'Saved' },
        { id: 't10', from_state_id: 'n-hangup', to_state_id: 'n-end', event_key: 'HANGUP', label: 'Disconnected' },
    ],
};

const emptyValidation: CallFlowValidation = { errors: [], warnings: [] };

const mockFlows: CallFlow[] = [
    {
        id: 'cf-1', company_id: 'c1', title: 'Main Routing', description: 'Primary inbound call routing with business hours',
        active_version_id: 'cfv-1-pub', active_version_number: 3, status: 'published',
        assigned_groups_count: 1, has_draft: true, has_validation_errors: false,
        created_at: '2026-01-20T10:00:00Z', updated_at: '2026-03-05T10:00:00Z',
    },
    {
        id: 'cf-2', company_id: 'c1', title: 'After Hours Flow', description: 'Direct to voicemail outside business hours',
        active_version_id: 'cfv-2-pub', active_version_number: 1, status: 'published',
        assigned_groups_count: 1, has_draft: false, has_validation_errors: false,
        created_at: '2026-02-10T10:00:00Z', updated_at: '2026-03-01T10:00:00Z',
    },
    {
        id: 'cf-3', company_id: 'c1', title: 'Emergency Override', description: 'Forward all calls to manager',
        active_version_id: null, active_version_number: null, status: 'draft',
        assigned_groups_count: 0, has_draft: true, has_validation_errors: true,
        created_at: '2026-03-01T10:00:00Z', updated_at: '2026-03-08T10:00:00Z',
    },
];

const mockVersions: Record<string, CallFlowVersion[]> = {
    'cf-1': [
        { id: 'cfv-1-draft', call_flow_id: 'cf-1', version_number: 4, status: 'draft', scxml_source: '<scxml/>', graph: sampleGraph, created_by: 'admin', created_at: '2026-03-08T10:00:00Z', published_by: null, published_at: null, change_note: 'WIP: adding queue', validation: { errors: [], warnings: [{ message: 'Queue path without estimated wait copy', nodeId: 'n-queue' }] } },
        { id: 'cfv-1-pub', call_flow_id: 'cf-1', version_number: 3, status: 'published', scxml_source: '<scxml/>', graph: sampleGraph, created_by: 'admin', created_at: '2026-03-05T10:00:00Z', published_by: 'admin', published_at: '2026-03-05T12:00:00Z', change_note: 'Added queue fallback path', validation: emptyValidation },
    ],
    'cf-2': [
        { id: 'cfv-2-pub', call_flow_id: 'cf-2', version_number: 1, status: 'published', scxml_source: '<scxml/>', graph: { initialStateId: 'vm-start', states: [{ id: 'vm-start', name: 'Start', kind: 'start', isInitial: true }, { id: 'vm-vm', name: 'Voicemail', kind: 'voicemail' }, { id: 'vm-end', name: 'End', kind: 'final' }], transitions: [{ id: 'vt1', from_state_id: 'vm-start', to_state_id: 'vm-vm', event_key: 'NEXT' }, { id: 'vt2', from_state_id: 'vm-vm', to_state_id: 'vm-end', event_key: 'VOICEMAIL_SAVED' }] }, created_by: 'admin', created_at: '2026-02-10T10:00:00Z', published_by: 'admin', published_at: '2026-02-10T12:00:00Z', change_note: 'Initial voicemail flow', validation: emptyValidation },
    ],
    'cf-3': [
        { id: 'cfv-3-draft', call_flow_id: 'cf-3', version_number: 1, status: 'draft', scxml_source: '<scxml/>', graph: { initialStateId: 'e-start', states: [{ id: 'e-start', name: 'Start', kind: 'start', isInitial: true }, { id: 'e-fwd', name: 'Forward to Manager', kind: 'forward_external', config: { external_number_e164: '+16175550000' } }], transitions: [{ id: 'et1', from_state_id: 'e-start', to_state_id: 'e-fwd', event_key: 'NEXT' }] }, created_by: 'admin', created_at: '2026-03-01T10:00:00Z', published_by: null, published_at: null, change_note: '', validation: { errors: [{ message: 'Forward node has no fallback/timeout path', nodeId: 'e-fwd' }], warnings: [] } },
    ],
};

export const callFlowApi = {
    async getCallFlows(): Promise<CallFlow[]> {
        await delay();
        return mockFlows;
    },
    async getCallFlow(id: string): Promise<CallFlow | null> {
        await delay();
        return mockFlows.find(f => f.id === id) || null;
    },
    async getVersions(flowId: string): Promise<CallFlowVersion[]> {
        await delay();
        return mockVersions[flowId] || [];
    },
    async getDraft(flowId: string): Promise<CallFlowVersion | null> {
        await delay();
        const versions = mockVersions[flowId] || [];
        return versions.find(v => v.status === 'draft') || null;
    },
    async getPublished(flowId: string): Promise<CallFlowVersion | null> {
        await delay();
        const versions = mockVersions[flowId] || [];
        return versions.find(v => v.status === 'published') || null;
    },
    async saveDraft(flowId: string, graph: CallFlowGraph): Promise<CallFlowVersion> {
        await delay(500);
        const versions = mockVersions[flowId] || [];
        const draft = versions.find(v => v.status === 'draft');
        if (draft) {
            draft.graph = graph;
            draft.created_at = new Date().toISOString();
            return draft;
        }
        const newDraft: CallFlowVersion = {
            id: `cfv-${flowId}-new`, call_flow_id: flowId, version_number: (versions[0]?.version_number || 0) + 1,
            status: 'draft', scxml_source: '<scxml/>', graph, created_by: 'admin',
            created_at: new Date().toISOString(), published_by: null, published_at: null,
            change_note: '', validation: { errors: [], warnings: [] },
        };
        versions.unshift(newDraft);
        return newDraft;
    },
};
