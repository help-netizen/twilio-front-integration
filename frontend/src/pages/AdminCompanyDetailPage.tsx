import { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { authedFetch } from '../services/apiClient';
import { Button } from '../components/ui/button';
import { Badge } from '../components/ui/badge';
import { Skeleton } from '../components/ui/skeleton';
import { UserPlus, ChevronLeft, ChevronRight, ArrowLeft } from 'lucide-react';
import { toast } from 'sonner';
import { useAdminCompanyUsers, type CompanyUser } from '../hooks/useAdminCompanyUsers';
import { CreateUserDialog, EditUserDialog, ConfirmActionDialog } from './CompanyUserDialogs';
import { ResetPasswordDialog } from '../components/super-admin/ResetPasswordDialog';
import { UsersTable } from '../components/users/UsersTable';
import { UserFilters } from '../components/users/UserFilters';

interface CompanyInfo {
    id: string;
    name: string;
    slug: string;
    status: string;
    timezone: string;
    contact_email?: string;
    created_at: string;
}

export default function AdminCompanyDetailPage() {
    const { companyId } = useParams<{ companyId: string }>();
    const navigate = useNavigate();
    const [company, setCompany] = useState<CompanyInfo | null>(null);
    const [companyLoading, setCompanyLoading] = useState(true);

    const h = useAdminCompanyUsers(companyId!);

    useEffect(() => {
        if (!companyId) return;
        (async () => {
            setCompanyLoading(true);
            try {
                const res = await authedFetch(`/api/admin/companies/${companyId}`);
                if (res.ok) {
                    const data = await res.json();
                    setCompany(data.company || data);
                } else {
                    toast.error('Failed to load company');
                    navigate('/settings/admin');
                }
            } catch {
                toast.error('Connection error');
            } finally {
                setCompanyLoading(false);
            }
        })();
    }, [companyId]);

    const requestToggle = (u: CompanyUser) => h.setConfirmDialog({
        open: true,
        title: u.membership_status === 'active' ? 'Disable user' : 'Enable user',
        description: u.membership_status === 'active'
            ? `Disable ${u.full_name}? They will lose access.`
            : `Re-enable ${u.full_name}? They will regain access.`,
        onConfirm: () => { h.setConfirmDialog((prev: any) => ({ ...prev, open: false })); h.toggleStatus(u); },
    });

    // Meta line: only render facts that exist (no timezone fallback filler).
    const meta = company
        ? [company.slug, company.timezone, `Created ${new Date(company.created_at).toLocaleDateString()}`].filter(Boolean).join(' · ')
        : '';

    return (
        <div className="max-w-6xl mx-auto p-6 space-y-6">
            <div>
                <Button variant="ghost" size="sm" className="mb-3 -ml-2 text-muted-foreground" onClick={() => navigate('/settings/admin')}>
                    <ArrowLeft className="size-4 mr-1" /> Back to companies
                </Button>

                {companyLoading ? (
                    <div className="space-y-2">
                        <Skeleton className="h-8 w-64" />
                        <Skeleton className="h-5 w-40" />
                    </div>
                ) : company ? (
                    <div className="flex items-start justify-between gap-4">
                        <div>
                            <div className="flex items-center gap-3">
                                <h1 className="text-2xl font-semibold" style={{ fontFamily: 'var(--blanc-font-heading, Manrope), sans-serif', color: 'var(--blanc-ink-1, #202734)' }}>{company.name}</h1>
                                <Badge variant={company.status === 'active' ? 'default' : company.status === 'suspended' ? 'destructive' : 'secondary'}>
                                    {company.status}
                                </Badge>
                            </div>
                            <p className="text-sm text-muted-foreground mt-1">{meta}</p>
                        </div>
                        <Button onClick={() => { h.setCreateForm(() => ({ full_name: '', email: '', role_key: 'dispatcher' })); h.setTempPassword(null); h.setCreateOpen(true); }}>
                            <UserPlus className="size-4 mr-2" />Add user
                        </Button>
                    </div>
                ) : null}
            </div>

            <div>
                <div className="blanc-eyebrow mb-3">
                    Users{h.data ? ` · ${h.data.total}` : ''}
                </div>
                <UserFilters
                    searchInput={h.searchInput} setSearchInput={h.setSearchInput}
                    roleFilter={h.roleFilter} setRoleFilter={h.setRoleFilter}
                    statusFilter={h.statusFilter} setStatusFilter={h.setStatusFilter}
                    onResetPage={() => h.setPage(1)} onRefresh={h.fetchUsers} loading={h.loading}
                />
            </div>

            <UsersTable
                users={h.users} loading={h.loading}
                filtered={!!h.search || h.roleFilter !== 'all' || h.statusFilter !== 'all'}
                fmtDate={h.fmtDate} actionLoading={h.actionLoading}
                onEdit={h.openEditDialog} onToggleStatus={requestToggle}
                onResetPassword={h.openResetPasswordDialog}
                emptyHint="Add the first user to this company."
            />

            {h.totalPages > 1 && (
                <div className="flex items-center justify-between text-sm text-muted-foreground">
                    <span>Showing {(h.page - 1) * h.limit + 1}–{Math.min(h.page * h.limit, h.data?.total || 0)} of {h.data?.total}</span>
                    <div className="flex gap-2">
                        <Button variant="outline" size="sm" disabled={h.page <= 1} onClick={() => h.setPage(p => p - 1)}><ChevronLeft className="size-4 mr-1" /> Previous</Button>
                        <Button variant="outline" size="sm" disabled={h.page >= h.totalPages} onClick={() => h.setPage(p => p + 1)}>Next <ChevronRight className="size-4 ml-1" /></Button>
                    </div>
                </div>
            )}

            <CreateUserDialog open={h.createOpen} setOpen={h.setCreateOpen} createForm={h.createForm} setCreateForm={h.setCreateForm} creating={h.creating} tempPassword={h.tempPassword} setTempPassword={h.setTempPassword} handleCreate={h.handleCreate} />
            <EditUserDialog open={h.editOpen} setOpen={h.setEditOpen} user={h.editUser} form={h.editForm} setForm={h.setEditForm} handleUpdate={h.handleUpdateUser} loading={h.actionLoading} />
            <ConfirmActionDialog confirmDialog={h.confirmDialog} setConfirmDialog={h.setConfirmDialog} />
            <ResetPasswordDialog open={h.resetPasswordOpen} setOpen={h.setResetPasswordOpen} user={h.resetPasswordUser} loading={h.resetPasswordLoading} tempPassword={h.resetTempPassword} setTempPassword={h.setResetTempPassword} handleReset={h.handleResetPassword} />
        </div>
    );
}
