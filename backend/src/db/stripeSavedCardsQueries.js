'use strict';

const db = require('./connection');

const TTL_SQL = `saved_at > NOW() - INTERVAL '14 days' AND expires_at > NOW()`;
const CARD_NOT_EXPIRED_SQL = `(
    exp_year > EXTRACT(YEAR FROM CURRENT_DATE)::int
    OR (
        exp_year = EXTRACT(YEAR FROM CURRENT_DATE)::int
        AND exp_month >= EXTRACT(MONTH FROM CURRENT_DATE)::int
    )
)`;
const USABLE_SQL = `${TTL_SQL} AND ${CARD_NOT_EXPIRED_SQL}`;

function queryFor(client = null) {
    return client?.query ? client.query.bind(client) : db.query;
}

async function lockContact(companyId, contactId, client) {
    await queryFor(client)(
        `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`,
        [`stripe-contact:${companyId}:${contactId}`]
    );
}

async function getContactCustomer(companyId, contactId, client = null) {
    const { rows } = await queryFor(client)(
        `SELECT * FROM stripe_contact_customers
         WHERE company_id = $1 AND contact_id = $2`,
        [companyId, contactId]
    );
    return rows[0] || null;
}

async function upsertContactCustomer(
    companyId,
    contactId,
    stripeAccountId,
    stripeCustomerId,
    client = null
) {
    const query = queryFor(client);
    const { rows } = await query(
        `INSERT INTO stripe_contact_customers
            (company_id, contact_id, stripe_account_id, stripe_customer_id)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (company_id, contact_id) DO UPDATE SET
            stripe_account_id = EXCLUDED.stripe_account_id,
            stripe_customer_id = EXCLUDED.stripe_customer_id,
            updated_at = NOW()
         RETURNING *`,
        [companyId, contactId, stripeAccountId, stripeCustomerId]
    );
    return rows[0];
}

async function upsertSavedCard(companyId, data, client = null) {
    const { rows } = await queryFor(client)(
        `INSERT INTO stripe_saved_payment_methods (
            company_id, contact_id, stripe_contact_customer_id,
            stripe_account_id, stripe_customer_id, stripe_payment_method_id,
            brand, last4, exp_month, exp_year, saved_at, expires_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NOW(),NOW() + INTERVAL '14 days')
         ON CONFLICT (company_id, stripe_account_id, stripe_payment_method_id)
         DO UPDATE SET
            contact_id = EXCLUDED.contact_id,
            stripe_contact_customer_id = EXCLUDED.stripe_contact_customer_id,
            stripe_customer_id = EXCLUDED.stripe_customer_id,
            brand = EXCLUDED.brand,
            last4 = EXCLUDED.last4,
            exp_month = EXCLUDED.exp_month,
            exp_year = EXCLUDED.exp_year,
            last_used_at = NULL,
            removed_at = NULL,
            removed_by = NULL,
            updated_at = NOW()
         RETURNING *`,
        [
            companyId,
            data.contactId,
            data.contactCustomerId,
            data.stripeAccountId,
            data.stripeCustomerId,
            data.stripePaymentMethodId,
            data.brand,
            data.last4,
            data.expMonth,
            data.expYear,
        ]
    );
    return rows[0];
}

const DISPLAY_COLUMNS = `
    id, brand, last4, exp_month, exp_year, saved_at, expires_at,
    GREATEST(0, CEIL(EXTRACT(EPOCH FROM (
        LEAST(expires_at, saved_at + INTERVAL '14 days') - NOW()
    )) / 86400.0))::int
        AS days_remaining`;

async function listContactCards(companyId, contactId, stripeAccountId, client = null) {
    const { rows } = await queryFor(client)(
        `SELECT ${DISPLAY_COLUMNS}, (${USABLE_SQL}) AS usable
         FROM stripe_saved_payment_methods
         WHERE company_id = $1 AND contact_id = $2 AND stripe_account_id = $3
           AND removed_at IS NULL
         ORDER BY saved_at DESC, id DESC`,
        [companyId, contactId, stripeAccountId]
    );
    return rows;
}

