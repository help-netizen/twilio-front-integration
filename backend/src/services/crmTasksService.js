'use strict';

const db = require('../db/connection');
const tasksQueries = require('../db/crmTasksQueries');
const accountsQueries = require('../db/crmAccountsQueries');
const dealsQueries = require('../db/crmDealsQueries');
const contactsQueries = require('../db/crmContactsQueries');
const writeAuditService = require('./crmWriteAuditService');
const metadataService = require('./crmMetadataService');
const { badRequest, notFound } = require('./crmErrors');

async function validateTarget(companyId, payload) {
    const targetCount = ['account_id', 'deal_id', 'contact_id', 'thread_id'].filter(key => payload[key]).length;
    if (targetCount === 0) throw badRequest('Task must be linked to account_id, deal_id, contact_id, or thread_id');
    if (payload.account_id && !await accountsQueries.getAccountById(companyId, payload.account_id)) {
        throw notFound('Account not found');
    }
    if (payload.deal_id && !await dealsQueries.getDealById(companyId, payload.deal_id)) {
        throw notFound('Deal not found');
    }
    if (payload.contact_id && !await contactsQueries.getContactById(companyId, payload.contact_id)) {
        throw notFound('Contact not found');
    }
}

async function validateStatus(companyId, status) {
    const metadata = await metadataService.getMetadata(companyId);
    const valid = metadata.task_statuses.some(item => item.status_key === status);
    if (!valid) throw badRequest(`Invalid task status: ${status}`);
}

async function listTasks(companyId, filters = {}) {
    return tasksQueries.listTasks(companyId, filters);
}

async function createTask(companyId, payload, context = {}) {
    if (!payload.title || !String(payload.title).trim()) throw badRequest('title is required');
    await validateTarget(companyId, payload);
    const task = await tasksQueries.createTask(companyId, {
        ...payload,
        created_by: context.createdBy || 'user',
    });
    await writeAuditService.logWriteAction({
        companyId,
        actorId: context.actorId,
        actorEmail: context.actorEmail,
        actorIp: context.actorIp,
        action: 'crm_task_created',
        entityType: 'task',
        entityId: task.id,
        details: {
            title: task.title,
            account_id: task.account_id || null,
            deal_id: task.deal_id || null,
            contact_id: task.contact_id || null,
        },
        source: context.source || 'Codex/Sales MCP',
        requestId: context.requestId,
        confirmation: context.confirmation || null,
    });
    return { task, field: 'task', before: null, after: task };
}

async function updateTaskStatus(companyId, taskId, status, context = {}) {
    if (!status) throw badRequest('status is required');
    await validateStatus(companyId, status);
    const client = await db.pool.connect();
    try {
        await client.query('BEGIN');
        const result = await tasksQueries.updateTaskStatus(companyId, taskId, status, client);
        if (!result) {
            await client.query('ROLLBACK');
            throw notFound('Task not found');
        }
        await writeAuditService.logFieldUpdate({
            companyId,
            actorId: context.actorId,
            actorEmail: context.actorEmail,
            actorIp: context.actorIp,
            entityType: 'task',
            entityId: taskId,
            field: 'task.status',
            before: result.before,
            after: result.after,
            source: context.source || 'Codex/Sales MCP',
            requestId: context.requestId,
            confirmation: context.confirmation || null,
            client,
        });
        await client.query('COMMIT');
        return { task: result.row, field: 'status', before: result.before, after: result.after };
    } catch (err) {
        try { await client.query('ROLLBACK'); } catch (_) {}
        throw err;
    } finally {
        client.release();
    }
}

module.exports = {
    listTasks,
    createTask,
    updateTaskStatus,
};
