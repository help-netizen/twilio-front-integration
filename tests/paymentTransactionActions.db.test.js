'use strict';

/**
 * JOBPANEL-REWORK-001 — real PostgreSQL coverage for the transaction action
 * projection and the receipt-email ownership boundary.
 */

const { randomUUID } = require('crypto');
const db = require('../backend/src/db/connection');
const paymentsQueries = require('../backend/src/db/paymentsQueries');
const paymentsService = require('../backend/src/services/paymentsService');
const { clientActor } = require('../backend/src/services/financialActivityService');

jest.setTimeout(60000);

const TAG = `PTRA-${Date.now().toString(36)}-${process.pid}`;

let client;
let originalQuery;
let companyA;
let companyB;
let contactA;
let contactB;

beforeAll(async () => {
    originalQuery = db.query;
    client = await db.pool.connect();
    await client.query('BEGIN');
    db.query = (text, params) => client.query(text, params);

    companyA = randomUUID();
    companyB = randomUUID();
    await db.query(
        `INSERT INTO companies (id, name, slug)
         VALUES ($1, $2, $3), ($4, $5, $6)`,
        [
            companyA, `${TAG} Company A`, `${TAG.toLowerCase()}-a`,
            companyB, `${TAG} Company B`, `${TAG.toLowerCase()}-b`,
        ]
    );
    await db.query(
        `INSERT INTO stripe_connected_accounts (
            company_id, stripe_account_id, livemode
         ) VALUES ($1, $2, true)`,
        [companyA, `acct_${TAG}`]
    );
    const { rows: contacts } = await db.query(
        `INSERT INTO contacts (company_id, full_name)
         VALUES ($1, $3), ($2, $4)
         RETURNING id, company_id`,
        [companyA, companyB, `${TAG} Contact A`, `${TAG} Contact B`]
    );
    contactA = contacts.find(row => row.company_id === companyA).id;
    contactB = contacts.find(row => row.company_id === companyB).id;
});

afterAll(async () => {
    db.query = originalQuery;
    if (client) {
        try {
            await client.query('ROLLBACK');
        } finally {
            client.release();
        }
    }
    await db.pool.end();
});

async function insertTransaction({
    method,
    source,
    externalId,
    metadata = {},
}) {
    const { rows } = await db.query(
        `INSERT INTO payment_transactions (
            company_id, transaction_type, payment_method, status,
            amount, currency, external_source, external_id, metadata,
            processed_at
         ) VALUES (
            $1, 'payment', $2, 'completed',
            95, 'USD', $3, $4, $5::jsonb, NOW()
         )
         RETURNING *`,
        [companyA, method, source, externalId, JSON.stringify(metadata)]
    );
    return rows[0];
}

async function insertSession({ paymentIntentId, chargeId }) {
    await db.query(
        `INSERT INTO stripe_payment_sessions (
            company_id, surface, amount, status,
            stripe_payment_intent_id, stripe_charge_id, stripe_account_id
         ) VALUES (
            $1, 'manual_card', 95, 'complete', $2, $3, $4
         )`,
        [companyA, paymentIntentId, chargeId, `acct_${TAG}`]
    );
}

