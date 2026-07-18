const db = require('../db/connection');

class CallBlacklistError extends Error {
    constructor(message, code, httpStatus) {
        super(message);
        this.name = 'CallBlacklistError';
        this.code = code;
        this.httpStatus = httpStatus;
    }
}

function normalizePhoneNumber(value) {
    if (typeof value !== 'string' && typeof value !== 'number') return null;

    let digits = String(value).replace(/\D/g, '');
    if (digits.length === 11 && digits.startsWith('1')) digits = digits.slice(1);
    if (digits.length !== 10) return null;

    return `+1${digits}`;
}

async function listNumbers(companyId) {
    const { rows } = await db.query(
        `SELECT id, phone_e164, created_at
         FROM telephony_blacklist_numbers
         WHERE company_id = $1
         ORDER BY created_at DESC, id DESC`,
        [companyId]
    );
    return rows;
}

async function addNumber(companyId, phoneNumber, createdBy = null) {
    const phoneE164 = normalizePhoneNumber(phoneNumber);
    if (!phoneE164) {
        throw new CallBlacklistError(
            'Enter a complete 10-digit phone number.',
            'INVALID_PHONE_NUMBER',
            400
        );
    }

    try {
        const { rows } = await db.query(
            `INSERT INTO telephony_blacklist_numbers (company_id, phone_e164, created_by)
             VALUES ($1, $2, $3)
             RETURNING id, phone_e164, created_at`,
            [companyId, phoneE164, createdBy]
        );
        return rows[0];
    } catch (err) {
        if (err.code === '23505') {
            throw new CallBlacklistError(
                'This number is already on the blacklist.',
                'PHONE_ALREADY_BLACKLISTED',
                409
            );
        }
        throw err;
    }
}

async function removeNumber(companyId, id) {
    const { rows } = await db.query(
        `DELETE FROM telephony_blacklist_numbers
         WHERE id = $1 AND company_id = $2
         RETURNING id`,
        [id, companyId]
    );
    return Boolean(rows[0]);
}

async function isBlocked(companyId, phoneNumber) {
    const phoneE164 = normalizePhoneNumber(phoneNumber);
    if (!phoneE164) return false;

    const { rows } = await db.query(
        `SELECT 1
         FROM telephony_blacklist_numbers
         WHERE company_id = $1 AND phone_e164 = $2
         LIMIT 1`,
        [companyId, phoneE164]
    );
    return Boolean(rows[0]);
}

module.exports = {
    CallBlacklistError,
    normalizePhoneNumber,
    listNumbers,
    addNumber,
    removeNumber,
    isBlocked,
};
