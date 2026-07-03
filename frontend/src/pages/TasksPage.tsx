import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { Check, Loader2, AlarmClock } from 'lucide-react';
import { toast } from 'sonner';
import { useAuthz } from '../hooks/useAuthz';
import { useIsMobile } from '../hooks/useIsMobile';
import { MobileListPage } from '../components/layout/MobileListPage';
import { TaskSnoozeMenu } from '../components/tasks/TaskSnoozeMenu';
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

    const groups = bucketTasks(tasks, tz);

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

    // Filter controls — shared markup for desktop header and the mobile sticky bar.
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
            {/* UI-QA-001: segment control (nav canon) — white pill on field strip,
                not a heavy black active state. */}
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

    // A single task row — mobile = full-width tile (JobMobileCard/LeadMobileCard
    // family: border var(--blanc-line), rounded-xl, no shadow), desktop = compact row.
    const renderTask = (t: Task, group: Group) => {
        const meta = PARENT_META[t.parent_type];
        const done = t.status === 'done';
        return isMobile ? (
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
        ) : (
            <div key={t.id} onClick={() => navigate(parentPath(t))}
                className="flex items-center gap-3 rounded-[10px] px-3 py-2.5 cursor-pointer transition-colors hover:bg-[rgba(25,25,25,0.03)]"
                style={{ border: '1px solid var(--blanc-line)', opacity: done ? 0.6 : 1 }}>
                <span style={{ width: 8, height: 8, borderRadius: '50%', background: meta.color, flex: 'none' }} title={meta.label} />
                <span className="shrink-0" style={{ fontSize: 11, color: 'var(--blanc-ink-3)', width: 60 }}>{meta.label}</span>
                <span className="flex-1 min-w-0 truncate text-sm" style={{ color: 'var(--blanc-ink-1)' }}>
                    {t.description}
                    <span style={{ color: 'var(--blanc-ink-3)' }}> · {t.parent_label}</span>
                </span>
                <TimeLabel t={t} compact={group.compactTime} />
                <Avatar t={t} />
                <Actions t={t} />
            </div>
        );
    };

    // Grouped list body (due-bucket groups + .blanc-eyebrow headers). Shared by
    // both layouts; on mobile the tiles inside are full-width.
    const body = loading ? (
        <div className={isMobile ? 'mobile-list-page__empty' : 'flex items-center justify-center py-16'}>
            <Loader2 className="size-5 animate-spin" style={{ color: 'var(--blanc-ink-3)' }} />
        </div>
    ) : groups.length === 0 ? (
        <div className={isMobile ? 'mobile-list-page__empty text-sm' : 'text-center py-16 text-sm'} style={{ color: 'var(--blanc-ink-3)' }}>No tasks</div>
    ) : (
        <div className="space-y-6">
            {groups.map(group => (
                <div key={group.key} className="space-y-2">
                    <div className="blanc-eyebrow" style={group.danger ? { color: '#b42318' } : undefined}>{group.label}</div>
                    {group.tasks.map(t => renderTask(t, group))}
                </div>
            ))}
        </div>
    );

    if (isMobile) {
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

    // Desktop — unchanged centered layout.
    return (
        <div className="mx-auto max-w-4xl px-4 py-5 md:px-6">
            <div className="flex items-center justify-between gap-3 mb-4 flex-wrap">
                <h2 className="text-2xl font-semibold" style={{ color: 'var(--blanc-ink-1)' }}>Tasks</h2>
                {controls}
            </div>
            {body}
        </div>
    );
}

export default TasksPage;
