import { useState, useEffect, useCallback, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { Check, Loader2, AlarmClock, ArrowUpDown, ArrowUp, ArrowDown } from 'lucide-react';
import { toast } from 'sonner';
import { useAuthz } from '../hooks/useAuthz';
import { useIsMobile } from '../hooks/useIsMobile';
import { MobileListPage } from '../components/layout/MobileListPage';
import { TaskSnoozeMenu } from '../components/tasks/TaskSnoozeMenu';
import { Popover, PopoverContent, PopoverTrigger } from '../components/ui/popover';
import { FilterColumn } from '../components/jobs/jobsFilterHelpers';
import { listTasks, completeTask, snoozeTask, parentPath, type Task, type TaskParentType } from '../components/tasks/tasksApi';
import { isOverdue } from '../components/tasks/taskUtils';
import { todayInTZ, dateKeyInTZ, dateInTZ, formatTimeInTZ, formatDateTimeInTZ } from '../utils/companyTime';

const PARENT_META: Record<TaskParentType, { label: string; color: string }> = {
    job: { label: 'Job', color: '#378ADD' },
    lead: { label: 'Lead', color: '#7F77DD' },
    contact: { label: 'Contact', color: '#1D9E75' },
    estimate: { label: 'Estimate', color: '#EF9F27' },
    invoice: { label: 'Invoice', color: '#D85A30' },
    timeline: { label: 'Conversation', color: '#C2683B' },
};

// Filterable parent types (the API takes one parent_type; timeline tasks are
// reachable via "All types" but not a dedicated filter, matching the old select).
const FILTER_TYPES: TaskParentType[] = ['job', 'lead', 'contact', 'estimate', 'invoice'];

interface Group { key: string; label: string; danger?: boolean; compactTime?: boolean; tasks: Task[]; }

function bucketTasks(tasks: Task[], tz: string): Group[] {
    const today = todayInTZ(tz);
    const [ty, tm, td] = today.split('-').map(Number);
    const tomorrow = dateKeyInTZ(dateInTZ(ty, tm, td + 1, 12, 0, tz).toISOString(), tz);
    const weekEnd = dateKeyInTZ(dateInTZ(ty, tm, td + 7, 12, 0, tz).toISOString(), tz);
    const g: Record<string, Task[]> = { overdue: [], today: [], tomorrow: [], week: [], later: [], none: [] };
    for (const t of tasks) {
        if (!t.due_at) { g.none.push(t); continue; }
        if (isOverdue(t)) { g.overdue.push(t); continue; }
        const k = dateKeyInTZ(t.due_at, tz);
        if (k === today) g.today.push(t);
        else if (k === tomorrow) g.tomorrow.push(t);
        else if (k <= weekEnd) g.week.push(t);
        else g.later.push(t);
    }
    return [
        { key: 'overdue', label: 'Overdue', danger: true, compactTime: true, tasks: g.overdue },
        { key: 'today', label: 'Today', compactTime: true, tasks: g.today },
        { key: 'tomorrow', label: 'Tomorrow', compactTime: true, tasks: g.tomorrow },
        { key: 'week', label: 'This week', tasks: g.week },
        { key: 'later', label: 'Later', tasks: g.later },
        { key: 'none', label: 'No date', tasks: g.none },
    ].filter(grp => grp.tasks.length > 0);
}

function initials(name?: string | null): string {
    if (!name) return '—';
    const p = name.trim().split(/\s+/);
    return ((p[0]?.[0] || '') + (p[1]?.[0] || '')).toUpperCase() || name[0].toUpperCase();
}

type SortKey = 'description' | 'parent_type' | 'parent_label' | 'assignee_name' | 'due_at';

export function TasksPage() {
    const navigate = useNavigate();
    const isMobile = useIsMobile();
    const { company, user, hasPermission } = useAuthz();
    const tz = company?.timezone || 'America/New_York';
    const myEmail = user?.email;
    const canManage = hasPermission('tasks.manage');

    const [tasks, setTasks] = useState<Task[]>([]);
    const [loading, setLoading] = useState(true);
    const [status, setStatus] = useState<'open' | 'all'>('open');
    const [parentType, setParentType] = useState<TaskParentType | ''>('');
    const [searchQuery, setSearchQuery] = useState('');
    const [sortBy, setSortBy] = useState<SortKey>('due_at');
    const [sortOrder, setSortOrder] = useState<'asc' | 'desc'>('asc');

    const load = useCallback(async () => {
        setLoading(true);
        try {
            setTasks(await listTasks({ status, parent_type: parentType || undefined, limit: 500 }));
        } catch {
            toast.error('Failed to load tasks');
        } finally {
            setLoading(false);
        }
    }, [status, parentType]);

    useEffect(() => { load(); }, [load]);

    const canActOn = (t: Task) => canManage || (!!myEmail && t.assignee_email === myEmail);

    const onComplete = async (t: Task) => {
        setTasks(prev => prev.map(x => x.id === t.id ? { ...x, status: 'done' as const } : x));
        try { await completeTask(t.id); toast.success('Task completed'); load(); }
        catch { toast.error('Failed'); load(); }
    };
    const onSnooze = async (t: Task, iso: string) => {
        try { await snoozeTask(t.id, iso); toast.success('Task snoozed'); load(); }
        catch { toast.error('Failed'); }
    };

    // Client-side search + sort over the (single-fetch) list — same UX as the
    // Jobs unified header, without a server round-trip.
    const filteredTasks = useMemo(() => {
        const q = searchQuery.trim().toLowerCase();
        const filtered = !q ? tasks : tasks.filter(t =>
            (t.description || '').toLowerCase().includes(q)
            || (t.parent_label || '').toLowerCase().includes(q)
            || (t.assignee_name || '').toLowerCase().includes(q));
        const dir = sortOrder === 'asc' ? 1 : -1;
        return [...filtered].sort((a, b) => {
            if (sortBy === 'due_at') {
                // No-date tasks sink to the bottom regardless of direction.
                if (!a.due_at && !b.due_at) return 0;
                if (!a.due_at) return 1;
                if (!b.due_at) return -1;
                return (a.due_at < b.due_at ? -1 : a.due_at > b.due_at ? 1 : 0) * dir;
            }
            const av = (a[sortBy] || '').toString().toLowerCase();
            const bv = (b[sortBy] || '').toString().toLowerCase();
            return (av < bv ? -1 : av > bv ? 1 : 0) * dir;
        });
    }, [tasks, searchQuery, sortBy, sortOrder]);

    const groups = bucketTasks(filteredTasks, tz);

    const TimeLabel = ({ t, compact }: { t: Task; compact?: boolean }) => {
        if (!t.due_at) return null;
        const overdue = isOverdue(t);
        const label = compact ? formatTimeInTZ(new Date(t.due_at), tz) : formatDateTimeInTZ(new Date(t.due_at), tz);
        return (
            <span className="inline-flex items-center gap-1 shrink-0" style={{ fontSize: 12, color: overdue ? '#b42318' : 'var(--blanc-ink-2)' }}>
                {overdue && <AlarmClock className="size-3.5" />}{label}
            </span>
        );
    };

    const Actions = ({ t }: { t: Task }) => canActOn(t) && t.status === 'open' ? (
        <div className="flex items-center gap-1.5 shrink-0" onClick={e => e.stopPropagation()}>
            <button type="button" title="Mark done" onClick={() => onComplete(t)}
                className="p-1.5 rounded-md transition-opacity hover:opacity-70"
                style={{ border: '1px solid var(--blanc-line)', color: 'var(--blanc-ink-1)' }}>
                <Check className="size-3.5" />
            </button>
            <TaskSnoozeMenu tz={tz} onSnooze={(iso) => onSnooze(t, iso)} iconOnly />
        </div>
    ) : null;

    const Avatar = ({ t }: { t: Task }) => (
        <span className="inline-flex items-center justify-center shrink-0"
            title={t.assignee_name || 'Unassigned'}
            style={{ width: 22, height: 22, borderRadius: '50%', background: 'rgba(25,25,25,0.08)', fontSize: 10, fontWeight: 600, color: 'var(--blanc-ink-2)' }}>
            {initials(t.assignee_name)}
        </span>
    );

    // ── Mobile (canonical MobileListPage shell — unchanged) ─────────────────
    if (isMobile) {
        const controls = (
            <div className="flex items-center gap-2">
                <select value={parentType} onChange={e => setParentType(e.target.value as TaskParentType | '')}
                    className="text-sm outline-none"
                    style={{ border: '1px solid var(--blanc-line)', borderRadius: 10, padding: '6px 10px', background: 'transparent', color: 'var(--blanc-ink-1)' }}>
                    <option value="">All types</option>
                    <option value="job">Jobs</option>
                    <option value="lead">Leads</option>
                    <option value="contact">Contacts</option>
                    <option value="estimate">Estimates</option>
                    <option value="invoice">Invoices</option>
                </select>
                <div className="flex items-center" style={{ background: 'var(--blanc-field)', borderRadius: 999, padding: 2 }}>
                    {(['open', 'all'] as const).map(s => (
                        <button key={s} type="button" onClick={() => setStatus(s)}
                            className="text-sm capitalize transition-colors"
                            style={{
                                padding: '4px 12px', borderRadius: 999,
                                background: status === s ? 'var(--blanc-panel-surface)' : 'transparent',
                                color: status === s ? 'var(--blanc-ink-1)' : 'var(--blanc-ink-2)',
                                fontWeight: status === s ? 600 : 400,
                                boxShadow: status === s ? '0 1px 2px rgba(25,25,25,0.08)' : 'none',
                            }}>
                            {s}
                        </button>
                    ))}
                </div>
            </div>
        );

        const renderTile = (t: Task, group: Group) => {
            const meta = PARENT_META[t.parent_type];
            const done = t.status === 'done';
            return (
                <div key={t.id} onClick={() => navigate(parentPath(t))}
                    className="w-full rounded-xl p-3 space-y-2 cursor-pointer transition-colors"
                    style={{ border: '1px solid var(--blanc-line)', background: 'var(--blanc-surface-strong, #fffdf9)', opacity: done ? 0.6 : 1 }}>
                    <div className="flex items-center justify-between gap-2">
                        <span className="inline-flex items-center gap-1.5" style={{ fontSize: 11, color: 'var(--blanc-ink-3)' }}>
                            <span style={{ width: 8, height: 8, borderRadius: '50%', background: meta.color }} />{meta.label}
                        </span>
                        <TimeLabel t={t} compact={group.compactTime} />
                    </div>
                    <p className="text-sm" style={{ color: 'var(--blanc-ink-1)' }}>{t.description}</p>
                    <div className="flex items-center justify-between gap-2">
                        <span className="inline-flex items-center gap-2 min-w-0" style={{ fontSize: 12, color: 'var(--blanc-ink-2)' }}>
                            <Avatar t={t} /><span className="truncate">{t.parent_label || meta.label}</span>
                        </span>
                        <Actions t={t} />
                    </div>
                </div>
            );
        };

        const body = loading ? (
            <div className="mobile-list-page__empty">
                <Loader2 className="size-5 animate-spin" style={{ color: 'var(--blanc-ink-3)' }} />
            </div>
        ) : groups.length === 0 ? (
            <div className="mobile-list-page__empty text-sm" style={{ color: 'var(--blanc-ink-3)' }}>No tasks</div>
        ) : (
            <div className="space-y-6">
                {groups.map(group => (
                    <div key={group.key} className="space-y-2">
                        <div className="blanc-eyebrow" style={group.danger ? { color: '#b42318' } : undefined}>{group.label}</div>
                        {group.tasks.map(t => renderTile(t, group))}
                    </div>
                ))}
            </div>
        );

        return (
            <MobileListPage
                stickyBar={
                    <div className="flex items-center justify-between gap-3">
                        <div className="blanc-eyebrow" style={{ marginBottom: 0 }}>Tasks</div>
                        {controls}
                    </div>
                }
            >
                {body}
            </MobileListPage>
        );
    }

    // ── Desktop — unified list canon (same shell + tile-table as Jobs) ──────
    const COLUMNS: { key: SortKey | 'actions'; label: string; sortable?: boolean }[] = [
        { key: 'description', label: 'Task', sortable: true },
        { key: 'parent_type', label: 'Type', sortable: true },
        { key: 'parent_label', label: 'Related to', sortable: true },
        { key: 'assignee_name', label: 'Assignee', sortable: true },
        { key: 'due_at', label: 'Due', sortable: true },
        { key: 'actions', label: '' },
    ];

    const handleHeaderClick = (key: SortKey) => {
        if (sortBy === key) setSortOrder(o => o === 'asc' ? 'desc' : 'asc');
        else { setSortBy(key); setSortOrder('asc'); }
    };

    const typeFilterLabel = parentType ? PARENT_META[parentType].label : 'All types';
    const typeColorMap = Object.fromEntries(FILTER_TYPES.map(k => [PARENT_META[k].label, PARENT_META[k].color]));

    return (
        <div className="blanc-page-wrapper">
            <div className="blanc-unified-header">
                <h1 className="blanc-header-title">Tasks</h1>

                <div className="blanc-search-wrapper">
                    <input
                        type="text"
                        placeholder="type to find anything..."
                        value={searchQuery}
                        onChange={(e) => setSearchQuery(e.target.value)}
                        className="blanc-search-input"
                    />
                </div>

                <div className="blanc-controls-group">
                    <button
                        type="button"
                        className="blanc-control-chip"
                        data-active={status === 'open' || undefined}
                        onClick={() => setStatus(s => s === 'open' ? 'all' : 'open')}
                    >
                        Only Open
                    </button>
                    <Popover>
                        <PopoverTrigger asChild>
                            <button type="button" className="blanc-control-chip" data-active={parentType || undefined}>
                                {typeFilterLabel}
                            </button>
                        </PopoverTrigger>
                        <PopoverContent align="end" className="w-56 p-2">
                            <FilterColumn
                                title="Type"
                                items={FILTER_TYPES.map(k => PARENT_META[k].label)}
                                selected={parentType ? [PARENT_META[parentType].label] : []}
                                onToggle={(label) => {
                                    const key = FILTER_TYPES.find(k => PARENT_META[k].label === label) || '';
                                    setParentType(prev => prev === key ? '' : key as TaskParentType | '');
                                }}
                                colorMap={typeColorMap}
                            />
                        </PopoverContent>
                    </Popover>
                </div>
            </div>

            <div className="flex flex-1 flex-col min-h-0">
                <div className="flex flex-1 flex-col overflow-hidden">
                    {loading ? (
                        <div className="flex-1 flex items-center justify-center h-40 text-muted-foreground">
                            <Loader2 className="size-5 animate-spin mr-2" /> Loading tasks...
                        </div>
                    ) : filteredTasks.length === 0 ? (
                        <div className="flex-1 flex items-center justify-center h-40 text-muted-foreground">
                            No tasks found
                        </div>
                    ) : (
                        <>
                            <div className="flex-1 overflow-auto">
                                <table className="w-full text-sm blanc-table-tiles">
                                    <thead>
                                        <tr className="text-left">
                                            {COLUMNS.map(col => col.key === 'actions' ? (
                                                <th key="actions" className="px-2 py-1 w-20" aria-label="Actions" />
                                            ) : (
                                                <th
                                                    key={col.key}
                                                    className="px-4 py-1 cursor-pointer select-none"
                                                    onClick={() => handleHeaderClick(col.key as SortKey)}
                                                >
                                                    <span className="inline-flex items-center gap-1">
                                                        {col.label}
                                                        {sortBy === col.key
                                                            ? (sortOrder === 'asc'
                                                                ? <ArrowUp className="size-3.5 text-primary" />
                                                                : <ArrowDown className="size-3.5 text-primary" />)
                                                            : <ArrowUpDown className="size-3.5 text-muted-foreground/40" />}
                                                    </span>
                                                </th>
                                            ))}
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {filteredTasks.map(t => {
                                            const meta = PARENT_META[t.parent_type];
                                            const done = t.status === 'done';
                                            return (
                                                <tr
                                                    key={t.id}
                                                    className="cursor-pointer"
                                                    style={done ? { opacity: 0.6 } : undefined}
                                                    onClick={() => navigate(parentPath(t))}
                                                >
                                                    <td className="px-4 py-2.5">
                                                        <span className="font-medium line-clamp-2" style={{ color: 'var(--blanc-ink-1)' }}>{t.description}</span>
                                                    </td>
                                                    <td className="px-4 py-2.5 whitespace-nowrap">
                                                        <span className="inline-flex items-center gap-2">
                                                            <span style={{ width: 8, height: 8, borderRadius: '50%', background: meta.color, flex: 'none' }} />
                                                            {meta.label}
                                                        </span>
                                                    </td>
                                                    <td className="px-4 py-2.5 max-w-[16rem]">
                                                        <span className="truncate block" style={{ color: 'var(--blanc-ink-2)' }}>{t.parent_label || '—'}</span>
                                                    </td>
                                                    <td className="px-4 py-2.5 whitespace-nowrap">
                                                        <span className="inline-flex items-center gap-2">
                                                            <Avatar t={t} />
                                                            <span style={{ color: 'var(--blanc-ink-2)' }}>{t.assignee_name || '—'}</span>
                                                        </span>
                                                    </td>
                                                    <td className="px-4 py-2.5 whitespace-nowrap">
                                                        {t.due_at ? <TimeLabel t={t} /> : <span style={{ color: 'var(--blanc-ink-3)' }}>—</span>}
                                                    </td>
                                                    <td className="px-2 py-2.5 w-20" onClick={e => e.stopPropagation()}>
                                                        <Actions t={t} />
                                                    </td>
                                                </tr>
                                            );
                                        })}
                                    </tbody>
                                </table>
                            </div>

                            {/* Count line — flat on the canvas, mirrors the Jobs footer */}
                            <div className="px-4 py-2 flex items-center justify-between text-sm text-muted-foreground">
                                <span>{filteredTasks.length} {filteredTasks.length === 1 ? 'task' : 'tasks'}</span>
                            </div>
                        </>
                    )}
                </div>
            </div>
        </div>
    );
}

export default TasksPage;
