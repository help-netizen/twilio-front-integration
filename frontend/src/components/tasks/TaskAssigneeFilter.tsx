import { useMemo } from 'react';
import { User, UserCog, Check } from 'lucide-react';
import { Popover, PopoverTrigger, PopoverContent } from '../ui/popover';
import type { Assignee, TaskFacets } from './tasksApi';

/**
 * TASKS-ASSIGNEE-FILTERS-001 (phase 1) — quick filter by assignee.
 * Top level = roles; nested under each = its users. Either a whole role or an
 * individual user can be selected (multi-select, OR-union). Two shortcuts —
 * "Assigned to me" / "Created by me" — save hunting for yourself in the list.
 * Each row shows a plain grey count of its OPEN tasks (active + snoozed).
 */

export interface AssigneeFilterValue {
    roles: string[];
    users: string[];
    authorMine: boolean;
    assigneeMine: boolean;
}

const ROLE_ORDER = ['tenant_admin', 'manager', 'dispatcher', 'provider'];
const ROLE_FALLBACK: Record<string, string> = {
    tenant_admin: 'Admin', manager: 'Manager', dispatcher: 'Dispatcher', provider: 'Provider', unassigned: 'Unassigned',
};

/** Plain tabular grey number — the count style (no colour, no icon). */
function Count({ n }: { n: number }) {
    return (
        <span style={{ fontSize: 13, color: 'var(--blanc-ink-3)', fontVariantNumeric: 'tabular-nums', minWidth: 18, textAlign: 'right' }}>
            {n > 0 ? n : ''}
        </span>
    );
}

function Row({ label, count, checked, onToggle, indent, strong }: {
    label: string; count: number; checked: boolean; onToggle: () => void; indent?: boolean; strong?: boolean;
}) {
    return (
        <button
            type="button"
            onClick={onToggle}
            className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-[rgba(25,25,25,0.05)]"
            style={{ paddingLeft: indent ? 28 : 8 }}
        >
            <span
                className="flex shrink-0 items-center justify-center"
                style={{
                    width: 16, height: 16, borderRadius: 5,
                    border: `1.5px solid ${checked ? 'var(--blanc-accent)' : 'var(--blanc-line-strong)'}`,
                    background: checked ? 'var(--blanc-accent)' : 'transparent',
                }}
            >
                {checked && <Check className="size-3" style={{ color: '#fff' }} />}
            </span>
            <span className="min-w-0 flex-1 truncate" style={{ fontSize: 14, fontWeight: strong ? 600 : 500, color: 'var(--blanc-ink-1)' }}>
                {label}
            </span>
            <Count n={count} />
        </button>
    );
}

export function TaskAssigneeFilter({ assignees, facets, myEmail, value, onChange }: {
    assignees: Assignee[];
    facets: TaskFacets | null;
    myEmail: string | null;
    value: AssigneeFilterValue;
    onChange: (next: AssigneeFilterValue) => void;
}) {
    // Group users by role, in a stable order; append any unknown roles + Unassigned.
    const roleGroups = useMemo(() => {
        const byRole = new Map<string, Assignee[]>();
        for (const a of assignees) {
            const key = a.role_key || 'unassigned';
            if (!byRole.has(key)) byRole.set(key, []);
            byRole.get(key)!.push(a);
        }
        const ordered = [
            ...ROLE_ORDER.filter(r => byRole.has(r)),
            ...[...byRole.keys()].filter(r => !ROLE_ORDER.includes(r) && r !== 'unassigned'),
        ];
        // "Unassigned" is a role facet even with no users (tasks with no owner).
        if ((facets?.byRole?.unassigned ?? 0) > 0 || byRole.has('unassigned')) ordered.push('unassigned');
        return ordered.map(roleKey => ({
            roleKey,
            label: byRole.get(roleKey)?.[0]?.role_label || ROLE_FALLBACK[roleKey] || roleKey,
            users: (byRole.get(roleKey) || []).filter(u => !myEmail || u.email !== myEmail), // "me" lives in the shortcut
        }));
    }, [assignees, facets, myEmail]);

    const activeCount = value.roles.length + value.users.length + (value.authorMine ? 1 : 0) + (value.assigneeMine ? 1 : 0);
    const toggle = (list: string[], id: string) => list.includes(id) ? list.filter(x => x !== id) : [...list, id];

    return (
        <Popover>
            <PopoverTrigger asChild>
                <button type="button" className="blanc-control-chip" data-active={activeCount ? true : undefined}>
                    <User className="size-3.5" />
                    {activeCount ? `Assignee · ${activeCount}` : 'Assignee'}
                </button>
            </PopoverTrigger>
            <PopoverContent align="end" className="w-72 p-1.5" style={{ maxHeight: 460, overflowY: 'auto' }}>
                {/* Shortcuts — me */}
                <Row label="Assigned to me" count={facets?.mineAssignee ?? 0} checked={value.assigneeMine}
                    onToggle={() => onChange({ ...value, assigneeMine: !value.assigneeMine })} strong />
                <Row label="Created by me" count={facets?.mineAuthor ?? 0} checked={value.authorMine}
                    onToggle={() => onChange({ ...value, authorMine: !value.authorMine })} strong />

                <div style={{ height: 1, background: 'var(--blanc-line)', margin: '6px 8px' }} />

                {roleGroups.map(group => (
                    <div key={group.roleKey}>
                        <Row
                            label={group.label}
                            count={facets?.byRole?.[group.roleKey] ?? 0}
                            checked={value.roles.includes(group.roleKey)}
                            onToggle={() => onChange({ ...value, roles: toggle(value.roles, group.roleKey) })}
                            strong
                        />
                        {group.users.map(u => (
                            <Row
                                key={u.id}
                                label={u.name || u.email}
                                count={facets?.byUser?.[u.id] ?? 0}
                                checked={value.users.includes(u.id)}
                                onToggle={() => onChange({ ...value, users: toggle(value.users, u.id) })}
                                indent
                            />
                        ))}
                    </div>
                ))}

                {activeCount > 0 && (
                    <>
                        <div style={{ height: 1, background: 'var(--blanc-line)', margin: '6px 8px' }} />
                        <button
                            type="button"
                            onClick={() => onChange({ roles: [], users: [], authorMine: false, assigneeMine: false })}
                            className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left hover:bg-[rgba(25,25,25,0.05)]"
                            style={{ fontSize: 13, color: 'var(--blanc-ink-2)' }}
                        >
                            <UserCog className="size-3.5" /> Clear assignee filters
                        </button>
                    </>
                )}
            </PopoverContent>
        </Popover>
    );
}
