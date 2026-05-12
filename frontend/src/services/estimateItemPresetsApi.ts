import { authedFetch } from './apiClient';

export interface EstimateItemPreset {
    id: number;
    name: string;
    description: string | null;
    default_quantity: number;
    default_unit_price: number;
    default_taxable: boolean;
    usage_count: number;
    last_used_at: string | null;
    archived_at: string | null;
    created_at: string;
    updated_at: string;
}

export interface EstimateItemPresetCreate {
    name: string;
    description?: string | null;
    default_quantity?: number;
    default_unit_price?: number;
    default_taxable?: boolean;
}

const API_BASE = '/api/estimate-item-presets';

async function ok<T>(res: Response): Promise<T> {
    if (!res.ok) {
        const text = await res.text().catch(() => '');
        const err = new Error(`Request failed: ${res.status} ${text}`);
        (err as Error & { status: number }).status = res.status;
        throw err;
    }
    return res.json() as Promise<T>;
}

export async function searchEstimateItemPresets(search = '', limit = 10): Promise<EstimateItemPreset[]> {
    const params = new URLSearchParams();
    if (search) params.set('search', search);
    if (limit) params.set('limit', String(limit));
    const res = await authedFetch(`${API_BASE}?${params.toString()}`);
    const json = await ok<{ items: EstimateItemPreset[] }>(res);
    return json.items;
}

export async function createEstimateItemPreset(payload: EstimateItemPresetCreate): Promise<EstimateItemPreset> {
    const res = await authedFetch(API_BASE, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
    });
    return ok<EstimateItemPreset>(res);
}

export async function recordEstimateItemPresetUsage(id: number): Promise<EstimateItemPreset> {
    const res = await authedFetch(`${API_BASE}/${id}/used`, { method: 'POST' });
    return ok<EstimateItemPreset>(res);
}

export async function archiveEstimateItemPreset(id: number): Promise<EstimateItemPreset> {
    const res = await authedFetch(`${API_BASE}/${id}`, { method: 'DELETE' });
    return ok<EstimateItemPreset>(res);
}
