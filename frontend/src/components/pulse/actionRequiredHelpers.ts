export function remainingTasksAfterCompletion<T extends { id: number }>(tasks: T[], taskId: number): T[] {
    return tasks.filter(task => task.id !== taskId);
}

export function shouldShowActionRequiredPlaque(tasks: unknown[], isManuallyRequired: boolean): boolean {
    return tasks.length > 0 || isManuallyRequired;
}
