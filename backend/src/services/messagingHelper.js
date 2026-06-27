// =============================================================================
// messagingHelper — shared outbound-SMS sender resolution.
//
// Extracted verbatim from backend/src/routes/jobs.js (ONWAY-001) so the SMS
// dispatch services (SD-5/SD-6) can resolve the same company proxy DID the
// "On the way" notify handler uses, without duplicating the lookup.
// =============================================================================

const db = require('../db/connection');
const { toE164 } = require('../utils/phoneUtils');

/**
 * Resolve the company's outbound sending DID (E.164).
 *  1. MRU of recent SMS conversations for this company (proven pulse query).
 *  2. Fallback to process.env.SOFTPHONE_CALLER_ID.
 *  3. Neither → null (caller returns 422 NO_PROXY).
 */
async function resolveCompanyProxyE164(companyId) {
    if (companyId) {
        const { rows } = await db.query(
            `SELECT proxy_e164 FROM sms_conversations
             WHERE company_id = $1 AND proxy_e164 IS NOT NULL
             ORDER BY last_message_at DESC NULLS LAST
             LIMIT 1`,
            [companyId]
        );
        if (rows[0]?.proxy_e164) return toE164(rows[0].proxy_e164) || rows[0].proxy_e164;
    }
    const envDid = process.env.SOFTPHONE_CALLER_ID;
    return envDid ? (toE164(envDid) || envDid) : null;
}

module.exports = { resolveCompanyProxyE164 };