async function listUsableContactCards(companyId, contactId, stripeAccountId, client = null) {
    const { rows } = await queryFor(client)(
        `SELECT ${DISPLAY_COLUMNS}, true AS usable
         FROM stripe_saved_payment_methods
         WHERE company_id = $1 AND contact_id = $2 AND stripe_account_id = $3
           AND removed_at IS NULL AND ${USABLE_SQL}
         ORDER BY saved_at DESC, id DESC`,
        [companyId, contactId, stripeAccountId]
    );
    return rows;
}

async function getUsableCard(companyId, contactId, stripeAccountId, cardId, client = null) {
    const { rows } = await queryFor(client)(
        `SELECT * FROM stripe_saved_payment_methods
         WHERE company_id = $1 AND contact_id = $2 AND stripe_account_id = $3
           AND id = $4 AND removed_at IS NULL AND ${USABLE_SQL}`,
        [companyId, contactId, stripeAccountId, cardId]
    );
    return rows[0] || null;
}

async function getOwnedCard(companyId, contactId, cardId, client = null) {
    const { rows } = await queryFor(client)(
        `SELECT * FROM stripe_saved_payment_methods
         WHERE company_id = $1 AND contact_id = $2 AND id = $3
           AND removed_at IS NULL`,
        [companyId, contactId, cardId]
    );
    return rows[0] || null;
}

async function deleteOwnedCard(companyId, contactId, cardId, client = null) {
    const { rows } = await queryFor(client)(
        `DELETE FROM stripe_saved_payment_methods
         WHERE company_id = $1 AND contact_id = $2 AND id = $3
         RETURNING id`,
        [companyId, contactId, cardId]
    );
    return rows[0] || null;
}

async function markCardUsed(companyId, cardId, client = null) {
    const { rows } = await queryFor(client)(
        `UPDATE stripe_saved_payment_methods
         SET last_used_at = NOW(), updated_at = NOW()
         WHERE company_id = $1 AND id = $2 AND removed_at IS NULL
           AND ${USABLE_SQL}
         RETURNING *`,
        [companyId, cardId]
    );
    return rows[0] || null;
}

async function listExpiredCompanyIds(limit = 100) {
    const { rows } = await db.query(
        `SELECT DISTINCT company_id
         FROM stripe_saved_payment_methods
         WHERE removed_at IS NULL
           AND (saved_at <= NOW() - INTERVAL '14 days' OR expires_at <= NOW())
         ORDER BY company_id
         LIMIT $1`,
        [limit]
    );
    return rows.map(row => row.company_id);
}

async function listExpiredCards(companyId, limit = 100, client = null) {
    const { rows } = await queryFor(client)(
        `SELECT * FROM stripe_saved_payment_methods
         WHERE company_id = $1 AND removed_at IS NULL
           AND (saved_at <= NOW() - INTERVAL '14 days' OR expires_at <= NOW())
         ORDER BY expires_at, id
         LIMIT $2`,
        [companyId, limit]
    );
    return rows;
}

async function deleteExpiredCard(companyId, cardId, client = null) {
    const { rows } = await queryFor(client)(
        `DELETE FROM stripe_saved_payment_methods
         WHERE company_id = $1 AND id = $2
           AND (saved_at <= NOW() - INTERVAL '14 days' OR expires_at <= NOW())
         RETURNING id`,
        [companyId, cardId]
    );
    return rows[0] || null;
}

module.exports = {
    TTL_SQL,
    CARD_NOT_EXPIRED_SQL,
    USABLE_SQL,
    lockContact,
    getContactCustomer,
    upsertContactCustomer,
    upsertSavedCard,
    listContactCards,
    listUsableContactCards,
    getUsableCard,
    getOwnedCard,
    deleteOwnedCard,
    markCardUsed,
    listExpiredCompanyIds,
    listExpiredCards,
    deleteExpiredCard,
};
