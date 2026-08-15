import { useEffect, useState } from 'react';
import { messagingApi } from '../services/messagingApi';

const REFRESH_SKEW_MS = 30_000;

export async function loadSmsMediaAccessUrl(mediaId: string): Promise<{
    url: string;
    expiresAt: string;
}> {
    const access = await messagingApi.getMediaUrl(mediaId);
    const expiresAt = Date.parse(access.expiresAt);
    if (typeof access.url !== 'string' || !access.url.startsWith('/api/messaging/media/')
        || !access.url.includes('cap=') || !Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
        throw new Error('Invalid media access response');
    }
    return access;
}

export function useSmsMediaAccessUrl(mediaId: string): string | undefined {
    const [url, setUrl] = useState<string>();

    useEffect(() => {
        let active = true;
        let refreshTimer: ReturnType<typeof setTimeout> | undefined;

        const load = async () => {
            try {
                const access = await loadSmsMediaAccessUrl(mediaId);
                if (!active) return;
                setUrl(access.url);
                const refreshIn = Date.parse(access.expiresAt) - Date.now() - REFRESH_SKEW_MS;
                refreshTimer = setTimeout(load, Math.max(1_000, refreshIn));
            } catch {
                if (active) setUrl(undefined);
            }
        };

        setUrl(undefined);
        void load();
        return () => {
            active = false;
            if (refreshTimer) clearTimeout(refreshTimer);
        };
    }, [mediaId]);

    return url;
}
