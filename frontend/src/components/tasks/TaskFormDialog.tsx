import { useState, useEffect, useCallback } from 'react';
import { Trash2 } from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '../ui/dialog';
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '../ui/select';
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
            <DialogContent size="sm">
                <DialogHeader>
                    <DialogTitle>{editing ? 'Edit task' : 'New task'}</DialogTitle>
                </DialogHeader>

                <div className="space-y-4">
                    <div className="space-y-1.5">
                        <label className="blanc-eyebrow">Description</label>
                        <textarea
                            autoFocus
                            className="w-full text-sm resize-none outline-none bg-transparent leading-5"
                            style={{ border: '1px solid var(--blanc-line)', borderRadius: 10, padding: '8px 12px', minHeight: 72, color: 'var(--blanc-ink-1)' }}
                            placeholder="What needs to be done?"
                            value={description}
                            onChange={e => setDescription(e.target.value)}
                        />
                    </div>

                    <div className="space-y-1.5">
                        <label className="blanc-eyebrow">Assignee</label>
                        <Select value={assigneeId} onValueChange={setAssigneeId}>
                            <SelectTrigger><SelectValue placeholder="Unassigned" /></SelectTrigger>
                            <SelectContent>
                                <SelectItem value={UNASSIGNED}>Unassigned</SelectItem>
                                {assignees.map(a => (
                                    <SelectItem key={a.id} value={a.id}>{a.name || a.email}</SelectItem>
                                ))}
                            </SelectContent>
                        </Select>
                    </div>

                    <div className="space-y-1.5">
                        <label className="blanc-eyebrow">Deadline</label>
                        <div className="flex items-center gap-2">
                            <input
                                type="date"
                                className="flex-1 text-sm outline-none"
                                style={{ border: '1px solid var(--blanc-line)', borderRadius: 10, padding: '8px 12px', color: 'var(--blanc-ink-1)', background: 'transparent' }}
                                value={dueDate}
                                onChange={e => setDueDate(e.target.value)}
                            />
                            <input
                                type="time"
                                className="text-sm outline-none"
                                style={{ border: '1px solid var(--blanc-line)', borderRadius: 10, padding: '8px 12px', color: 'var(--blanc-ink-1)', background: 'transparent' }}
                                value={dueTime}
                                onChange={e => setDueTime(e.target.value)}
                                disabled={!dueDate}
                            />
                        </div>
                    </div>
                </div>

                <DialogFooter className="sm:justify-between">
                    {editing ? (
                        <Button variant="ghost" onClick={remove} disabled={saving} className="text-red-600 hover:text-red-700">
                            <Trash2 className="size-4 mr-1" /> Delete
                        </Button>
                    ) : <span />}
                    <div className="flex items-center gap-2">
                        <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={saving}>Cancel</Button>
                        <Button onClick={save} disabled={saving || !description.trim()}>{editing ? 'Save' : 'Add task'}</Button>
                    </div>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
