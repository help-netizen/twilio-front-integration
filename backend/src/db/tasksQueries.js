'use strict';

/**
 * tasksQueries.js — TASKS-001 cross-entity tasks.
 *
 * Tasks attach to exactly one parent (job/lead/estimate/invoice/contact/timeline)
 * and have no standalone view. Reuses the shared `tasks` table; the task text
 * lives in the NOT NULL `title` column but is exposed to the API as `description`.
 * Every query is company-scoped (req.companyFilter.company_id).
 *
 * AR-TASK-UNIFY-001: a Pulse `timeline` (thread) is a first-class parent via the
 * existing `tasks.thread_id` column — an open timeline task IS "Action Required".
 * Auto-generated timeline tasks (inbound/rules, created_by <> 'user') stay
 * Pulse-only and are excluded from the global cross-entity list. Sales-CRM
 * columns (account_id/deal_id/subject_*) are still left untouched here.
 */

const db = require('./connection');
const { requireCompanyId, queryFor, clampLimit, clampOffset } = require('./crmUtils');
const {
    createCursorFingerprint,
    encodeCursor,
    decodeCursor,
    assertCursorOffsetExclusive,
    buildKeysetPredicate,
    timestampCursorExpression,
    bigintCursorExpression,
} = require('../utils/listCursor');

// parentType → { column, table+alias, label expression, frontend path }
const PARENTS = {
    job: { col: 'job_id', table: 'jobs', alias: 'j', path: 'jobs' },
    lead: { col: 'lead_id', table: 'leads', alias: 'l', path: 'leads' },
    estimate: { col: 'estimate_id', table: 'estimates', alias: 'e', path: 'estimates' },
    invoice: { col: 'invoice_id', table: 'invoices', alias: 'iv', path: 'invoices' },
    contact: { col: 'contact_id', table: 'contacts', alias: 'co', path: 'contacts' },
    timeline: { col: 'thread_id', table: 'timelines', alias: 'tl', path: 'pulse' },
};

const PARENT_TYPES = Object.keys(PARENTS);

function isValidParentType(t) {
    return Object.prototype.hasOwnProperty.call(PARENTS, t);
}

const PARENT_TYPE_EXPRESSION = `CASE
    WHEN t.job_id      IS NOT NULL THEN 'job'
    WHEN t.lead_id     IS NOT NULL THEN 'lead'
    WHEN t.estimate_id IS NOT NULL THEN 'estimate'
    WHEN t.invoice_id  IS NOT NULL THEN 'invoice'
    WHEN t.contact_id  IS NOT NULL THEN 'contact'
    WHEN t.thread_id   IS NOT NULL THEN 'timeline'
END`;

const PARENT_LABEL_EXPRESSION = `CASE
    WHEN t.job_id      IS NOT NULL THEN COALESCE(NULLIF(j.service_name,''), NULLIF(j.customer_name,''), 'Job #' || j.id)
    WHEN t.lead_id     IS NOT NULL THEN COALESCE(NULLIF(TRIM(CONCAT_WS(' ', l.first_name, l.last_name)),''), NULLIF(l.company,''), 'Lead')
    WHEN t.estimate_id IS NOT NULL THEN COALESCE(NULLIF(e.estimate_number,''), 'Estimate')
    WHEN t.invoice_id  IS NOT NULL THEN COALESCE(NULLIF(iv.invoice_number,''), 'Invoice')
    WHEN t.contact_id  IS NOT NULL THEN COALESCE(NULLIF(co.full_name,''), 'Contact')
    WHEN t.thread_id   IS NOT NULL THEN COALESCE(NULLIF(tlc.full_name,''), NULLIF(tl.phone_e164,''), 'Conversation')
END`;

const TASK_LIST_FROM = `FROM tasks t
    LEFT JOIN crm_users ow ON ow.id = t.owner_user_id AND ow.company_id = t.company_id
    LEFT JOIN crm_users au ON au.id = t.author_user_id AND au.company_id = t.company_id
    LEFT JOIN jobs j       ON j.id  = t.job_id      AND j.company_id  = t.company_id
    LEFT JOIN leads l      ON l.id  = t.lead_id     AND l.company_id  = t.company_id
    LEFT JOIN estimates e  ON e.id  = t.estimate_id AND e.company_id  = t.company_id
    LEFT JOIN invoices iv  ON iv.id = t.invoice_id  AND iv.company_id = t.company_id
    LEFT JOIN contacts co  ON co.id = t.contact_id  AND co.company_id = t.company_id
    LEFT JOIN timelines tl ON tl.id = t.thread_id   AND tl.company_id = t.company_id
    LEFT JOIN contacts tlc ON tlc.id = tl.contact_id AND tlc.company_id = t.company_id`;

