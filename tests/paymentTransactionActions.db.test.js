'use strict';

/**
 * JOBPANEL-REWORK-001 — real PostgreSQL coverage for the transaction action
 * projection and the receipt-email ownership boundary.
 */

const { randomUUID } = require('crypto');
const db = require('../backend/src/db/connection');
const paymentsQueries = require('../backend/src/db/paymentsQueries');

jest.setTimeout(60000);

const TAG = `PTRA-${Date.now().toString(36)}-${process.pid}`;

let client;
let originalQuery;
let companyA;
let companyB;

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
