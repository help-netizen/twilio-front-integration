import { Check, Pencil, RotateCcw, AlarmClock, Sparkles } from 'lucide-react';
import { TaskSnoozeMenu } from './TaskSnoozeMenu';
import { isOverdue, formatDeadline } from './taskUtils';
import { type Task } from './tasksApi';
import { TaskActionButtons } from './TaskActionButtons';

interface Props {
    task: Task;
    tz: string;
    canAct: boolean;
    onComplete: (task: Task) => void;
    onReopen?: (task: Task) => void;
    onSnooze: (task: Task, dueIso: string) => void;
    onEdit: (task: Task) => void;
    /** OUTBOUND-PARTS-CALL-001: refetch after a robot_call so the button reflects
     *  the new action state (e.g. failed + reason, or the task closing). */
    onChanged?: () => void;
}

function initials(name?: string | null): string {
    if (!name) return '—';
    const parts = name.trim().split(/\s+/);
    return ((parts[0]?.[0] || '') + (parts[1]?.[0] || '')).toUpperCase() || name[0].toUpperCase();
}

export function TaskCard({ task, tz, canAct, onComplete, onReopen, onSnooze, onEdit, onChanged }: Props) {
    const overdue = isOverdue(task);
    const done = task.status === 'done';

    return (
        <div
            className="rounded-xl p-3 space-y-2"
            style={{
                background: 'var(--blanc-surface-strong, #fffdf9)',
                border: '1px solid var(--blanc-line)',
                opacity: done ? 0.6 : 1,
            }}
        >
            <div className="flex items-start justify-between gap-2">
                <div className="flex items-center gap-2 min-w-0">
                    <span
                        className="shrink-0"
                        style={{
                            fontSize: 10, letterSpacing: '0.1em', textTransform: 'uppercase',
                            background: 'rgba(25,25,25,0.08)', color: 'var(--blanc-ink-2)',
                            padding: '2px 7px', borderRadius: 8,
                        }}
                    >
                        Task
                    </span>
                    {task.kind === 'agent' && (
                        <span
                            className="inline-flex items-center gap-1 shrink-0"
                            title={task.agent_output?.reason || 'Created by Mail Secretary'}
                            style={{
                                fontSize: 10, letterSpacing: '0.08em', textTransform: 'uppercase',
                                background: 'var(--blanc-accent-soft)', color: 'var(--blanc-accent)',
                                padding: '2px 7px', borderRadius: 8, fontWeight: 600,
                            }}
                        >
                            <Sparkles className="size-3" /> AI
                        </span>
                    )}
                    <span
                        className="inline-flex items-center gap-1 truncate"
                        style={{ fontSize: 12.5, color: overdue ? '#b42318' : 'var(--blanc-ink-2)' }}
                    >
                        {!done && task.due_at && <AlarmClock className="size-3.5 shrink-0" />}
                        {done ? 'Done' : (overdue ? 'Overdue · ' : '') + formatDeadline(task.due_at, tz)}
                    </span>
                </div>
                {canAct && !done && (
                    <button
                        type="button"
                        title="Edit task"
                        onClick={() => onEdit(task)}
                        className="shrink-0 p-1 rounded-md transition-opacity hover:opacity-70"
                        style={{ color: 'var(--blanc-ink-3)' }}
                    >
                        <Pencil className="size-3.5" />
                    </button>
                )}
            </div>

            <p className="text-sm whitespace-pre-wrap" style={{ color: 'var(--blanc-ink-1)' }}>{task.description}</p>

            {/* MAIL-AGENT-001: the agent explains WHY it flagged this email. */}
            {task.kind === 'agent' && task.agent_output?.reason && (
                <p className="text-sm" style={{ color: 'var(--blanc-ink-2)' }}>{task.agent_output.reason}</p>
            )}

            {/* OUTBOUND-PARTS-CALL-001: typed action buttons (robot_call / manual_call),
                in addition to the built-in Done/Cancel affordances below. The shared
                component self-gates on tasks.manage and guards done/actions internally,
                and adds a confirm before a robot_call. */}
            <TaskActionButtons
                id={task.id}
                actions={task.actions}
                done={done}
                jobId={task.parent_type === 'job' ? task.parent_id : undefined}
                onChanged={onChanged}
            />

            <div className="flex items-center justify-between gap-2 flex-wrap">
                <div className="flex items-center gap-2 min-w-0" style={{ fontSize: 12, color: 'var(--blanc-ink-2)' }}>
                    <span
                        className="inline-flex items-center justify-center shrink-0"
                        style={{ width: 22, height: 22, borderRadius: '50%', background: 'rgba(25,25,25,0.08)', fontSize: 10, fontWeight: 600, color: 'var(--blanc-ink-2)' }}
                        title={task.assignee_name || 'Unassigned'}
                    >
                        {initials(task.assignee_name)}
                    </span>
                    <span className="truncate">
                        {task.assignee_name || 'Unassigned'}
                        {task.author_name && <span style={{ color: 'var(--blanc-ink-3)' }}> · by {task.author_name}</span>}
                    </span>
                </div>

                {canAct && (
                    <div className="flex items-center gap-1.5 shrink-0">
                        {done ? (
                            onReopen && (
                                <button
                                    type="button"
                                    onClick={() => onReopen(task)}
                                    className="inline-flex items-center gap-1.5 transition-opacity hover:opacity-70"
                                    style={{ fontSize: 12, padding: '4px 10px', borderRadius: 8, border: '1px solid var(--blanc-line)', background: 'transparent', color: 'var(--blanc-ink-2)', cursor: 'pointer' }}
                                >
                                    <RotateCcw className="size-3.5" /> Reopen
                                </button>
                            )
                        ) : (
                            <>
                                <button
                                    type="button"
                                    onClick={() => onComplete(task)}
                                    className="inline-flex items-center gap-1.5 transition-opacity hover:opacity-70"
                                    style={{ fontSize: 12, padding: '4px 10px', borderRadius: 8, border: '1px solid var(--blanc-line)', background: 'transparent', color: 'var(--blanc-ink-1)', cursor: 'pointer' }}
                                >
                                    <Check className="size-3.5" /> Done
                                </button>
                                <TaskSnoozeMenu tz={tz} onSnooze={(iso) => onSnooze(task, iso)} />
                            </>
                        )}
                    </div>
                )}
            </div>
        </div>
    );
}
