import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { authedFetch } from '../services/apiClient';

const API_BASE = import.meta.env.VITE_API_URL || '';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface FsmAction {
    event: string;
    target: string;
    label: string;
    icon: string | null;
    confirm: boolean;
    confirmText: string | null;
    order: number;
    roles: string | null;
}

export interface TransitionResult {
    previousState: string;
    newState: string;
    entityId: number;
}

export interface OverrideResult {
    previousState: string;
    newState: string;
    entityId: number;
    override: true;
}

// ─── Hooks ──────────────────────────────────────────────────────────────────

/**
 * Fetch available action buttons for a given state.
 * GET /api/fsm/:machineKey/actions?state=X
 */
export function useFsmActions(machineKey: string, currentState: string | null) {
    return useQuery<FsmAction[]>({
        queryKey: ['fsm', machineKey, 'actions', currentState],
        queryFn: async () => {
            const qs = new URLSearchParams({ state: currentState! });
            const res = await authedFetch(`${API_BASE}/api/fsm/${machineKey}/actions?${qs.toString()}`);
            const json = await res.json();
            if (!res.ok || !json.ok) throw new Error(json.error || 'Failed to load actions');
            return json.data;
        },
        enabled: !!currentState,
    });
}

/**
 * Apply a transition event to an entity.
 * POST /api/fsm/:machineKey/apply
 */
export function useApplyTransition(machineKey: string) {
    const queryClient = useQueryClient();

    return useMutation<TransitionResult, Error, { entityId: number; event: string }>({
        mutationFn: async ({ entityId, event }) => {
            const res = await authedFetch(`${API_BASE}/api/fsm/${machineKey}/apply`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ entityId, event }),
            });
            const json = await res.json();
            if (!res.ok || !json.ok) throw new Error(json.error || 'Transition failed');
            return json.data;
        },
        onSuccess: (data) => {
            // Invalidate entity-related queries so the card re-renders with new state
            queryClient.invalidateQueries({ queryKey: [machineKey === 'job' ? 'jobs' : 'leads'] });
            queryClient.invalidateQueries({ queryKey: ['fsm', machineKey, 'actions'] });
            // Invalidate specific entity queries if they exist
            queryClient.invalidateQueries({ queryKey: [machineKey, data.entityId] });
        },
    });
}

/**
 * Force a status change bypassing FSM transition rules.
 * POST /api/fsm/:machineKey/override
 */
/**
 * Fetch all states for a machine (used by override UI).
 * GET /api/fsm/:machineKey/states
 */
export function useFsmStates(machineKey: string, enabled = false) {
    return useQuery<string[]>({
        queryKey: ['fsm', machineKey, 'states'],
        queryFn: async () => {
            const res = await authedFetch(`${API_BASE}/api/fsm/${machineKey}/states`);
            const json = await res.json();
            if (!res.ok || !json.ok) throw new Error(json.error || 'Failed to load states');
            return json.data;
        },
        enabled,
    });
}

export function useOverrideStatus(machineKey: string) {
    const queryClient = useQueryClient();

    return useMutation<OverrideResult, Error, { entityId: number; targetState: string; reason: string }>({
        mutationFn: async ({ entityId, targetState, reason }) => {
            const res = await authedFetch(`${API_BASE}/api/fsm/${machineKey}/override`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ entityId, targetState, reason }),
            });
            const json = await res.json();
            if (!res.ok || !json.ok) throw new Error(json.error || 'Override failed');
            return json.data;
        },
        onSuccess: (data) => {
            queryClient.invalidateQueries({ queryKey: [machineKey === 'job' ? 'jobs' : 'leads'] });
            queryClient.invalidateQueries({ queryKey: ['fsm', machineKey, 'actions'] });
            queryClient.invalidateQueries({ queryKey: [machineKey, data.entityId] });
        },
    });
}
