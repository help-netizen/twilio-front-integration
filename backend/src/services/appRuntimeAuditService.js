'use strict';

const crypto = require('node:crypto');
const db = require('../db/connection');
const catalog = require('./appRuntimeToolCatalog');

const KNOWN_TOOLS = new Set(catalog.TOOL_NAMES);

function safeToolIdentity(toolName) {
    const normalized = typeof toolName === 'string' ? toolName : '';
    if (KNOWN_TOOLS.has(normalized)) {
        return { targetId: normalized, unknownTool: false };
    }
    const digest = crypto.createHash('sha256').update(normalized, 'utf8').digest('hex');
    return { targetId: `unknown:${digest.slice(0, 24)}`, unknownTool: true };
}

async function recordToolCall(context, {
    toolName,
    outcome,
    errorCode = null,
    httpStatus,
    callOrdinal,
    requestId,
}) {
    const toolIdentity = safeToolIdentity(toolName);
    const details = {
        version_id: String(context.version_id),
        outcome,
        error_code: errorCode,
        response_class: `${Math.floor(Number(httpStatus) / 100)}xx`,
        run_call_ordinal: Number(callOrdinal),
        unknown_tool: toolIdentity.unknownTool,
    };
    const { rows } = await db.query(
        `INSERT INTO audit_log
            (actor_id, actor_email, action, target_type, target_id, company_id,
             details, trace_id, app_id, installation_id, app_run_id)
         VALUES ($1, NULL, 'app_runtime.tool_call', 'app_runtime_tool', $2, $3,
                 $4::jsonb, $5, $6, $7, $8)
         RETURNING id`,
        [
            context.agent_user_id,
            toolIdentity.targetId,
            context.company_id,
            JSON.stringify(details),
            String(requestId || '').slice(0, 64) || null,
            context.app_id,
            context.installation_id,
            context.run_id,
        ]
    );
    if (rows.length !== 1) throw new Error('App runtime audit insert failed');
    return rows[0];
}

async function recordRunAuthorization(context, {
    outcome,
    errorCode = null,
    httpStatus,
    requestId,
}) {
    const details = {
        version_id: String(context.version_id),
        source_sha256: String(context.artifact_sha256),
        outcome,
        error_code: errorCode,
        response_class: `${Math.floor(Number(httpStatus) / 100)}xx`,
    };
    const { rows } = await db.query(
        `INSERT INTO audit_log
            (actor_id, actor_email, action, target_type, target_id, company_id,
             details, trace_id, app_id, installation_id, app_run_id)
         VALUES ($1, NULL, 'app_runtime.execution_authorization', 'app_runtime_run',
                 $2, $3, $4::jsonb, $5, $6, $7, $8)
         RETURNING id`,
        [
            context.agent_user_id,
            String(context.run_id),
            context.company_id,
            JSON.stringify(details),
            String(requestId || '').slice(0, 64) || null,
            context.app_id,
            context.installation_id,
            context.run_id,
        ]
    );
    if (rows.length !== 1) throw new Error('App runtime authorization audit insert failed');
    return rows[0];
}

module.exports = {
    recordToolCall,
    recordRunAuthorization,
    safeToolIdentity,
};
