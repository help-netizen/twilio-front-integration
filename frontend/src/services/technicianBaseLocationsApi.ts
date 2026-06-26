import { authedFetch } from './apiClient';

// ─── SLOT-ENGINE-001 Phase 3 — technician base locations ─────────────────────
// CRUD for each technician's "home base" (start/end-of-day location). The slot
// engine uses these to estimate drive time. Permission is enforced server-side
// (tenant.company.manage). Mirrors techniciansApi.ts style.

export interface TechnicianBaseLocation {
    tech_id: string;
    name: string | null;
    lat: number | null;
    lng: number | null;
    label: string | null;
    address: string | null;
    has_base: boolean;
}

export interface TechnicianBaseLocationUpsert {
    lat?: number | null;
    lng?: number | null;
    label?: string;
    address?: string;
}

export const technicianBaseLocationsApi = {
    list: async (): Promise<TechnicianBaseLocation[]> => {
        const res = await authedFetch('/api/settings/technician-base-locations');
        const json = await res.json();
        if (!res.ok || json.ok === false) throw new Error(json.error?.message || `Request failed: ${res.status}`);
        return json.data;
    },

    upsert: async (
        techId: string,
        body: TechnicianBaseLocationUpsert,
    ): Promise<{ tech_id: string; lat: number | null; lng: number | null; label: string | null; address: string | null }> => {
        const res = await authedFetch(`/api/settings/technician-base-locations/${encodeURIComponent(techId)}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
        const json = await res.json();
        if (!res.ok || json.ok === false) throw new Error(json.error?.message || `Save failed: ${res.status}`);
        return json.data;
    },

    remove: async (techId: string): Promise<void> => {
        const res = await authedFetch(`/api/settings/technician-base-locations/${encodeURIComponent(techId)}`, {
            method: 'DELETE',
        });
        const json = await res.json().catch(() => ({ ok: res.ok }));
        if (!res.ok || json.ok === false) throw new Error(json.error?.message || `Delete failed: ${res.status}`);
    },
};
