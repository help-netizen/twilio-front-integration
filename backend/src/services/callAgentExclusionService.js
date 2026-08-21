const db = require('../db/connection');
const { normalizePhoneNumber, CallBlacklistError } = require('./callBlacklistService');

// AGENT-EXCLUSION-001: "the voice agent must not answer these callers." Unlike the
// blacklist (which rejects the whole call before routing), an excluded caller still
// gets through — they just skip the assistant and take the human/voicemail path.
class AgentExclusionError extends CallBlacklistError {
    constructor(message, code, httpStatus) {
        super(message, code, httpStatus);
        this.name = 'AgentExclusionError';
    }
}

async function listNumbers(companyId) {
    const { rows } = await db.query(
        `SELECT id, phone_e164, created_at
         FROM telephony_agent_excluded_numbers
         WHERE company_id = $1
         ORDER BY created_at DESC, id DESC`,
        [companyId]
    );
    return rows;
}

async function addNumber(companyId, phoneNumber, createdBy = null) {
    const phoneE164 = normalizePhoneNumber(phoneNumber);
    if (!phoneE164) {
        throw new AgentExclusionError('Enter a complete 10-digit phone number.', 'INVALID_PHONE_NUMBER', 400);
    }
    try {
        const { rows } = await db.query(
            `INSERT INTO telephony_agent_excluded_numbers (company_id, phone_e164, created_by)
             VALUES ($1, $2, $3)
             RETURNING id, phone_e164, created_at`,
            [companyId, phoneE164, createdBy]
        );
        return rows[0];
    } catch (err) {
        if (err.code === '23505') {
            throw new AgentExclusionError('This number is already excluded from the agent.', 'PHONE_ALREADY_EXCLUDED', 409);
        }
        throw err;
    }
}

async function removeNumber(companyId, id) {
    const { rows } = await db.query(
        `DELETE FROM telephony_agent_excluded_numbers
         WHERE id = $1 AND company_id = $2
         RETURNING id`,
        [id, companyId]
    );
    return Boolean(rows[0]);
}

/**
 * True when the voice agent must not answer this caller for this company. The set
 * is the company's manual agent-exclusions UNION its full blacklist (a fully-blocked
 * number is, by definition, also off-limits to the bot — a fail-safe belt so a config
 * gap can never let the bot answer someone the company blocked). `query` is injectable
 * for the call-flow runtime / tests. Tenant-scoped by company_id.
 */
async function isExcludedForAgent(companyId, phoneNumber, query = db.query) {
    const phoneE164 = normalizePhoneNumber(phoneNumber);
    if (!phoneE164 || !companyId) return false;
    const { rows } = await query(
        `SELECT 1 FROM telephony_agent_excluded_numbers
          WHERE company_id = $1 AND phone_e164 = $2
         UNION ALL
         SELECT 1 FROM telephony_blacklist_numbers
          WHERE company_id = $1 AND phone_e164 = $2
         LIMIT 1`,
        [companyId, phoneE164]
    );
    return Boolean(rows[0]);
}

module.exports = {
    AgentExclusionError,
    normalizePhoneNumber,
    listNumbers,
    addNumber,
    removeNumber,
    isExcludedForAgent,
};
