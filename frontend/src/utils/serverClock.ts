// ─── Server Clock Sync ────────────────────────────────────────────────────────
// Computes offset between server UTC and client UTC to correct for devices
// with stale timezone databases (e.g. Kazakhstan UTC+5/+6 change in 2024).

let offset = 0; // ms: serverUTC - clientUTC
let synced = false;

/**
 * Fetch server time and compute clock offset.
 * Call once at app startup. No-ops after first success.
 */
export async function syncClock(): Promise<void> {
    if (synced) return;
    try {
        const t0 = Date.now();
        const res = await fetch('/api/time');
        const t1 = Date.now();
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const { utc } = await res.json();
        const rtt = t1 - t0;
        offset = utc - (t0 + rtt / 2);
        synced = true;
        if (Math.abs(offset) > 5000) {
            console.warn(`[serverClock] client clock off by ${Math.round(offset / 1000)}s — using server time`);
        }
    } catch (err) {
        console.warn('[serverClock] sync failed, using client clock:', err);
    }
}

/** Corrected Date.now() aligned with server UTC */
export function serverNow(): number {
    return Date.now() + offset;
}

/** Corrected new Date() aligned with server UTC */
export function serverDate(): Date {
    return new Date(serverNow());
}

/** Raw offset in ms (for debugging) */
export function getClockOffset(): number {
    return offset;
}
