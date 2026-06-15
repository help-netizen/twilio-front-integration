/**
 * stripePaymentsQueries.js — DB access for F018 Stripe Payments.
 *
 * Tables: stripe_connected_accounts, stripe_payment_sessions, stripe_webhook_events.
 * SECURITY: every tenant-scoped read/write filters by company_id. Webhook lookups by
 * stripe_account_id return the row WITH its company_id so callers can verify tenant
 * scope before any ledger mutation (never trust event metadata alone).
 */

const db = require('./connection');
const { ensureMarketplaceSchema } = require('./marketplaceQueries');

// ---- connected accounts -----------------------------------------------------

async function getAccountByCompany(companyId) {
    await ensureMarketplaceSchema();
    const { rows } = await db.query(
        `SELECT * FROM stripe_connected_accounts WHERE company_id = $1`,
        [companyId]
    );
    return rows[0] || null;
}

/** Lookup by Stripe account id (webhook path). Returns row incl. company_id. */
async function getAccountByStripeId(stripeAccountId) {
    await ensureMarketplaceSchema();
    const { rows } = await db.query(
        `SELECT * FROM stripe_connected_accounts WHERE stripe_account_id = $1`,
        [stripeAccountId]
    );
    return rows[0] || null;
}

async function insertAccount(companyId, { stripeAccountId, marketplaceInstallationId = null }) {
    await ensureMarketplaceSchema();
    const { rows } = await db.query(
        `INSERT INTO stripe_connected_accounts
            (company_id, stripe_account_id, marketplace_installation_id, status)
         VALUES ($1, $2, $3, 'onboarding_incomplete')
         ON CONFLICT (company_id) DO UPDATE SET stripe_account_id = EXCLUDED.stripe_account_id,
            marketplace_installation_id = COALESCE(EXCLUDED.marketplace_installation_id,
                stripe_connected_accounts.marketplace_installation_id),
            updated_at = NOW()
         RETURNING *`,
        [companyId, stripeAccountId, marketplaceInstallationId]
    );
    return rows[0];
}

async function updateAccountStatus(companyId, fields) {
    await ensureMarketplaceSchema();
    const {
        livemode, charges_enabled, payouts_enabled, details_submitted,
        requirements_currently_due, requirements_past_due, capabilities, status,
    } = fields;
    const { rows } = await db.query(
        `UPDATE stripe_connected_accounts SET
            livemode = COALESCE($2, livemode),
            charges_enabled = COALESCE($3, charges_enabled),
            payouts_enabled = COALESCE($4, payouts_enabled),
            details_submitted = COALESCE($5, details_submitted),
            requirements_currently_due = COALESCE($6, requirements_currently_due),
            requirements_past_due = COALESCE($7, requirements_past_due),
            capabilities = COALESCE($8, capabilities),
            status = COALESCE($9, status),
            updated_at = NOW()
         WHERE company_id = $1
         RETURNING *`,
        [
            companyId,
            livemode ?? null,
            charges_enabled ?? null,
            payouts_enabled ?? null,
            details_submitted ?? null,
            requirements_currently_due ? JSON.stringify(requirements_currently_due) : null,
            requirements_past_due ? JSON.stringify(requirements_past_due) : null,
            capabilities ? JSON.stringify(capabilities) : null,
            status ?? null,
        ]
    );
    return rows[0] || null;
}

async function setAccountStatus(companyId, status) {
    await ensureMarketplaceSchema();
    const { rows } = await db.query(
        `UPDATE stripe_connected_accounts SET status = $2, updated_at = NOW()
         WHERE company_id = $1 RETURNING *`,
        [companyId, status]
    );
    return rows[0] || null;
}

// ---- payment sessions -------------------------------------------------------

/** Find a reusable OPEN, non-expired checkout session for an invoice+amount. */
async function findOpenSession(companyId, invoiceId, amount) {
    await ensureMarketplaceSchema();
    const { rows } = await db.query(
        `SELECT * FROM stripe_payment_sessions
         WHERE company_id = $1 AND invoice_id = $2 AND surface = 'checkout_link'
           AND status = 'open' AND amount = $3
           AND (expires_at IS NULL OR expires_at > NOW())
         ORDER BY created_at DESC LIMIT 1`,
        [companyId, invoiceId, amount]
    );
    return rows[0] || null;
}

async function insertSession(companyId, data) {
    await ensureMarketplaceSchema();
    const {
        invoice_id = null, job_id = null, contact_id = null, created_by = null,
        surface = 'checkout_link', amount, currency = 'USD', status = 'open',
        stripe_checkout_session_id = null, stripe_payment_intent_id = null,
        stripe_charge_id = null, stripe_account_id = null, url = null,
        expires_at = null, metadata = {},
    } = data;
    const { rows } = await db.query(
        `INSERT INTO stripe_payment_sessions
            (company_id, invoice_id, job_id, contact_id, created_by, surface, amount,
             currency, status, stripe_checkout_session_id, stripe_payment_intent_id,
             stripe_charge_id, stripe_account_id, url, expires_at, metadata)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
         RETURNING *`,
        [
            companyId, invoice_id, job_id, contact_id, created_by, surface, amount,
            currency, status, stripe_checkout_session_id, stripe_payment_intent_id,
            stripe_charge_id, stripe_account_id, url, expires_at, JSON.stringify(metadata),
        ]
    );
    return rows[0];
}

