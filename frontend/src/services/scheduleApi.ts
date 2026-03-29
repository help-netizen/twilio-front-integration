/**
 * Schedule API Client
 * Frontend fetch wrapper for /api/schedule endpoints.
 */

import { authedFetch } from './apiClient';

const SCHEDULE_BASE = '/api/schedule';

// ── Types ────────────────────────────────────────────────────────────────────

export interface ScheduleItem {
    entity_type: 'job' | 'lead' | 'task';
    entity_id: number;
    title: string;
    subtitle: string;
    status: string;
    start_at: string | null;
    end_at: string | null;
    address_summary: string;
    customer_name: string;
    customer_phone: string;
    customer_email: string;
    assigned_techs: Array<{ id: string; name: string }> | null;
    job_type: string | null;
    job_source: string | null;
    tags: string[] | null;
}

export interface DispatchSettings {
    timezone: string;
    work_start_time: string; // "08:00"
    work_end_time: string;   // "18:00"
    work_days: number[];
    slot_duration: number;
}

export interface ScheduleFilters {
    startDate: string;     // ISO date
    endDate: string;
    entityTypes?: string[];
    statuses?: string[];
    assigneeId?: string;
    unassignedOnly?: boolean;
    search?: string;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

interface ApiResponse<T> {
    ok: boolean;
    data: T;
    error?: { code: string; message: string };
}

async function scheduleRequest<T>(url: string, options?: RequestInit): Promise<T> {
    const res = await authedFetch(url, {
        headers: { 'Content-Type': 'application/json' },
        ...options,
    });
    const json: ApiResponse<T> = await res.json();
    if (!res.ok || !json.ok) throw new Error(json.error?.message || `Schedule API error ${res.status}`);
    return json.data;
}

// ── Public API ───────────────────────────────────────────────────────────────

interface ScheduleItemsResponse {
    items: ScheduleItem[];
    total: number;
}

export async function fetchScheduleItems(filters: ScheduleFilters): Promise<ScheduleItem[]> {
    const params = new URLSearchParams();
    // Backend expects snake_case params
    params.set('start_date', filters.startDate);
    params.set('end_date', filters.endDate);
    if (filters.entityTypes?.length) params.set('entity_types', filters.entityTypes.join(','));
    if (filters.statuses?.length) params.set('statuses', filters.statuses.join(','));
    if (filters.assigneeId) params.set('assignee_id', filters.assigneeId);
    if (filters.unassignedOnly) params.set('unassigned_only', 'true');
    if (filters.search) params.set('search', filters.search);
    const result = await scheduleRequest<ScheduleItemsResponse>(`${SCHEDULE_BASE}?${params.toString()}`);
    return result.items;
}

export async function fetchDispatchSettings(): Promise<DispatchSettings> {
    return scheduleRequest<DispatchSettings>(`${SCHEDULE_BASE}/settings`);
}

export async function updateDispatchSettings(settings: Partial<DispatchSettings>): Promise<DispatchSettings> {
    return scheduleRequest<DispatchSettings>(`${SCHEDULE_BASE}/settings`, {
        method: 'PATCH',
        body: JSON.stringify(settings),
    });
}

export async function rescheduleItem(
    entityType: string,
    entityId: number,
    startAt: string,
    endAt: string,
): Promise<void> {
    await scheduleRequest<void>(`${SCHEDULE_BASE}/items/${entityType}/${entityId}/reschedule`, {
        method: 'PATCH',
        body: JSON.stringify({ start_at: startAt, end_at: endAt }),
    });
}

export async function reassignItem(
    entityType: string,
    entityId: number,
    assigneeId: string,
): Promise<void> {
    await scheduleRequest<void>(`${SCHEDULE_BASE}/items/${entityType}/${entityId}/reassign`, {
        method: 'PATCH',
        body: JSON.stringify({ assignee_id: assigneeId }),
    });
}
