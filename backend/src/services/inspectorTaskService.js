'use strict';

const db = require('../db/connection');
const { requireCompanyId } = require('../db/crmUtils');
const inspectorQueries = require('../db/inspectorQueries');
const tasksQueries = require('../db/tasksQueries');
const tasksService = require('./tasksService');

function reviewPayload(input, verdict, taskId = null) {
    return {
        company_local_date: input.companyLocalDate,
        entity_type: input.entityType,
        entity_id: input.entityId,
        verdict,
        provider: input.modelResult?.provider || null,
        model: input.modelResult?.model || null,
        latency_ms: input.modelResult?.latency_ms ?? null,
        token_usage: input.modelResult?.token_usage || {},
        explanation: input.verdict?.reason || verdict,
        task_id: taskId,
    };
}

async function createTaskInTransaction(input, client) {
    const {
        companyId,
        entityType,
        entityId,
        boundary,
        ignoredStatuses,
        verdict,
    } = input;
    inspectorQueries.assertEntityType(entityType);

    const priorReview = await inspectorQueries.getReview(
        companyId,
        input.companyLocalDate,
        entityType,
        entityId,
        client
    );
    if (priorReview) return { status: 'already_reviewed', review: priorReview, task: null };

    const eligible = await inspectorQueries.reloadEligibleEntity(
        companyId,
        entityType,
        entityId,
        boundary,
        ignoredStatuses,
        client
    );
    if (!eligible) {
        const ownedRecord = await inspectorQueries.getEntityRecord(
            companyId,
            entityType,
            entityId,
            client
        );
        if (!ownedRecord) return { status: 'not_found', review: null, task: null };
        const review = await inspectorQueries.insertReview(
            companyId,
            reviewPayload(input, 'became_ineligible'),
            client
        );
        return { status: 'became_ineligible', review, task: null };
    }

    const existing = await inspectorQueries.getOpenInspectorTask(
        companyId,
        entityType,
        entityId,
        client
    );
    if (existing) {
        const review = await inspectorQueries.insertReview(
            companyId,
            reviewPayload(input, 'deduped_open_task', existing.id),
            client
        );
        return { status: 'deduped', review, task: existing };
    }

    const parentType = entityType;
    const taskInput = {
        entity_type: entityType,
        entity_id: entityId,
        company_local_date: input.companyLocalDate,
        run_id: input.runId,
    };
    const taskOutput = {
        needs_attention: true,
        confidence: verdict.confidence,
        reason: verdict.reason,
        task_title: verdict.task_title,
        task_description: verdict.task_description,
        provider: input.modelResult?.provider || null,
        model: input.modelResult?.model || null,
    };

    await client.query('SAVEPOINT inspector_task_create');
    let task;
    try {
        task = await tasksQueries.createTask(companyId, {
            parentType,
            parentId: entityId,
            parentIdIsNumeric: true,
            title: verdict.task_title,
            description: verdict.task_description,
            created_by: 'agent',
            kind: 'agent',
            agent_type: 'inspector',
            agent_input: taskInput,
            agent_output: taskOutput,
            agent_status: 'succeeded',
        }, client);
        await client.query('RELEASE SAVEPOINT inspector_task_create');
    } catch (error) {
        await client.query('ROLLBACK TO SAVEPOINT inspector_task_create');
        if (error?.code !== '23505') throw error;
        const winner = await inspectorQueries.getOpenInspectorTask(
            companyId,
            entityType,
            entityId,
            client
        );
        if (!winner) throw error;
        const review = await inspectorQueries.insertReview(
            companyId,
            reviewPayload(input, 'deduped_open_task', winner.id),
            client
        );
        return { status: 'deduped', review, task: winner };
    }

    if (eligible.contact_id) {
        const timeline = await inspectorQueries.findExistingTimeline(
            companyId,
            eligible.contact_id,
            client
        );
        if (timeline) {
            await inspectorQueries.linkTaskToTimeline(
                companyId,
                task.id,
                timeline.id,
                eligible.contact_id,
                client
            );
            task = await tasksQueries.getTaskById(companyId, task.id, client);
        }
    }

    const review = await inspectorQueries.insertReview(
        companyId,
        reviewPayload(input, 'task_created', task.id),
        client
    );
    return { status: 'created', review, task };
}

async function createInspectorTask(input) {
    requireCompanyId(input?.companyId);
    inspectorQueries.assertEntityType(input.entityType);
    if (!input.verdict?.needs_attention) {
        throw new Error('Inspector task creation requires an action verdict');
    }
    const client = await db.pool.connect();
    let result;
    try {
        await client.query('BEGIN');
        result = await createTaskInTransaction(input, client);
        await client.query('COMMIT');
    } catch (error) {
        try { await client.query('ROLLBACK'); } catch { /* preserve original error */ }
        throw error;
    } finally {
        client.release();
    }
    if (result.status === 'created') tasksService.emitTaskChange(input.companyId);
    return result;
}

module.exports = {
    createInspectorTask,
    createTaskInTransaction,
    reviewPayload,
};
