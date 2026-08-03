'use strict';

const db = require('../db/connection');
const tasksQueries = require('../db/tasksQueries');
const { requireCompanyId } = require('../db/crmUtils');
const { companyDateFilterBounds } = require('../utils/companyTime');
const tasksService = require('./tasksService');
const { appRuntimeError } = require('./appRuntimeErrors');

const DAILY_TASK_LIMIT = 100;

function normalizeDueAt(value, companyTimezone) {
    if (value === undefined) return null;
    if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
        return companyDateFilterBounds(value, null, companyTimezone).fromInclusive;
    }
    return new Date(value).toISOString();
}

async function createTaskInTransaction(context, args, client) {
    const companyId = context.company_id;
    requireCompanyId(companyId);
    if (!context.installation_id || !context.app_id || !context.agent_user_id) {
        throw appRuntimeError(
            'APP_RUNTIME_INACTIVE',
            'App runtime authorization is not active.',
            403
        );
    }

    const description = String(args.description).trim();
    if (!description || description.length > 500) {
        throw appRuntimeError('INVALID_ARGUMENTS', 'Tool arguments are invalid.', 422);
    }
    const parentId = await tasksQueries.resolveNumericParentId(
        companyId,
        args.parent_type,
        args.parent_id,
        client
    );
    if (parentId == null) {
        throw appRuntimeError('NOT_FOUND', 'Resource not found.', 404);
    }

    // Serializes the installation's dedup + daily-count + insert decision. The
    // row is selected only through the live run-derived company/app tuple.
    const installation = await client.query(
        `SELECT id
         FROM marketplace_installations
         WHERE company_id = $1
           AND app_id = $2
           AND id = $3
           AND status = 'connected'
         FOR UPDATE`,
        [companyId, context.app_id, context.installation_id]
    );
    if (installation.rows.length !== 1) {
        throw appRuntimeError(
            'APP_RUNTIME_INACTIVE',
            'App runtime authorization is not active.',
            403
        );
    }

    const existing = await tasksQueries.findOpenAppTask(companyId, {
        installationId: context.installation_id,
        parentType: args.parent_type,
        parentId,
        description,
    }, client);
    if (existing) {
        return { task: existing, deduplicated: true };
    }

    const createdToday = await tasksQueries.countAppTasksCreatedToday(
        companyId,
        context.installation_id,
        client
    );
    if (createdToday >= DAILY_TASK_LIMIT) {
        throw appRuntimeError(
            'TASK_DAILY_LIMIT',
            'Daily task creation limit of 100 reached.',
            429
        );
    }

    const task = await tasksQueries.createTask(companyId, {
        parentType: args.parent_type,
        parentId,
        parentIdIsNumeric: true,
        description,
        owner_user_id: null,
        author_user_id: context.agent_user_id,
        due_at: normalizeDueAt(args.due_at, context.company_timezone),
        created_by: 'agent',
        kind: 'agent',
        agent_type: 'app',
        agent_input: {
            source: 'app',
            installation_id: String(context.installation_id),
        },
        agent_status: 'succeeded',
    }, client);
    return { task, deduplicated: false };
}

async function createTask(context, args) {
    const client = await db.pool.connect();
    let result;
    try {
        await client.query('BEGIN');
        result = await createTaskInTransaction(context, args, client);
        await client.query('COMMIT');
    } catch (error) {
        try { await client.query('ROLLBACK'); } catch { /* preserve original error */ }
        throw error;
    } finally {
        client.release();
    }
    if (!result.deduplicated) tasksService.emitTaskChange(context.company_id);
    return {
        task_id: result.task.id,
        status: 'open',
        ...(result.deduplicated ? { deduplicated: true } : {}),
    };
}

module.exports = {
    DAILY_TASK_LIMIT,
    normalizeDueAt,
    createTask,
    createTaskInTransaction,
};