// Shared SELECT projection — derives parent_type/_id/_label/_path via CASE so the
// caller gets everything needed to render a row and deep-link to the parent card.
const SELECT_TASK = `
    SELECT t.id, t.company_id, t.title AS description, t.status, t.due_at,
           t.completed_at, t.created_at, t.owner_user_id, t.author_user_id,
           t.thread_id, t.kind, t.agent_type, t.agent_output, t.actions,
           ow.full_name AS assignee_name, ow.email AS assignee_email,
           au.full_name AS author_name,
           ${PARENT_TYPE_EXPRESSION} AS parent_type,
           COALESCE(t.job_id, t.lead_id, t.estimate_id, t.invoice_id, t.contact_id, t.thread_id) AS parent_id,
           ${PARENT_LABEL_EXPRESSION} AS parent_label
    ${TASK_LIST_FROM}
`;

// Rows shown in the global cross-entity list: one of the 5 entity parents, OR a
// USER-created timeline task (auto inbound/rules tasks stay Pulse-only).
// MAIL-AGENT-001: 'agent' timeline tasks ARE listed — unlike the every-message
// 'system' auto tasks they are already significance-filtered by the LLM, and the
// owner's ask is precisely "a task in the Tasks section that opens the email".
const HAS_ENTITY_PARENT =
    "(t.job_id IS NOT NULL OR t.lead_id IS NOT NULL OR t.estimate_id IS NOT NULL OR t.invoice_id IS NOT NULL OR t.contact_id IS NOT NULL OR (t.thread_id IS NOT NULL AND t.created_by IN ('user', 'agent')))";

/**
 * Map a caller-supplied parentId to the numeric FK value stored on `tasks`.
 *
 * Leads are addressed app-wide by their VARCHAR `uuid` (e.g. "0NMHI5") — the
 * leads route is `/:uuid` and the FE passes `lead.UUID` everywhere — but
 * `tasks.lead_id` is a BIGINT FK → `leads.id`. Resolve the uuid (or a numeric id)
 * to the numeric `leads.id` so the FE can keep sending `lead.uuid`. Returns the
 * numeric id, or null when no such lead exists in this company. All other parent
 * types are already numeric and pass through unchanged.
 */
async function resolveParentId(companyId, parentType, parentId, client = null) {
    if (parentType !== 'lead') return parentId;
    if (parentId === undefined || parentId === null || parentId === '') return null;
    const query = queryFor(client, db);
    // The FE addresses leads by uuid, so try uuid first (correct even for an
    // all-digit uuid), then fall back to a numeric leads.id for internal callers.
    let { rows } = await query(
        `SELECT id FROM leads WHERE uuid = $1 AND company_id = $2 LIMIT 1`,
        [String(parentId), companyId]
    );
    if (rows.length === 0 && /^\d+$/.test(String(parentId))) {
        ({ rows } = await query(
            `SELECT id FROM leads WHERE id = $1 AND company_id = $2 LIMIT 1`,
            [Number(parentId), companyId]
        ));
    }
    return rows[0]?.id ?? null;
}

/** Resolve and re-verify an internal numeric parent under the same tenant. */
async function resolveNumericParentId(companyId, parentType, parentId, client = null) {
    requireCompanyId(companyId);
    const parent = PARENTS[parentType];
    if (!parent || !Number.isFinite(Number(parentId))) return null;
    const query = queryFor(client, db);
    const { rows } = await query(
        `SELECT id FROM ${parent.table} WHERE company_id = $1 AND id = $2 LIMIT 1`,
        [companyId, Number(parentId)]
    );
    return rows[0]?.id ?? null;
}

