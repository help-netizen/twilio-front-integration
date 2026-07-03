import { Button } from '../components/ui/button';
import { UserPlus, ChevronLeft, ChevronRight } from 'lucide-react';
import { useCompanyUsers, type CompanyUser } from '../hooks/useCompanyUsers';
import { CreateUserDialog, EditUserDialog, ConfirmActionDialog } from './CompanyUserDialogs';
import { SettingsPageShell } from '../components/settings/SettingsPageShell';
import { UsersTable } from '../components/users/UsersTable';
import { UserFilters } from '../components/users/UserFilters';

export default function CompanyUsersPage() {
    const h = useCompanyUsers();

    const requestToggle = (u: CompanyUser) => h.setConfirmDialog({
        open: true,
        title: u.membership_status === 'active' ? 'Disable user' : 'Enable user',
        description: u.membership_status === 'active'
            ? `Disable ${u.full_name}? They will lose access.`
            : `Re-enable ${u.full_name}? They will regain access.`,
        onConfirm: () => { h.setConfirmDialog((prev: any) => ({ ...prev, open: false })); h.toggleStatus(u); },
    });

    return (
        <SettingsPageShell
            title="Company users"
            description="Manage who can sign in, their role, and what they can do."
            actions={
                <Button onClick={() => { h.setCreateForm(() => ({ full_name: '', email: '', role_key: 'dispatcher' })); h.setTempPassword(null); h.setCreateOpen(true); }}>
                    <UserPlus className="size-4 mr-2" />Add user
                </Button>
            }
        >
            {/* Filters + table + pagination — один поток, ритм от родителя (правило 2). */}
            <div className="flex flex-col gap-4">
                <UserFilters
                    searchInput={h.searchInput} setSearchInput={h.setSearchInput}
                    roleFilter={h.roleFilter} setRoleFilter={h.setRoleFilter}
                    statusFilter={h.statusFilter} setStatusFilter={h.setStatusFilter}
                    onResetPage={() => h.setPage(1)} onRefresh={h.fetchUsers} loading={h.loading}
                />

                <UsersTable
                    users={h.users} loading={h.loading}
                    filtered={!!h.search || h.roleFilter !== 'all' || h.statusFilter !== 'all'}
                    fmtDate={h.fmtDate} actionLoading={h.actionLoading}
                    onEdit={h.openEditDialog} onToggleStatus={requestToggle}
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
            </div>

            <CreateUserDialog open={h.createOpen} setOpen={h.setCreateOpen} createForm={h.createForm} setCreateForm={h.setCreateForm} creating={h.creating} tempPassword={h.tempPassword} setTempPassword={h.setTempPassword} handleCreate={h.handleCreate} />
            <EditUserDialog open={h.editOpen} setOpen={h.setEditOpen} user={h.editUser} form={h.editForm} setForm={h.setEditForm} handleUpdate={h.handleUpdateUser} loading={h.actionLoading} />
            <ConfirmActionDialog confirmDialog={h.confirmDialog} setConfirmDialog={h.setConfirmDialog} />
        </SettingsPageShell>
    );
}
