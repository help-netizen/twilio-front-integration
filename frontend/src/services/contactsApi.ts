import type {
    ContactsListParams,
    ContactsListResponse,
    ContactDetailResponse,
    SearchCandidatesResponse,
    Contact,
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

/**
 * Search for candidate contacts for deduplication (used by create lead form)
 */
export async function searchCandidates(params: {
    first_name: string;
    last_name: string;
    phone?: string;
    email?: string;
}): Promise<SearchCandidatesResponse> {
    const sp = new URLSearchParams();
    sp.set('first_name', params.first_name);
    sp.set('last_name', params.last_name);
    if (params.phone) sp.set('phone', params.phone);
    if (params.email) sp.set('email', params.email);
    return request<SearchCandidatesResponse>(`${API_BASE}/search-candidates?${sp.toString()}`);
}

/**
 * Update a contact's fields
 */
export async function updateContact(contactId: number, fields: {
    first_name?: string; last_name?: string; company_name?: string;
    phone_e164?: string; secondary_phone?: string; email?: string; notes?: string;
}): Promise<{ ok: true; data: { contact: Contact } }> {
    const res = await authedFetch(`${API_BASE}/${contactId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(fields),
    });
    const data = await res.json();
    if (!data.ok) {
        throw new ContactsApiError(data.error.code, data.error.message, res.status, data.error.correlation_id);
    }
    return data;
}

/**
 * Get saved addresses for a contact
 */
export async function getContactAddresses(contactId: number): Promise<{
    ok: true;
    data: {
        addresses: SavedAddress[];
    };
    meta: { request_id: string; timestamp: string };
}> {
    return request(`${API_BASE}/${contactId}/addresses`);
}

/**
 * Update a saved address for a contact
 */
export async function updateContactAddress(contactId: number, addressId: number, address: {
    street: string; apt: string; city: string; state: string; zip: string;
    lat?: number | null; lng?: number | null; placeId?: string | null;
}): Promise<{ ok: true; data: { addresses: SavedAddress[] } }> {
    const res = await authedFetch(`${API_BASE}/${contactId}/addresses/${addressId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(address),
    });
    const data = await res.json();
    if (!data.ok) {
        throw new ContactsApiError(data.error.code, data.error.message, res.status, data.error.correlation_id);
    }
    return data;
}

export type SavedAddress = {
    id: number;
    contact_id: number;
    label: string | null;
    is_primary: boolean;
    street_line1: string;
    street_line2: string | null;
    city: string;
    state: string;
    postal_code: string;
    country: string;
    google_place_id: string | null;
    lat: number | null;
    lng: number | null;
    display: string;
};

