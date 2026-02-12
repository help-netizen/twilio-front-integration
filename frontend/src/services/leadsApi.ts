/**
 * Leads API Client
 * Frontend fetch wrapper for /api/leads/* endpoints.
 */

import type {
    LeadsListParams,
    LeadsListResponse,
    LeadDetailResponse,
    LeadMutationResponse,
    CreateLeadInput,
    UpdateLeadInput,
    ApiError,
} from '../types/lead';

const API_BASE = '/api/leads';

import { authedFetch } from './apiClient';

async function request<T>(url: string, options?: RequestInit): Promise<T> {
    const res = await authedFetch(url, {
        headers: { 'Content-Type': 'application/json' },
        ...options,
    });
    const data = await res.json();
    if (!data.ok) {
        const err = data as ApiError;
        throw new LeadsApiError(
            err.error.code,
            err.error.message,
            res.status,
            err.error.correlation_id
        );
    }
    return data as T;
}

export class LeadsApiError extends Error {
    code: string;
    httpStatus: number;
    correlationId: string;

    constructor(code: string, message: string, httpStatus: number, correlationId: string) {
        super(message);
        this.name = 'LeadsApiError';
        this.code = code;
        this.httpStatus = httpStatus;
        this.correlationId = correlationId;
    }
}

/**
 * List leads with filters and pagination
 */
export async function listLeads(params: LeadsListParams): Promise<LeadsListResponse> {
    const searchParams = new URLSearchParams();
    if (params.start_date) searchParams.set('start_date', params.start_date);
    if (params.offset !== undefined) searchParams.set('offset', String(params.offset));
    if (params.records !== undefined) searchParams.set('records', String(params.records));
    if (params.only_open !== undefined) searchParams.set('only_open', String(params.only_open));
    if (params.status) {
        params.status.forEach(s => searchParams.append('status', s));
    }

    return request<LeadsListResponse>(`${API_BASE}?${searchParams.toString()}`);
}

/**
 * Get lead details by UUID
 */
export async function getLeadByUUID(uuid: string): Promise<LeadDetailResponse> {
    return request<LeadDetailResponse>(`${API_BASE}/${encodeURIComponent(uuid)}`);
}

/**
 * Create a new lead
 */
export async function createLead(input: CreateLeadInput): Promise<LeadMutationResponse> {
    return request<LeadMutationResponse>(API_BASE, {
        method: 'POST',
        body: JSON.stringify(input),
    });
}

/**
 * Update lead (PATCH — only changed fields)
 */
export async function updateLead(uuid: string, fields: UpdateLeadInput): Promise<LeadMutationResponse> {
    return request<LeadMutationResponse>(`${API_BASE}/${encodeURIComponent(uuid)}`, {
        method: 'PATCH',
        body: JSON.stringify(fields),
    });
}

/**
 * Mark lead as lost
 */
export async function markLost(uuid: string): Promise<LeadMutationResponse> {
    return request<LeadMutationResponse>(`${API_BASE}/${encodeURIComponent(uuid)}/mark-lost`, {
        method: 'POST',
        body: '{}',
    });
}

/**
 * Activate lead
 */
export async function activateLead(uuid: string): Promise<LeadMutationResponse> {
    return request<LeadMutationResponse>(`${API_BASE}/${encodeURIComponent(uuid)}/activate`, {
        method: 'POST',
        body: '{}',
    });
}

/**
 * Assign user to lead
 */
export async function assignLead(uuid: string, user: string): Promise<LeadMutationResponse> {
    return request<LeadMutationResponse>(`${API_BASE}/${encodeURIComponent(uuid)}/assign`, {
        method: 'POST',
        body: JSON.stringify({ User: user }),
    });
}

/**
 * Unassign user from lead
 */
export async function unassignLead(uuid: string, user: string): Promise<LeadMutationResponse> {
    return request<LeadMutationResponse>(`${API_BASE}/${encodeURIComponent(uuid)}/unassign`, {
        method: 'POST',
        body: JSON.stringify({ User: user }),
    });
}

/**
 * Convert lead to job
 */
export async function convertLead(uuid: string, body: Record<string, unknown> = {}): Promise<LeadMutationResponse> {
    return request<LeadMutationResponse>(`${API_BASE}/${encodeURIComponent(uuid)}/convert`, {
        method: 'POST',
        body: JSON.stringify(body),
    });
}

/**
 * Find the newest lead by phone number (returns lead or null)
 */
export async function getLeadByPhone(phone: string): Promise<LeadDetailResponse> {
    return request<LeadDetailResponse>(`${API_BASE}/by-phone/${encodeURIComponent(phone)}`);
}
