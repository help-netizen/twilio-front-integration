import { useState, useEffect, useCallback } from 'react';
import { authedFetch } from '../services/apiClient';
import { toast } from 'sonner';

const API_BASE = import.meta.env.VITE_API_URL || '/api';

export interface CompanyUser { id: string; email: string; full_name: string; membership_role: string; membership_status: string; phone_calls_allowed: boolean; last_login_at: string | null; created_at: string; }
interface PaginatedResponse { ok: boolean; users: CompanyUser[]; total: number; page: number; limit: number; }

export function useCompanyUsers() {
    const [data, setData] = useState<PaginatedResponse | null>(null);
    const [loading, setLoading] = useState(true);
    const [search, setSearch] = useState('');
    const [roleFilter, setRoleFilter] = useState('all');
    const [statusFilter, setStatusFilter] = useState('all');
    const [page, setPage] = useState(1);
    const limit = 25;
    const [createOpen, setCreateOpen] = useState(false);
    const [createForm, setCreateForm] = useState({ full_name: '', email: '', role: 'company_member' });
    const [creating, setCreating] = useState(false);
    const [tempPassword, setTempPassword] = useState<string | null>(null);
    const [roleDialog, setRoleDialog] = useState<{ open: boolean; user: CompanyUser | null; newRole: string }>({ open: false, user: null, newRole: '' });
    const [confirmDialog, setConfirmDialog] = useState<{ open: boolean; title: string; description: string; onConfirm: () => void }>({ open: false, title: '', description: '', onConfirm: () => { } });
    const [actionLoading, setActionLoading] = useState<string | null>(null);
    const [searchInput, setSearchInput] = useState('');

    const fetchUsers = useCallback(async () => { setLoading(true); try { const params = new URLSearchParams(); if (search) params.set('search', search); if (roleFilter !== 'all') params.set('role', roleFilter); if (statusFilter !== 'all') params.set('status', statusFilter); params.set('page', String(page)); params.set('limit', String(limit)); const res = await authedFetch(`${API_BASE}/users?${params}`); if (res.status === 403) { toast.error('Access denied'); return; } if (!res.ok) throw new Error(`HTTP ${res.status}`); const json: PaginatedResponse = await res.json(); setData(json); } catch (e: any) { toast.error('Failed to load users', { description: e.message }); } finally { setLoading(false); } }, [search, roleFilter, statusFilter, page]);
    useEffect(() => { fetchUsers(); }, [fetchUsers]);
    useEffect(() => { const t = setTimeout(() => { setSearch(searchInput); setPage(1); }, 300); return () => clearTimeout(t); }, [searchInput]);

    const handleCreate = async () => { if (!createForm.full_name || !createForm.email) { toast.error('Please fill in the required fields'); return; } setCreating(true); try { const res = await authedFetch(`${API_BASE}/users`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(createForm) }); const json = await res.json(); if (!res.ok) { if (json.code === 'USER_EXISTS') toast.error('A user with this email already exists'); else if (json.code === 'VALIDATION_ERROR') toast.error(json.message); else toast.error('Failed to create user'); return; } setTempPassword(json.temporary_password); toast.success('User created'); fetchUsers(); } catch { toast.error('Connection error'); } finally { setCreating(false); } };

    const handleRoleChange = async () => { if (!roleDialog.user) return; setActionLoading(roleDialog.user.id); try { const res = await authedFetch(`${API_BASE}/users/${roleDialog.user.id}/role`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ role: roleDialog.newRole }) }); const json = await res.json(); if (res.status === 409 && json.code === 'LAST_ADMIN_REQUIRED') toast.error('Cannot remove the last company admin'); else if (!res.ok) toast.error(json.message || 'Failed to change role'); else { toast.success('Role updated'); fetchUsers(); } } catch { toast.error('Connection error'); } finally { setActionLoading(null); setRoleDialog({ open: false, user: null, newRole: '' }); } };

    const toggleStatus = async (user: CompanyUser) => { const isActive = user.membership_status === 'active'; const endpoint = isActive ? 'disable' : 'enable'; setActionLoading(user.id); try { const res = await authedFetch(`${API_BASE}/users/${user.id}/${endpoint}`, { method: 'PUT' }); const json = await res.json(); if (res.status === 409 && json.code === 'LAST_ADMIN_REQUIRED') toast.error('Cannot disable the last company admin'); else if (!res.ok) toast.error(json.message || 'Failed to change status'); else { toast.success(isActive ? 'User disabled' : 'User enabled'); fetchUsers(); } } catch { toast.error('Connection error'); } finally { setActionLoading(null); } };

    const togglePhoneCalls = async (user: CompanyUser) => { const newVal = !user.phone_calls_allowed; setActionLoading(user.id); try { const res = await authedFetch(`${API_BASE}/users/${user.id}/phone-calls`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ allowed: newVal }) }); if (!res.ok) toast.error('Failed to update phone calls access'); else { toast.success(newVal ? 'Phone calls enabled' : 'Phone calls disabled'); fetchUsers(); } } catch { toast.error('Connection error'); } finally { setActionLoading(null); } };

    const fmtDate = (d: string | null) => { if (!d) return '—'; return new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }); };
    const totalPages = data ? Math.ceil(data.total / limit) : 0;
    const users = data?.users || [];

    return {
        users, loading, search, roleFilter, statusFilter, page, setPage, setRoleFilter, setStatusFilter,
        searchInput, setSearchInput, fetchUsers, totalPages, data, limit, fmtDate,
        createOpen, setCreateOpen, createForm, setCreateForm, creating, tempPassword, setTempPassword, handleCreate,
        roleDialog, setRoleDialog, handleRoleChange, confirmDialog, setConfirmDialog,
        actionLoading, toggleStatus, togglePhoneCalls,
    };
}
