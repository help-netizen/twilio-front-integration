/**
 * useAutonomousMode — company-wide telephony autonomous-mode flag
 * (TELEPHONY-AUTONOMOUS-MODE-001).
 *
 * When ON, all incoming calls are routed through the After-Hours branch. The flag
 * is company-wide operational status, so it is readable by ANY authenticated user
 * and surfaced app-wide by the bottom banner.
 *
 * Delivery = fetch-once-at-shell-mount + refetch-after-toggle (the MVP). We do NOT
 * refetch on every route change — the value is cached in state for the session. The
 * user who toggles sees the banner immediately (setAutonomousMode updates state on
 * success); other users pick it up on their next load/navigation that remounts the
 * shell. Real-time SSE fan-out is a deliberate nice-to-have left out of the MVP.
 *
 * Intended to be called ONCE, in the app shell (AppLayout), and its return value
 * threaded to the banner + the telephony toggle page.
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { useAuth } from '../auth/AuthProvider';
import { getAutonomousMode, setAutonomousModeApi } from '../services/autonomousModeApi';

export interface UseAutonomousMode {
    /** Current company-wide flag. `false` until the first fetch resolves. */
    autonomousMode: boolean;
    /** True while the initial fetch is in flight. */
    loading: boolean;
    /** Re-read the flag from the server. */
    refetch: () => void;
    /** Persist a new value (PATCH); resolves to the server-echoed value. Updates local state on success. */
    setAutonomousMode: (on: boolean) => Promise<boolean>;
}

export function useAutonomousMode(): UseAutonomousMode {
    // Only fetch once we have a company (auth resolved); avoids a spurious 401 on
    // the cold, pre-auth render.
    const { company } = useAuth();
    const [autonomousMode, setState] = useState(false);
    const [loading, setLoading] = useState(true);
    const mounted = useRef(true);

    useEffect(() => {
        mounted.current = true;
        return () => { mounted.current = false; };
    }, []);

    const load = useCallback(() => {
        if (!company) { setLoading(false); return; }
        setLoading(true);
        getAutonomousMode()
            .then(on => { if (mounted.current) setState(on); })
            .catch(() => { /* endpoint may not be live yet — leave prior/default value */ })
            .finally(() => { if (mounted.current) setLoading(false); });
    }, [company]);

    // Fetch once when the shell mounts (and if the company identity changes).
    useEffect(() => { load(); }, [load]);

    const setAutonomousMode = useCallback(async (on: boolean) => {
        const next = await setAutonomousModeApi(on);
        if (mounted.current) setState(next);
        return next;
    }, []);

    return { autonomousMode, loading, refetch: load, setAutonomousMode };
}