/** Confirm a parent row exists in this company. Returns boolean. */
async function parentExists(companyId, parentType, parentId, client = null) {
    requireCompanyId(companyId);
    if (!isValidParentType(parentType)) return false;
    // Leads: resolve uuid → numeric id (the resolution IS the existence check).
    if (parentType === 'lead') {
        return (await resolveParentId(companyId, 'lead', parentId, client)) != null;
    }
    const p = PARENTS[parentType];
    const query = queryFor(client, db);
    const { rows } = await query(
        `SELECT 1 FROM ${p.table} WHERE id = $1 AND company_id = $2 LIMIT 1`,
        [parentId, companyId]
    );
    return rows.length > 0;
}

/**
 * Check whether a job parent is visible under the canonical Jobs record scope.
 *
 * This is deliberately separate from parentExists(): creation validates tenant
 * ownership, while entity-card reads must also enforce the caller's assigned-only
 * visibility. The predicate matches jobsService.listJobs/getJobById.
 */
async function jobParentVisible(
    companyId,
    parentId,
    providerScope,
    client = null,
    { lock = false } = {}
) {
    requireCompanyId(companyId);
    const query = queryFor(client, db);
    const params = [companyId, parentId];
    const conditions = ['company_id = $1', 'id = $2'];
    if (providerScope?.assignedOnly) {
        if (!providerScope.userId) return false;
        params.push(JSON.stringify([String(providerScope.userId)]));
        conditions.push(`assigned_provider_user_ids @> $${params.length}::jsonb`);
    }
    const { rows } = await query(
        `SELECT 1
         FROM jobs
         WHERE ${conditions.join(' AND ')}
         LIMIT 1
         ${lock ? 'FOR SHARE' : ''}`,
        params
    );
    return rows.length > 0;
}

/** Tasks for one parent card (open first, optional recently-done). */
async function listEntityTasks(companyId, { parentType, parentId, includeDone = false }, client = null) {
    requireCompanyId(companyId);
    if (!isValidParentType(parentType)) return [];
    const p = PARENTS[parentType];
    const query = queryFor(client, db);
    // Leads arrive as a uuid; resolve to the numeric leads.id the FK is stored as.
    const resolvedId = await resolveParentId(companyId, parentType, parentId, client);
    if (resolvedId === null || resolvedId === undefined) return [];
    const params = [companyId, resolvedId];
    let statusCond = '';
    if (!includeDone) statusCond = `AND t.status = 'open'`;
    const { rows } = await query(
        `${SELECT_TASK}
         WHERE t.company_id = $1 AND t.${p.col} = $2 ${statusCond}
         ORDER BY (t.status = 'done'), t.due_at ASC NULLS LAST, t.created_at DESC`,
        params
    );
    return rows;
}

/**
 * Shared WHERE builder for the global cross-entity task list.
 *
 * TASKS-COUNT-BADGE-001: extracted verbatim from `listTasks` so the list and the
 * count consume ONE predicate source — the badge count can never drift from the
 * list row count (AC-1..AC-3). Seed and push order are byte-identical to the
 * former inline block, so the `$n` numbering the callers emit is unchanged.
 * It deliberately does NOT append limit/offset — those stay caller-side in
 * `listTasks` (the count has no pagination).
 *
 * Returns `{ conditions, params }`; the caller joins `conditions` with ' AND '.
 */
function buildTaskListFilters(companyId, filters = {}) {
    const params = [companyId];
    const conditions = ['t.company_id = $1', HAS_ENTITY_PARENT];

    if (Object.prototype.hasOwnProperty.call(filters, 'scopeOwnerId')) {
        if (filters.scopeOwnerId) {
            params.push(filters.scopeOwnerId);
            conditions.push(`(
                t.owner_user_id = $${params.length}
                OR t.author_user_id = $${params.length}
            )`);
        } else {
            // A requested owner scope with no actor must never collapse into the
            // company-wide branch. Routes reject it; this is query-layer defense.
            conditions.push('FALSE');
        }
    }
    if (filters.status) {
        params.push(filters.status);
        conditions.push(`t.status = $${params.length}`);
    }
    if (filters.assignee_id) {
        params.push(filters.assignee_id);
        conditions.push(`t.owner_user_id = $${params.length}`);
    }
    if (filters.parent_type && isValidParentType(filters.parent_type)) {
        conditions.push(`t.${PARENTS[filters.parent_type].col} IS NOT NULL`);
    }
    if (filters.overdue) {
        conditions.push(`t.status = 'open' AND t.due_at IS NOT NULL AND t.due_at < now()`);
    }
    if (filters.due_from) {
        params.push(filters.due_from);
        conditions.push(`t.due_at >= $${params.length}::timestamptz`);
    }
    if (filters.due_to) {
        params.push(filters.due_to);
        conditions.push(`t.due_at <= $${params.length}::timestamptz`);
    }
    if (filters.search && String(filters.search).trim()) {
        params.push(`%${String(filters.search).trim()}%`);
        conditions.push(`(
            t.title ILIKE $${params.length}
            OR (${PARENT_LABEL_EXPRESSION}) ILIKE $${params.length}
            OR ow.full_name ILIKE $${params.length}
        )`);
    }

    return { conditions, params };
}

