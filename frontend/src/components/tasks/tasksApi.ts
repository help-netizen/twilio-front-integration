import { authedFetch } from '../../services/apiClient';

export type TaskParentType = 'job' | 'lead' | 'contact' | 'estimate' | 'invoice' | 'timeline';

/**
 * OUTBOUND-PARTS-CALL-001 (TASK-ACTIONS): a typed action button rendered on the
 * task card, in addition to the built-in Done/Cancel/Reopen affordances. The set
 * of `type`s is a closed backend registry (`robot_call`, `manual_call`).
 * `state:'failed'` + `reason` surface a prior failed attempt (e.g. the robot found
 * no slots) so the dispatcher sees why and can fall back to a manual call.
 * OUTBOUND-PARTS-CALL-CANCEL-001: `state:'canceled'` + `reason` surface a canceled
 * robot-call plan (job left 'Part arrived' / customer already reached); re-queueing
 * resets the stamp to `state:'queued'` (no reason). The action stays clickable in
 * every state — the server re-checks dialability on execute.
 */
export type TaskActionType = 'robot_call' | 'manual_call';

export interface TaskAction {
    type: TaskActionType;
    label: string;
    state?: 'failed' | 'canceled' | 'queued';
    reason?: string;
}

/** Client directive returned by `POST /actions/manual_call` — dial the softphone. */
export interface TaskActionClientDirective {
    action: 'open_softphone';
    phone: string;
    contactName?: string;
}

/** Parsed response of `runTaskAction`. `ok:false` carries a human `reason`. */
export interface RunTaskActionResult {
    ok: boolean;
    reason?: string;
    client?: TaskActionClientDirective;
    [k: string]: unknown;
}

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
    /** MAIL-AGENT-001: 'agent' tasks carry the AI triage comment in agent_output. */
    kind?: 'user' | 'agent';
    agent_type?: string | null;
    agent_output?: { reason?: string; category?: string; confidence?: number } | null;
    /** OUTBOUND-PARTS-CALL-001: typed action buttons (robot_call / manual_call). */
    actions?: TaskAction[];
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
    cursor?: string;
    search?: string;
    sort_by?: 'description' | 'parent_type' | 'parent_label' | 'assignee_name' | 'due_at';
    sort_order?: 'asc' | 'desc';
}

export interface TasksPagination {
    mode: 'cursor' | 'offset';
    limit: number;
    returned: number;
    has_more: boolean;
    next_cursor: string | null;
    total: number | null;
}

export interface TasksPageResult {
    tasks: Task[];
    pagination: TasksPagination;
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

export async function listTasksPage(
    params: ListTasksParams = {},
    signal?: AbortSignal,
): Promise<TasksPageResult> {
    const query = new URLSearchParams();
    if (params.status) query.set('status', params.status);
    if (params.parent_type) query.set('parent_type', params.parent_type);
    if (params.overdue) query.set('overdue', '1');
    if (params.assignee_id) query.set('assignee_id', params.assignee_id);
    if (params.due_from) query.set('due_from', params.due_from);
    if (params.due_to) query.set('due_to', params.due_to);
    if (params.limit != null) query.set('limit', String(params.limit));
    if (params.cursor) query.set('cursor', params.cursor);
    if (params.search) query.set('search', params.search);
    if (params.sort_by) query.set('sort_by', params.sort_by);
    if (params.sort_order) query.set('sort_order', params.sort_order);
    const queryString = query.toString();
    const response = await authedFetch(`${BASE}${queryString ? `?${queryString}` : ''}`, { signal });
    return unwrap<TasksPageResult>(response);
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

/**
 * OUTBOUND-PARTS-CALL-001: execute a typed task action.
 * `POST /api/tasks/:id/actions/:type`. The route wraps the handler result in the
 * standard `{ ok, data }` envelope, where `data` is the domain object
 * `{ ok, state?, client?, reason? }` — so we unwrap `json.data` and return that.
 * The envelope's own `ok` is always `true` on 2xx and says nothing about the
 * action outcome; the INNER `data.ok:false` (e.g. no slots) is a domain outcome,
 * not a thrown error — the caller decides how to surface `data.reason`. A non-2xx
 * / auth / network failure DOES throw.
 *
 * OUTBOUND-PARTS-CALL-SLOTPICK-001: an optional `body` (e.g. the dispatcher's
 * chosen `{ slot }`) is sent as JSON. Omit it → identical bodyless POST as before.
 */
export async function runTaskAction(id: number, type: TaskActionType, body?: unknown): Promise<RunTaskActionResult> {
    const res = await authedFetch(
        `${BASE}/${id}/actions/${type}`,
        body === undefined
            ? { method: 'POST' }
            : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
    );
    const json = (await res.json().catch(() => null)) as
        | { ok?: boolean; data?: RunTaskActionResult; error?: { message?: string }; message?: string }
        | null;
    if (!res.ok || !json || json.ok === false) {
        throw new Error(json?.error?.message || json?.message || `Request failed: ${res.status}`);
    }
    return (json.data as RunTaskActionResult) ?? { ok: false };
}

export async function listAssignees(): Promise<Assignee[]> {
    const res = await authedFetch(`${BASE}/assignees`);
    const data = await unwrap<{ users: Assignee[] }>(res);
    return data.users;
}
