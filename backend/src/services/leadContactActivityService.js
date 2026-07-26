'use strict';

const { logActivity } = require('./activityLogService');
const { withTransaction } = require('./transactionService');

const ENTITY_TYPES = new Set(['lead', 'contact']);

function userActor(id, source = 'crm') {
    return { id: id || null, type: 'user', label: null, source };
}

function nonUserActor(type, label, source) {
    return { id: null, type, label, source };
}

function aiActor(label = 'Avatar', source = 'mcp') {
    return nonUserActor('ai', label, source);
}

function clientActor(label = 'Client', source = 'portal') {
    return nonUserActor('client', label, source);
}

function integrationActor(label, source = 'crm') {
    return nonUserActor('integration', label, source);
}

function systemActor(label = 'Automation', source = 'crm') {
    return nonUserActor('system', label, source);
}

async function logWithClient({
    companyId,
    entityType,
    action,
    entityId,
    actor,
    summary,
}, client) {
    if (!client?.query) {
        throw new Error('[LeadContactActivity] transaction client is required');
    }
    if (!companyId) {
        throw new Error('[LeadContactActivity] companyId is required');
    }
    if (!ENTITY_TYPES.has(entityType)) {
        throw new Error('[LeadContactActivity] entityType must be lead or contact');
    }
    if (entityId === null || entityId === undefined || String(entityId).trim() === '') {
        throw new Error(`[LeadContactActivity] ${entityType} target id is required`);
    }
    if (!actor?.type) {
        throw new Error('[LeadContactActivity] actor is required');
    }

    return logActivity({
        action,
        target_type: entityType,
        target_id: String(entityId),
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

async function logLeadContactActivity(event, { client } = {}) {
    if (client) return logWithClient(event, client);
    return withTransaction(tx => logWithClient(event, tx));
}

module.exports = {
    aiActor,
    clientActor,
    integrationActor,
    logLeadContactActivity,
    systemActor,
    userActor,
};
