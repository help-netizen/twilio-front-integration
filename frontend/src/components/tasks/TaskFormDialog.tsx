import { useState, useEffect, useCallback } from 'react';
import { Trash2 } from 'lucide-react';
import { Dialog, DialogContent, DialogPanelHeader, DialogTitle, DialogDescription, DialogBody, DialogPanelFooter } from '../ui/dialog';
import { FloatingField, FloatingLabel } from '../ui/floating-field';
import { FloatingSelect } from '../ui/floating-select';
import { SelectItem } from '../ui/select';
import { Button } from '../ui/button';
import { toast } from 'sonner';
import { useAuthz } from '../../hooks/useAuthz';
import {
    createTask, updateTask, deleteTask, listAssignees,
    type Task, type TaskParentType, type Assignee,
} from './tasksApi';
import { isoToLocalParts, localPartsToIso, defaultDueIso } from './taskUtils';

interface Props {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    parentType: TaskParentType;
    parentId: number | string;
    tz: string;
    /** Provided → edit mode; omitted → create mode. */
    task?: Task | null;
    onSaved: (task: Task) => void;
    onDeleted?: (id: number) => void;
}

const UNASSIGNED = '__none__';

const dateInputClass =
    'h-[50px] w-full rounded-xl border-[1.5px] border-input bg-transparent px-3.5 text-[15px] font-medium text-[var(--blanc-ink-1)] outline-none transition-colors focus:border-ring disabled:cursor-not-allowed disabled:opacity-50';

export function TaskFormDialog({ open, onOpenChange, parentType, parentId, tz, task, onSaved, onDeleted }: Props) {
    const { user } = useAuthz();
    const myEmail = user?.email;
    const editing = !!task;

    const [description, setDescription] = useState('');
    const [assigneeId, setAssigneeId] = useState<string>(UNASSIGNED);
    const [dueDate, setDueDate] = useState('');
    const [dueTime, setDueTime] = useState('');
    const [assignees, setAssignees] = useState<Assignee[]>([]);
    const [saving, setSaving] = useState(false);

    // Reset/prefill on open.
    useEffect(() => {
        if (!open) return;
        if (task) {
            setDescription(task.description);
            setAssigneeId(task.owner_user_id || UNASSIGNED);
            const parts = isoToLocalParts(task.due_at, tz);
            setDueDate(parts.date);
            setDueTime(parts.time);
        } else {
            setDescription('');
            setAssigneeId(UNASSIGNED);
            const parts = isoToLocalParts(defaultDueIso(tz), tz);
            setDueDate(parts.date);
            setDueTime(parts.time);
        }
    }, [open, task, tz]);

    // Load assignees once per open; default a new task's assignee to "me".
    useEffect(() => {
        if (!open) return;
        let cancelled = false;
        listAssignees()
            .then(list => {
                if (cancelled) return;
                setAssignees(list);
                if (!task) {
                    const me = list.find(a => a.email && a.email === myEmail);
                    if (me) setAssigneeId(me.id);
                }
            })
            .catch(() => { /* picker stays minimal; '' self-assigns server-side */ });
        return () => { cancelled = true; };
    }, [open, task, myEmail]);

    const save = useCallback(async () => {
        const text = description.trim();
        if (!text) { toast.error('A task description is required'); return; }
        setSaving(true);
        try {
            const due_at = dueDate ? localPartsToIso(dueDate, dueTime || '08:00', tz) : null;
            const owner_user_id = assigneeId === UNASSIGNED ? null : assigneeId;
            const saved = editing
                ? await updateTask(task!.id, { description: text, owner_user_id, due_at })
                : await createTask({ parent_type: parentType, parent_id: parentId, description: text, owner_user_id, due_at });
            toast.success(editing ? 'Task updated' : 'Task added');
            onSaved(saved);
            onOpenChange(false);
        } catch (err) {
            toast.error(err instanceof Error ? err.message : 'Failed to save task');
        } finally {
            setSaving(false);
        }
    }, [description, dueDate, dueTime, tz, assigneeId, editing, task, parentType, parentId, onSaved, onOpenChange]);

    const remove = useCallback(async () => {
        if (!task) return;
        if (!window.confirm('Delete this task?')) return;
        setSaving(true);
        try {
            await deleteTask(task.id);
            toast.success('Task deleted');
            onDeleted?.(task.id);
            onOpenChange(false);
        } catch (err) {
            toast.error(err instanceof Error ? err.message : 'Failed to delete task');
        } finally {
            setSaving(false);
        }
    }, [task, onDeleted, onOpenChange]);

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent variant="panel">
                <DialogPanelHeader>
                    <DialogTitle>{editing ? 'Edit task' : 'New task'}</DialogTitle>
                    <DialogDescription className="sr-only">
                        {editing ? 'Edit this task' : 'Create a task on this record'}
                    </DialogDescription>
                </DialogPanelHeader>

                <DialogBody className="md:px-8 md:py-7">
                    <div className="space-y-5">
                        <FloatingField
                            label="Description"
                            textarea
                            rows={3}
                            value={description}
                            onChange={e => setDescription(e.target.value)}
                        />

                        <FloatingSelect label="Assignee" value={assigneeId} onValueChange={setAssigneeId}>
                            <SelectItem value={UNASSIGNED}>Unassigned</SelectItem>
                            {assignees.map(a => (
                                <SelectItem key={a.id} value={a.id}>{a.name || a.email}</SelectItem>
                            ))}
                        </FloatingSelect>

                        <div className="grid grid-cols-2 gap-3">
                            {/* Native date/time inputs ALWAYS render their format (mm/dd/yyyy, --:--),
                                so the label must always float — filled={!!value} would leave it centered
                                over that format when empty, overlapping it. */}
                            <FloatingLabel label="Deadline date" htmlFor="task-due-date" filled>
                                <input
                                    id="task-due-date"
                                    type="date"
                                    className={dateInputClass}
                                    value={dueDate}
                                    onChange={e => setDueDate(e.target.value)}
                                />
                            </FloatingLabel>
                            <FloatingLabel label="Time" htmlFor="task-due-time" filled>
                                <input
                                    id="task-due-time"
                                    type="time"
                                    className={dateInputClass}
                                    value={dueTime}
                                    onChange={e => setDueTime(e.target.value)}
                                    disabled={!dueDate}
                                />
                            </FloatingLabel>
                        </div>
                    </div>
                </DialogBody>

                <DialogPanelFooter className="justify-between">
                    {editing ? (
                        <Button variant="ghost" onClick={remove} disabled={saving} className="text-red-600 hover:text-red-700">
                            <Trash2 className="size-4 mr-1" /> Delete
                        </Button>
                    ) : <span />}
                    <div className="flex items-center gap-2">
                        <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={saving}>Cancel</Button>
                        <Button onClick={save} disabled={saving || !description.trim()}>{editing ? 'Save' : 'Add task'}</Button>
                    </div>
                </DialogPanelFooter>
            </DialogContent>
        </Dialog>
    );
}
