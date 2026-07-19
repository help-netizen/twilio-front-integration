import { useCallback } from 'react';
import { toast } from 'sonner';
import { completeTask, reopenTask, snoozeTask, updateTask, type Task } from './tasksApi';

type TaskTarget = Pick<Task, 'id'>;

interface Options {
    refetch: () => void | Promise<unknown>;
    onOptimisticComplete?: (taskId: number) => void;
    onTasksChanged?: () => void;
}

/** Shared task mutation semantics for entity stacks and compact task surfaces. */
export function useTaskMutations({ refetch, onOptimisticComplete, onTasksChanged }: Options) {
    const refresh = useCallback(async () => {
        await refetch();
        onTasksChanged?.();
    }, [refetch, onTasksChanged]);

    const complete = useCallback(async (task: TaskTarget) => {
        onOptimisticComplete?.(task.id);
        try {
            await completeTask(task.id);
            toast.success('Task completed', {
                action: {
                    label: 'Undo',
                    onClick: () => {
                        reopenTask(task.id)
                            .then(refresh)
                            .catch(() => {});
                    },
                },
            });
        } catch {
            toast.error('Failed to complete task');
        }
        await refresh();
    }, [onOptimisticComplete, refresh]);

    const reopen = useCallback(async (task: TaskTarget) => {
        try {
            await reopenTask(task.id);
            await refresh();
        } catch {
            toast.error('Failed to reopen task');
        }
    }, [refresh]);

    const snooze = useCallback(async (task: TaskTarget, dueAtIso: string) => {
        try {
            await snoozeTask(task.id, dueAtIso);
            toast.success('Task snoozed');
            await refresh();
        } catch {
            toast.error('Failed to snooze task');
        }
    }, [refresh]);

    const assign = useCallback(async (task: TaskTarget, ownerUserId: string | null) => {
        try {
            const updated = await updateTask(task.id, { owner_user_id: ownerUserId });
            await refresh();
            return updated;
        } catch (error) {
            toast.error('Failed to assign task');
            throw error;
        }
    }, [refresh]);

    return { complete, reopen, snooze, assign };
}
