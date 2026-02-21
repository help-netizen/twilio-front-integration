const API_BASE = '/api/admin/integrations';

export interface Integration {
    id: number;
    client_name: string;
    key_id: string;
    secret?: string; // only present on create response
    scopes: string[];
    created_at: string;
    expires_at: string | null;
    revoked_at: string | null;
    last_used_at: string | null;
    updated_at: string;
}

export interface CreateIntegrationPayload {
    client_name: string;
    scopes?: string[];
    expires_at?: string | null;
}

import { authedFetch } from './apiClient';

async function request<T>(url: string, options?: RequestInit): Promise<T> {
    const res = await authedFetch(url, {
        headers: { 'Content-Type': 'application/json' },
        ...options,
    });
    if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.message || `Request failed: ${res.status}`);
    }
    return res.json();
}

// List all integrations
export async function fetchIntegrations(): Promise<Integration[]> {
    const data = await request<{ integrations: Integration[] }>(API_BASE);
    return data.integrations;
}

// Create a new integration (returns secret ONCE)
export async function createIntegration(payload: CreateIntegrationPayload): Promise<Integration> {
    const data = await request<{ integration: Integration }>(API_BASE, {
        method: 'POST',
        body: JSON.stringify(payload),
    });
    return data.integration;
}

// Revoke an integration
export async function revokeIntegration(keyId: string): Promise<void> {
    await request(`${API_BASE}/${keyId}`, { method: 'DELETE' });
}

// ── Zenbooker Webhook URL ───────────────────────────────────────────────────
const ZB_BASE = '/api/integrations/zenbooker';

export async function fetchWebhookUrl(): Promise<{ url: string; key: string }> {
    const data = await request<{ ok: boolean; data: { url: string; key: string } }>(`${ZB_BASE}/webhook-url`);
    return data.data;
}

export async function regenerateWebhookUrl(): Promise<{ url: string; key: string }> {
    const data = await request<{ ok: boolean; data: { url: string; key: string } }>(`${ZB_BASE}/webhook-url/regenerate`, {
        method: 'POST',
    });
    return data.data;
}
