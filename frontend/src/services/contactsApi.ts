import type {
    ContactsListParams,
    ContactsListResponse,
    ContactDetailResponse,
    SearchCandidatesResponse,
    Contact,
    ContactConflictPayload,
    ContactConflictResolution,
} from '../types/contact';

import { authedFetch } from './apiClient';
import type { SavedPaymentMethod } from '../types/savedCard';

// CONTACT-MERGE-001 — conflict contract types, re-exported so surfaces can import
// everything API-shaped from one module.
export type {
    ContactConflict,
    ContactConflictAttribute,
    ContactConflictParty,
    ContactConflictPartyPhone,
    ContactConflictPartyEmail,
    ContactConflictPayload,
    ContactConflictResolution,
} from '../types/contact';

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
    /**
     * CONTACT-MERGE-001: for 409 `CONTACT_ATTRIBUTE_CONFLICT` this carries the
     * `conflict` sibling of the error envelope ({ conflicts: [...] }) so the
     * conflict flow can open the merge dialog. Undefined for every other error.
     */
    details?: ContactConflictPayload;

    constructor(
        code: string,
        message: string,
        httpStatus: number,
        correlationId: string,
        details?: ContactConflictPayload
    ) {
        super(message);
        this.name = 'ContactsApiError';
        this.code = code;
        this.httpStatus = httpStatus;
        this.correlationId = correlationId;
        this.details = details;
    }
}

async function request<T>(url: string, options?: RequestInit): Promise<T> {
    const res = await authedFetch(url, {
        headers: { 'Content-Type': 'application/json' },
        ...options,
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
export async function listContacts(params: ContactsListParams = {}, signal?: AbortSignal): Promise<ContactsListResponse> {
    const searchParams = new URLSearchParams();
    if (params.search) searchParams.set('search', params.search);
    if (params.offset !== undefined) searchParams.set('offset', String(params.offset));
    if (params.limit !== undefined) searchParams.set('limit', String(params.limit));
    if (params.cursor) searchParams.set('cursor', params.cursor);

    const qs = searchParams.toString();
    return request<ContactsListResponse>(`${API_BASE}${qs ? `?${qs}` : ''}`, { signal });
}

/**
 * Get contact detail with associated leads
 */
export async function getContact(id: number): Promise<ContactDetailResponse> {
    return request<ContactDetailResponse>(`${API_BASE}/${id}`);
}

/**
 * Resolve a durable global contact code → the contact (CONTACT-NUMBERING-001).
 * Returns just the contact (with id + public_code); callers load full detail via getContact(id).
 */
export async function getContactByCode(code: string): Promise<{ ok: true; data: Contact }> {
    return request<{ ok: true; data: Contact }>(`${API_BASE}/by-code/${encodeURIComponent(code)}`);
}

export async function listSavedPaymentMethods(contactId: number): Promise<SavedPaymentMethod[]> {
    const response = await request<{ ok: true; data: SavedPaymentMethod[] }>(
        `${API_BASE}/${contactId}/saved-payment-methods`
    );
    return response.data;
}

export async function removeSavedPaymentMethod(contactId: number, cardId: number): Promise<void> {
    await request<{ ok: true; data: { removed: true } }>(
        `${API_BASE}/${contactId}/saved-payment-methods/${cardId}`,
        { method: 'DELETE' }
    );
}

/**
 * Search for candidate contacts for deduplication (used by create lead form)
 */
export async function searchCandidates(params: {
    q?: string;
    first_name?: string;
    last_name?: string;
    phone?: string;
    email?: string;
}): Promise<SearchCandidatesResponse> {
    const sp = new URLSearchParams();
    if (params.q) sp.set('q', params.q);
    if (params.first_name) sp.set('first_name', params.first_name);
    if (params.last_name) sp.set('last_name', params.last_name);
    if (params.phone) sp.set('phone', params.phone);
    if (params.email) sp.set('email', params.email);
    return request<SearchCandidatesResponse>(`${API_BASE}/search-candidates?${sp.toString()}`);
}

/** Editable contact fields accepted by `PATCH /api/contacts/:id`. */
export type UpdateContactFields = {
    first_name?: string; last_name?: string; company_name?: string;
    phone_e164?: string; secondary_phone?: string; secondary_phone_name?: string;
    email?: string; notes?: string;
    /** Multi-email list (CONTACT-EMAIL-MERGE-001). Exactly one is_primary is enforced server-side. */
    emails?: { email: string; is_primary?: boolean }[];
};

/**
 * Update a contact's fields.
 *
 * CONTACT-MERGE-001: when the save previously 409'd with
 * `CONTACT_ATTRIBUTE_CONFLICT`, the retry re-sends the SAME `fields` plus the
 * user's `resolutions` (strict echo of the detected conflicts). A 409 throws a
 * `ContactsApiError` whose `details` carries the dialog payload.
 */
export async function updateContact(
    contactId: number,
    fields: UpdateContactFields,
    resolutions?: ContactConflictResolution[]
): Promise<{ ok: true; data: { contact: Contact } }> {
    const body = resolutions && resolutions.length > 0 ? { ...fields, resolutions } : fields;
    const res = await authedFetch(`${API_BASE}/${contactId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!data.ok) {
        throw new ContactsApiError(
            data.error.code,
            data.error.message,
            res.status,
            data.error.correlation_id,
            data.conflict ?? undefined
        );
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
