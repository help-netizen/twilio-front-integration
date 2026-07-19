import { useEffect, useState } from 'react';
import { UserRound } from 'lucide-react';
import { toast } from 'sonner';
import { isMobileViewport } from '../../hooks/useViewportSafePosition';
import { BottomSheet } from '../ui/BottomSheet';
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover';
import { listAssignees, type Assignee } from './tasksApi';

interface Props {
    taskId: number;
    onAssign: (ownerUserId: string | null) => Promise<unknown>;
}

export function TaskAssignMenu({ taskId, onAssign }: Props) {
    const [open, setOpen] = useState(false);
    const [assignees, setAssignees] = useState<Assignee[]>([]);
    const [loaded, setLoaded] = useState(false);
    const isMobile = isMobileViewport();

    useEffect(() => {
        if (!open || loaded) return;
        let cancelled = false;
        listAssignees()
            .then(list => { if (!cancelled) setAssignees(list); })
            .catch(() => {})
            .finally(() => { if (!cancelled) setLoaded(true); });
        return () => { cancelled = true; };
    }, [open, loaded]);

    const assign = async (ownerUserId: string | null, name: string) => {
        setOpen(false);
        try {
            await onAssign(ownerUserId);
            toast.success(ownerUserId ? `Assigned to ${name}` : 'Task unassigned');
        } catch {
            // The shared mutation seam owns the failure toast.
        }
    };

    const list = !loaded ? (
        <div className="px-4 py-3 text-xs" style={{ color: 'var(--blanc-ink-3)' }}>Loading…</div>
    ) : (
        <>
            <button
                type="button"
                onClick={() => assign(null, 'Unassigned')}
                className="block w-full px-4 py-3 text-left text-sm hover:bg-muted/60"
                style={{ color: 'var(--blanc-ink-2)' }}
            >
                Unassigned
            </button>
            {assignees.map(assignee => (
                <button
                    key={assignee.id}
                    type="button"
                    onClick={() => assign(assignee.id, assignee.name || assignee.email)}
                    className="block w-full px-4 py-3 text-left text-sm hover:bg-muted/60"
                    style={{ color: 'var(--blanc-ink-1)' }}
                >
                    {assignee.name || assignee.email}
                </button>
            ))}
        </>
    );

    const trigger = (
        <button
            type="button"
            className="pulse-ar-task-action"
            aria-label="Assign"
            title="Assign"
            data-task-id={taskId}
        >
            <UserRound aria-hidden="true" />
            <span className="pulse-ar-task-action-label">Assign</span>
        </button>
    );

    return (
        <>
            <Popover open={open && !isMobile} onOpenChange={setOpen}>
                <PopoverTrigger asChild>{trigger}</PopoverTrigger>
                <PopoverContent align="end" sideOffset={4} className="w-auto min-w-[200px] max-h-[240px] overflow-y-auto p-0 py-1 rounded-xl">
                    {list}
                </PopoverContent>
            </Popover>
            {open && isMobile && (
                <BottomSheet open={open} onClose={() => setOpen(false)} title="Assign task" size="auto">
                    {list}
                </BottomSheet>
            )}
        </>
    );
}
