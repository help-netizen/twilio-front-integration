import { Button } from '../components/ui/button';
import { Card } from '../components/ui/card';
import { Badge } from '../components/ui/badge';
import { Input } from '../components/ui/input';
import { Label } from '../components/ui/label';
import { Separator } from '../components/ui/separator';
import { Skeleton } from '../components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../components/ui/table';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../components/ui/select';
import { Users, UserPlus, RefreshCw, ShieldCheck, User, ChevronLeft, ChevronRight, Ban, CheckCircle2, Phone, PhoneOff } from 'lucide-react';
import { useCompanyUsers } from '../hooks/useCompanyUsers';
import { CreateUserDialog, RoleChangeDialog, ConfirmActionDialog } from './CompanyUserDialogs';

export default function CompanyUsersPage() {
    const h = useCompanyUsers();

    return (
        <div className="max-w-5xl mx-auto p-6 space-y-6">
            <div className="flex items-center justify-between">
                <div><div className="flex items-center gap-2 mb-1"><Users className="size-5 text-muted-foreground" /><h2 className="text-xl font-semibold">Company Users</h2></div><p className="text-sm text-muted-foreground">Manage users, roles, and access for your company.</p></div>
                <Button onClick={() => { h.setCreateForm(() => ({ full_name: '', email: '', role: 'company_member' })); h.setTempPassword(null); h.setCreateOpen(true); }}><UserPlus className="size-4 mr-2" />Add User</Button>
            </div>
            <Separator />

            <div className="flex flex-wrap items-end gap-3">
                <div className="flex-1 min-w-[200px]"><Label className="text-xs text-muted-foreground mb-1">Search</Label><Input placeholder="Name or email…" value={h.searchInput} onChange={e => h.setSearchInput(e.target.value)} /></div>
                <div className="w-[160px]"><Label className="text-xs text-muted-foreground mb-1">Role</Label><Select value={h.roleFilter} onValueChange={v => { h.setRoleFilter(v); h.setPage(1); }}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="all">All Roles</SelectItem><SelectItem value="company_admin">Admin</SelectItem><SelectItem value="company_member">Member</SelectItem></SelectContent></Select></div>
                <div className="w-[160px]"><Label className="text-xs text-muted-foreground mb-1">Status</Label><Select value={h.statusFilter} onValueChange={v => { h.setStatusFilter(v); h.setPage(1); }}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="all">All Status</SelectItem><SelectItem value="active">Active</SelectItem><SelectItem value="inactive">Disabled</SelectItem></SelectContent></Select></div>
                <Button variant="outline" size="icon" onClick={h.fetchUsers} disabled={h.loading}><RefreshCw className={`size-4 ${h.loading ? 'animate-spin' : ''}`} /></Button>
            </div>

            {h.loading ? (
                <div className="space-y-2">{[...Array(5)].map((_, i) => <Skeleton key={i} className="h-14 w-full" />)}</div>
            ) : h.users.length === 0 ? (
                <div className="flex items-center justify-center py-16"><div className="text-center"><Users className="size-12 mx-auto mb-3 opacity-20" /><p className="text-lg mb-1">No users found</p><p className="text-sm text-muted-foreground">{h.search || h.roleFilter !== 'all' || h.statusFilter !== 'all' ? 'Try adjusting your filters.' : 'Add your first user to get started.'}</p></div></div>
            ) : (
                <Card><Table><TableHeader><TableRow><TableHead>User</TableHead><TableHead>Role</TableHead><TableHead>Status</TableHead><TableHead>Phone Calls</TableHead><TableHead>Last Login</TableHead><TableHead>Created</TableHead><TableHead className="text-right">Actions</TableHead></TableRow></TableHeader>
                    <TableBody>{h.users.map(u => (
                        <TableRow key={u.id}>
                            <TableCell><div className="font-medium text-sm">{u.full_name}</div><div className="text-xs text-muted-foreground">{u.email}</div></TableCell>
                            <TableCell><Badge variant={u.membership_role === 'company_admin' ? 'default' : 'secondary'} className="cursor-pointer" onClick={() => h.setRoleDialog({ open: true, user: u, newRole: u.membership_role === 'company_admin' ? 'company_member' : 'company_admin' })}>{u.membership_role === 'company_admin' ? <><ShieldCheck className="size-3 mr-1" />Admin</> : <><User className="size-3 mr-1" />Member</>}</Badge></TableCell>
                            <TableCell><Badge variant={u.membership_status === 'active' ? 'outline' : 'destructive'}>{u.membership_status === 'active' ? 'Active' : 'Disabled'}</Badge></TableCell>
                            <TableCell><Badge variant={u.phone_calls_allowed ? 'outline' : 'secondary'} className={`cursor-pointer ${u.phone_calls_allowed ? 'border-emerald-300 text-emerald-700' : 'opacity-60'}`} onClick={() => h.togglePhoneCalls(u)}>{u.phone_calls_allowed ? <><Phone className="size-3 mr-1" />Allowed</> : <><PhoneOff className="size-3 mr-1" />Not Allowed</>}</Badge></TableCell>
                            <TableCell className="text-sm">{h.fmtDate(u.last_login_at)}</TableCell>
                            <TableCell className="text-sm">{h.fmtDate(u.created_at)}</TableCell>
                            <TableCell className="text-right"><Button variant="ghost" size="sm" disabled={h.actionLoading === u.id} className={u.membership_status === 'active' ? 'text-destructive hover:text-destructive' : 'text-green-600 hover:text-green-600'} onClick={() => h.setConfirmDialog({ open: true, title: u.membership_status === 'active' ? 'Disable User' : 'Enable User', description: u.membership_status === 'active' ? `Disable ${u.full_name}? They will lose access.` : `Re-enable ${u.full_name}? They will regain access.`, onConfirm: () => { h.setConfirmDialog((prev: any) => ({ ...prev, open: false })); h.toggleStatus(u); } })}>{u.membership_status === 'active' ? <><Ban className="size-4 mr-1" />Disable</> : <><CheckCircle2 className="size-4 mr-1" />Enable</>}</Button></TableCell>
                        </TableRow>
                    ))}</TableBody></Table></Card>
            )}

            {h.totalPages > 1 && (
                <div className="flex items-center justify-between text-sm text-muted-foreground">
                    <span>Showing {(h.page - 1) * h.limit + 1}–{Math.min(h.page * h.limit, h.data?.total || 0)} of {h.data?.total}</span>
                    <div className="flex gap-2"><Button variant="outline" size="sm" disabled={h.page <= 1} onClick={() => h.setPage(p => p - 1)}><ChevronLeft className="size-4 mr-1" /> Previous</Button><Button variant="outline" size="sm" disabled={h.page >= h.totalPages} onClick={() => h.setPage(p => p + 1)}>Next <ChevronRight className="size-4 ml-1" /></Button></div>
                </div>
            )}

            <CreateUserDialog open={h.createOpen} setOpen={h.setCreateOpen} createForm={h.createForm} setCreateForm={h.setCreateForm} creating={h.creating} tempPassword={h.tempPassword} setTempPassword={h.setTempPassword} handleCreate={h.handleCreate} />
            <RoleChangeDialog roleDialog={h.roleDialog} setRoleDialog={h.setRoleDialog} handleRoleChange={h.handleRoleChange} actionLoading={h.actionLoading} />
            <ConfirmActionDialog confirmDialog={h.confirmDialog} setConfirmDialog={h.setConfirmDialog} />
        </div>
    );
}