describe('transaction action tenant and card-only contract', () => {
    test('payment write and activity row roll back atomically on the shared client', async () => {
        const reference = `${TAG}-atomic`;
        await client.query('SAVEPOINT financial_activity_atomic');

        const transaction = await paymentsService.createTransaction(
            companyA,
            null,
            {
                transaction_type: 'payment',
                payment_method: 'cash',
                contact_id: contactA,
                amount: 37,
                currency: 'USD',
                reference_number: reference,
            },
            client,
            clientActor()
        );

        await expect(client.query(
            `SELECT id
             FROM payment_transactions
             WHERE company_id = $1 AND id = $2`,
            [companyA, transaction.id]
        )).resolves.toMatchObject({ rowCount: 1 });
        await expect(client.query(
            `SELECT details->>'parent_type' AS parent_type,
                    details->>'parent_id' AS parent_id
             FROM audit_log
             WHERE company_id = $1
               AND action = 'payment.recorded'
               AND target_id = $2`,
            [companyA, String(transaction.id)]
        )).resolves.toMatchObject({
            rows: [{
                parent_type: 'contact',
                parent_id: String(contactA),
            }],
        });

        await client.query('ROLLBACK TO SAVEPOINT financial_activity_atomic');
        await client.query('RELEASE SAVEPOINT financial_activity_atomic');

        await expect(client.query(
            `SELECT id
             FROM payment_transactions
             WHERE company_id = $1 AND reference_number = $2`,
            [companyA, reference]
        )).resolves.toMatchObject({ rows: [] });
        await expect(client.query(
            `SELECT id
             FROM audit_log
             WHERE company_id = $1
               AND action = 'payment.recorded'
               AND target_id = $2`,
            [companyA, String(transaction.id)]
        )).resolves.toMatchObject({ rows: [] });
    });

    test('foreign Contact linkage is a 404 and leaves ledger plus activity unchanged', async () => {
        const beforePayments = await client.query(
            'SELECT COUNT(*)::INT AS count FROM payment_transactions WHERE company_id = $1',
            [companyA]
        );
        const beforeActivities = await client.query(
            `SELECT COUNT(*)::INT AS count
             FROM audit_log
             WHERE company_id = $1 AND action = 'payment.recorded'`,
            [companyA]
        );

        await expect(paymentsService.createTransaction(
            companyA,
            null,
            {
                transaction_type: 'payment',
                payment_method: 'cash',
                contact_id: contactB,
                amount: 25,
                currency: 'USD',
            },
            client,
            clientActor()
        )).rejects.toMatchObject({ code: 'NOT_FOUND', httpStatus: 404 });

        await expect(client.query(
            'SELECT COUNT(*)::INT AS count FROM payment_transactions WHERE company_id = $1',
            [companyA]
        )).resolves.toMatchObject({ rows: beforePayments.rows });
        await expect(client.query(
            `SELECT COUNT(*)::INT AS count
             FROM audit_log
             WHERE company_id = $1 AND action = 'payment.recorded'`,
            [companyA]
        )).resolves.toMatchObject({ rows: beforeActivities.rows });
    });

    test('receipt context cannot resolve another company transaction', async () => {
        const transaction = await insertTransaction({
            method: 'credit_card',
            source: 'stripe',
            externalId: `pi_tenant_${TAG}`,
        });

        await expect(
            paymentsQueries.getTransactionReceiptContext(companyA, transaction.id)
        ).resolves.toMatchObject({
            id: transaction.id,
            company_id: companyA,
        });
        await expect(
            paymentsQueries.getTransactionReceiptContext(companyB, transaction.id)
        ).resolves.toBeNull();
    });

    test('list exposes charge + livemode for Stripe card, never for cash', async () => {
        const stripePaymentIntent = `pi_card_${TAG}`;
        const stripeCharge = `ch_card_${TAG}`;
        const cashPaymentIntent = `pi_cash_${TAG}`;

        const stripeTransaction = await insertTransaction({
            method: 'credit_card',
            source: 'stripe',
            externalId: stripePaymentIntent,
            metadata: { payment_intent_id: stripePaymentIntent },
        });
        const cashTransaction = await insertTransaction({
            method: 'cash',
            source: 'manual',
            externalId: cashPaymentIntent,
            metadata: { payment_intent_id: cashPaymentIntent },
        });
        await insertSession({
            paymentIntentId: stripePaymentIntent,
            chargeId: stripeCharge,
        });
        // Even a corrupt/malicious session match cannot turn a cash row into a
        // Stripe-dashboard action; the ledger source+method gate is authoritative.
        await insertSession({
            paymentIntentId: cashPaymentIntent,
            chargeId: `ch_cash_${TAG}`,
        });

        const result = await paymentsQueries.listTransactions(companyA, { limit: 100 });
        const stripeRow = result.rows.find(row => String(row.id) === String(stripeTransaction.id));
        const cashRow = result.rows.find(row => String(row.id) === String(cashTransaction.id));

        expect(stripeRow).toMatchObject({
            stripe_payment_id: stripeCharge,
            stripe_livemode: true,
        });
        expect(cashRow).toMatchObject({
            stripe_payment_id: null,
            stripe_livemode: null,
        });

        const foreignResult = await paymentsQueries.listTransactions(companyB, { limit: 100 });
        expect(foreignResult.rows).toEqual([]);
    });
});
