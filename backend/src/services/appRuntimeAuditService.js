'use strict';

const db = require('../db/connection');

async function recordToolCall(context, {
    toolName,
    outcome,
    errorCode = null,
    httpStatus,
    callOrdinal,
    requestId,
}) {
    const details = {
        version_id: String(context.version_id),
        outcome,
        error_code: errorCode,
        response_class: `${Math.floor(Number(httpStatus) / 100)}xx`,
        run_call_ordinal: Number(callOrdinal),
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
            String(toolName || '').slice(0, 255),
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

module.exports = {
    recordToolCall,
};
