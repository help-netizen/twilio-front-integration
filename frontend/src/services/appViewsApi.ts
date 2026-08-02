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

export async function runApp(installationId: number): Promise<AppRun> {
    const payload = await call(`/installations/${installationId}/runs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
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
