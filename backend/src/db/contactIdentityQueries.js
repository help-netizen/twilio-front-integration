/**
 * ZB-DECOUPLE-001 Phase B / B1 — tenant-scoped contact identity primitives.
 * Every database operation binds company_id first and validates contact ownership
 * before inserting a mapping or phone.
 */
const db = require('./connection');

function queryFor(client) {
    return client?.query ? client.query.bind(client) : db.query;
}

function normalizePhone(raw) {
    if (raw === null || raw === undefined) return null;
    const digits = String(raw).replace(/[^0-9]/g, '');
    return digits.length >= 10 ? digits.slice(-10) : null;
}

async function upsertExternalIdentity({ companyId, source, externalId, contactId, client = db }) {
    const query = queryFor(client);
    const { rows } = await query(
        `INSERT INTO contact_external_identities
            (company_id, source, external_id, contact_id)
         SELECT $1, $2, $3, c.id
         FROM contacts c
         WHERE c.company_id = $1 AND c.id = $4
         ON CONFLICT (company_id, source, external_id) DO NOTHING
         RETURNING company_id, source, external_id, contact_id, created_at`,
        [companyId, source, externalId, contactId]
    );
    if (rows[0]) return rows[0];

    const existing = await query(
        `SELECT identity.company_id, identity.source, identity.external_id,
                identity.contact_id, identity.created_at
         FROM contact_external_identities identity
         JOIN contacts contact
           ON contact.id = identity.contact_id
          AND contact.company_id = identity.company_id
         WHERE identity.company_id = $1
           AND identity.source = $2
           AND identity.external_id = $3`,
        [companyId, source, externalId]
    );
    return existing.rows[0] || null;
}

async function resolveExternalToContact(companyId, source, externalId, client = db) {
    const { rows } = await queryFor(client)(
        `SELECT identity.contact_id
         FROM contact_external_identities identity
         JOIN contacts contact
           ON contact.id = identity.contact_id
          AND contact.company_id = identity.company_id
         WHERE identity.company_id = $1
           AND identity.source = $2
           AND identity.external_id = $3`,
        [companyId, source, externalId]
    );
    return rows[0] ? rows[0].contact_id : null;
}

async function resolveContactToExternal(companyId, source, contactId, client = db) {
    const { rows } = await queryFor(client)(
        `SELECT identity.external_id
         FROM contact_external_identities identity
         JOIN contacts contact
           ON contact.id = identity.contact_id
          AND contact.company_id = identity.company_id
         WHERE identity.company_id = $1
           AND identity.source = $2
           AND identity.contact_id = $3
         ORDER BY identity.created_at ASC, identity.external_id ASC
         LIMIT 1`,
        [companyId, source, contactId]
    );
    return rows[0] ? rows[0].external_id : null;
}

async function findContactIdsByNormalizedPhone(
    companyId,
    normalizedPhone,
    { includeShared = false, client = db } = {}
) {
    const normalized = normalizePhone(normalizedPhone);
    if (!normalized) return [];

    const sharedClause = includeShared ? '' : 'AND phone.is_shared = FALSE';
    const { rows } = await queryFor(client)(
        `SELECT DISTINCT phone.contact_id
         FROM contact_phones phone
         JOIN contacts contact
           ON contact.id = phone.contact_id
          AND contact.company_id = phone.company_id
         WHERE phone.company_id = $1
           AND phone.normalized_phone = $2
           AND contact.deleted_at IS NULL
           ${sharedClause}
         ORDER BY phone.contact_id ASC`,
        [companyId, normalized]
    );
    return rows.map(row => row.contact_id);
}

async function listPhonesForContact(companyId, contactId, client = db) {
    const { rows } = await queryFor(client)(
        `SELECT id, company_id, contact_id, phone_e164, normalized_phone,
                label, is_primary, is_shared, created_at
         FROM contact_phones
         WHERE company_id = $1 AND contact_id = $2
         ORDER BY is_primary DESC, id ASC`,
        [companyId, contactId]
    );
    return rows;
}

async function upsertContactPhone({
    companyId,
    contactId,
    phoneE164,
    label = null,
    isPrimary = false,
    isShared = false,
    client = db,
}) {
    const normalizedPhone = normalizePhone(phoneE164);
    if (!normalizedPhone) return null;

    const { rows } = await queryFor(client)(
        `WITH owned_contact AS (
             SELECT id
             FROM contacts
             WHERE company_id = $1 AND id = $2
         ), inserted AS (
             INSERT INTO contact_phones
                 (company_id, contact_id, phone_e164, normalized_phone, label, is_primary, is_shared)
             SELECT $1, owned_contact.id, $3, $4, $5, $6, $7
             FROM owned_contact
             WHERE NOT EXISTS (
                 SELECT 1
                 FROM contact_phones existing
                 WHERE existing.company_id = $1
                   AND existing.contact_id = owned_contact.id
                   AND existing.normalized_phone = $4
             )
             RETURNING id, company_id, contact_id, phone_e164, normalized_phone,
                       label, is_primary, is_shared, created_at
         )
         SELECT * FROM inserted
         UNION ALL
         SELECT existing.id, existing.company_id, existing.contact_id,
                existing.phone_e164, existing.normalized_phone, existing.label,
                existing.is_primary, existing.is_shared, existing.created_at
         FROM contact_phones existing
         JOIN owned_contact ON owned_contact.id = existing.contact_id
         WHERE existing.company_id = $1
           AND existing.normalized_phone = $4
           AND NOT EXISTS (SELECT 1 FROM inserted)
         ORDER BY id ASC
         LIMIT 1`,
        [companyId, contactId, String(phoneE164).trim(), normalizedPhone, label, isPrimary, isShared]
    );
    return rows[0] || null;
}

async function markPhoneShared(companyId, normalizedPhone, isShared, client = db) {
    const normalized = normalizePhone(normalizedPhone);
    if (!normalized) return [];

    const { rows } = await queryFor(client)(
        `UPDATE contact_phones phone
         SET is_shared = $3
         FROM contacts contact
         WHERE phone.company_id = $1
           AND phone.normalized_phone = $2
           AND contact.id = phone.contact_id
           AND contact.company_id = phone.company_id
         RETURNING phone.id, phone.company_id, phone.contact_id, phone.phone_e164,
                   phone.normalized_phone, phone.label, phone.is_primary,
                   phone.is_shared, phone.created_at`,
        [companyId, normalized, isShared]
    );
    return rows;
}

module.exports = {
    normalizePhone,
    upsertExternalIdentity,
    resolveExternalToContact,
    resolveContactToExternal,
    findContactIdsByNormalizedPhone,
    listPhonesForContact,
    upsertContactPhone,
    markPhoneShared,
};
