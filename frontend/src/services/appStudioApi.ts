import { authedFetch } from './apiClient';

const API_BASE = '/api/app-studio';

export interface AppStudioChat {
    id: string;
    app_id: string | null;
    title: string;
    app_name?: string | null;
    message_count?: number;
    created_at?: string;
    updated_at?: string;
}

export interface AppStudioMessage {
    id: string;
    role: 'user' | 'assistant';
    text: string;
    model?: string | null;
    token_usage?: Record<string, number>;
    version_id?: string | null;
    created_at?: string;
}

export interface AppStudioVersion {
    id: string;
    version_number: string;
    status: string;
    tools: string[];
    source_sha256?: string;
    scanner_report?: Record<string, unknown>;
    created_at?: string;
}

export interface GenerationResult {
    generation_status: 'created' | 'failed';
    message: AppStudioMessage;
    app_id: string | null;
    version: AppStudioVersion | null;
    error?: { code: string };
}

interface ErrorPayload {
    code?: string;
    message?: string;
    message_record?: AppStudioMessage;
}

export class AppStudioApiError extends Error {
    status: number;
    code: string;
    messageRecord?: AppStudioMessage;

    constructor(status: number, payload: ErrorPayload) {
        super(payload.message || 'App Studio request failed.');
        this.name = 'AppStudioApiError';
        this.status = status;
        this.code = payload.code || 'APP_STUDIO_REQUEST_FAILED';
        this.messageRecord = payload.message_record;
    }
}

async function requestJson<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await authedFetch(`${API_BASE}${path}`, {
        ...init,
        headers: {
            'Content-Type': 'application/json',
            ...(init?.headers || {}),
        },
    });
    let payload: unknown = {};
    try {
        payload = await response.json();
    } catch { /* normalized below */ }
    if (!response.ok) throw new AppStudioApiError(response.status, payload as ErrorPayload);
    return payload as T;
}

export async function listAppStudioChats(): Promise<AppStudioChat[]> {
    const payload = await requestJson<{ chats: AppStudioChat[] }>('/chats');
    return payload.chats;
}

export async function createAppStudioChat(): Promise<AppStudioChat> {
    const payload = await requestJson<{ chat: AppStudioChat }>('/chats', {
        method: 'POST',
        body: JSON.stringify({ title: 'New app' }),
    });
    return payload.chat;
}

export async function getAppStudioMessages(chatId: string): Promise<{
    chat: AppStudioChat;
    messages: AppStudioMessage[];
}> {
    return requestJson(`/chats/${encodeURIComponent(chatId)}/messages`);
}

export async function sendAppStudioMessage(chatId: string, text: string): Promise<GenerationResult> {
    return requestJson(`/chats/${encodeURIComponent(chatId)}/messages`, {
        method: 'POST',
        body: JSON.stringify({ text }),
    });
}

export async function listAppStudioVersions(appId: string): Promise<{
    app: { app_id: string; name: string };
    versions: AppStudioVersion[];
}> {
    return requestJson(`/apps/${encodeURIComponent(appId)}/versions`);
}