/** Global cross-entity list. scopeOwnerId set → only that user's tasks (own scope). */
async function listTasks(companyId, filters = {}, client = null) {
    requireCompanyId(companyId);
    const query = queryFor(client, db);
    const { conditions, params } = buildTaskListFilters(companyId, filters);

    const limit = clampLimit(filters.limit, 100, 500);
    const offset = clampOffset(filters.offset);
    params.push(limit, offset);

    const { rows } = await query(
        `${SELECT_TASK}
         WHERE ${conditions.join(' AND ')}
         ORDER BY t.due_at ASC NULLS LAST, t.created_at DESC
         LIMIT $${params.length - 1} OFFSET $${params.length}`,
        params
    );
    return rows;
}

const TASK_PAGE_SORTS = Object.freeze({
    description: `LOWER(COALESCE(page_base.description, '')) COLLATE "C"`,
    parent_type: `LOWER(COALESCE(page_base.parent_type, '')) COLLATE "C"`,
    parent_label: `LOWER(COALESCE(page_base.parent_label, '')) COLLATE "C"`,
    assignee_name: `LOWER(COALESCE(page_base.assignee_name, '')) COLLATE "C"`,
});

function tasksListError(code, message) {
    const error = new Error(message);
    error.code = code;
    error.statusCode = 400;
    return error;
}

