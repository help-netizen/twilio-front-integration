/**
 * automationApi.ts — AUTO-001. Rules engine + agent tasks API client.
 */
import { authedFetch } from './apiClient';

const BASE = '/api/automation';

export interface RuleAction { type: string; params: Record<string, any> }
export interface AutomationRule {
    id: number;
    name: string;
    description: string | null;
    enabled: boolean;
    is_system?: boolean;
    trigger_kind: 'event' | 'schedule';
    event_type: string | null;
    schedule_cron: string | null;
    delay_after_event_type: string | null;
    delay_seconds: number | null;
    conditions: Record<string, any>;
    actions: RuleAction[];
    created_at: string;
}

export interface CatalogEventType { key: string; label: string; sample_fields: string[] }
export interface CatalogActionType { type: string; params: Record<string, string> }
export interface CatalogAgentType { type: string; label: string; input_hint: Record<string, string> }
export interface Catalog {
    event_types: CatalogEventType[];
    action_types: CatalogActionType[];
    agent_types: CatalogAgentType[];
}

export interface RuleRun {
    id: number; status: string; error_text: string | null;
    actions_result: any[]; started_at: string | null; finished_at: string | null; created_at: string;
}

export interface AgentTask {
    id: number; agent_type: string; agent_status: string;
    agent_input: any; agent_output: any; source_rule_id: number | null;
    created_at: string; completed_at: string | null;
}

async function json<T>(p: Promise<Response>): Promise<T> {
    const r = await p; const j = await r.json();
    if (!r.ok || j.ok === false) throw new Error(j.error || `HTTP ${r.status}`);
    return j;
}

export const automationApi = {
    catalog: () => json<{ ok: true } & Catalog>(authedFetch(`${BASE}/catalog`)),
    listRules: () => json<{ rules: AutomationRule[] }>(authedFetch(`${BASE}/rules`)),
    createRule: (rule: Partial<AutomationRule>) =>
        json<{ rule: AutomationRule }>(authedFetch(`${BASE}/rules`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(rule),
        })),
    updateRule: (id: number, patch: Partial<AutomationRule>) =>
        json<{ rule: AutomationRule }>(authedFetch(`${BASE}/rules/${id}`, {
            method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch),
        })),
    deleteRule: (id: number) => json(authedFetch(`${BASE}/rules/${id}`, { method: 'DELETE' })),
    runs: (id: number) => json<{ runs: RuleRun[] }>(authedFetch(`${BASE}/rules/${id}/runs`)),
    seedDefaults: () => json<{ inserted: number }>(authedFetch(`${BASE}/rules/seed-defaults`, { method: 'POST' })),
    agentTasks: (status?: string) =>
        json<{ tasks: AgentTask[] }>(authedFetch(`${BASE}/agent-tasks${status ? `?status=${status}` : ''}`)),
    retryAgentTask: (id: number) =>
        json(authedFetch(`${BASE}/agent-tasks/${id}/retry`, { method: 'POST' })),
};
