import { Button } from '../ui/button';
import { SelectItem } from '../ui/select';
import { FloatingField } from '../ui/floating-field';
import { FloatingSelect } from '../ui/floating-select';
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
            <FloatingField containerClassName="flex-1 min-w-[200px]" label="Name or email" value={searchInput} onChange={e => setSearchInput(e.target.value)} />
            <FloatingSelect className="min-w-[160px]" label="Role" value={roleFilter} onValueChange={v => { setRoleFilter(v); onResetPage(); }}>
                <SelectItem value="all">All roles</SelectItem>
                {Object.entries(ROLE_LABELS).map(([key, r]) => (
                    <SelectItem key={key} value={key}>{r.label}</SelectItem>
                ))}
            </FloatingSelect>
            <FloatingSelect className="min-w-[160px]" label="Status" value={statusFilter} onValueChange={v => { setStatusFilter(v); onResetPage(); }}>
                <SelectItem value="all">All status</SelectItem>
                <SelectItem value="active">Active</SelectItem>
                <SelectItem value="inactive">Disabled</SelectItem>
            </FloatingSelect>
            <Button variant="outline" size="icon" onClick={onRefresh} disabled={loading} aria-label="Refresh">
                <RefreshCw className={`size-4 ${loading ? 'animate-spin' : ''}`} />
            </Button>
        </div>
    );
}