/** Cursor page used only by GET /api/tasks; legacy listTasks remains array-returning. */
async function listTasksPage(companyId, filters = {}, client = null) {
    requireCompanyId(companyId);
    const query = queryFor(client, db);
    const requestedLimit = filters.limit ?? 50;
    if (!Number.isInteger(Number(requestedLimit)) || Number(requestedLimit) < 1 || Number(requestedLimit) > 500) {
        throw tasksListError('INVALID_QUERY', 'limit must be an integer from 1 to 500');
    }
    const limit = Number(requestedLimit);
    if (filters.offset !== undefined && (
        !Number.isInteger(Number(filters.offset)) || Number(filters.offset) < 0
    )) {
        throw tasksListError('INVALID_QUERY', 'offset must be a non-negative integer');
    }
    assertCursorOffsetExclusive(filters.cursor, filters.offset);

    const sortBy = filters.sort_by || 'due_at';
    const sortOrder = filters.sort_order || 'asc';
    if ((sortBy !== 'due_at' && !TASK_PAGE_SORTS[sortBy]) || (sortOrder !== 'asc' && sortOrder !== 'desc')) {
        throw tasksListError('INVALID_QUERY', 'Invalid task sort');
    }

    const mode = filters.offset === undefined ? 'cursor' : 'offset';
    const normalizedSearch = typeof filters.search === 'string' ? filters.search.trim() : '';
    const fingerprint = createCursorFingerprint({
        endpoint: 'tasks',
        company: String(companyId),
        visibility: {
            owner_scope_applied: Object.prototype.hasOwnProperty.call(filters, 'scopeOwnerId'),
            scope_owner_id: filters.scopeOwnerId ? String(filters.scopeOwnerId) : null,
            assignee_id: filters.assignee_id ? String(filters.assignee_id) : null,
        },
        filters: {
            status: filters.status || null,
            parent_type: filters.parent_type || null,
            overdue: Boolean(filters.overdue),
            due_from: filters.due_from || null,
            due_to: filters.due_to || null,
            search: normalizedSearch.toLocaleLowerCase('en-US'),
        },
        sort: sortBy,
        direction: sortOrder,
        limit,
    });
    const cursorValueTypes = sortBy === 'due_at'
        ? ['boolean', { type: 'timestamp', nullable: true }, 'timestamp', 'bigint']
        : ['text', 'bigint'];
    const cursorExpectation = {
        endpoint: 'tasks',
        sort: sortBy,
        direction: sortOrder,
        fingerprint,
        valueTypes: cursorValueTypes,
    };
    const decodedCursor = filters.cursor
        ? decodeCursor(filters.cursor, cursorExpectation)
        : null;

    const pageFilters = { ...filters, search: normalizedSearch || undefined };
    const { conditions, params } = buildTaskListFilters(companyId, pageFilters);
    let total = null;
    if (!decodedCursor) {
        const countResult = await query(
            `SELECT COUNT(*)::int AS total ${TASK_LIST_FROM} WHERE ${conditions.join(' AND ')}`,
            params,
        );
        total = countResult.rows[0]?.total ?? 0;
    }

    const pageParams = params.slice();
    const cursorKeys = [];
    const cursorProjections = [];
    const orderParts = [];
    if (sortBy === 'due_at') {
        cursorKeys.push(
            { expression: '(page_base.due_at IS NULL)', direction: 'asc', type: 'boolean' },
            { expression: 'page_base.due_at', direction: sortOrder, type: 'timestamp', nullable: true },
            { expression: 'page_base.created_at', direction: 'desc', type: 'timestamp' },
            { expression: 'page_base.id', direction: 'desc', type: 'bigint' },
        );
        cursorProjections.push(
            '(page_base.due_at IS NULL) AS __cursor_null',
            `${timestampCursorExpression('page_base.due_at')} AS __cursor_value`,
            `${timestampCursorExpression('page_base.created_at')} AS __cursor_created`,
            `${bigintCursorExpression('page_base.id')} AS __cursor_id`,
        );
        orderParts.push(
            '(page_base.due_at IS NULL) ASC',
            `page_base.due_at ${sortOrder.toUpperCase()}`,
            'page_base.created_at DESC',
            'page_base.id DESC',
        );
    } else {
        const expression = TASK_PAGE_SORTS[sortBy];
        cursorKeys.push(
            { expression, direction: sortOrder, type: 'text' },
            { expression: 'page_base.id', direction: sortOrder, type: 'bigint' },
        );
        cursorProjections.push(
            `${expression} AS __cursor_value`,
            `${bigintCursorExpression('page_base.id')} AS __cursor_id`,
        );
        orderParts.push(`${expression} ${sortOrder.toUpperCase()}`, `page_base.id ${sortOrder.toUpperCase()}`);
    }

    let cursorWhere = 'TRUE';
    if (decodedCursor) {
        const keyset = buildKeysetPredicate(cursorKeys, decodedCursor.values, pageParams.length + 1);
        cursorWhere = keyset.sql;
        pageParams.push(...keyset.params);
    }
    const limitParam = pageParams.length + 1;
    pageParams.push(limit + 1);
    let offsetSql = '';
    if (mode === 'offset') {
        const offsetParam = pageParams.length + 1;
        pageParams.push(Number(filters.offset));
        offsetSql = ` OFFSET $${offsetParam}`;
    }

    const pageResult = await query(
        `SELECT page_base.*, ${cursorProjections.join(', ')}
         FROM (
             ${SELECT_TASK}
             WHERE ${conditions.join(' AND ')}
         ) page_base
         WHERE ${cursorWhere}
         ORDER BY ${orderParts.join(', ')}
         LIMIT $${limitParam}${offsetSql}`,
        pageParams,
    );
    const probedRows = pageResult.rows;
    const pageRows = probedRows.slice(0, limit);
    const tasks = pageRows.map(({
        __cursor_null,
        __cursor_value,
        __cursor_created,
        __cursor_id,
        ...task
    }) => {
        void __cursor_null;
        void __cursor_value;
        void __cursor_created;
        void __cursor_id;
        return task;
    });
    const hasMore = probedRows.length > limit;
    const lastPageRow = pageRows.at(-1);
    const cursorValues = !lastPageRow
        ? []
        : sortBy === 'due_at'
            ? [
                Boolean(lastPageRow.__cursor_null),
                lastPageRow.__cursor_value == null ? null : String(lastPageRow.__cursor_value),
                String(lastPageRow.__cursor_created),
                String(lastPageRow.__cursor_id),
            ]
            : [String(lastPageRow.__cursor_value), String(lastPageRow.__cursor_id)];
    const nextCursor = mode === 'cursor' && hasMore && lastPageRow
        ? encodeCursor({
            endpoint: 'tasks',
            sort: sortBy,
            direction: sortOrder,
            fingerprint,
            values: cursorValues,
        }, cursorExpectation)
        : null;

    return {
        tasks,
        pagination: {
            mode,
            limit,
            returned: tasks.length,
            has_more: hasMore,
            next_cursor: nextCursor,
            total,
        },
    };
}

