import { authedFetch } from './apiClient';

const API_BASE = '/api/vapi';

export interface VapiConnection {
    id: string;
    tenant_id: string;
    provider: string;
    environment: 'prod' | 'dev';
    status: 'active' | 'error' | 'disabled' | 'connecting';
    display_name: string | null;
    created_at: string;
    updated_at: string;
}

export interface VapiResource {
    id: string;
    tenant_id: string;
    provider_connection_id: string;
    environment: 'prod' | 'dev';
    vapi_phone_number_id: string | null;
    sip_uri: string | null;
    server_url: string | null;
    is_active: boolean;
    created_at: string;
    updated_at: string;
}

export interface CreateConnectionBody {
    api_key: string;
    display_name?: string;
    environment?: 'prod' | 'dev';
}

export interface CreateResourceBody {
    provider_connection_id: string;
    sip_uri: string;
    server_url?: string;
    environment?: 'prod' | 'dev';
}

async function apiFetch<T>(path: string, opts?: RequestInit): Promise<T> {
    const res = await authedFetch(`${API_BASE}${path}`, {
        ...opts,
        headers: {
            'Content-Type': 'application/json',
            ...(opts?.headers ?? {}),
        },
    });
    const json = await res.json();
    if (!res.ok) {
        throw new Error(json.error || json.message || `Request failed: ${res.status}`);
    }
    return json.data !== undefined ? json.data : json;
}

export const vapiApi = {
    getConnections: (): Promise<VapiConnection[]> =>
        apiFetch<VapiConnection[]>('/connections'),

    createConnection: (body: CreateConnectionBody): Promise<VapiConnection> =>
        apiFetch<VapiConnection>('/connections', {
            method: 'POST',
            body: JSON.stringify(body),
        }),

    getResources: (): Promise<VapiResource[]> =>
        apiFetch<VapiResource[]>('/resources'),

    createResource: (body: CreateResourceBody): Promise<VapiResource> =>
        apiFetch<VapiResource>('/resources', {
            method: 'POST',
            body: JSON.stringify(body),
        }),
};
