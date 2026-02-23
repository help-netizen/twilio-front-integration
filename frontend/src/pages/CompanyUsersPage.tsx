import { useState, useEffect, useCallback } from 'react';
import { authedFetch } from '../services/apiClient';
import { Button } from '../components/ui/button';
import { Card } from '../components/ui/card';
import { Badge } from '../components/ui/badge';
import { Input } from '../components/ui/input';
import { Label } from '../components/ui/label';
import { Separator } from '../components/ui/separator';
import { Skeleton } from '../components/ui/skeleton';
import {
    Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '../components/ui/table';
import {
    Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '../components/ui/dialog';
import {
    Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '../components/ui/select';
import { toast } from 'sonner';
import {
    Users, UserPlus, RefreshCw, ShieldCheck, User,
    ChevronLeft, ChevronRight, Ban, CheckCircle2, Copy, Phone, PhoneOff,
} from 'lucide-react';

const API_BASE = import.meta.env.VITE_API_URL || '/api';

/* ───────────────────────────── Types ────────────────────────────── */

interface CompanyUser {
    id: string;
    email: string;
    full_name: string;
    membership_role: string;
    membership_status: string;
    phone_calls_allowed: boolean;
    last_login_at: string | null;
    created_at: string;
}

interface PaginatedResponse {
    ok: boolean;
    users: CompanyUser[];
    total: number;
    page: number;
    limit: number;
}

/* ───────────────────────────── Page ─────────────────────────────── */

export default function CompanyUsersPage() {

    // List state
    const [data, setData] = useState<PaginatedResponse | null>(null);
    const [loading, setLoading] = useState(true);
    const [search, setSearch] = useState('');
    const [roleFilter, setRoleFilter] = useState('all');
    const [statusFilter, setStatusFilter] = useState('all');
    const [page, setPage] = useState(1);
    const limit = 25;

    // Create dialog
    const [createOpen, setCreateOpen] = useState(false);
    const [createForm, setCreateForm] = useState({ full_name: '', email: '', role: 'company_member' });
    const [creating, setCreating] = useState(false);
    const [tempPassword, setTempPassword] = useState<string | null>(null);

    // Role change dialog
    const [roleDialog, setRoleDialog] = useState<{ open: boolean; user: CompanyUser | null; newRole: string }>({
        open: false, user: null, newRole: '',
    });

    // Confirm dialog (enable/disable)
    const [confirmDialog, setConfirmDialog] = useState<{
        open: boolean; title: string; description: string; onConfirm: () => void;
    }>({ open: false, title: '', description: '', onConfirm: () => { } });

    const [actionLoading, setActionLoading] = useState<string | null>(null);

    /* ── Fetch ────────────────────────────────────────────────── */

    const fetchUsers = useCallback(async () => {
        setLoading(true);
        try {
            const params = new URLSearchParams();
            if (search) params.set('search', search);
            if (roleFilter !== 'all') params.set('role', roleFilter);
            if (statusFilter !== 'all') params.set('status', statusFilter);
            params.set('page', String(page));
            params.set('limit', String(limit));

            const res = await authedFetch(`${API_BASE}/users?${params}`);
            if (res.status === 403) {
                toast.error('Access denied');
                return;
            }
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const json: PaginatedResponse = await res.json();
            setData(json);
        } catch (e: any) {
            toast.error('Failed to load users', { description: e.message });
        } finally {
            setLoading(false);
        }
    }, [search, roleFilter, statusFilter, page]);

    useEffect(() => { fetchUsers(); }, [fetchUsers]);

    // Debounced search
    const [searchInput, setSearchInput] = useState('');
    useEffect(() => {
        const t = setTimeout(() => {
            setSearch(searchInput);
            setPage(1);
        }, 300);
        return () => clearTimeout(t);
    }, [searchInput]);

    /* ── Create User ──────────────────────────────────────────── */

    const handleCreate = async () => {
        if (!createForm.full_name || !createForm.email) {
            toast.error('Please fill in the required fields');
            return;
        }
        setCreating(true);
        try {
            const res = await authedFetch(`${API_BASE}/users`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(createForm),
            });
            const json = await res.json();
            if (!res.ok) {
                if (json.code === 'USER_EXISTS') {
                    toast.error('A user with this email already exists');
                } else if (json.code === 'VALIDATION_ERROR') {
                    toast.error(json.message);
                } else {
                    toast.error('Failed to create user');
                }
                return;
            }
            setTempPassword(json.temporary_password);
            toast.success('User created');
            fetchUsers();
        } catch {
            toast.error('Connection error');
        } finally {
            setCreating(false);
        }
    };

    /* ── Change Role ──────────────────────────────────────────── */

    const handleRoleChange = async () => {
        if (!roleDialog.user) return;
        setActionLoading(roleDialog.user.id);
        try {
            const res = await authedFetch(`${API_BASE}/users/${roleDialog.user.id}/role`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ role: roleDialog.newRole }),
            });
            const json = await res.json();
            if (res.status === 409 && json.code === 'LAST_ADMIN_REQUIRED') {
                toast.error('Cannot remove the last company admin');
            } else if (!res.ok) {
                toast.error(json.message || 'Failed to change role');
            } else {
                toast.success('Role updated');
                fetchUsers();
            }
        } catch {
            toast.error('Connection error');
        } finally {
            setActionLoading(null);
            setRoleDialog({ open: false, user: null, newRole: '' });
        }
    };

    /* ── Toggle Status ────────────────────────────────────────── */

    const toggleStatus = async (user: CompanyUser) => {
        const isActive = user.membership_status === 'active';
        const endpoint = isActive ? 'disable' : 'enable';

        setActionLoading(user.id);
        try {
            const res = await authedFetch(`${API_BASE}/users/${user.id}/${endpoint}`, {
                method: 'PUT',
            });
            const json = await res.json();
            if (res.status === 409 && json.code === 'LAST_ADMIN_REQUIRED') {
                toast.error('Cannot disable the last company admin');
            } else if (!res.ok) {
                toast.error(json.message || 'Failed to change status');
            } else {
                toast.success(isActive ? 'User disabled' : 'User enabled');
                fetchUsers();
            }
        } catch {
            toast.error('Connection error');
        } finally {
            setActionLoading(null);
        }
    };

    /* ── Toggle Phone Calls ───────────────────────────────────── */

    const togglePhoneCalls = async (user: CompanyUser) => {
        const newVal = !user.phone_calls_allowed;
        setActionLoading(user.id);
        try {
            const res = await authedFetch(`${API_BASE}/users/${user.id}/phone-calls`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ allowed: newVal }),
            });
            if (!res.ok) {
                toast.error('Failed to update phone calls access');
            } else {
                toast.success(newVal ? 'Phone calls enabled' : 'Phone calls disabled');
                fetchUsers();
            }
        } catch {
            toast.error('Connection error');
        } finally {
            setActionLoading(null);
        }
    };

    /* ── Helpers ───────────────────────────────────────────────── */

    const fmtDate = (d: string | null) => {
        if (!d) return '—';
        return new Date(d).toLocaleDateString('en-US', {
            month: 'short', day: 'numeric', year: 'numeric',
        });
    };

    const totalPages = data ? Math.ceil(data.total / limit) : 0;
    const users = data?.users || [];

    /* ── Render ────────────────────────────────────────────────── */

    return (
        <div className="max-w-5xl mx-auto p-6 space-y-6">
            {/* Header */}
            <div className="flex items-center justify-between">
                <div>
                    <div className="flex items-center gap-2 mb-1">
                        <Users className="size-5 text-muted-foreground" />
                        <h2 className="text-xl font-semibold">Company Users</h2>
                    </div>
                    <p className="text-sm text-muted-foreground">
                        Manage users, roles, and access for your company.
                    </p>
                </div>
                <Button onClick={() => {
                    setCreateForm({ full_name: '', email: '', role: 'company_member' });
                    setTempPassword(null);
                    setCreateOpen(true);
                }}>
                    <UserPlus className="size-4 mr-2" />
                    Add User
                </Button>
            </div>

            <Separator />

            {/* Filters */}
            <div className="flex flex-wrap items-end gap-3">
                <div className="flex-1 min-w-[200px]">
                    <Label className="text-xs text-muted-foreground mb-1">Search</Label>
                    <Input
                        placeholder="Name or email…"
                        value={searchInput}
                        onChange={e => setSearchInput(e.target.value)}
                    />
                </div>
                <div className="w-[160px]">
                    <Label className="text-xs text-muted-foreground mb-1">Role</Label>
                    <Select value={roleFilter} onValueChange={v => { setRoleFilter(v); setPage(1); }}>
                        <SelectTrigger>
                            <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                            <SelectItem value="all">All Roles</SelectItem>
                            <SelectItem value="company_admin">Admin</SelectItem>
                            <SelectItem value="company_member">Member</SelectItem>
                        </SelectContent>
                    </Select>
                </div>
                <div className="w-[160px]">
                    <Label className="text-xs text-muted-foreground mb-1">Status</Label>
                    <Select value={statusFilter} onValueChange={v => { setStatusFilter(v); setPage(1); }}>
                        <SelectTrigger>
                            <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                            <SelectItem value="all">All Status</SelectItem>
                            <SelectItem value="active">Active</SelectItem>
                            <SelectItem value="inactive">Disabled</SelectItem>
                        </SelectContent>
                    </Select>
                </div>
                <Button variant="outline" size="icon" onClick={fetchUsers} disabled={loading}>
                    <RefreshCw className={`size-4 ${loading ? 'animate-spin' : ''}`} />
                </Button>
            </div>

            {/* Table */}
            {loading ? (
                <div className="space-y-2">
                    {[...Array(5)].map((_, i) => (
                        <Skeleton key={i} className="h-14 w-full" />
                    ))}
                </div>
            ) : users.length === 0 ? (
                <div className="flex items-center justify-center py-16">
                    <div className="text-center">
                        <Users className="size-12 mx-auto mb-3 opacity-20" />
                        <p className="text-lg mb-1">No users found</p>
                        <p className="text-sm text-muted-foreground">
                            {search || roleFilter !== 'all' || statusFilter !== 'all'
                                ? 'Try adjusting your filters.'
                                : 'Add your first user to get started.'}
                        </p>
                    </div>
                </div>
            ) : (
                <Card>
                    <Table>
                        <TableHeader>
                            <TableRow>
                                <TableHead>User</TableHead>
                                <TableHead>Role</TableHead>
                                <TableHead>Status</TableHead>
                                <TableHead>Phone Calls</TableHead>
                                <TableHead>Last Login</TableHead>
                                <TableHead>Created</TableHead>
                                <TableHead className="text-right">Actions</TableHead>
                            </TableRow>
                        </TableHeader>
                        <TableBody>
                            {users.map(u => (
                                <TableRow key={u.id}>
                                    <TableCell>
                                        <div className="font-medium text-sm">{u.full_name}</div>
                                        <div className="text-xs text-muted-foreground">{u.email}</div>
                                    </TableCell>
                                    <TableCell>
                                        <Badge
                                            variant={u.membership_role === 'company_admin' ? 'default' : 'secondary'}
                                            className="cursor-pointer"
                                            onClick={() => setRoleDialog({
                                                open: true,
                                                user: u,
                                                newRole: u.membership_role === 'company_admin' ? 'company_member' : 'company_admin',
                                            })}
                                        >
                                            {u.membership_role === 'company_admin' ? (
                                                <><ShieldCheck className="size-3 mr-1" />Admin</>
                                            ) : (
                                                <><User className="size-3 mr-1" />Member</>
                                            )}
                                        </Badge>
                                    </TableCell>
                                    <TableCell>
                                        <Badge variant={u.membership_status === 'active' ? 'outline' : 'destructive'}>
                                            {u.membership_status === 'active' ? 'Active' : 'Disabled'}
                                        </Badge>
                                    </TableCell>
                                    <TableCell>
                                        <Badge
                                            variant={u.phone_calls_allowed ? 'outline' : 'secondary'}
                                            className={`cursor-pointer ${u.phone_calls_allowed ? 'border-emerald-300 text-emerald-700' : 'opacity-60'}`}
                                            onClick={() => togglePhoneCalls(u)}
                                        >
                                            {u.phone_calls_allowed ? (
                                                <><Phone className="size-3 mr-1" />Allowed</>
                                            ) : (
                                                <><PhoneOff className="size-3 mr-1" />Not Allowed</>
                                            )}
                                        </Badge>
                                    </TableCell>
                                    <TableCell className="text-sm">{fmtDate(u.last_login_at)}</TableCell>
                                    <TableCell className="text-sm">{fmtDate(u.created_at)}</TableCell>
                                    <TableCell className="text-right">
                                        <Button
                                            variant="ghost"
                                            size="sm"
                                            disabled={actionLoading === u.id}
                                            className={u.membership_status === 'active'
                                                ? 'text-destructive hover:text-destructive'
                                                : 'text-green-600 hover:text-green-600'}
                                            onClick={() => setConfirmDialog({
                                                open: true,
                                                title: u.membership_status === 'active' ? 'Disable User' : 'Enable User',
                                                description: u.membership_status === 'active'
                                                    ? `Disable ${u.full_name}? They will lose access.`
                                                    : `Re-enable ${u.full_name}? They will regain access.`,
                                                onConfirm: () => {
                                                    setConfirmDialog(prev => ({ ...prev, open: false }));
                                                    toggleStatus(u);
                                                },
                                            })}
                                        >
                                            {u.membership_status === 'active'
                                                ? <><Ban className="size-4 mr-1" />Disable</>
                                                : <><CheckCircle2 className="size-4 mr-1" />Enable</>
                                            }
                                        </Button>
                                    </TableCell>
                                </TableRow>
                            ))}
                        </TableBody>
                    </Table>
                </Card>
            )}

            {/* Pagination */}
            {totalPages > 1 && (
                <div className="flex items-center justify-between text-sm text-muted-foreground">
                    <span>
                        Showing {(page - 1) * limit + 1}–{Math.min(page * limit, data?.total || 0)} of {data?.total}
                    </span>
                    <div className="flex gap-2">
                        <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage(p => p - 1)}>
                            <ChevronLeft className="size-4 mr-1" /> Previous
                        </Button>
                        <Button variant="outline" size="sm" disabled={page >= totalPages} onClick={() => setPage(p => p + 1)}>
                            Next <ChevronRight className="size-4 ml-1" />
                        </Button>
                    </div>
                </div>
            )}

            {/* ── Create User Dialog ─────────────────────────────── */}
            <Dialog open={createOpen} onOpenChange={open => {
                if (!open) { setTempPassword(null); }
                setCreateOpen(open);
            }}>
                <DialogContent>
                    <DialogHeader>
                        <DialogTitle>
                            {tempPassword ? 'User Created' : 'Add New User'}
                        </DialogTitle>
                        <DialogDescription>
                            {tempPassword
                                ? 'Share the temporary password with the user. It will only be shown once.'
                                : 'The user will receive a temporary password and must change it on first login.'}
                        </DialogDescription>
                    </DialogHeader>

                    {tempPassword ? (
                        <div className="space-y-4 py-2">
                            <div className="rounded-lg border bg-muted/50 p-4">
                                <Label className="text-xs text-muted-foreground">Temporary Password</Label>
                                <div className="flex items-center gap-2 mt-1">
                                    <code className="text-lg font-mono font-semibold flex-1">{tempPassword}</code>
                                    <Button variant="outline" size="sm" onClick={() => {
                                        navigator.clipboard.writeText(tempPassword);
                                        toast.success('Copied!');
                                    }}>
                                        <Copy className="size-4" />
                                    </Button>
                                </div>
                            </div>
                            <DialogFooter>
                                <Button onClick={() => { setCreateOpen(false); setTempPassword(null); }}>
                                    Done
                                </Button>
                            </DialogFooter>
                        </div>
                    ) : (
                        <div className="space-y-4 py-2">
                            <div className="space-y-2">
                                <Label htmlFor="user-name">Full Name *</Label>
                                <Input
                                    id="user-name"
                                    placeholder="John Doe"
                                    value={createForm.full_name}
                                    onChange={e => setCreateForm(f => ({ ...f, full_name: e.target.value }))}
                                />
                            </div>
                            <div className="space-y-2">
                                <Label htmlFor="user-email">Email *</Label>
                                <Input
                                    id="user-email"
                                    type="email"
                                    placeholder="john@company.com"
                                    value={createForm.email}
                                    onChange={e => setCreateForm(f => ({ ...f, email: e.target.value }))}
                                />
                            </div>
                            <div className="space-y-2">
                                <Label>Role</Label>
                                <Select
                                    value={createForm.role}
                                    onValueChange={v => setCreateForm(f => ({ ...f, role: v }))}
                                >
                                    <SelectTrigger>
                                        <SelectValue />
                                    </SelectTrigger>
                                    <SelectContent>
                                        <SelectItem value="company_member">Member</SelectItem>
                                        <SelectItem value="company_admin">Admin</SelectItem>
                                    </SelectContent>
                                </Select>
                            </div>
                            <DialogFooter>
                                <Button variant="outline" onClick={() => setCreateOpen(false)}>
                                    Cancel
                                </Button>
                                <Button onClick={handleCreate} disabled={creating}>
                                    {creating ? 'Creating…' : 'Create User'}
                                </Button>
                            </DialogFooter>
                        </div>
                    )}
                </DialogContent>
            </Dialog>

            {/* ── Role Change Dialog ─────────────────────────────── */}
            <Dialog open={roleDialog.open} onOpenChange={open => setRoleDialog(prev => ({ ...prev, open }))}>
                <DialogContent>
                    <DialogHeader>
                        <DialogTitle>Change Role</DialogTitle>
                        <DialogDescription>
                            Change role for <strong>{roleDialog.user?.full_name}</strong> from{' '}
                            <Badge variant="secondary" className="mx-1">
                                {roleDialog.user?.membership_role === 'company_admin' ? 'Admin' : 'Member'}
                            </Badge>
                            to{' '}
                            <Badge variant="default" className="mx-1">
                                {roleDialog.newRole === 'company_admin' ? 'Admin' : 'Member'}
                            </Badge>
                        </DialogDescription>
                    </DialogHeader>
                    <DialogFooter>
                        <Button variant="outline" onClick={() => setRoleDialog(prev => ({ ...prev, open: false }))}>
                            Cancel
                        </Button>
                        <Button onClick={handleRoleChange} disabled={actionLoading === roleDialog.user?.id}>
                            {actionLoading === roleDialog.user?.id ? 'Saving…' : 'Confirm'}
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>

            {/* ── Confirm Dialog ─────────────────────────────────── */}
            <Dialog open={confirmDialog.open} onOpenChange={open => setConfirmDialog(prev => ({ ...prev, open }))}>
                <DialogContent>
                    <DialogHeader>
                        <DialogTitle>{confirmDialog.title}</DialogTitle>
                        <DialogDescription>{confirmDialog.description}</DialogDescription>
                    </DialogHeader>
                    <DialogFooter>
                        <Button variant="outline" onClick={() => setConfirmDialog(prev => ({ ...prev, open: false }))}>
                            Cancel
                        </Button>
                        <Button variant="destructive" onClick={confirmDialog.onConfirm}>
                            Confirm
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </div>
    );
}
