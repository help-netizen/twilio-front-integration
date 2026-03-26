import { Button } from '../components/ui/button';
import { Card } from '../components/ui/card';
import { Badge } from '../components/ui/badge';
import { Input } from '../components/ui/input';
import { Label } from '../components/ui/label';
import { Separator } from '../components/ui/separator';
import { Skeleton } from '../components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../components/ui/table';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../components/ui/select';
import { Users, UserPlus, RefreshCw, ShieldCheck, User, ChevronLeft, ChevronRight, Ban, CheckCircle2, Phone, MapPin, Truck, Settings } from 'lucide-react';
import { useCompanyUsers } from '../hooks/useCompanyUsers';
import { CreateUserDialog, EditUserDialog, ConfirmActionDialog } from './CompanyUserDialogs';

const ROLE_LABELS: Record<string, { label: string; icon: any; color: "default" | "secondary" | "outline" }> = {
    tenant_admin: { label: 'Admin', icon: ShieldCheck, color: 'default' },
    manager: { label: 'Manager', icon: ShieldCheck, color: 'default' },
    dispatcher: { label: 'Dispatcher', icon: User, color: 'secondary' },
    provider: { label: 'Field Provider', icon: Truck, color: 'outline' },
};

export default function CompanyUsersPage() {
    const h = useCompanyUsers();

    return (
        <div className="max-w-5xl mx-auto p-6 space-y-6">
            <div className="flex items-center justify-between">
                <div><div className="flex items-center gap-2 mb-1"><Users className="size-5 text-muted-foreground" /><h2 className="text-xl font-semibold">Company Users</h2></div><p className="text-sm text-muted-foreground">Manage users, roles, and access for your company.</p></div>
                <Button onClick={() => { h.setCreateForm(() => ({ full_name: '', email: '', role_key: 'dispatcher' })); h.setTempPassword(null); h.setCreateOpen(true); }}><UserPlus className="size-4 mr-2" />Add User</Button>
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
                <Card><Table><TableHeader><TableRow><TableHead>User</TableHead><TableHead>Role</TableHead><TableHead>Status</TableHead><TableHead>Profile</TableHead><TableHead>Last Login</TableHead><TableHead className="text-right">Actions</TableHead></TableRow></TableHeader>
                    <TableBody>{h.users.map(u => {
                        const rk = u.role_key || (u.membership_role === 'company_admin' ? 'tenant_admin' : 'dispatcher');
                        const r = ROLE_LABELS[rk] || ROLE_LABELS.dispatcher;
                        const Icon = r.icon;

                        return (
                        <TableRow key={u.id}>
                            <TableCell><div className="font-medium text-sm flex items-center gap-2"><div style={{ backgroundColor: u.schedule_color || '#3B82F6' }} className="w-2.5 h-2.5 rounded-full flex-shrink-0" />{u.full_name}</div><div className="text-xs text-muted-foreground pl-4">{u.email}</div></TableCell>
                            <TableCell><Badge variant={r.color} className="font-medium"><Icon className="size-3 mr-1.5" />{r.label}</Badge></TableCell>
                            <TableCell><Badge variant={u.membership_status === 'active' ? 'outline' : 'destructive'}>{u.membership_status === 'active' ? 'Active' : 'Disabled'}</Badge></TableCell>
                            <TableCell>
                                <div className="flex gap-1.5 flex-wrap max-w-[200px]">
                                    {u.phone_calls_allowed && <Badge variant="secondary" className="text-[10px] px-1.5"><Phone className="size-2.5 mr-1" />Softphone</Badge>}
                                    {u.is_provider && <Badge variant="secondary" className="text-[10px] px-1.5"><Truck className="size-2.5 mr-1" />Provider</Badge>}
                                    {u.location_tracking_enabled && <Badge variant="secondary" className="text-[10px] px-1.5"><MapPin className="size-2.5 mr-1" />Tracking</Badge>}
                                </div>
                            </TableCell>
                            <TableCell className="text-sm">{h.fmtDate(u.last_login_at)}</TableCell>
                            <TableCell className="text-right flex items-center justify-end gap-1">
                                <Button variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground hover:text-foreground" onClick={() => h.openEditDialog(u)}><Settings className="size-4" /></Button>
                                <Button variant="ghost" size="icon" disabled={h.actionLoading === u.id} className={`h-8 w-8 ${u.membership_status === 'active' ? 'text-destructive hover:text-destructive' : 'text-green-600 hover:text-green-600'}`} onClick={() => h.setConfirmDialog({ open: true, title: u.membership_status === 'active' ? 'Disable User' : 'Enable User', description: u.membership_status === 'active' ? `Disable ${u.full_name}? They will lose access.` : `Re-enable ${u.full_name}? They will regain access.`, onConfirm: () => { h.setConfirmDialog((prev: any) => ({ ...prev, open: false })); h.toggleStatus(u); } })}>{u.membership_status === 'active' ? <Ban className="size-4" /> : <CheckCircle2 className="size-4" />}</Button>
                            </TableCell>
                        </TableRow>
                    );})}</TableBody></Table></Card>
            )}

            {h.totalPages > 1 && (
                <div className="flex items-center justify-between text-sm text-muted-foreground">
                    <span>Showing {(h.page - 1) * h.limit + 1}–{Math.min(h.page * h.limit, h.data?.total || 0)} of {h.data?.total}</span>
                    <div className="flex gap-2"><Button variant="outline" size="sm" disabled={h.page <= 1} onClick={() => h.setPage(p => p - 1)}><ChevronLeft className="size-4 mr-1" /> Previous</Button><Button variant="outline" size="sm" disabled={h.page >= h.totalPages} onClick={() => h.setPage(p => p + 1)}>Next <ChevronRight className="size-4 ml-1" /></Button></div>
                </div>
            )}

            <CreateUserDialog open={h.createOpen} setOpen={h.setCreateOpen} createForm={h.createForm} setCreateForm={h.setCreateForm} creating={h.creating} tempPassword={h.tempPassword} setTempPassword={h.setTempPassword} handleCreate={h.handleCreate} />
            <EditUserDialog open={h.editOpen} setOpen={h.setEditOpen} user={h.editUser} form={h.editForm} setForm={h.setEditForm} handleUpdate={h.handleUpdateUser} loading={h.actionLoading} />
            <ConfirmActionDialog confirmDialog={h.confirmDialog} setConfirmDialog={h.setConfirmDialog} />
        </div>
    );
}
