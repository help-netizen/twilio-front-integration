import { useState } from 'react';
import { Plus, ChevronDown, ChevronUp } from 'lucide-react';
import { useAuthz } from '../../hooks/useAuthz';
import { TaskCard } from './TaskCard';
import { TaskFormDialog } from './TaskFormDialog';
import { useEntityTasks } from './useEntityTasks';
import { type Task, type TaskParentType } from './tasksApi';
import { useTaskMutations } from './useTaskMutations';

interface Props {
    parentType: TaskParentType;
    parentId: number | string;
    /** Show the built-in "Add task" button + header (estimate/invoice). When false,
     *  the host supplies its own button and controls the create dialog (NotesSection). */
    showAddButton?: boolean;
    title?: string;
    /** Controlled create dialog (when the host owns the "Add task" button). */
    createOpen?: boolean;
    onCreateOpenChange?: (open: boolean) => void;
    /** Fired after any create/edit/complete/snooze/delete so hosts (e.g. Pulse)
     *  can refresh derived state such as the Action Required badge. */
    onTasksChanged?: () => void;
}

export function TaskStack({ parentType, parentId, showAddButton = true, title, createOpen, onCreateOpenChange, onTasksChanged }: Props) {
    const { company, user, hasPermission, hasAnyPermission } = useAuthz();
    const tz = company?.timezone || 'America/New_York';
    const myEmail = user?.email;
    const canManage = hasPermission('tasks.manage');
    const canCreate = hasAnyPermission('tasks.create', 'tasks.manage');

    const { tasks, setTasks, refetch } = useEntityTasks(parentType, parentId);
    const [expanded, setExpanded] = useState(false);
    const [editingTask, setEditingTask] = useState<Task | null>(null);
    const [internalCreate, setInternalCreate] = useState(false);

    const createIsOpen = createOpen !== undefined ? createOpen : internalCreate;
    const setCreateOpen = (o: boolean) => { if (onCreateOpenChange) onCreateOpenChange(o); else setInternalCreate(o); };

    const canActOn = (t: Task) => canManage || (!!myEmail && t.assignee_email === myEmail);

    const taskMutations = useTaskMutations({
        refetch,
        onOptimisticComplete: taskId => setTasks(prev => prev.filter(x => x.id !== taskId)),
        onTasksChanged,
    });

    const open = tasks;
    const hasMany = open.length > 1;
    const visible = expanded ? open : open.slice(0, 1);

    return (
        <div className="space-y-2">
            {showAddButton && (
                <div className="flex items-center justify-between">
                    {title ? <span className="blanc-eyebrow">{title}</span> : <span />}
                    {canCreate && (
                        <button
                            type="button"
                            onClick={() => setCreateOpen(true)}
                            className="inline-flex items-center gap-1.5 transition-opacity hover:opacity-70"
                            style={{ fontSize: 12.5, padding: '4px 10px', borderRadius: 10, border: '1px solid var(--blanc-line)', background: 'transparent', color: 'var(--blanc-ink-2)', cursor: 'pointer' }}
                        >
                            <Plus className="size-3.5" /> Add task
                        </button>
                    )}
                </div>
            )}

            {open.length > 0 && (
                <div className="space-y-2">
                    {/* Collapsed stack: top card with a subtle "peek" of the rest behind it. */}
                    <div className="relative">
                        {!expanded && hasMany && (
                            <>
                                <div className="absolute left-2.5 right-2.5" style={{ top: 7, height: 16, background: 'rgba(25,25,25,0.04)', border: '1px solid var(--blanc-line)', borderRadius: 10 }} />
                                <div className="absolute left-1.5 right-1.5" style={{ top: 3, height: 16, background: 'var(--blanc-surface-strong, #fffdf9)', border: '1px solid var(--blanc-line)', borderRadius: 10 }} />
                            </>
                        )}
                        <div className="relative space-y-2">
                            {visible.map(t => (
                                <TaskCard
                                    key={t.id}
                                    task={t}
                                    tz={tz}
                                    canAct={canActOn(t)}
                                    onComplete={taskMutations.complete}
                                    onSnooze={taskMutations.snooze}
                                    onEdit={setEditingTask}
                                    onChanged={() => { refetch(); onTasksChanged?.(); }}
                                />
                            ))}
                        </div>
                    </div>

                    {hasMany && (
                        <button
                            type="button"
                            onClick={() => setExpanded(e => !e)}
                            className="w-full inline-flex items-center justify-center gap-1.5 transition-opacity hover:opacity-70"
                            style={{ fontSize: 12, padding: '4px 12px', color: 'var(--blanc-ink-2)', background: 'none', border: 'none', cursor: 'pointer' }}
                        >
                            {expanded
                                ? <><ChevronUp className="size-3.5" /> Show less</>
                                : <><ChevronDown className="size-3.5" /> {open.length - 1} more {open.length - 1 === 1 ? 'task' : 'tasks'}</>}
                        </button>
                    )}
                </div>
            )}

            {/* Create dialog (host- or self-triggered) */}
            {canCreate && (
                <TaskFormDialog
                    open={createIsOpen}
                    onOpenChange={setCreateOpen}
                    parentType={parentType}
                    parentId={parentId}
                    tz={tz}
                    onSaved={() => { refetch(); onTasksChanged?.(); }}
                />
            )}

            {/* Edit dialog */}
            <TaskFormDialog
                open={!!editingTask}
                onOpenChange={(o) => { if (!o) setEditingTask(null); }}
                parentType={parentType}
                parentId={parentId}
                tz={tz}
                task={editingTask}
                onSaved={() => { setEditingTask(null); refetch(); onTasksChanged?.(); }}
                onDeleted={() => { setEditingTask(null); refetch(); onTasksChanged?.(); }}
            />
        </div>
    );
}
