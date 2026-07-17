import { Card } from '../ui/card';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { Skeleton } from '../ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../ui/table';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '../ui/dropdown-menu';
import { Users, ShieldCheck, User, Truck, Phone, MapPin, MoreHorizontal, Settings, KeyRound, Ban, CheckCircle2 } from 'lucide-react';
import type { CompanyUser } from '../../hooks/useCompanyUsers';

// Single source of truth for role display — the modern role_key vocabulary.
// Keys match what the backend stores in role_key and what the role filter sends.
export const ROLE_LABELS: Record<string, { label: string; icon: any; color: 'default' | 'secondary' | 'outline' }> = {
    tenant_admin: { label: 'Admin', icon: ShieldCheck, color: 'default' },
    manager: { label: 'Manager', icon: ShieldCheck, color: 'default' },
    dispatcher: { label: 'Dispatcher', icon: User, color: 'secondary' },
    provider: { label: 'Field Provider', icon: Truck, color: 'outline' },
};

/** Normalize a row to its modern role_key — mirrors the backend's COALESCE rule. */
export function roleKeyOf(u: Pick<CompanyUser, 'role_key' | 'membership_role'>): string {
    return u.role_key || (u.membership_role === 'company_admin' ? 'tenant_admin' : 'dispatcher');
}

interface UsersTableProps {
    users: CompanyUser[];
    loading: boolean;
    /** Whether any filter is active — drives the empty-state copy. */
    filtered: boolean;
    fmtDate: (d: string | null) => string;
    actionLoading: string | null;
    onEdit: (u: CompanyUser) => void;
    onToggleStatus: (u: CompanyUser) => void;
    /** Optional — only super-admin can reset passwords. */
    onResetPassword?: (u: CompanyUser) => void;
    emptyHint?: string;
}

/**
 * Shared company-users table (RBAC-096). One table, one action pattern
 * (overflow menu), used by both the company-admin and super-admin surfaces so
 * the two never drift apart again.
 */
export function UsersTable({ users, loading, filtered, fmtDate, actionLoading, onEdit, onToggleStatus, onResetPassword, emptyHint }: UsersTableProps) {
    if (loading) {
        return <div className="space-y-2">{[...Array(5)].map((_, i) => <Skeleton key={i} className="h-14 w-full" />)}</div>;
    }

    if (users.length === 0) {
        return (
            <div className="flex items-center justify-center py-16">
                <div className="text-center">
                    <Users className="size-12 mx-auto mb-3 opacity-20" />
                    <p className="text-lg mb-1">No users found</p>
                    <p className="text-sm text-muted-foreground">
                        {filtered ? 'Try adjusting your filters.' : (emptyHint || 'Add your first user to get started.')}
                    </p>
                </div>
            </div>
        );
    }

    return (
        <Card className="overflow-x-auto">
            <Table>
                <TableHeader>
                    <TableRow>
                        <TableHead>User</TableHead>
                        <TableHead>Role</TableHead>
                        <TableHead>Status</TableHead>
                        <TableHead>Access</TableHead>
                        <TableHead>Last login</TableHead>
                        <TableHead className="text-right">Actions</TableHead>
                    </TableRow>
                </TableHeader>
                <TableBody>
                    {users.map(u => {
                        const r = ROLE_LABELS[roleKeyOf(u)] || ROLE_LABELS.dispatcher;
                        const Icon = r.icon;
                        const active = u.membership_status === 'active';
                        const busy = actionLoading === u.id;
                        return (
                            <TableRow key={u.id}>
                                <TableCell>
                                    <div className="font-medium text-sm flex items-center gap-2">
                                        <span style={{ backgroundColor: u.schedule_color || 'var(--blanc-ink-3, #7d8796)' }} className="size-2.5 rounded-full flex-shrink-0" />
                                        {u.full_name}
                                    </div>
                                    <div className="text-xs text-muted-foreground pl-[18px]">{u.email}</div>
                                </TableCell>
                                <TableCell>
                                    <Badge variant={r.color} className="font-medium"><Icon className="size-3 mr-1.5" />{r.label}</Badge>
                                </TableCell>
                                <TableCell>
                                    <Badge variant={active ? 'outline' : 'destructive'}>{active ? 'Active' : 'Disabled'}</Badge>
                                </TableCell>
                                <TableCell>
                                    <div className="flex gap-1.5 flex-wrap">
                                        {u.phone_calls_allowed && <Badge variant="secondary" className="text-[10px] px-1.5"><Phone className="size-2.5 mr-1" />Softphone</Badge>}
                                        {u.is_provider && <Badge variant="secondary" className="text-[10px] px-1.5"><Truck className="size-2.5 mr-1" />Provider</Badge>}
                                        {u.location_tracking_enabled && <Badge variant="secondary" className="text-[10px] px-1.5"><MapPin className="size-2.5 mr-1" />Tracking</Badge>}
                                    </div>
                                </TableCell>
                                <TableCell className="text-sm">{fmtDate(u.last_login_at)}</TableCell>
                                <TableCell className="text-right">
                                    <DropdownMenu>
                                        <DropdownMenuTrigger asChild>
                                            <Button variant="ghost" className="h-8 w-8 p-0" disabled={busy} aria-label={`Actions for ${u.full_name}`}>
                                                <MoreHorizontal className="size-4" />
                                            </Button>
                                        </DropdownMenuTrigger>
                                        <DropdownMenuContent align="end">
                                            <DropdownMenuItem onClick={() => onEdit(u)}>
                                                <Settings className="size-4 mr-2" /> Edit settings
                                            </DropdownMenuItem>
                                            {onResetPassword && (
                                                <DropdownMenuItem onClick={() => onResetPassword(u)}>
                                                    <KeyRound className="size-4 mr-2" /> Reset password
                                                </DropdownMenuItem>
                                            )}
                                            <DropdownMenuItem
                                                onClick={() => onToggleStatus(u)}
                                                className={active ? 'text-destructive' : 'text-green-600'}
                                            >
                                                {active ? <><Ban className="size-4 mr-2" /> Disable</> : <><CheckCircle2 className="size-4 mr-2" /> Enable</>}
                                            </DropdownMenuItem>
                                        </DropdownMenuContent>
                                    </DropdownMenu>
                                </TableCell>
                            </TableRow>
                        );
                    })}
                </TableBody>
            </Table>
        </Card>
    );
}
