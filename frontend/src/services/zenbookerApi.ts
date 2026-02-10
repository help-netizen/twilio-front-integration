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
    id: string;
    start: string;
    end: string;
    type: string;
    formatted: string;
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

export interface ServiceOption {
    option_id: string;
    name: string;
    price: string;
    duration: number;
}

export interface ServiceSection {
    section_id: string;
    section_type: string;
    title: string;
    input_type: string;
    options: ServiceOption[];
}

export interface ZbService {
    service_id: string;
    name: string;
    base_duration: number;
    base_price: string;
    sections?: ServiceSection[];
}

export interface ZbServicesResult {
    results: ZbService[];
}

export interface CreateJobResult {
    job_id: string;
    status: string;
}

// ─── API calls ────────────────────────────────────────────────────────────────

export async function checkServiceArea(postalCode: string): Promise<ServiceAreaResult> {
    return zbRequest<ServiceAreaResult>(
        `${ZB_BASE}/service-area-check?postal_code=${encodeURIComponent(postalCode)}`
    );
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

export async function getServices(): Promise<ZbServicesResult> {
    return zbRequest<ZbServicesResult>(`${ZB_BASE}/services`);
}

export async function createJob(payload: Record<string, unknown>): Promise<CreateJobResult> {
    return zbRequest<CreateJobResult>(`${ZB_BASE}/jobs`, {
        method: 'POST',
        body: JSON.stringify(payload),
    });
}
