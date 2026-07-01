/**
 * Autonomous-mode telephony flag — the ONE place the API paths live so a
 * backend path tweak is a single-file change (TELEPHONY-AUTONOMOUS-MODE-001).
 *
 * Contract (backend building in parallel):
 *   GET   /api/telephony/provider/autonomous-mode → { ok, data: { autonomous_mode } }
 *         readable by any authenticated user.
 *   PATCH /api/telephony/provider/autonomous-mode  body { autonomous_mode }
 *         → { ok, data: { autonomous_mode } }; server-side gated to
 *         tenant.telephony.manage.
 */

import { authedFetch } from './apiClient';

// Mounted under the telephonyProvider router (src/server.js: app.use('/api/telephony/provider', …)).
export const AUTONOMOUS_MODE_PATH = '/api/telephony/provider/autonomous-mode';

interface AutonomousModeEnvelope {
    ok?: boolean;
    data?: { autonomous_mode?: boolean };
}

/** Read the current company-wide autonomous-mode flag. */
export async function getAutonomousMode(): Promise<boolean> {
    const res = await authedFetch(AUTONOMOUS_MODE_PATH);
    if (!res.ok) throw new Error(`GET ${AUTONOMOUS_MODE_PATH} → ${res.status}`);
    const json = (await res.json()) as AutonomousModeEnvelope;
    return Boolean(json.data?.autonomous_mode);
}

/** Set the company-wide autonomous-mode flag. Returns the server's echoed value. */
export async function setAutonomousModeApi(on: boolean): Promise<boolean> {
    const res = await authedFetch(AUTONOMOUS_MODE_PATH, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ autonomous_mode: on }),
    });
    if (!res.ok) throw new Error(`PATCH ${AUTONOMOUS_MODE_PATH} → ${res.status}`);
    const json = (await res.json()) as AutonomousModeEnvelope;
    // Trust the server echo; fall back to the requested value if the body omits it.
    return json.data?.autonomous_mode ?? on;
}
