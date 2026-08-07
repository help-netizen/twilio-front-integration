import { useEffect, useState } from 'react';

const RUNNING_VERSION = typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : 'dev';
const POLL_INTERVAL_MS = 5 * 60 * 1000;

/** A newer build is live when version.json reports a non-empty version different from ours. */
export function shouldPromptReload(running: string, deployed: string | null | undefined): boolean {
    return !!deployed && deployed !== running;
}

async function fetchDeployedVersion(): Promise<string | null> {
    try {
        const res = await fetch('/version.json', { cache: 'no-store' });
        if (!res.ok) return null;
        const data: unknown = await res.json();
        const v = (data as { version?: unknown } | null)?.version;
        return typeof v === 'string' ? v : null;
    } catch {
        return null;
    }
}

/**
 * PWA-UPDATE-001 — an installed PWA can keep an old bundle running for days; after a deploy the
 * stale app breaks in subtle ways (e.g. the card-entry hand-off). Poll the build-stamped
 * /version.json — on load, on an interval, and whenever the tab regains focus — and flag when the
 * deployed build differs from the running one so the UI can offer a reload. No-op in dev (no stamp).
 */
export function useAppUpdate(): { updateAvailable: boolean; reload: () => void } {
    const [updateAvailable, setUpdateAvailable] = useState(false);

    useEffect(() => {
        if (RUNNING_VERSION === 'dev') return;
        let stopped = false;
        const check = async () => {
            if (stopped) return;
            const deployed = await fetchDeployedVersion();
            if (!stopped && shouldPromptReload(RUNNING_VERSION, deployed)) setUpdateAvailable(true);
        };
        const onVisible = () => { if (document.visibilityState === 'visible') void check(); };
        void check();
        const interval = window.setInterval(() => void check(), POLL_INTERVAL_MS);
        document.addEventListener('visibilitychange', onVisible);
        window.addEventListener('focus', onVisible);
        return () => {
            stopped = true;
            window.clearInterval(interval);
            document.removeEventListener('visibilitychange', onVisible);
            window.removeEventListener('focus', onVisible);
        };
    }, []);

    return { updateAvailable, reload: () => window.location.reload() };
}
