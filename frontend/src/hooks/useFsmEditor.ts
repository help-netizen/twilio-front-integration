import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { authedFetch } from '../services/apiClient';

const API_BASE = import.meta.env.VITE_API_URL || '';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface FsmMachine {
    machine_key: string;
    title: string;
    description: string;
    active_version: {
        version_id: number;
        version_number: number;
        published_at: string;
        published_by: string;
    } | null;
    has_draft: boolean;
    created_at: string;
    updated_at: string;
}

export interface FsmVersion {
    version_id: number;
    version_number: number;
    status: 'draft' | 'published' | 'archived';
    scxml_source: string;
    created_by: string;
    created_at: string;
    published_by: string | null;
    published_at: string | null;
    change_note: string | null;
}

export interface FsmDraft {
    version_id: number;
    scxml_source: string;
    created_at: string;
    created_by: string;
}

export interface FsmActiveVersion {
    version_id: number;
    version_number: number;
    scxml_source: string;
    published_at: string;
    published_by: string;
    change_note: string | null;
}

export interface ValidationError {
    message: string;
    line?: number;
    col?: number;
    severity: string;
}

export interface ValidationResult {
    valid: boolean;
    errors: ValidationError[];
    warnings: ValidationError[];
}

export interface FsmVersionListItem {
    version_id: number;
    version_number: number;
    status: 'draft' | 'published' | 'archived';
    created_by: string;
    created_at: string;
    published_by: string | null;
    published_at: string | null;
    change_note: string | null;
}

export interface FsmVersionsResponse {
    versions: FsmVersionListItem[];
    total: number;
    offset: number;
    limit: number;
}

// ─── Hooks ──────────────────────────────────────────────────────────────────

/**
 * Fetch all FSM machines for the tenant.
 * GET /api/fsm/machines
 */
export function useFsmMachines() {
    return useQuery<FsmMachine[]>({
        queryKey: ['fsm', 'machines'],
        queryFn: async () => {
            const res = await authedFetch(`${API_BASE}/api/fsm/machines`);
            const json = await res.json();
            if (!res.ok || !json.ok) throw new Error(json.error || 'Failed to load FSM machines');
            return (json.data as any[]).map((m: any) => ({
                machine_key: m.machine_key,
                title: m.title,
                description: m.description,
                active_version: m.active_version_id ? {
                    version_id: m.active_version_id,
                    version_number: m.active_version_number,
                    published_at: m.active_published_at,
                    published_by: m.active_published_by,
                } : null,
                has_draft: m.has_draft,
                created_at: m.created_at,
                updated_at: m.updated_at,
            }));
        },
        staleTime: 60_000,
    });
}

/**
 * Fetch the active (published) SCXML version for a machine.
 * GET /api/fsm/:machineKey/active
 */
export function useFsmActiveVersion(machineKey: string | null) {
    return useQuery<FsmActiveVersion | null>({
        queryKey: ['fsm', machineKey, 'active'],
        queryFn: async () => {
            const res = await authedFetch(`${API_BASE}/api/fsm/${machineKey}/active`);
            const json = await res.json();
            if (res.status === 404) return null;
            if (!res.ok || !json.ok) throw new Error(json.error || 'Failed to load active version');
            return json.data;
        },
        enabled: !!machineKey,
    });
}

/**
 * Fetch the current draft for a machine (null if no draft exists).
 * GET /api/fsm/:machineKey/draft
 */
export function useFsmDraft(machineKey: string | null) {
    return useQuery<FsmDraft | null>({
        queryKey: ['fsm', machineKey, 'draft'],
        queryFn: async () => {
            const res = await authedFetch(`${API_BASE}/api/fsm/${machineKey}/draft`);
            const json = await res.json();
            if (!res.ok || !json.ok) throw new Error(json.error || 'Failed to load draft');
            return json.data; // null when no draft
        },
        enabled: !!machineKey,
    });
}

/**
 * Fetch version history for a machine.
 * GET /api/fsm/:machineKey/history
 */
export function useFsmVersions(machineKey: string | null) {
    return useQuery<FsmVersionsResponse>({
        queryKey: ['fsm', machineKey, 'versions'],
        queryFn: async () => {
            const res = await authedFetch(`${API_BASE}/api/fsm/${machineKey}/history`);
            const json = await res.json();
            if (!res.ok || !json.ok) throw new Error(json.error || 'Failed to load version history');
            return json.data;
        },
        enabled: !!machineKey,
    });
}

/**
 * Save (create or update) a draft.
 * PUT /api/fsm/:machineKey/draft
 */
export function useSaveDraft(machineKey: string) {
    const queryClient = useQueryClient();

    return useMutation<{ version_id: number }, Error, { scxml_source: string }>({
        mutationFn: async ({ scxml_source }) => {
            const res = await authedFetch(`${API_BASE}/api/fsm/${machineKey}/draft`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ scxml_source }),
            });
            const json = await res.json();
            if (!res.ok || !json.ok) {
                const err = new Error(json.error || 'Failed to save draft') as Error & { data?: unknown };
                err.data = json.data;
                throw err;
            }
            return json.data;
        },
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ['fsm', machineKey, 'draft'] });
            queryClient.invalidateQueries({ queryKey: ['fsm', 'machines'] });
        },
    });
}

/**
 * Validate SCXML without saving.
 * POST /api/fsm/:machineKey/validate
 */
export function useValidateScxml(machineKey: string) {
    return useMutation<ValidationResult, Error, { scxml_source: string }>({
        mutationFn: async ({ scxml_source }) => {
            const res = await authedFetch(`${API_BASE}/api/fsm/${machineKey}/validate`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ scxml_source }),
            });
            const json = await res.json();
            if (!res.ok || !json.ok) throw new Error(json.error || 'Validation request failed');
            return json.data;
        },
    });
}

/**
 * Publish the current draft.
 * POST /api/fsm/:machineKey/publish
 */
export function usePublishDraft(machineKey: string) {
    const queryClient = useQueryClient();

    return useMutation<{ version_id: number; version_number: number }, Error, { change_note: string }>({
        mutationFn: async ({ change_note }) => {
            const res = await authedFetch(`${API_BASE}/api/fsm/${machineKey}/publish`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ change_note }),
            });
            const json = await res.json();
            if (!res.ok || !json.ok) {
                const err = new Error(json.error || 'Failed to publish draft') as Error & { data?: unknown };
                err.data = json.data;
                throw err;
            }
            return json.data;
        },
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ['fsm', machineKey, 'active'] });
            queryClient.invalidateQueries({ queryKey: ['fsm', machineKey, 'draft'] });
            queryClient.invalidateQueries({ queryKey: ['fsm', machineKey, 'versions'] });
            queryClient.invalidateQueries({ queryKey: ['fsm', 'machines'] });
        },
    });
}

/**
 * Restore a previous version as a new draft.
 * POST /api/fsm/:machineKey/versions/:versionId/restore
 */
export function useRestoreVersion(machineKey: string) {
    const queryClient = useQueryClient();

    return useMutation<{ version_id: number }, Error, { versionId: number }>({
        mutationFn: async ({ versionId }) => {
            const res = await authedFetch(`${API_BASE}/api/fsm/${machineKey}/versions/${versionId}/restore`, {
                method: 'POST',
            });
            const json = await res.json();
            if (!res.ok || !json.ok) throw new Error(json.error || 'Failed to restore version');
            return json.data;
        },
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ['fsm', machineKey, 'draft'] });
            queryClient.invalidateQueries({ queryKey: ['fsm', 'machines'] });
        },
    });
}
