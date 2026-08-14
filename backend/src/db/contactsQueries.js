/**
 * Contacts Query Module
 * Extracted from queries.js — RF006
 *
 * Covers: contact CRUD, unread state, phone lookup
 */
const db = require('./connection');
const { toE164 } = require('../utils/phoneUtils');
const { requireCompanyId } = require('../utils/tenantContext');

// =============================================================================
// Contact operations
// =============================================================================

// Phone lookups are tenant-scoped (PF007-HARDENING-001): a phone match must
// never resolve to another company's contact.
async function findContactByPhone(phoneE164, companyId) {
    const cid = requireCompanyId(companyId);
    const digits = phoneE164.replace(/\D/g, '');
    const result = await db.query(
        `SELECT * FROM contacts
         WHERE regexp_replace(phone_e164, '\\D', '', 'g') = $1 AND company_id = $2
         LIMIT 1`,
        [digits, cid]
    );
    return result.rows[0];
}

async function createContact(phoneE164, fullName, companyId) {
    const cid = requireCompanyId(companyId);
    const normalized = toE164(phoneE164) || phoneE164;
    const result = await db.query(
        `INSERT INTO contacts (phone_e164, full_name, company_id)
         VALUES ($1, $2, $3)
         RETURNING *`,
        [normalized, fullName || normalized, cid]
    );
    return result.rows[0];
}

async function findOrCreateContact(phoneE164, fullName, companyId) {
    const cid = requireCompanyId(companyId);
    let contact = await findContactByPhone(phoneE164, cid);
    if (!contact) {
        contact = await createContact(phoneE164, fullName, cid);
    }
    return contact;
}

async function findContactByPhoneOrSecondary(phoneE164, companyId) {
    const cid = requireCompanyId(companyId);
    const digits = phoneE164.replace(/\D/g, '');
    let result = await db.query(
        `SELECT * FROM contacts
         WHERE regexp_replace(phone_e164, '\\D', '', 'g') = $1 AND company_id = $2
         LIMIT 1`,
        [digits, cid]
    );
    if (result.rows[0]) return result.rows[0];

    result = await db.query(
        `SELECT * FROM contacts
         WHERE regexp_replace(secondary_phone, '\\D', '', 'g') = $1 AND company_id = $2
         LIMIT 1`,
        [digits, cid]
    );
    return result.rows[0] || null;
}

// =============================================================================
// Contact unread state
// =============================================================================

async function markContactUnread(contactId, eventTime = new Date()) {
    const result = await db.query(
        `UPDATE contacts SET
            has_unread = true,
            last_incoming_event_at = GREATEST(last_incoming_event_at, $2),
            updated_at = now()
         WHERE id = $1
         RETURNING *`,
        [contactId, eventTime]
    );
    return result.rows[0] || null;
}

async function markContactRead(contactId) {
    const result = await db.query(
        `UPDATE contacts SET
            has_unread = false,
            last_read_at = now(),
            updated_at = now()
         WHERE id = $1
         RETURNING *`,
        [contactId]
    );
    return result.rows[0] || null;
}

// =============================================================================
// Exports
// =============================================================================

module.exports = {
    findContactByPhone,
    createContact,
    findOrCreateContact,
    findContactByPhoneOrSecondary,
    markContactUnread,
    markContactRead,
};
