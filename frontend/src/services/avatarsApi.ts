import { authedFetch } from './apiClient';

const API_BASE = '/api/avatars';

export type AvatarBaseModel = 'chatgpt';
export type AvatarMode = 'mcp';
export type AvatarConnectionStatus = 'connected' | 'disconnected';
export type AvatarPresence = 'active' | 'idle';

export interface MyAvatar {
    connected: boolean;
    base: AvatarBaseModel;
    mode: AvatarMode;
    writes_enabled: boolean;
    sends_enabled: boolean;
}

export interface RosterAvatar {
    owner_user_id: string;
    owner_name: string;
    base: AvatarBaseModel;
    connection_status: AvatarConnectionStatus;
    presence: AvatarPresence;
    is_me: boolean;
}

export interface AvatarsResponse {
    /** True once a tenant admin has enabled Avatars for the company. */
    installation_enabled: boolean;
    /** The caller's own avatar, or null when they have not connected one. */
    me: MyAvatar | null;
    /** Every connected avatar in the company (name + base + status only). */
    roster: RosterAvatar[];
}

async function request<T>(url: string, options?: RequestInit): Promise<T> {
    const res = await authedFetch(url, {
        headers: { 'Content-Type': 'application/json' },
        ...options,
    });
    if (!res.ok) {
        let message = `Request failed (${res.status})`;
        try {
            const body = await res.json();
            message = body?.error || body?.message || message;
        } catch { /* keep default */ }
        throw new Error(message);
    }
    return res.json() as Promise<T>;
}

export async function fetchAvatars(): Promise<AvatarsResponse> {
    return request<AvatarsResponse>(API_BASE);
}

/** Self-consent: toggle Writes on the caller's OWN avatar. */
export async function setMyAvatarWrites(enabled: boolean): Promise<MyAvatar> {
    return request<MyAvatar>(`${API_BASE}/me/writes`, {
        method: 'POST',
        body: JSON.stringify({ enabled }),
    });
}

/** Self-consent: toggle customer Sends on the caller's OWN avatar. */
export async function setMyAvatarSends(enabled: boolean): Promise<MyAvatar> {
    return request<MyAvatar>(`${API_BASE}/me/sends`, {
        method: 'POST',
        body: JSON.stringify({ enabled }),
    });
}

/**
 * Pre-provision the caller's own avatar binding before opening the ChatGPT
 * OAuth connect steps. Idempotent; 409 AVATARS_NOT_ENABLED if an admin has not
 * enabled Avatars for the company.
 */
export async function connectMyAvatar(): Promise<MyAvatar> {
    return request<MyAvatar>(`${API_BASE}/me/connect`, { method: 'POST', body: JSON.stringify({}) });
}

/** Self-revoke the caller's own avatar. */
export async function disconnectMyAvatar(): Promise<void> {
    await request<{ success: true }>(`${API_BASE}/me/disconnect`, { method: 'POST' });
}
