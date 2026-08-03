import { authedFetch } from './apiClient';
import type { ViewDocument } from '../components/apps/AppViewBlocks';

const API_BASE = '/api/apps';

export interface AppRun {
    run_id: string;
    status: 'running' | 'succeeded' | 'failed' | string;
    started_at: string;
    completed_at: string | null;
    duration_ms: number | null;
    gateway_calls: number | null;
    result_bytes: number | null;
    error_code: string | null;
    error_message: string | null;
    has_result: boolean;
    view_document?: ViewDocument | null;
}

export class AppViewApiError extends Error {
    code: string;
    status: number;
    constructor(code: string, message: string, status: number) {
        super(message);
        this.name = 'AppViewApiError';
        this.code = code;
        this.status = status;
    }
}

async function call(path: string, init?: RequestInit): Promise<{ run?: AppRun; runs?: AppRun[] }> {
    const response = await authedFetch(`${API_BASE}${path}`, init);
    let payload: Record<string, unknown> = {};
    try {
        payload = await response.json();
    } catch {
        payload = {};
    }
    if (!response.ok) {
        throw new AppViewApiError(
            typeof payload.code === 'string' ? payload.code : 'REQUEST_FAILED',
            // The service already writes these for a human — the author of the app
            // reads them — so surface them rather than inventing our own wording.
            typeof payload.message === 'string' ? payload.message : 'This app could not be reached.',
            response.status
        );
    }
    return payload as { run?: AppRun; runs?: AppRun[] };
}

export async function runApp(
    installationId: number,
    action?: { id: string; row_key: string }
): Promise<AppRun> {
    const payload = await call(`/installations/${installationId}/runs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(action ? { action } : {}),
    });
    return payload.run as AppRun;
}

export async function fetchLatestAppRun(installationId: number): Promise<AppRun | null> {
    const payload = await call(`/installations/${installationId}/latest`);
    return (payload.run as AppRun) || null;
}

export async function fetchAppRuns(installationId: number): Promise<AppRun[]> {
    const payload = await call(`/installations/${installationId}/runs`);
    return payload.runs || [];
}

export async function fetchAppRun(installationId: number, runId: string): Promise<AppRun> {
    const payload = await call(`/installations/${installationId}/runs/${runId}`);
    return payload.run as AppRun;
}

/** APP-VIEW-001 phase B: the cadence a tenant picks, and what it will cost. */
export type Cadence =
    | { kind: 'every_minutes'; n: number }
    | { kind: 'hourly'; minute: number }
    | { kind: 'daily'; at: string }
    | { kind: 'weekly'; dow: number; at: string }
    | { kind: 'monthly'; dom: number; at: string };

export interface CostForecast {
    runs_per_day: number;
    runs_per_month: number;
    maximum_data_reads_per_month: number;
    maximum_compute_ms_per_day: number;
    warnings: string[];
}

export interface AppSchedule {
    enabled: boolean;
    cadence: Cadence | null;
    next_run_at: string | null;
    last_run_at: string | null;
    last_status: string | null;
    failure_count: number;
    suspended_reason: string | null;
    timezone: string;
    cost_forecast: CostForecast | null;
}

export interface AppVersionState {
    current: { version_id: string; version_number: string; consented_tools: string[] };
    update_available: boolean;
    available: {
        version_id: string;
        version_number: string;
        tools: string[];
        suggested_schedule: Cadence | null;
    } | null;
}

export interface AppScheduleResponse {
    schedule: AppSchedule;
    version: AppVersionState;
}

export async function fetchAppSchedule(installationId: number): Promise<AppScheduleResponse> {
    const response = await authedFetch(`${API_BASE}/installations/${installationId}/schedule`);
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
        throw new AppViewApiError(
            payload.code || 'REQUEST_FAILED',
            payload.message || 'The schedule could not be loaded.',
            response.status
        );
    }
    return payload as AppScheduleResponse;
}

export async function saveAppSchedule(
    installationId: number,
    body: { enabled: boolean; cadence: Cadence | null }
): Promise<AppScheduleResponse> {
    const response = await authedFetch(`${API_BASE}/installations/${installationId}/schedule`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
        throw new AppViewApiError(
            payload.code || 'REQUEST_FAILED',
            payload.message || 'The schedule could not be saved.',
            response.status
        );
    }
    return payload as AppScheduleResponse;
}

export async function acceptAppVersion(installationId: number, versionId: string): Promise<AppVersionState> {
    const response = await authedFetch(`${API_BASE}/installations/${installationId}/accept-version`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ version_id: versionId }),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
        throw new AppViewApiError(
            payload.code || 'REQUEST_FAILED',
            payload.message || 'This version could not be accepted.',
            response.status
        );
    }
    return (payload as { version: AppVersionState }).version;
}
