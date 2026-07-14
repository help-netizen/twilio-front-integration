/**
 * OUTBOUND-LEAD-CALL-001 — Outbound Lead Caller settings API client.
 * Mirrors mailAgentApi.ts (authedFetch + unwrap).
 */

import { authedFetch } from './apiClient';

export interface OutboundLeadCallerSettings {
    enabled_sources: string[];
    max_attempts: number;
    backoff_schedule: string[];
    updated_at?: string | null;
}

export interface OutboundLeadCallerOverview {
    settings: OutboundLeadCallerSettings;
    installed: boolean;
    install_status: string | null;
    company_sources: string[];
    recent: { status: string; count: number }[];
}

const BASE = '/api/outbound-lead-caller';

async function unwrap<T>(res: Response): Promise<T> {
    const json = await res.json().catch(() => null);
    if (!res.ok || !json || json.ok === false) {
        const err: any = new Error(json?.error?.message || `Request failed: ${res.status}`);
        err.code = json?.error?.code;
        throw err;
    }
    return json.data as T;
}

export async function getOutboundLeadCallerOverview(): Promise<OutboundLeadCallerOverview> {
    return unwrap(await authedFetch(`${BASE}/settings`));
}

export async function saveOutboundLeadCallerSettings(enabledSources: string[]): Promise<OutboundLeadCallerSettings> {
    const res = await authedFetch(`${BASE}/settings`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled_sources: enabledSources }),
    });
    return (await unwrap<{ settings: OutboundLeadCallerSettings }>(res)).settings;
}
