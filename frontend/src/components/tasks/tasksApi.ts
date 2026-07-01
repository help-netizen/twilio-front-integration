import { authedFetch } from '../../services/apiClient';

export type TaskParentType = 'job' | 'lead' | 'contact' | 'estimate' | 'invoice' | 'timeline';

export interface Task {
    id: number;
    description: string;
    status: 'open' | 'done';
    due_at: string | null;
    completed_at: string | null;
    created_at: string;
    owner_user_id: string | null;
    author_user_id: string | null;
    assignee_name: string | null;
    assignee_email: string | null;
    author_name: string | null;
    parent_type: TaskParentType;
    parent_id: number;
    parent_label: string | null;
}

export interface Assignee {
    id: string;
    name: string;
    email: string;
}

export interface ListTasksParams {
    status?: 'open' | 'done' | 'all';
    parent_type?: TaskParentType;
    overdue?: boolean;
    assignee_id?: string;
    due_from?: string;
    due_to?: string;
    limit?: number;
    offset?: number;
}

const BASE = '/api/tasks';

/** Unwrap a `{ ok, data }` envelope, throwing the server message on failure. */
async function unwrap<T>(res: Response): Promise<T> {
    const json = await res.json().catch(() => null);
    if (!res.ok || !json || json.ok === false) {
        throw new Error(json?.error?.message || json?.message || `Request failed: ${res.status}`);
    }
    return json.data as T;
}

/** Map a task to the route that opens its parent entity's card. */
export function parentPath(task: Pick<Task, 'parent_type' | 'parent_id'>): string {
    switch (task.parent_type) {
        case 'job': return `/jobs/${task.parent_id}`;
        case 'lead': return `/leads/${task.parent_id}`;
        case 'contact': return `/contacts/${task.parent_id}`;
        // Estimates/Invoices open via the existing ?openId query mechanism.
        case 'estimate': return `/estimates?openId=${task.parent_id}`;
        case 'invoice': return `/invoices?openId=${task.parent_id}`;
        // Timeline (Pulse thread) tasks open the conversation.
        case 'timeline': return `/pulse/timeline/${task.parent_id}`;
        default: return '/tasks';
    }
}

export async function listEntityTasks(
    parentType: TaskParentType,
    parentId: number | string,
    includeDone = false,
): Promise<Task[]> {
    const qs = includeDone ? '?include_done=1' : '';
    const res = await authedFetch(`${BASE}/entity/${parentType}/${parentId}${qs}`);
    const data = await unwrap<{ tasks: Task[] }>(res);
    return data.tasks;
}

export async function listTasks(params: ListTasksParams = {}): Promise<Task[]> {
    const q = new URLSearchParams();
    if (params.status) q.set('status', params.status);
    if (params.parent_type) q.set('parent_type', params.parent_type);
    if (params.overdue) q.set('overdue', '1');
    if (params.assignee_id) q.set('assignee_id', params.assignee_id);
    if (params.due_from) q.set('due_from', params.due_from);
    if (params.due_to) q.set('due_to', params.due_to);
    if (params.limit != null) q.set('limit', String(params.limit));
    if (params.offset != null) q.set('offset', String(params.offset));
    const qs = q.toString();
    const res = await authedFetch(`${BASE}${qs ? `?${qs}` : ''}`);
    const data = await unwrap<{ tasks: Task[] }>(res);
    return data.tasks;
}

export interface CreateTaskInput {
    parent_type: TaskParentType;
    parent_id: number | string;
    description: string;
    owner_user_id?: string | null;
    due_at?: string | null;
}

export async function createTask(input: CreateTaskInput): Promise<Task> {
    const res = await authedFetch(BASE, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
    });
    const data = await unwrap<{ task: Task }>(res);
    return data.task;
}

export interface UpdateTaskPatch {
    description?: string;
    owner_user_id?: string | null;
    due_at?: string | null;
    status?: 'open' | 'done';
}

export async function updateTask(id: number, patch: UpdateTaskPatch): Promise<Task> {
    const res = await authedFetch(`${BASE}/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
    });
    const data = await unwrap<{ task: Task }>(res);
    return data.task;
}

export const completeTask = (id: number) => updateTask(id, { status: 'done' });
export const reopenTask = (id: number) => updateTask(id, { status: 'open' });
export const snoozeTask = (id: number, dueAtIso: string) => updateTask(id, { due_at: dueAtIso });

export async function deleteTask(id: number): Promise<void> {
    const res = await authedFetch(`${BASE}/${id}`, { method: 'DELETE' });
    await unwrap<unknown>(res);
}

export async function listAssignees(): Promise<Assignee[]> {
    const res = await authedFetch(`${BASE}/assignees`);
    const data = await unwrap<{ users: Assignee[] }>(res);
    return data.users;
}
