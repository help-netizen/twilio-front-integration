'use strict';

const { logActivity } = require('./activityLogService');

const ENTITY_TYPES = new Set(['job', 'contact', 'payment']);

function integrationActor(source = 'sync') {
    return {
        id: null,
        type: 'integration',
        label: 'Zenbooker',
        source,
    };
}

function validateEvent(companyId, entityType) {
    if (!companyId) throw new Error('[ZenbookerActivity] companyId is required');
    if (!ENTITY_TYPES.has(entityType)) {
        throw new Error('[ZenbookerActivity] entityType must be job, contact, or payment');
    }
}

async function logZenbookerBatch({
    companyId,
    entityType,
    summary = {},
}) {
    validateEvent(companyId, entityType);
    const actor = integrationActor('sync');
    return logActivity({
        action: `${entityType}.sync_completed`,
        target_type: 'company',
        target_id: companyId,
        company_id: companyId,
        actor_id: null,
        details: {
            actor_type: actor.type,
            actor_label: actor.label,
            source: actor.source,
            parent_type: null,
            parent_id: null,
            summary,
        },
    });
}

async function logZenbookerEntity({
    companyId,
    entityType,
    entityId,
    summary = {},
}) {
    validateEvent(companyId, entityType);
    if (entityId === null || entityId === undefined || String(entityId).trim() === '') {
        throw new Error(`[ZenbookerActivity] ${entityType} entityId is required`);
    }
    const actor = integrationActor('webhook');
    return logActivity({
        action: `${entityType}.synced`,
        target_type: entityType,
        target_id: String(entityId),
        company_id: companyId,
        actor_id: null,
        details: {
            actor_type: actor.type,
            actor_label: actor.label,
            source: actor.source,
            parent_type: null,
            parent_id: null,
            summary,
        },
    });
}

module.exports = {
    integrationActor,
    logZenbookerBatch,
    logZenbookerEntity,
};

