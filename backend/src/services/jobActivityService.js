'use strict';

const { logActivity } = require('./activityLogService');
const { withTransaction } = require('./transactionService');

function userActor(id, source = 'crm') {
    return { id: id || null, type: 'user', label: null, source };
}

function aiActor(label = 'AI Phone', source = 'agent') {
    return { id: null, type: 'ai', label, source };
}

function systemActor(label = 'Automation', source = 'crm') {
    return { id: null, type: 'system', label, source };
}

async function logWithClient({
    companyId,
    action,
    jobId,
    actor,
    summary,
}, client) {
    if (!client?.query) {
        throw new Error('[JobActivity] transaction client is required');
    }
    if (!companyId) {
        throw new Error('[JobActivity] companyId is required');
    }
    if (!jobId) {
        throw new Error('[JobActivity] jobId is required');
    }
    if (!actor?.type) {
        throw new Error('[JobActivity] actor is required');
    }

    return logActivity({
        action,
        target_type: 'job',
        target_id: String(jobId),
        company_id: companyId,
        actor_id: actor.type === 'user' ? actor.id : null,
        details: {
            actor_type: actor.type,
            actor_label: actor.type === 'user' ? null : actor.label,
            source: actor.source,
            parent_type: null,
            parent_id: null,
            ...(summary && Object.keys(summary).length > 0 ? { summary } : {}),
        },
    }, { client });
}

async function logJobActivity(event, { client } = {}) {
    if (client) return logWithClient(event, client);
    return withTransaction(tx => logWithClient(event, tx));
}

module.exports = {
    aiActor,
    logJobActivity,
    systemActor,
    userActor,
};
