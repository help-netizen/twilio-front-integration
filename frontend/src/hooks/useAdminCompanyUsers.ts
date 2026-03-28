import { useState, useEffect, useCallback } from 'react';
import { authedFetch } from '../services/apiClient';
import { toast } from 'sonner';
import type { CompanyUser, EditUserForm } from './useCompanyUsers';

export type { CompanyUser, EditUserForm };

interface PaginatedResponse { ok: boolean; users: CompanyUser[]; total: number; page: number; limit: number; }

export function useAdminCompanyUsers(companyId: string) {
    const apiBase = `/api/admin/companies/${companyId}/users`;

    const [data, setData] = useState<PaginatedResponse | null>(null);
    const [loading, setLoading] = useState(true);
    const [search, setSearch] = useState('');
    const [roleFilter, setRoleFilter] = useState('all');
    const [statusFilter, setStatusFilter] = useState('all');
    const [page, setPage] = useState(1);
    const limit = 25;

    // Create Mode
    const [createOpen, setCreateOpen] = useState(false);
    const [createForm, setCreateForm] = useState({ full_name: '', email: '', role_key: 'dispatcher' });
    const [creating, setCreating] = useState(false);
    const [tempPassword, setTempPassword] = useState<string | null>(null);

    // Edit Mode
    const [editOpen, setEditOpen] = useState(false);
    const [editUser, setEditUser] = useState<CompanyUser | null>(null);
    const [editForm, setEditForm] = useState<EditUserForm>({ role_key: 'dispatcher', phone_calls_allowed: false, is_provider: false, schedule_color: '#3B82F6', call_masking_enabled: false, location_tracking_enabled: false });

    // Reset Password
    const [resetPasswordOpen, setResetPasswordOpen] = useState(false);
    const [resetPasswordUser, setResetPasswordUser] = useState<CompanyUser | null>(null);
    const [resetPasswordLoading, setResetPasswordLoading] = useState(false);
    const [resetTempPassword, setResetTempPassword] = useState<string | null>(null);

    // Status / Misc
    const [confirmDialog, setConfirmDialog] = useState<{ open: boolean; title: string; description: string; onConfirm: () => void }>({ open: false, title: '', description: '', onConfirm: () => { } });
    const [actionLoading, setActionLoading] = useState<string | null>(null);
    const [searchInput, setSearchInput] = useState('');

    const fetchUsers = useCallback(async () => {
        setLoading(true);
        try {
            const params = new URLSearchParams();
            if (search) params.set('search', search);
            if (roleFilter !== 'all') params.set('role', roleFilter);
            if (statusFilter !== 'all') params.set('status', statusFilter);
            params.set('page', String(page));
            params.set('limit', String(limit));
            const res = await authedFetch(`${apiBase}?${params}`);
            if (res.status === 403) { toast.error('Access denied'); return; }
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const json: PaginatedResponse = await res.json();
            setData(json);
        } catch (e: any) {
            toast.error('Failed to load users', { description: e.message });
        } finally {
            setLoading(false);
        }
    }, [apiBase, search, roleFilter, statusFilter, page]);

    useEffect(() => { fetchUsers(); }, [fetchUsers]);
    useEffect(() => { const t = setTimeout(() => { setSearch(searchInput); setPage(1); }, 300); return () => clearTimeout(t); }, [searchInput]);

    const handleCreate = async () => {
        if (!createForm.full_name || !createForm.email) { toast.error('Please fill in the required fields'); return; }
        setCreating(true);
        try {
            const res = await authedFetch(apiBase, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ ...createForm })
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

    const handleUpdateUser = async () => {
        if (!editUser) return;
        setActionLoading(editUser.id);
        try {
            const res = await authedFetch(`${apiBase}/${editUser.id}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    role_key: editForm.role_key,
                    profile: {
                        phone_calls_allowed: editForm.phone_calls_allowed,
                        is_provider: editForm.is_provider,
                        schedule_color: editForm.schedule_color,
                        call_masking_enabled: editForm.call_masking_enabled,
                        location_tracking_enabled: editForm.location_tracking_enabled
                    }
                })
            });
            const json = await res.json();
            if (res.status === 409 && json.code === 'LAST_ADMIN_REQUIRED') toast.error('Cannot remove the last company admin');
            else if (!res.ok) toast.error(json.message || 'Failed to update user');
            else { toast.success('User updated'); fetchUsers(); }
        } catch { toast.error('Connection error'); } finally { setActionLoading(null); setEditOpen(false); }
    };

    const toggleStatus = async (user: CompanyUser) => {
        const isActive = user.membership_status === 'active';
        const status = isActive ? 'inactive' : 'active';
        const reason = isActive ? 'Disabled by SuperAdmin' : null;
        setActionLoading(user.id);
        try {
            const res = await authedFetch(`${apiBase}/${user.id}/status`, {
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

    const handleResetPassword = async () => {
        if (!resetPasswordUser) return;
        setResetPasswordLoading(true);
        try {
            const res = await authedFetch(`${apiBase}/${resetPasswordUser.id}/reset-password`, { method: 'PUT' });
            const json = await res.json();
            if (!res.ok) {
                toast.error(json.message || 'Failed to reset password');
                return;
            }
            setResetTempPassword(json.temporary_password);
            toast.success('Password reset successfully');
        } catch { toast.error('Connection error'); } finally { setResetPasswordLoading(false); }
    };

    const openResetPasswordDialog = (u: CompanyUser) => {
        setResetPasswordUser(u);
        setResetTempPassword(null);
        setResetPasswordOpen(true);
    };

    const fmtDate = (d: string | null) => { if (!d) return '—'; return new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }); };
    const totalPages = data ? Math.ceil(data.total / limit) : 0;
    const users = data?.users || [];

    const openEditDialog = (u: CompanyUser) => {
        setEditUser(u);
        setEditForm({
            role_key: u.role_key || 'dispatcher',
            phone_calls_allowed: !!u.phone_calls_allowed,
            is_provider: !!u.is_provider,
            schedule_color: u.schedule_color || '#3B82F6',
            call_masking_enabled: !!u.call_masking_enabled,
            location_tracking_enabled: !!u.location_tracking_enabled
        });
        setEditOpen(true);
    };

    return {
        users, loading, search, roleFilter, statusFilter, page, setPage, setRoleFilter, setStatusFilter,
        searchInput, setSearchInput, fetchUsers, totalPages, data, limit, fmtDate,
        createOpen, setCreateOpen, createForm, setCreateForm, creating, tempPassword, setTempPassword, handleCreate,
        editOpen, setEditOpen, editUser, editForm, setEditForm, handleUpdateUser, openEditDialog,
        confirmDialog, setConfirmDialog, actionLoading, toggleStatus,
        // Password reset
        resetPasswordOpen, setResetPasswordOpen, resetPasswordUser, resetPasswordLoading, resetTempPassword, setResetTempPassword,
        handleResetPassword, openResetPasswordDialog
    };
}
