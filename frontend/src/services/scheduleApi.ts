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
    city?: string | null;
    // SCHED-ROUTE-001: geocoding state + generated Maps link (no Google call on read).
    lat: number | null;
    lng: number | null;
    normalized_address: string | null;
    geocoding_status: GeocodingStatus | null;
    google_maps_url: string | null;
    customer_name: string;
    customer_phone: string;
    customer_email: string;
    assigned_techs: Array<{ id: string; name: string }> | null;
    job_type: string | null;
    job_source: string | null;
    tags: string[] | null;
}

export type GeocodingStatus =
    | 'not_geocoded' | 'pending' | 'success' | 'failed' | 'needs_review';

// SCHED-ROUTE-001 FR-009 — a stored leg between two consecutive jobs for one
// technician on one company-local day. Distance/duration are pre-computed
// server-side; the client never calls Google.
export interface RouteSegment {
    id: number;
    technician_id: string;
    schedule_date: string;          // YYYY-MM-DD (company-local)
    from_job_id: number;
    to_job_id: number;
    distance_meters: number | null;
    duration_minutes: number | null;
    travel_mode: string;
    status: 'pending' | 'success' | 'failed' | 'missing_address' | 'address_needs_review' | 'stale';
    calculated_at: string | null;
}

export interface DispatchSettings {
    timezone: string;
    work_start_time: string; // "08:00"
    work_end_time: string;   // "18:00"
    work_days: number[];
    slot_duration: number;
    distance_unit?: 'mi' | 'km';  // SCHED-ROUTE-001 C-13: route-leg distance unit
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

interface RouteSegmentsResponse {
    segments: RouteSegment[];
}

/**
 * Stored route legs for a date range (optionally one technician). No Google
 * call — reads pre-computed segments. Provider scope is enforced server-side
 * (assigned_only sees only own segments).
 */
export async function fetchRouteSegments(
    from: string, to: string, technicianId?: string,
): Promise<RouteSegment[]> {
    const params = new URLSearchParams();
    params.set('from', from);
    params.set('to', to);
    if (technicianId) params.set('technician_id', technicianId);
    const result = await scheduleRequest<RouteSegmentsResponse>(`${SCHEDULE_BASE}/route-segments?${params.toString()}`);
    return result.segments;
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
    assigneeName?: string | null,
): Promise<void> {
    await scheduleRequest<void>(`${SCHEDULE_BASE}/items/${entityType}/${entityId}/reassign`, {
        method: 'PATCH',
        body: JSON.stringify({ assignee_id: assigneeId, assignee_name: assigneeName ?? null }),
    });
}

/** Set the FULL provider list on a job (multi-assign + Save). [] unassigns all.
 *  Pushes the assign/unassign diff to Zenbooker server-side (JOB-PROVIDER-MULTI-001). */
export async function setJobProviders(
    jobId: number,
    providers: { id: string; name: string }[],
): Promise<void> {
    await scheduleRequest<void>(`${SCHEDULE_BASE}/items/job/${jobId}/reassign`, {
        method: 'PATCH',
        body: JSON.stringify({ assignees: providers }),
    });
}

export interface CreateFromSlotPayload {
    title: string;
    start_at: string;
    end_at: string;
    entity_type?: string;
    assigned_provider_id?: string | null;
    // SCHED-ROUTE-001 FR-001.4: provider lane the job was created in (ZenBooker
    // team-member shape); the server resolves the internal crm_users.id mirror.
    assigned_techs?: Array<{ id: string; name: string }>;
    // SCHED-ROUTE-001 FR-001: optional address for the new job. When lat/lng are
    // supplied (from AddressAutocomplete) the server skips the paid geocode.
    address?: string;
    lat?: number | null;
    lng?: number | null;
    normalized_address?: string | null;
    // Structured address parts for best-effort ZenBooker sync (C-12).
    zb_address?: { line1?: string; line2?: string; city?: string; state?: string; postal_code?: string };
}

export async function createFromSlot(payload: CreateFromSlotPayload): Promise<ScheduleItem> {
    return scheduleRequest<ScheduleItem>(`${SCHEDULE_BASE}/items/from-slot`, {
        method: 'POST',
        body: JSON.stringify(payload),
    });
}
