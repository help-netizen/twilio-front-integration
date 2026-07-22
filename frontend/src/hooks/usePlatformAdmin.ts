import { useState, useEffect, useCallback } from 'react';
import { authedFetch } from '../services/apiClient';
import { toast } from 'sonner';

const API_BASE = import.meta.env.VITE_API_URL || '/api';

/** One row per membership: a user in N companies appears N times. */
export interface PlatformUser {
    id: string;
    keycloak_sub: string | null;
    email: string;
    full_name: string;
    last_login_at: string | null;
    role: string;
    role_key: string;
    status: string;
    company_id: string;
    company_name: string;
}

export interface PlatformStats {
    companies: { total: number; today: number; last7: number; last30: number };
    users: { total: number; today: number; last7: number; last30: number };
    growth: Array<{ date: string; companies: number; users: number }>;
}

const PAGE_SIZE = 25;

/** All users across every tenant (super-admin only). Server sorts online-first. */
export function usePlatformUsers() {
    const [users, setUsers] = useState<PlatformUser[]>([]);
    const [total, setTotal] = useState(0);
    const [page, setPage] = useState(1);
    const [searchInput, setSearchInput] = useState('');
    const [search, setSearch] = useState('');
    const [loading, setLoading] = useState(true);

    const fetchUsers = useCallback(async () => {
        setLoading(true);
        try {
            const params = new URLSearchParams();
            if (search) params.set('search', search);
            params.set('page', String(page));
            params.set('limit', String(PAGE_SIZE));
            const res = await authedFetch(`${API_BASE}/platform/users?${params}`);
            if (res.status === 403) { toast.error('Super-admin access required'); return; }
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const json = await res.json();
            setUsers(json.users || []);
            setTotal(json.total || 0);
        } catch (e: any) {
            toast.error('Failed to load users', { description: e.message });
        } finally {
            setLoading(false);
        }
    }, [search, page]);

    useEffect(() => { fetchUsers(); }, [fetchUsers]);
    // debounce the search box, resetting to page 1 on a new query
    useEffect(() => {
        const t = setTimeout(() => { setSearch(searchInput); setPage(1); }, 300);
        return () => clearTimeout(t);
    }, [searchInput]);

    return {
        users, total, page, setPage, pageSize: PAGE_SIZE,
        searchInput, setSearchInput, loading, refetch: fetchUsers,
    };
}

/** Platform growth counters (super-admin only). */
export function usePlatformStats() {
    const [stats, setStats] = useState<PlatformStats | null>(null);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        let cancelled = false;
        (async () => {
            setLoading(true);
            try {
                const res = await authedFetch(`${API_BASE}/platform/stats`);
                if (res.status === 403) { toast.error('Super-admin access required'); return; }
                if (!res.ok) throw new Error(`HTTP ${res.status}`);
                const json = await res.json();
                if (!cancelled) setStats({ companies: json.companies, users: json.users, growth: json.growth || [] });
            } catch (e: any) {
                if (!cancelled) toast.error('Failed to load statistics', { description: e.message });
            } finally {
                if (!cancelled) setLoading(false);
            }
        })();
        return () => { cancelled = true; };
    }, []);

    return { stats, loading };
}
