import { useState, useEffect, useCallback } from 'react';
import { authedFetch } from '../services/apiClient';
import { toast } from 'sonner';
import { useCompanyTime } from '../lib/companyTime';

const API_BASE = import.meta.env.VITE_API_URL || '/api';

// ZB-DECOUPLE Phase E: `technician_id` is the user's OWN native technician
// (roster-compat id, backend-derived) — read-only; there is no Zenbooker link
// anymore. A provider / "also works in the field" user IS a technician
// automatically (USERS-FIRST projection); this id is null until that technician
// exists (i.e. after the user is saved with the role/flag).
export interface CompanyUser { id: string; email: string; full_name: string; phone: string | null; membership_role: string; role_key: string; legacy_role: string; membership_status: string; phone_calls_allowed: boolean; is_provider: boolean; schedule_color: string; location_tracking_enabled: boolean; technician_id: string | null; last_login_at: string | null; created_at: string; }
interface PaginatedResponse { ok: boolean; users: CompanyUser[]; total: number; page: number; limit: number; }

export type EditUserForm = {
    full_name: string;
    email: string;
    phone: string;
    role_key: string;
    phone_calls_allowed: boolean;
    is_provider: boolean;
    schedule_color: string;
    location_tracking_enabled: boolean;
};

export function useCompanyUsers() {
    const { format } = useCompanyTime();
    const [data, setData] = useState<PaginatedResponse | null>(null);
    const [loading, setLoading] = useState(true);
    const [search, setSearch] = useState('');
    const [roleFilter, setRoleFilter] = useState('all');
    const [statusFilter, setStatusFilter] = useState('all');
    const [page, setPage] = useState(1);
    const limit = 25;
    
    // Create Mode
    const [createOpen, setCreateOpen] = useState(false);
    const [createForm, setCreateForm] = useState({ full_name: '', email: '', phone: '', role_key: 'dispatcher', phone_calls_allowed: true, is_provider: false, schedule_color: '#3B82F6', location_tracking_enabled: false });
    const [creating, setCreating] = useState(false);
    const [tempPassword, setTempPassword] = useState<string | null>(null);
    
    // Edit Mode
    const [editOpen, setEditOpen] = useState(false);
    const [editUser, setEditUser] = useState<CompanyUser | null>(null);
    const [editForm, setEditForm] = useState<EditUserForm>({ full_name: '', email: '', phone: '', role_key: 'dispatcher', phone_calls_allowed: false, is_provider: false, schedule_color: '#3B82F6', location_tracking_enabled: false });

    // Status / Misc
    const [confirmDialog, setConfirmDialog] = useState<{ open: boolean; title: string; description: string; onConfirm: () => void }>({ open: false, title: '', description: '', onConfirm: () => { } });
    const [actionLoading, setActionLoading] = useState<string | null>(null);
    const [searchInput, setSearchInput] = useState('');

    const fetchUsers = useCallback(async () => { setLoading(true); try { const params = new URLSearchParams(); if (search) params.set('search', search); if (roleFilter !== 'all') params.set('role', roleFilter); if (statusFilter !== 'all') params.set('status', statusFilter); params.set('page', String(page)); params.set('limit', String(limit)); const res = await authedFetch(`${API_BASE}/users?${params}`); if (res.status === 403) { toast.error('Access denied'); return; } if (!res.ok) throw new Error(`HTTP ${res.status}`); const json: PaginatedResponse = await res.json(); setData(json); } catch (e: any) { toast.error('Failed to load users', { description: e.message }); } finally { setLoading(false); } }, [search, roleFilter, statusFilter, page]);
    useEffect(() => { fetchUsers(); }, [fetchUsers]);
    useEffect(() => { const t = setTimeout(() => { setSearch(searchInput); setPage(1); }, 300); return () => clearTimeout(t); }, [searchInput]);

    const handleCreate = async () => { 
        if (!createForm.full_name || !createForm.email) { toast.error('Please fill in the required fields'); return; } 
        setCreating(true); 
        try { 
            const phone = createForm.phone.trim();
            const res = await authedFetch(`${API_BASE}/users`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    full_name: createForm.full_name,
                    email: createForm.email,
                    role_key: createForm.role_key,
                    profile: {
                        ...(phone ? { phone } : {}),
                        phone_calls_allowed: createForm.phone_calls_allowed,
                        is_provider: createForm.role_key === 'provider' ? true : createForm.is_provider,
                        schedule_color: createForm.schedule_color,
                        location_tracking_enabled: createForm.location_tracking_enabled,
                    },
                })
            });
            const json = await res.json(); 
            if (!res.ok) { 
                if (json.code === 'USER_EXISTS') toast.error('A user with this email already exists'); 
                else if (json.code === 'VALIDATION_ERROR') toast.error(json.message); 
                else toast.error('Failed to create user'); 
                return; 
            } 
            setTempPassword(json.temporary_password); 
            toast.success('User created'); 
            fetchUsers(); 
        } catch { toast.error('Connection error'); } finally { setCreating(false); } 
    };

    const handleUpdateUser = async (confirmIdentityChange = false) => {
        if (!editUser) return;
        setActionLoading(editUser.id);
        try {
            const res = await authedFetch(`${API_BASE}/users/${editUser.id}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    full_name: editForm.full_name,
                    email: editForm.email,
                    role_key: editForm.role_key,
                    confirm_identity_change: confirmIdentityChange,
                    profile: {
                        phone: editForm.phone,
                        phone_calls_allowed: editForm.phone_calls_allowed,
                        is_provider: editForm.is_provider,
                        schedule_color: editForm.schedule_color,
                        location_tracking_enabled: editForm.location_tracking_enabled,
                        // ZB-DECOUPLE Phase E: no Zenbooker bridge. is_provider ⇒ the
                        // USERS-FIRST projection makes/links the native technician on save.
                    }
                })
            });
            const json = await res.json();
            if (res.ok) { toast.success('User updated'); setEditOpen(false); fetchUsers(); return; }
            switch (json.code) {
                case 'IDENTITY_CHANGE_CONFIRMATION_REQUIRED': {
                    const providers = (json.linked_identity_providers || []).join(', ');
                    if (window.confirm(`Changing this email may affect the user's linked sign-in${providers ? ` (${providers})` : ''}. Continue?`)) {
                        await handleUpdateUser(true);
                    }
                    break;
                }
                case 'EMAIL_IN_USE': toast.error('That email is already used by another user'); break;
                case 'SHARED_IDENTITY_REQUIRES_PLATFORM_ADMIN': toast.error('This person belongs to more than one company — a platform admin must change their name or email'); break;
                case 'LAST_ADMIN_REQUIRED': toast.error('Cannot remove the last company admin'); break;
                default: toast.error(json.message || 'Failed to update user');
            }
        } catch { toast.error('Connection error'); } finally { setActionLoading(null); }
    };

    const resetPassword = async (user: CompanyUser) => {
        setActionLoading(user.id);
        try {
            const res = await authedFetch(`${API_BASE}/users/${user.id}/reset-password`, { method: 'POST' });
            const json = await res.json().catch(() => ({}));
            if (res.ok) toast.success(`Password-reset link sent to ${user.email}`);
            else toast.error(json.message || 'Could not send the reset link');
        } catch { toast.error('Connection error'); } finally { setActionLoading(null); }
    };

    const toggleStatus = async (user: CompanyUser) => { 
        const isActive = user.membership_status === 'active'; 
        const status = isActive ? 'inactive' : 'active'; 
        const reason = isActive ? 'Disabled by Admin' : null;
        setActionLoading(user.id); 
        try { 
            const res = await authedFetch(`${API_BASE}/users/${user.id}/status`, { 
                method: 'PATCH', 
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ status, reason }) 
            }); 
            const json = await res.json(); 
            if (res.status === 409 && json.code === 'LAST_ADMIN_REQUIRED') toast.error('Cannot disable the last company admin');
            else if (!res.ok) toast.error(json.message || 'Failed to change status');
            else { toast.success(isActive ? 'User disabled' : 'User enabled'); fetchUsers(); }
        } catch { toast.error('Connection error'); } finally { setActionLoading(null); }
    };

    // #86 DELETE-DISABLED-USER: fully unlink a disabled user from the company
    // (removes the membership). Backend re-checks the user is inactive and not the
    // last admin, and audit-logs the removal. Frontend only exposes this on
    // already-disabled users; the confirm here is a UX guard, not the security gate.
    const deleteUser = async (user: CompanyUser) => {
        setActionLoading(user.id);
        try {
            const res = await authedFetch(`${API_BASE}/users/${user.id}`, { method: 'DELETE' });
            const json = await res.json().catch(() => ({}));
            if (res.ok) {
                toast.success(`${user.full_name || user.email} removed from the company`);
                setEditOpen(false);
                fetchUsers();
                return;
            }
            if (res.status === 409 && json.code === 'USER_STILL_ACTIVE') toast.error('Disable the user before removing them');
            else if (res.status === 409 && json.code === 'LAST_ADMIN_REQUIRED') toast.error('Cannot remove the last company admin');
            else toast.error(json.message || 'Failed to remove user');
        } catch { toast.error('Connection error'); } finally { setActionLoading(null); }
    };

    const fmtDate = (d: string | null) => { if (!d) return '—'; return format(d, { month: 'short', day: 'numeric', year: 'numeric' }); };
    const totalPages = data ? Math.ceil(data.total / limit) : 0;
    const users = data?.users || [];

    const openEditDialog = (u: CompanyUser) => {
        setEditUser(u);
        setEditForm({
            full_name: u.full_name || '',
            email: u.email || '',
            phone: u.phone || '',
            role_key: u.role_key || 'dispatcher',
            phone_calls_allowed: !!u.phone_calls_allowed,
            is_provider: !!u.is_provider,
            schedule_color: u.schedule_color || '#3B82F6',
            location_tracking_enabled: !!u.location_tracking_enabled,
        });
        setEditOpen(true);
    };

    return {
        users, loading, search, roleFilter, statusFilter, page, setPage, setRoleFilter, setStatusFilter,
        searchInput, setSearchInput, fetchUsers, totalPages, data, limit, fmtDate,
        createOpen, setCreateOpen, createForm, setCreateForm, creating, tempPassword, setTempPassword, handleCreate,
        editOpen, setEditOpen, editUser, editForm, setEditForm, handleUpdateUser, openEditDialog, resetPassword,
        confirmDialog, setConfirmDialog, actionLoading, toggleStatus, deleteUser
    };
}
