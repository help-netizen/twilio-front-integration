/**
 * Team roster + zip lookup API client.
 * ZB-DECOUPLE F1: the dispatch roster now lives at the native /api/team path
 * (the old /api/zenbooker alias still resolves for the deployed mobile app).
 */

import { authedFetch } from './apiClient';

const TEAM_BASE = '/api/team';

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
// ZB-DECOUPLE C4b (2026-08-09): the ZB territory/timeslot surface
// (ServiceTerritory/ServiceAreaResult/Timeslot* types, checkServiceArea,
// getTimeslots) is GONE — the convert wizards run on the native
// slot-recommendation engine and native conversion. What remains here:
// checkZipCode (a LOCAL /api/zip-check lookup, not ZB) and getTeamMembers
// (mode-aware roster since C1). Both go away with the final ZB removal (Phase F).

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

// ─── Team Members (Providers) ─────────────────────────────────────────────────

export interface TeamMember {
    id: string;
    name: string;
    assigned_territories: { id: string; name: string }[];
    calendar_color?: string;
    is_service_provider?: boolean;
}

export async function getTeamMembers(): Promise<TeamMember[]> {
    return zbRequest<TeamMember[]>(`${TEAM_BASE}/team-members`);
}
