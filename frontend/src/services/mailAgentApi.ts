/**
 * MAIL-AGENT-001 — Mail Secretary settings/activity API client.
 */

import { authedFetch } from './apiClient';

export interface MailAgentSettings {
    company_id?: string;
    enabled: boolean;
    confidence_threshold: number;
    create_contact_for_unknown: boolean;
    assign_owner_user_id: string | null;
    exclusion_rules: string;
    updated_at: string | null;
}

export interface MailAgentStats {
    reviewed_30d: number;
    tasks_30d: number;
    excluded_30d: number;
    errors_30d: number;
    last_review_at: string | null;
}

export type MailAgentVerdict =
    | 'task_created' | 'skipped_excluded' | 'skipped_no_attention'
    | 'skipped_low_confidence' | 'skipped_unknown_sender' | 'error';

export interface MailAgentReview {
    id: number;
    verdict: MailAgentVerdict;
    category: string | null;
    confidence: number | null;
    reason: string | null;
    rule_line: number | null;
    task_id: number | null;
    model: string | null;
    latency_ms: number | null;
    created_at: string;
    from_name: string | null;
    from_email: string | null;
    subject: string | null;
    timeline_id: number | null;
}

export interface MailAgentDryRunRow {
    from_name: string | null;
    from_email: string | null;
    subject: string | null;
    verdict: MailAgentVerdict;
    category?: string;
    confidence?: number;
    reason?: string;
    rule_line?: number;
}

export interface MailAgentOverview {
    settings: MailAgentSettings;
    stats: MailAgentStats;
    installed: boolean;
    install_status: string | null;
    gmail_connected: boolean;
}

const BASE = '/api/mail-agent';

async function unwrap<T>(res: Response): Promise<T> {
    const json = await res.json().catch(() => null);
    if (!res.ok || !json || json.ok === false) {
        const err: any = new Error(json?.error?.message || `Request failed: ${res.status}`);
        err.code = json?.error?.code;
        err.line = json?.error?.line;
        throw err;
    }
    return json.data as T;
}

export async function getMailAgentOverview(): Promise<MailAgentOverview> {
    return unwrap(await authedFetch(`${BASE}/settings`));
}

export async function saveMailAgentSettings(patch: Partial<MailAgentSettings>): Promise<MailAgentSettings> {
    const res = await authedFetch(`${BASE}/settings`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
    });
    return (await unwrap<{ settings: MailAgentSettings }>(res)).settings;
}

export async function testMailAgentRules(input: { rules: string; from: string; subject: string; body: string }):
    Promise<{ excluded: boolean; rule_line: number | null }> {
    const res = await authedFetch(`${BASE}/test-rules`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
    });
    return unwrap(res);
}

export async function runMailAgentDryRun(limit = 10): Promise<MailAgentDryRunRow[]> {
    const res = await authedFetch(`${BASE}/dry-run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ limit }),
    });
    return (await unwrap<{ results: MailAgentDryRunRow[] }>(res)).results;
}

export async function listMailAgentReviews(limit = 50): Promise<MailAgentReview[]> {
    const res = await authedFetch(`${BASE}/reviews?limit=${limit}`);
    return (await unwrap<{ reviews: MailAgentReview[] }>(res)).reviews;
}
