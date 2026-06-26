import { authedFetch } from './apiClient';

// ─── REC-SETTINGS-001 — per-company recommendation settings ───────────────────
// Reads/writes the 5 user-editable parameters that feed the slot-recommendation
// engine (Settings → Technicians). Permission (tenant.company.manage) is enforced
// server-side. Mirrors technicianBaseLocationsApi.ts: authedFetch from ./apiClient,
// unwrap json.data, throw on the { ok:false, error } envelope.

export interface SlotEngineSettings {
    max_distance_miles: number;
    overlap_minutes: number;
    min_buffer_minutes: number;
    horizon_days: number;
    recommendations_shown: number;
}

/** Server-side defaults, mirrored for first-paint / load-failure fallback. */
export const SLOT_ENGINE_SETTINGS_DEFAULTS: SlotEngineSettings = {
    max_distance_miles: 10,
    overlap_minutes: 0,
    min_buffer_minutes: 15,
    horizon_days: 3,
    recommendations_shown: 3,
};

/** Inclusive integer ranges, mirrored for client-side hints (server is authoritative). */
export const SLOT_ENGINE_SETTINGS_RANGES: Record<keyof SlotEngineSettings, { min: number; max: number }> = {
    max_distance_miles: { min: 1, max: 100 },
    overlap_minutes: { min: 0, max: 240 },
    min_buffer_minutes: { min: 0, max: 240 },
    horizon_days: { min: 1, max: 14 },
    recommendations_shown: { min: 1, max: 10 },
};

/**
 * Error thrown when the server rejects a save. Carries the server's `message` (and
 * `field`/`code` when present) so the form can surface a precise validation message.
 */
export class SlotEngineSettingsError extends Error {
    code?: string;
    field?: string;
    status: number;
    constructor(message: string, opts: { code?: string; field?: string; status: number }) {
        super(message);
        this.name = 'SlotEngineSettingsError';
        this.code = opts.code;
        this.field = opts.field;
        this.status = opts.status;
    }
}

export const slotEngineSettingsApi = {
    /** GET resolved settings (always the full 5 keys — row or server defaults). */
    get: async (): Promise<SlotEngineSettings> => {
        const res = await authedFetch('/api/settings/slot-engine-settings');
        const json = await res.json().catch(() => ({}));
        if (!res.ok || json.ok === false) {
            throw new SlotEngineSettingsError(
                json.error?.message || `Request failed: ${res.status}`,
                { code: json.error?.code, field: json.error?.field, status: res.status },
            );
        }
        return json.data as SlotEngineSettings;
    },

    /** PUT all 5 keys; resolves to the saved values, throws SlotEngineSettingsError on 422. */
    save: async (body: SlotEngineSettings): Promise<SlotEngineSettings> => {
        const res = await authedFetch('/api/settings/slot-engine-settings', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
        const json = await res.json().catch(() => ({}));
        if (!res.ok || json.ok === false) {
            throw new SlotEngineSettingsError(
                json.error?.message || `Save failed: ${res.status}`,
                { code: json.error?.code, field: json.error?.field, status: res.status },
            );
        }
        return json.data as SlotEngineSettings;
    },
};
