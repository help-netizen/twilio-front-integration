/**
 * AutonomousModeContext — shares the single useAutonomousMode() instance created
 * in the app shell (AppLayout) with routed children like the telephony settings
 * toggle (TELEPHONY-AUTONOMOUS-MODE-001).
 *
 * The shell owns ONE fetch-on-mount instance; the banner reads it there, and the
 * toggle page reads/writes the SAME instance through this context so toggling
 * updates the banner immediately (shared state, no second fetch).
 */

import { createContext, useContext } from 'react';
import type { UseAutonomousMode } from '../hooks/useAutonomousMode';

const AutonomousModeContext = createContext<UseAutonomousMode | null>(null);

export const AutonomousModeProvider = AutonomousModeContext.Provider;

/**
 * Consume the shared autonomous-mode state. Safe to call outside the provider —
 * returns a harmless inert fallback (flag off, no-op setter) so a page rendered
 * without the shell (e.g. in isolation) doesn't crash.
 */
export function useAutonomousModeContext(): UseAutonomousMode {
    const ctx = useContext(AutonomousModeContext);
    if (ctx) return ctx;
    return {
        autonomousMode: false,
        loading: false,
        refetch: () => {},
        setAutonomousMode: async (on: boolean) => on,
    };
}
