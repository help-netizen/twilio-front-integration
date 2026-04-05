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
    jobType?: string;
    source?: string;
    providerIds?: string[];
    tags?: string[];
}

// ── Filter persistence ──────────────────────────────────────────────────────

const FILTER_STORAGE_KEY = 'schedule-filters';

export type PersistableFilters = Pick<ScheduleFilters, 'entityTypes' | 'statuses' | 'unassignedOnly' | 'search' | 'jobType' | 'source' | 'providerIds' | 'tags'>;

export function loadPersistedFilters(): Partial<PersistableFilters> {
    try {
        const raw = localStorage.getItem(FILTER_STORAGE_KEY);
        if (!raw) return {};
        return JSON.parse(raw);
    } catch { return {}; }
}

export function persistFilters(filters: Partial<PersistableFilters>): void {
    try {
        const { entityTypes, statuses, unassignedOnly, search, jobType, source, tags } = filters;
        const toSave: Partial<PersistableFilters> = {};
        if (entityTypes?.length) toSave.entityTypes = entityTypes;
        if (statuses?.length) toSave.statuses = statuses;
        if (unassignedOnly) toSave.unassignedOnly = true;
        if (search) toSave.search = search;
        if (jobType) toSave.jobType = jobType;
        if (source) toSave.source = source;
        if (tags?.length) toSave.tags = tags;
        if (Object.keys(toSave).length) {
            localStorage.setItem(FILTER_STORAGE_KEY, JSON.stringify(toSave));
        } else {
            localStorage.removeItem(FILTER_STORAGE_KEY);
        }
    } catch { /* ignore */ }
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
    if (filters.jobType) params.set('job_type', filters.jobType);
    if (filters.source) params.set('source', filters.source);
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
    assigneeId: string | null,
): Promise<void> {
    await scheduleRequest<void>(`${SCHEDULE_BASE}/items/${entityType}/${entityId}/reassign`, {
        method: 'PATCH',
        body: JSON.stringify({ assignee_id: assigneeId }),
    });
}

export interface CreateFromSlotPayload {
    title: string;
    start_at: string;
    end_at: string;
    entity_type?: string;
    assigned_provider_id?: string | null;
}

export async function createFromSlot(payload: CreateFromSlotPayload): Promise<ScheduleItem> {
    return scheduleRequest<ScheduleItem>(`${SCHEDULE_BASE}/items/from-slot`, {
        method: 'POST',
        body: JSON.stringify(payload),
    });
}
