'use strict';

const db = require('../db/connection');

async function logFieldUpdate({
    companyId,
    actorId = null,
    actorEmail = null,
    actorIp = null,
    entityType,
    entityId,
    field,
    before,
    after,
    source = 'Codex/Sales MCP',
    requestId = null,
    confirmation = null,
    client = null,
}) {
    const query = client?.query ? client.query.bind(client) : db.query;
    await query(
        `INSERT INTO audit_log
            (actor_id, actor_email, actor_ip, action, target_type, target_id, company_id, details, trace_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9)`,
        [
            actorId,
            actorEmail,
            actorIp || null,
            'crm_field_updated',
            entityType,
            String(entityId),
            companyId,
            JSON.stringify({
                field,
                old_value: before ?? null,
                new_value: after ?? null,
                source,
                request_id: requestId,
                confirmation_id: confirmation?.confirmationId || null,
                confirmation_reason: confirmation?.reason || null,
            }),
            requestId,
        ]
    );
}

async function logWriteAction({
    companyId,
    actorId = null,
    actorEmail = null,
    actorIp = null,
    action,
    entityType,
    entityId,
    details = {},
    source = 'Codex/Sales MCP',
    requestId = null,
    confirmation = null,
    client = null,
}) {
    const query = client?.query ? client.query.bind(client) : db.query;
    await query(
        `INSERT INTO audit_log
            (actor_id, actor_email, actor_ip, action, target_type, target_id, company_id, details, trace_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9)`,
        [
            actorId,
            actorEmail,
            actorIp || null,
            action,
            entityType,
            String(entityId),
            companyId,
            JSON.stringify({
                ...details,
                source,
                request_id: requestId,
                confirmation_id: confirmation?.confirmationId || null,
                confirmation_reason: confirmation?.reason || null,
            }),
            requestId,
        ]
    );
}

module.exports = {
    logFieldUpdate,
    logWriteAction,
};
