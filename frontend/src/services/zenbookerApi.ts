/**
 * Zenbooker Scheduling API Client
 * Frontend fetch wrapper for /api/zenbooker/* proxy endpoints.
 */

import { authedFetch } from './apiClient';

const ZB_BASE = '/api/zenbooker';

async function zbRequest<T>(url: string, options?: RequestInit): Promise<T> {
    const res = await authedFetch(url, {
        headers: { 'Content-Type': 'application/json' },
        ...options,
    });
    const json = await res.json();
    if (!res.ok || !json.ok) {
        throw new Error(json.error || `Request failed (${res.status})`);
    }
    return json.data as T;
}

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ServiceTerritory {
    id: string;
    name: string;
    timezone: string;
}

export interface ServiceAreaResult {
    in_service_area: boolean;
    service_territory?: ServiceTerritory;
    customer_location?: {
        coordinates: { lat: number; lng: number };
    };
}

export interface Timeslot {
    id?: string;
    start: string;
    end: string;
    type: string;
    formatted: string;
    /** Provider ID selected from the timeline modal */
    techId?: string;
}

export interface TimeslotDay {
    date: string;
    timeslots: Timeslot[];
}

export interface TimeslotsResult {
    territory_id: string;
    timezone: string;
    days: TimeslotDay[];
}

// ZB-DECOUPLE C4a (2026-08-09): the ZbService catalog types, CreateJobResult,
// getServices() and createJob() were removed — zero consumers (native job
// creation goes through jobsApi). Remaining ZB surface here: checkServiceArea +
// getTimeslots (the convert-wizards' booking step — replaced by native
// slot-recommendations in C4b) and getTeamMembers (mode-aware since C1).

// ─── Territory Check (local service_territories lookup) ──────────────────────

export interface ZipCheckResult {
    success: boolean;
    exists: boolean;
    area: string;
    zip: string;
    city: string;
    state: string;
}

export async function checkZipCode(query: string): Promise<ZipCheckResult> {
    return zbRequest<ZipCheckResult>(`/api/zip-check?q=${encodeURIComponent(query)}`);
}

// ─── API calls ────────────────────────────────────────────────────────────────

export async function checkServiceArea(query: string | { postal_code?: string; address?: string }): Promise<ServiceAreaResult> {
    const params = typeof query === 'string'
        ? `postal_code=${encodeURIComponent(query)}`
        : Object.entries(query).filter(([, v]) => v).map(([k, v]) => `${k}=${encodeURIComponent(v!)}`).join('&');
    return zbRequest<ServiceAreaResult>(`${ZB_BASE}/service-area-check?${params}`);
}

export async function getTimeslots(params: {
    territory: string;
    date: string;
    duration: number;
    days?: number;
    lat?: number;
    lng?: number;
}): Promise<TimeslotsResult> {
    const qs = new URLSearchParams();
    qs.set('territory', params.territory);
    qs.set('date', params.date);
    qs.set('duration', String(params.duration));
    if (params.days) qs.set('days', String(params.days));
    if (params.lat) qs.set('lat', String(params.lat));
    if (params.lng) qs.set('lng', String(params.lng));
    return zbRequest<TimeslotsResult>(`${ZB_BASE}/timeslots?${qs.toString()}`);
}

// ─── Team Members (Providers) ─────────────────────────────────────────────────

export interface TeamMember {
    id: string;
    name: string;
    assigned_territories: { id: string; name: string }[];
    calendar_color?: string;
    is_service_provider?: boolean;
}

export async function getTeamMembers(): Promise<TeamMember[]> {
    return zbRequest<TeamMember[]>(`${ZB_BASE}/team-members`);
}