/**
 * Count of the global cross-entity list under the SAME predicate as `listTasks`
 * (TASKS-COUNT-BADGE-001). The common no-search path counts the bare `tasks t`;
 * search uses the shared joins because parent label and assignee are predicates.
 * Returns a non-negative integer.
 */
async function countTasks(companyId, filters = {}, client = null) {
    requireCompanyId(companyId);
    const query = queryFor(client, db);
    const { conditions, params } = buildTaskListFilters(companyId, filters);
    const fromClause = filters.search && String(filters.search).trim()
        ? TASK_LIST_FROM
        : 'FROM tasks t';

    const { rows } = await query(
        `SELECT COUNT(*)::int AS count ${fromClause} WHERE ${conditions.join(' AND ')}`,
        params
    );
    return rows[0]?.count || 0;
}

/** Single task with the derived parent fields. */
async function getTaskById(companyId, taskId, client = null) {
    requireCompanyId(companyId);
    const query = queryFor(client, db);
    const { rows } = await query(
        `${SELECT_TASK} WHERE t.company_id = $1 AND t.id = $2`,
        [companyId, taskId]
    );
    return rows[0] || null;
}

/**
 * Create a task on exactly one parent. payload:
 *   { parentType, parentId, description, owner_user_id, author_user_id, due_at, kind?, actions? }
 *
 * OUTBOUND-PARTS-CALL-001 (T6): `kind` and `actions` are ADDITIVE, optional
 * passthroughs — appended to the column list ONLY when present in the payload,
 * so legacy callers (which pass neither) get the byte-for-byte original INSERT
 * with the new columns left at their table defaults (NULL). `actions` is a jsonb
 * column (mig 157); it is serialized with JSON.stringify and cast `::jsonb`.
 * The dedup / one-open-per-job app-upsert lives in the caller
 * (`partsCallService.onPartArrived`) — `createTask` has no built-in upsert.
 */
async function createTask(companyId, payload, client = null) {
    requireCompanyId(companyId);
    const p = PARENTS[payload.parentType];
    const query = queryFor(client, db);
    // HTTP Lead callers arrive with a uuid. Internal workers can opt into an
    // explicitly company-verified numeric id so an all-digit Lead uuid can
    // never redirect a task to the wrong row.
    const parentId = payload.parentIdIsNumeric
        ? await resolveNumericParentId(companyId, payload.parentType, payload.parentId, client)
        : await resolveParentId(companyId, payload.parentType, payload.parentId, client);
    if (parentId === null || parentId === undefined) {
        const error = new Error('Task parent was not found for this company');
        error.code = 'PARENT_NOT_FOUND';
        throw error;
    }
    const cols = ['company_id', 'title', 'description', 'status', 'created_by', 'owner_user_id', 'author_user_id', 'due_at', p.col];
    const vals = [
        companyId,
        payload.title || payload.description, // title (NOT NULL) holds the task text
        payload.description,            // description column mirrors it
        'open',
        payload.created_by || 'user',
        payload.owner_user_id || null,
        payload.author_user_id || null,
        payload.due_at || null,
        parentId,
    ];

    // Additive: only extend cols/vals when the caller opts in, so the legacy
    // placeholder/`p.col` ordering never shifts for existing callers.
    if (payload.kind !== undefined) {
        cols.push('kind');
        vals.push(payload.kind);
    }
    if (payload.actions !== undefined) {
        cols.push('actions');
        // Serialize objects/arrays to a json string; a plain string is passed as-is.
        vals.push(typeof payload.actions === 'string' ? payload.actions : JSON.stringify(payload.actions));
    }
    for (const [payloadKey, column] of [
        ['agent_type', 'agent_type'],
        ['agent_input', 'agent_input'],
        ['agent_output', 'agent_output'],
        ['agent_status', 'agent_status'],
    ]) {
        if (payload[payloadKey] !== undefined) {
            cols.push(column);
            const value = payload[payloadKey];
            vals.push((column === 'agent_input' || column === 'agent_output') && typeof value !== 'string'
                ? JSON.stringify(value)
                : value);
        }
    }

    const placeholders = vals.map((_, i) => {
        if (cols[i] === 'due_at') return `$${i + 1}::timestamptz`;
        if (cols[i] === 'actions') return `$${i + 1}::jsonb`;
        if (cols[i] === 'agent_input' || cols[i] === 'agent_output') return `$${i + 1}::jsonb`;
        return `$${i + 1}`;
    });
    const { rows } = await query(
        `INSERT INTO tasks (${cols.join(', ')}) VALUES (${placeholders.join(', ')}) RETURNING id`,
        vals
    );
    return getTaskById(companyId, rows[0].id, client);
}

