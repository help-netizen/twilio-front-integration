/**
 * Contacts Query Module
 * Extracted from queries.js — RF006
 *
 * Covers: contact CRUD, unread state, phone lookup
 */
const db = require('./connection');
const { toE164 } = require('../utils/phoneUtils');

const DEFAULT_COMPANY_ID = '00000000-0000-0000-0000-000000000001';

// =============================================================================
// Contact operations
// =============================================================================

async function findContactByPhone(phoneE164) {
    const digits = phoneE164.replace(/\D/g, '');
    const result = await db.query(
        `SELECT * FROM contacts WHERE regexp_replace(phone_e164, '\\D', '', 'g') = $1 LIMIT 1`,
        [digits]
    );
    return result.rows[0];
}

async function createContact(phoneE164, fullName = null, companyId = null) {
    const normalized = toE164(phoneE164) || phoneE164;
    const result = await db.query(
        `INSERT INTO contacts (phone_e164, full_name, company_id)
         VALUES ($1, $2, $3)
         RETURNING *`,
        [normalized, fullName || normalized, companyId || DEFAULT_COMPANY_ID]
    );
    return result.rows[0];
}

async function findOrCreateContact(phoneE164, fullName = null) {
    let contact = await findContactByPhone(phoneE164);
    if (!contact) {
        contact = await createContact(phoneE164, fullName);
    }
    return contact;
}

async function findContactByPhoneOrSecondary(phoneE164) {
    const digits = phoneE164.replace(/\D/g, '');
    let result = await db.query(
        `SELECT * FROM contacts WHERE regexp_replace(phone_e164, '\\D', '', 'g') = $1 LIMIT 1`,
        [digits]
    );
    if (result.rows[0]) return result.rows[0];

    result = await db.query(
        `SELECT * FROM contacts WHERE regexp_replace(secondary_phone, '\\D', '', 'g') = $1 LIMIT 1`,
        [digits]
    );
    return result.rows[0] || null;
}

// =============================================================================
// Contact unread state
// =============================================================================

async function markContactUnread(contactId, eventTime = new Date()) {
    console.log(`[UNREAD-TRACE] markContactUnread called for contact ${contactId}`, new Error().stack?.split('\n').slice(1, 4).join(' <- '));
    const result = await db.query(
        `UPDATE contacts SET
            has_unread = true,
            last_incoming_event_at = GREATEST(last_incoming_event_at, $2),
            updated_at = now()
         WHERE id = $1
         RETURNING *`,
        [contactId, eventTime]
    );
    console.log(`[UNREAD-TRACE] markContactUnread result: has_unread=${result.rows[0]?.has_unread}`);
    return result.rows[0] || null;
}

async function markContactRead(contactId) {
    console.log(`[UNREAD-TRACE] markContactRead called for contact ${contactId}`, new Error().stack?.split('\n').slice(1, 4).join(' <- '));
    const result = await db.query(
        `UPDATE contacts SET
            has_unread = false,
            last_read_at = now(),
            updated_at = now()
         WHERE id = $1
         RETURNING *`,
        [contactId]
    );
    console.log(`[UNREAD-TRACE] markContactRead result: has_unread=${result.rows[0]?.has_unread}`);
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
