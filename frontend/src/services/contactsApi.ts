/**
 * Contacts API Client
 * Frontend fetch wrapper for /api/contacts/* endpoints.
 */

import type {
    ContactsListParams,
    ContactsListResponse,
    ContactDetailResponse,
} from '../types/contact';

import { authedFetch } from './apiClient';

const API_BASE = '/api/contacts';

type ApiError = {
    ok: false;
    error: {
        code: string;
        message: string;
        correlation_id: string;
    };
};

export class ContactsApiError extends Error {
    code: string;
    httpStatus: number;
    correlationId: string;

    constructor(code: string, message: string, httpStatus: number, correlationId: string) {
        super(message);
        this.name = 'ContactsApiError';
        this.code = code;
        this.httpStatus = httpStatus;
        this.correlationId = correlationId;
    }
}

async function request<T>(url: string): Promise<T> {
    const res = await authedFetch(url, {
        headers: { 'Content-Type': 'application/json' },
    });
    const data = await res.json();
    if (!data.ok) {
        const err = data as ApiError;
        throw new ContactsApiError(
            err.error.code,
            err.error.message,
            res.status,
            err.error.correlation_id
        );
    }
    return data as T;
}

/**
 * List contacts with optional search and pagination
 */
export async function listContacts(params: ContactsListParams = {}): Promise<ContactsListResponse> {
    const searchParams = new URLSearchParams();
    if (params.search) searchParams.set('search', params.search);
    if (params.offset !== undefined) searchParams.set('offset', String(params.offset));
    if (params.limit !== undefined) searchParams.set('limit', String(params.limit));

    const qs = searchParams.toString();
    return request<ContactsListResponse>(`${API_BASE}${qs ? `?${qs}` : ''}`);
}

/**
 * Get contact detail with associated leads
 */
export async function getContact(id: number): Promise<ContactDetailResponse> {
    return request<ContactDetailResponse>(`${API_BASE}/${id}`);
}
