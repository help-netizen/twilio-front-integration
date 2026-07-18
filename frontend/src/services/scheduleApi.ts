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

// TECH-DAYOFF-001 — a technician day-off period. `technician_id` is the ZB
// team-member TEXT id (same id space as lanes/providers — INV-7); the interval
// is half-open UTC `[starts_at, ends_at)` and may span midnight / several days.
export interface TimeOffBlock {
    id: string;
    technician_id: string;
    technician_name: string;
    starts_at: string;              // UTC ISO
    ends_at: string;                // UTC ISO
    note?: string | null;
    source: 'individual' | 'company';
    batch_id?: string | null;       // shared by rows of one company-wide create
    created_at?: string;
}

// TECH-SCHEDULE-001 — the read-only availability projection used by schedule
// surfaces, manual warnings, and smart-slot suppression. Only `time_off` rows
// are mutable; `schedule_gap` rows are derived server-side for the read range.
export interface UnavailabilityBlock {
    id: string;
    kind: 'time_off' | 'schedule_gap';
    technician_id: string;
    technician_name: string;
    starts_at: string;
    ends_at: string;
    note?: string | null;
    source: 'individual' | 'company' | 'work_schedule';
    mutable: boolean;
    batch_id?: string | null;
    created_at?: string;
}

export interface TechnicianServiceAreaMatch {
    technician_id: string;
    wildcard: boolean;
    eligible: boolean;
}

export interface TechnicianServiceAreaMatches {
    active_mode: 'list' | 'radius';
    target_resolved: boolean;
    no_targets: boolean;
    target_ids: string[];
    matches: TechnicianServiceAreaMatch[];
}

export type CreateTimeOffPayload =
    | { target: 'technician'; technician_id: string; technician_name: string; starts_at: string; ends_at: string; note?: string }
    | { target: 'company'; starts_at: string; ends_at: string; note?: string };

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

// ── Time off (TECH-DAYOFF-001) ───────────────────────────────────────────────

interface TimeOffListResponse {
    time_off: TimeOffBlock[];
}

interface UnavailabilityListResponse {
    unavailability: UnavailabilityBlock[];
}

/** Combined explicit time off plus recurring schedule gaps over `[from, to)`. */
export async function fetchUnavailability(
    params: { from: string; to: string; technician_id?: string },
): Promise<UnavailabilityBlock[]> {
    const qs = new URLSearchParams();
    qs.set('from', params.from);
    qs.set('to', params.to);
    if (params.technician_id) qs.set('technician_id', params.technician_id);
    const result = await scheduleRequest<UnavailabilityListResponse>(
        `${SCHEDULE_BASE}/unavailability?${qs.toString()}`,
    );
    return result.unavailability;
}

/** Albusto active-mode matches for warning-only manual technician selection. */
export async function fetchTechnicianServiceAreaMatches(input: {
    address?: string;
    lat?: number | null;
    lng?: number | null;
}): Promise<TechnicianServiceAreaMatches> {
    return scheduleRequest<TechnicianServiceAreaMatches>(
        `${SCHEDULE_BASE}/technician-service-area-matches`,
        {
            method: 'POST',
            body: JSON.stringify(input),
        },
    );
}

/**
 * Day-off blocks overlapping `[from, to)` (UTC ISO, both required). Optional
 * `technician_id` narrows to one technician (used by the targeted reschedule
 * warning check). Provider scope is enforced server-side (assigned_only sees
 * only own blocks).
 */
export async function fetchTimeOff(
    params: { from: string; to: string; technician_id?: string },
): Promise<TimeOffBlock[]> {
    const qs = new URLSearchParams();
    qs.set('from', params.from);
    qs.set('to', params.to);
    if (params.technician_id) qs.set('technician_id', params.technician_id);
    const result = await scheduleRequest<TimeOffListResponse>(`${SCHEDULE_BASE}/time-off?${qs.toString()}`);
    return result.time_off;
}

/**
 * Create a day-off period. `target:'technician'` inserts one row;
 * `target:'company'` is materialized server-side into one row per active
 * technician (shared batch_id). Returns the created rows.
 */
export async function createTimeOff(payload: CreateTimeOffPayload): Promise<TimeOffBlock[]> {
    const result = await scheduleRequest<{ created: TimeOffBlock[] }>(`${SCHEDULE_BASE}/time-off`, {
        method: 'POST',
        body: JSON.stringify(payload),
    });
    return result.created;
}

/** Delete ONE day-off row (company batches are deleted row by row). */
export async function deleteTimeOff(id: string): Promise<void> {
    await scheduleRequest<{ deleted: boolean }>(`${SCHEDULE_BASE}/time-off/${id}`, {
        method: 'DELETE',
    });
}

/**
 * THE single front-end overlap definition (TECH-DAYOFF-001): returns the
 * day-off blocks of the given technicians that overlap the half-open interval
 * `[startIso, endIso)`. Strict half-open semantics — touching boundaries
 * (`ends_at === startIso`) are NOT an overlap. Empty array ⇒ no conflict.
 */
export function overlapsTimeOff(
    blocks: TimeOffBlock[],
    techIds: string[],
    startIso: string,
    endIso: string,
): TimeOffBlock[] {
    const start = Date.parse(startIso);
    const end = Date.parse(endIso);
    if (!Number.isFinite(start) || !Number.isFinite(end)) return [];
    return blocks.filter(b =>
        techIds.includes(b.technician_id) &&
        Date.parse(b.starts_at) < end &&
        start < Date.parse(b.ends_at),
    );
}

/** Shared strict half-open overlap rule for the composite availability read. */
export function overlapsUnavailability(
    blocks: UnavailabilityBlock[],
    techIds: string[],
    startIso: string,
    endIso: string,
): UnavailabilityBlock[] {
    const start = Date.parse(startIso);
    const end = Date.parse(endIso);
    if (!Number.isFinite(start) || !Number.isFinite(end)) return [];
    return blocks.filter(block =>
        techIds.includes(block.technician_id)
        && Date.parse(block.starts_at) < end
        && start < Date.parse(block.ends_at),
    );
}

export function unavailabilityLabel(block: Pick<UnavailabilityBlock, 'kind'>): string {
    return block.kind === 'schedule_gap' ? 'Outside work schedule' : 'Time off';
}

export function unavailabilityWarningPhrase(block: Pick<UnavailabilityBlock, 'kind'>): string {
    return block.kind === 'schedule_gap' ? 'is outside their work schedule' : 'has time off';
}
