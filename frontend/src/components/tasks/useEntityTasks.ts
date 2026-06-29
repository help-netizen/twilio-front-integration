import { useState, useEffect, useCallback } from 'react';
import { listEntityTasks, type Task, type TaskParentType } from './tasksApi';

/** Fetch + refresh the open tasks for one parent entity (used by the in-card stack). */
export function useEntityTasks(parentType: TaskParentType, parentId: number | string | null | undefined, enabled = true) {
    const [tasks, setTasks] = useState<Task[]>([]);
    const [loading, setLoading] = useState(false);

    const refetch = useCallback(async () => {
        if (!enabled || parentId == null || parentId === '') return;
        setLoading(true);
        try {
            setTasks(await listEntityTasks(parentType, parentId));
        } catch {
            /* non-critical — leave the existing list */
        } finally {
            setLoading(false);
        }
    }, [parentType, parentId, enabled]);

    useEffect(() => { refetch(); }, [refetch]);

    return { tasks, loading, refetch, setTasks };
}
