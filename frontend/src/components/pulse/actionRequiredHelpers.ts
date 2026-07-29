export function remainingTasksAfterCompletion<T extends { id: number }>(tasks: T[], taskId: number): T[] {
    return tasks.filter(task => task.id !== taskId);
}

/**
 * The plaque row copy for a task. Agent tasks append the agent's reason — but
 * ONLY when the description doesn't already contain it (the Mail Secretary
 * writes the reason into the description too, which doubled the sentence).
 */
export function taskTitle(task: {
    title: string;
    description?: string | null;
    kind?: string | null;
    agent_output?: { reason?: string | null } | null;
}): string {
    const title = task.description || task.title;
    const reason = task.kind === 'agent' ? (task.agent_output?.reason || '').trim() : '';
    if (reason && !title.includes(reason)) {
        return `${title}. ${reason}`;
    }
    return title;
}

export function shouldShowActionRequiredPlaque(tasks: unknown[], isManuallyRequired: boolean): boolean {
    return tasks.length > 0 || isManuallyRequired;
}