async function getSessionByCheckoutId(checkoutSessionId) {
    await ensureMarketplaceSchema();
    const { rows } = await db.query(
        `SELECT * FROM stripe_payment_sessions WHERE stripe_checkout_session_id = $1`,
        [checkoutSessionId]
    );
    return rows[0] || null;
}

async function getSessionByPaymentIntent(paymentIntentId) {
    await ensureMarketplaceSchema();
    const { rows } = await db.query(
        `SELECT * FROM stripe_payment_sessions WHERE stripe_payment_intent_id = $1`,
        [paymentIntentId]
    );
    return rows[0] || null;
}

async function updateSession(id, fields) {
    await ensureMarketplaceSchema();
    const {
        status, stripe_payment_intent_id, stripe_charge_id, failure_reason,
    } = fields;
    const { rows } = await db.query(
        `UPDATE stripe_payment_sessions SET
            status = COALESCE($2, status),
            stripe_payment_intent_id = COALESCE($3, stripe_payment_intent_id),
            stripe_charge_id = COALESCE($4, stripe_charge_id),
            failure_reason = COALESCE($5, failure_reason),
            updated_at = NOW()
         WHERE id = $1 RETURNING *`,
        [id, status ?? null, stripe_payment_intent_id ?? null, stripe_charge_id ?? null, failure_reason ?? null]
    );
    return rows[0] || null;
}

async function listSessionsForInvoice(companyId, invoiceId) {
    await ensureMarketplaceSchema();
    const { rows } = await db.query(
        `SELECT * FROM stripe_payment_sessions
         WHERE company_id = $1 AND invoice_id = $2
         ORDER BY created_at DESC`,
        [companyId, invoiceId]
    );
    return rows;
}

async function getSessionById(companyId, id) {
    await ensureMarketplaceSchema();
    const { rows } = await db.query(
        `SELECT * FROM stripe_payment_sessions WHERE company_id = $1 AND id = $2`,
        [companyId, id]
    );
    return rows[0] || null;
}

// ---- terminal locations -----------------------------------------------------

async function listTerminalLocations(companyId) {
    await ensureMarketplaceSchema();
    const { rows } = await db.query(
        `SELECT * FROM stripe_terminal_locations WHERE company_id = $1 AND status = 'active' ORDER BY created_at`,
        [companyId]
    );
    return rows;
}

async function insertTerminalLocation(companyId, { stripeAccountId, stripeLocationId, displayName, address = {} }) {
    await ensureMarketplaceSchema();
    const { rows } = await db.query(
        `INSERT INTO stripe_terminal_locations (company_id, stripe_account_id, stripe_location_id, display_name, address)
         VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (company_id, stripe_location_id) DO UPDATE SET display_name = EXCLUDED.display_name, updated_at = NOW()
         RETURNING *`,
        [companyId, stripeAccountId, stripeLocationId, displayName || null, JSON.stringify(address)]
    );
    return rows[0];
}

// ---- webhook events (idempotency) -------------------------------------------

/**
 * Insert an incoming event. Returns { inserted: boolean, row }. inserted=false means
 * the event id was already processed (dedup) → caller should ack without reprocessing.
 */
async function insertWebhookEvent({ stripeEventId, livemode, eventType, stripeAccountId, companyId, payload }) {
    await ensureMarketplaceSchema();
    const { rows } = await db.query(
        `INSERT INTO stripe_webhook_events
            (stripe_event_id, livemode, event_type, stripe_account_id, company_id, payload, processing_status)
         VALUES ($1,$2,$3,$4,$5,$6,'received')
         ON CONFLICT (stripe_event_id) DO NOTHING
         RETURNING *`,
        [stripeEventId, Boolean(livemode), eventType, stripeAccountId || null, companyId || null, JSON.stringify(payload || {})]
    );
    return { inserted: rows.length > 0, row: rows[0] || null };
}

async function markWebhookEvent(stripeEventId, processingStatus, { error = null, companyId = null } = {}) {
    await ensureMarketplaceSchema();
    await db.query(
        `UPDATE stripe_webhook_events SET
            processing_status = $2,
            error = $3,
            company_id = COALESCE($4, company_id),
            processed_at = NOW()
         WHERE stripe_event_id = $1`,
        [stripeEventId, processingStatus, error, companyId]
    );
}

module.exports = {
    getAccountByCompany,
    getAccountByStripeId,
    insertAccount,
    updateAccountStatus,
    setAccountStatus,
    findOpenSession,
    insertSession,
    getSessionByCheckoutId,
    getSessionByPaymentIntent,
    getSessionById,
    updateSession,
    listSessionsForInvoice,
    listTerminalLocations,
    insertTerminalLocation,
    insertWebhookEvent,
    markWebhookEvent,
};
