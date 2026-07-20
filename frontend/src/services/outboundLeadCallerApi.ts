/**
 * OUTBOUND-LEAD-CALL-001 — Outbound Lead Caller settings API client.
 * Mirrors mailAgentApi.ts (authedFetch + unwrap).
 */

import { authedFetch } from './apiClient';

export type CallingWindowMode = 'always' | 'custom' | null;

export interface OutboundLeadCallerSettings {
    enabled_sources: string[];
    max_attempts: number;
    backoff_schedule: string[];
    calling_window_mode: CallingWindowMode;
    custom_start_time: string | null;
    custom_end_time: string | null;
    calling_window_work_days: number[] | null;
    updated_at?: string | null;
}

export interface OutboundLeadCallerSettingsInput {
    enabled_sources: string[];
    calling_window_mode: CallingWindowMode;
    custom_start_time?: string | null;
    custom_end_time?: string | null;
    calling_window_work_days?: number[] | null;
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

export async function saveOutboundLeadCallerSettings(
    input: OutboundLeadCallerSettingsInput,
): Promise<OutboundLeadCallerSettings> {
    const res = await authedFetch(`${BASE}/settings`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
    });
    return (await unwrap<{ settings: OutboundLeadCallerSettings }>(res)).settings;
}
