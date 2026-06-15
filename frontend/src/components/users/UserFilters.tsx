import { Input } from '../ui/input';
import { Label } from '../ui/label';
import { Button } from '../ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select';
import { RefreshCw } from 'lucide-react';
import { ROLE_LABELS } from './UsersTable';

interface UserFiltersProps {
    searchInput: string;
    setSearchInput: (v: string) => void;
    roleFilter: string;
    setRoleFilter: (v: string) => void;
    statusFilter: string;
    setStatusFilter: (v: string) => void;
    onResetPage: () => void;
    onRefresh: () => void;
    loading: boolean;
}

/**
 * Shared user filter bar (RBAC-096). Role options come straight from
 * ROLE_LABELS, so the filter vocabulary always matches what the table renders
 * (fixes the old company_admin/company_member vs role_key mismatch).
 */
export function UserFilters({ searchInput, setSearchInput, roleFilter, setRoleFilter, statusFilter, setStatusFilter, onResetPage, onRefresh, loading }: UserFiltersProps) {
    return (
        <div className="flex flex-wrap items-end gap-3">
            <div className="flex-1 min-w-[200px]">
                <Label className="text-xs text-muted-foreground mb-1">Search</Label>
                <Input placeholder="Name or email…" value={searchInput} onChange={e => setSearchInput(e.target.value)} />
            </div>
            <div className="min-w-[160px]">
                <Label className="text-xs text-muted-foreground mb-1">Role</Label>
                <Select value={roleFilter} onValueChange={v => { setRoleFilter(v); onResetPage(); }}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                        <SelectItem value="all">All roles</SelectItem>
                        {Object.entries(ROLE_LABELS).map(([key, r]) => (
                            <SelectItem key={key} value={key}>{r.label}</SelectItem>
                        ))}
                    </SelectContent>
                </Select>
            </div>
            <div className="min-w-[160px]">
                <Label className="text-xs text-muted-foreground mb-1">Status</Label>
                <Select value={statusFilter} onValueChange={v => { setStatusFilter(v); onResetPage(); }}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                        <SelectItem value="all">All status</SelectItem>
                        <SelectItem value="active">Active</SelectItem>
                        <SelectItem value="inactive">Disabled</SelectItem>
                    </SelectContent>
                </Select>
            </div>
            <Button variant="outline" size="icon" onClick={onRefresh} disabled={loading} aria-label="Refresh">
                <RefreshCw className={`size-4 ${loading ? 'animate-spin' : ''}`} />
            </Button>
        </div>
    );
}
