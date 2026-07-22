import { useState } from 'react';
import { Input } from '../ui/input';
import { Button } from '../ui/button';
import { Badge } from '../ui/badge';
import { Skeleton } from '../ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../ui/table';
import { KeyRound, Users as UsersIcon } from 'lucide-react';
import { usePlatformUsers, type PlatformUser } from '../../hooks/usePlatformAdmin';
import { formatRelativeTime } from '../../utils/formatters';
import { PlatformResetPasswordDialog } from './PlatformResetPasswordDialog';

const ONLINE_MS = 5 * 60 * 1000;

const ROLE_LABEL: Record<string, string> = {
    tenant_admin: 'Admin',
    company_admin: 'Admin',
    dispatcher: 'Dispatcher',
    provider: 'Field tech',
    field_provider: 'Field tech',
    manager: 'Manager',
};

function roleLabel(u: PlatformUser): string {
    return ROLE_LABEL[u.role_key] || ROLE_LABEL[u.role] || u.role_key || u.role || '—';
}

/** Green dot when active in the last 5 minutes, else muted "last seen". */
function Presence({ ts }: { ts: string | null }) {
    if (!ts) {
        return (
            <span className="inline-flex items-center gap-2 text-sm text-muted-foreground">
                <span className="size-2 rounded-full bg-border" />Never signed in
            </span>
        );
    }
    const t = new Date(ts).getTime();
    if (Date.now() - t < ONLINE_MS) {
        return (
            <span className="inline-flex items-center gap-2 text-sm font-semibold text-emerald-600">
                <span className="size-2 rounded-full bg-emerald-500 ring-4 ring-emerald-500/15" />Online
            </span>
        );
    }
    return (
        <span className="inline-flex items-center gap-2 text-sm text-muted-foreground">
            <span className="size-2 rounded-full bg-border" />{formatRelativeTime(t)}
        </span>
    );
}

export function PlatformUsersTab() {
    const { users, total, page, setPage, pageSize, searchInput, setSearchInput, loading } = usePlatformUsers();
    const [resetUser, setResetUser] = useState<PlatformUser | null>(null);
    const [resetOpen, setResetOpen] = useState(false);

    const openReset = (u: PlatformUser) => { setResetUser(u); setResetOpen(true); };

    const pages = Math.max(1, Math.ceil(total / pageSize));
    const from = total === 0 ? 0 : (page - 1) * pageSize + 1;
    const to = Math.min(page * pageSize, total);

    return (
        <div className="space-y-4">
            <div className="flex items-center justify-between gap-3">
                <div className="w-full sm:w-1/2">
                    <Input
                        placeholder="Search by name, email, or company…"
                        value={searchInput}
                        onChange={e => setSearchInput(e.target.value)}
                    />
                </div>
                <div className="flex items-center gap-1.5 whitespace-nowrap text-sm text-muted-foreground">
                    <UsersIcon className="size-3.5" />{total}
                </div>
            </div>

            {/* Ряды-тайлы на канвасе (LAYOUT-CANON правило 7, .blanc-table-tiles). */}
            <Table className="blanc-table-tiles">
                <TableHeader>
                    <TableRow>
                        <TableHead className="px-4">Company</TableHead>
                        <TableHead className="px-4">Name</TableHead>
                        <TableHead className="px-4">Email</TableHead>
                        <TableHead className="px-4">Role</TableHead>
                        <TableHead className="px-4">Presence</TableHead>
                        <TableHead className="px-4 text-right">Action</TableHead>
                    </TableRow>
                </TableHeader>
                <TableBody>
                    {loading && users.length === 0 ? (
                        [...Array(6)].map((_, i) => (
                            <TableRow key={i}>
                                {[...Array(6)].map((__, j) => (
                                    <TableCell key={j} className="px-4 py-2.5"><Skeleton className="h-6 w-full" /></TableCell>
                                ))}
                            </TableRow>
                        ))
                    ) : users.length === 0 ? (
                        <TableRow>
                            <TableCell colSpan={6} className="h-24 text-center text-muted-foreground">No users found.</TableCell>
                        </TableRow>
                    ) : (
                        users.map(u => (
                            <TableRow key={`${u.id}:${u.company_id}`}>
                                <TableCell className="px-4 py-2.5 font-medium">{u.company_name}</TableCell>
                                <TableCell className="px-4 py-2.5">{u.full_name || '—'}</TableCell>
                                <TableCell className="px-4 py-2.5 text-sm text-muted-foreground">{u.email}</TableCell>
                                <TableCell className="px-4 py-2.5"><Badge variant="secondary">{roleLabel(u)}</Badge></TableCell>
                                <TableCell className="px-4 py-2.5"><Presence ts={u.last_login_at} /></TableCell>
                                <TableCell className="px-4 py-2.5 text-right">
                                    <Button variant="ghost" size="sm" onClick={() => openReset(u)}>
                                        <KeyRound className="mr-1.5 size-4" />Reset password
                                    </Button>
                                </TableCell>
                            </TableRow>
                        ))
                    )}
                </TableBody>
            </Table>

            {total > pageSize && (
                <div className="flex items-center justify-between pt-1 text-sm text-muted-foreground">
                    <span>Showing {from}–{to} of {total}</span>
                    <div className="flex gap-2">
                        <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage(page - 1)}>Previous</Button>
                        <Button variant="outline" size="sm" disabled={page >= pages} onClick={() => setPage(page + 1)}>Next</Button>
                    </div>
                </div>
            )}

            <PlatformResetPasswordDialog user={resetUser} open={resetOpen} setOpen={setResetOpen} />
        </div>
    );
}
