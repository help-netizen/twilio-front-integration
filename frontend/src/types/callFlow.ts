import type { CallFlowNodeKind } from './callFlowTypes';

// ─── Call Flow Types ──────────────────────────────────────────────────────────

export type CallFlowStatus = 'draft' | 'published' | 'archived';

export interface CallFlow {
    id: string;
    company_id: string;
    title: string;
    description: string;
    active_version_id: string | null;
    active_version_number: number | null;
    status: CallFlowStatus;
    assigned_groups_count: number;
    has_draft: boolean;
    has_validation_errors: boolean;
    created_at: string;
    updated_at: string;
}

export interface CallFlowVersion {
    id: string;
    call_flow_id: string;
    version_number: number;
    status: CallFlowStatus;
    scxml_source: string;
    graph: CallFlowGraph;
    created_by: string;
    created_at: string;
    published_by: string | null;
    published_at: string | null;
    change_note: string;
    validation: CallFlowValidation;
}

export interface CallFlowGraph {
    initialStateId: string;
    states: CallFlowNode[];
    transitions: CallFlowTransition[];
}

export { CallFlowNodeKind };

export interface CallFlowNode {
    id: string;
    name: string;
    kind: CallFlowNodeKind;
    description?: string;
    isInitial?: boolean;
    config?: Record<string, any>;
}

export interface CallFlowTransition {
    id: string;
    from_state_id: string;
    to_state_id: string;
    event_key: string;
    label?: string;
    order?: number;
    condition_type?: string;
}

export interface CallFlowValidation {
    errors: { message: string; nodeId?: string; edgeId?: string }[];
    warnings: { message: string; nodeId?: string; edgeId?: string }[];
}