/** Patch description / owner_user_id / due_at / status. */
async function updateTask(companyId, taskId, patch = {}, client = null) {
    requireCompanyId(companyId);
    const query = queryFor(client, db);
    const sets = [];
    const params = [companyId, taskId];

    if (patch.description !== undefined) {
        params.push(patch.description);
        sets.push(`title = $${params.length}`);
        params.push(patch.description);
        sets.push(`description = $${params.length}`);
    }
    if (patch.owner_user_id !== undefined) {
        params.push(patch.owner_user_id);
        sets.push(`owner_user_id = $${params.length}`);
    }
    if (patch.due_at !== undefined) {
        params.push(patch.due_at);
        sets.push(`due_at = $${params.length}::timestamptz`);
    }
    if (patch.status !== undefined) {
        params.push(patch.status);
        sets.push(`status = $${params.length}`);
        sets.push(`completed_at = CASE WHEN $${params.length} = 'done' THEN COALESCE(completed_at, now()) ELSE NULL END`);
    }

    if (sets.length === 0) return getTaskById(companyId, taskId, client);

    const { rows } = await query(
        `UPDATE tasks SET ${sets.join(', ')}
         WHERE company_id = $1 AND id = $2 RETURNING id`,
        params
    );
    if (rows.length === 0) return null;
    return getTaskById(companyId, taskId, client);
}

/** Clear the legacy timeline flag after its final open task is completed. */
async function clearTimelineActionRequiredIfNoOpenTasks(companyId, timelineId, client = null) {
    requireCompanyId(companyId);
    const query = queryFor(client, db);
    const { rowCount } = await query(
        `UPDATE timelines tl SET
            is_action_required = false,
            action_required_reason = NULL,
            action_required_set_at = NULL,
            action_required_set_by = NULL,
            snoozed_until = NULL,
            updated_at = now()
         WHERE tl.company_id = $1 AND tl.id = $2
           AND NOT EXISTS (
               SELECT 1 FROM tasks remaining
                WHERE remaining.company_id = $1
                  AND remaining.thread_id = tl.id
                  AND remaining.status = 'open'
           )`,
        [companyId, timelineId]
    );
    return rowCount > 0;
}

async function deleteTask(companyId, taskId, client = null) {
    requireCompanyId(companyId);
    const query = queryFor(client, db);
    const { rowCount } = await query(
        `DELETE FROM tasks WHERE company_id = $1 AND id = $2`,
        [companyId, taskId]
    );
    return rowCount > 0;
}

module.exports = {
    PARENT_TYPES,
    isValidParentType,
    resolveParentId,
    parentExists,
    jobParentVisible,
    listEntityTasks,
    buildTaskListFilters,
    listTasks,
    listTasksPage,
    countTasks,
    getTaskById,
    createTask,
    updateTask,
    clearTimelineActionRequiredIfNoOpenTasks,
    deleteTask,
};
