/**
 * useProviders — the company's technician roster (ZenBooker team members).
 *
 * Same source the Schedule uses (`/api/zenbooker/team-members`, dispatch-scoped).
 * Best-effort: any error yields an empty list. Pass `enabled=false` to skip the
 * fetch entirely (e.g. when the caller lacks the dispatch permission).
 */

import { useEffect, useState } from 'react';
import { authedFetch } from '../services/apiClient';
import type { ProviderInfo } from './useScheduleData';

export function useProviders(enabled: boolean = true): { providers: ProviderInfo[]; loading: boolean } {
    const [providers, setProviders] = useState<ProviderInfo[]>([]);
    const [loading, setLoading] = useState(false);

    useEffect(() => {
        if (!enabled) return;
        let cancelled = false;
        setLoading(true);
        authedFetch('/api/zenbooker/team-members')
            .then((r) => r.json())
            .then((j) => {
                if (cancelled) return;
                const list = j.data || [];
                setProviders(list.map((p: any) => ({ id: String(p.id), name: p.name || '' })));
            })
            .catch(() => { if (!cancelled) setProviders([]); })
            .finally(() => { if (!cancelled) setLoading(false); });
        return () => { cancelled = true; };
    }, [enabled]);

    return { providers, loading };
}
