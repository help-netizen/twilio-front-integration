'use strict';

const db = require('../db/connection');

function looksLikeOutbound(call) {
    const values = call?.assistantOverrides?.variableValues;
    return Boolean(
        call?.id &&
        values &&
        (values.scenario || values.jobId || values.leadUuid),
    );
}

/**
 * Resolve an outbound call's authoritative tenant and repair subject from the
 * stored attempt. `vapi_call_id` is an external natural key, so a collision
 * spanning companies fails closed rather than selecting one row.
 */
async function resolve(call) {
    if (!looksLikeOutbound(call)) return { matched: false, ambiguous: false };
    try {
        const { rows } = await db.query(
            `SELECT DISTINCT ON (company_id)
                    company_id, job_id, lead_uuid, contact_id, phone, scenario
             FROM outbound_call_attempts
             WHERE vapi_call_id = $1
             ORDER BY company_id, id DESC`,
            [call.id],
        );
        if (!Array.isArray(rows) || rows.length === 0) {
            return { matched: false, ambiguous: false };
        }
        const companies = new Set(rows.map((row) => String(row.company_id)));
        if (companies.size !== 1) {
            return { matched: false, ambiguous: true };
        }
        const attempt = rows[0];
        return {
            matched: true,
            ambiguous: false,
            companyId: attempt.company_id,
            values: {
                companyId: attempt.company_id,
                ...(attempt.job_id != null ? { jobId: attempt.job_id } : {}),
                ...(attempt.lead_uuid ? { leadUuid: attempt.lead_uuid } : {}),
                ...(attempt.contact_id != null ? { contactId: attempt.contact_id } : {}),
                ...(attempt.phone ? { phone: attempt.phone } : {}),
                ...(attempt.scenario ? { scenario: attempt.scenario } : {}),
            },
        };
    } catch (err) {
        // Existing outbound booking flows retain their server-injected variable
        // fallback if the correlation read is temporarily unavailable.
        console.error(
            `[vapi-tools] outbound context lookup failed: ${err && err.message ? err.message : 'unknown error'}`,
        );
        return { matched: false, ambiguous: false };
    }
}

module.exports = {
    looksLikeOutbound,
    resolve,
};
