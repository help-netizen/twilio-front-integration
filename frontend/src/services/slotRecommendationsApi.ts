import { authedFetch } from './apiClient';

// ─── SLOT-ENGINE-001 Phase 3 — slot recommendations ──────────────────────────
// Calls the Albusto slot-recommendation engine. The engine is optional: when the
// marketplace app isn't connected (or anything goes wrong) the UI must degrade
// silently, so this service NEVER throws — it resolves to a disabled result.

export interface SlotRecommendation {
    rank: number;
    date: string;                 // 'YYYY-MM-DD'
    time_frame: { start: string; end: string }; // 'HH:MM'
    technicians: { id: string; name: string }[];
    score: number;
    confidence: string;
    requires_dispatch_confirmation?: boolean;
    feasible_arrival_interval?: { start: string; end: string };
    metrics?: Record<string, unknown>;
    reason_codes?: string[];
    explanation?: string;
}

export interface SlotRecommendationsResult {
    enabled: boolean;
    engine_status?: 'ok' | 'unavailable';
    recommendations: SlotRecommendation[];
    summary?: unknown;
}

export interface SlotRecommendationsInput {
    lat?: number | null;
    lng?: number | null;
    address?: string;
    job_type?: string;
    duration_minutes?: number;
    territory_id?: string;
    earliest_allowed_date?: string;
    latest_allowed_date?: string;
}

const DISABLED: SlotRecommendationsResult = { enabled: false, recommendations: [] };

/**
 * POST /api/schedule/slot-recommendations.
 * Resolves to a disabled result on any HTTP/network error — never throws to the UI.
 */
export async function fetchSlotRecommendations(
    input: SlotRecommendationsInput,
): Promise<SlotRecommendationsResult> {
    // Strip out null/undefined so the body stays clean.
    const new_job: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(input)) {
        if (v !== null && v !== undefined && v !== '') new_job[k] = v;
    }
    try {
        const res = await authedFetch('/api/schedule/slot-recommendations', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ new_job }),
        });
        if (!res.ok) return DISABLED;
        const json = await res.json();
        if (!json?.ok || !json?.data) return DISABLED;
        const data = json.data;
        return {
            enabled: !!data.enabled,
            engine_status: data.engine_status,
            recommendations: Array.isArray(data.recommendations) ? data.recommendations : [],
            summary: data.summary,
        };
    } catch {
        return DISABLED;
    }
}
