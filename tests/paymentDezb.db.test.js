'use strict';

const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const express = require('express');
const request = require('supertest');
const db = require('../backend/src/db/connection');
const paymentLedgerService = require('../backend/src/services/paymentLedgerService');
const paymentsRouter = require('../backend/src/routes/payments');
const {
    BEFORE_SQL,
    MIGRATION_SQL,
    captureRows,
    compareRows,
} = require('../scripts/compare-payment-ledger-dezb');

jest.setTimeout(60000);

const TAG = `PAY-DEZB-${Date.now()}-${process.pid}`;
const COMPANY_A = randomUUID();
const COMPANY_B = randomUUID();
let client;
let originalQuery;
let contactA;
let jobA;
let historicalA;
let historicalB;
let stripeA;
let manualA;
let sabotagePayment;
let beforeRowsA;

async function insertPayment(companyId, {
    jobId = null,
    contactId = null,
    method,
    source,
    externalId,
    amount,
    metadata = {},
    memo = null,
}) {
    const { rows } = await client.query(
        `INSERT INTO payment_transactions (
            company_id, job_id, contact_id, transaction_type, payment_method,
            status, amount, currency, reference_number, external_id,
            external_source, memo, metadata, processed_at
         ) VALUES (
            $1, $2, $3, 'payment', $4,
            'completed', $5, 'USD', $6, $7,
            $8, $9, $10::jsonb, '2026-08-01T12:00:00Z'
         ) RETURNING *`,
        [
            companyId,
            jobId,
            contactId,
            method,
            amount,
            `${TAG}-invoice`,
            externalId,
            source,
            memo,
            JSON.stringify(metadata),
        ]
    );
    return rows[0];
}

async function insertArchivedPayment(companyId, transactionId, overrides = {}) {
    await client.query(
        `INSERT INTO zb_payments (
            company_id, transaction_id, invoice_id, job_id, job_number,
            client, job_type, status, payment_methods, display_payment_method,
            amount_paid, tags, payment_date, source, transaction_status,
            missing_job_link, invoice_status, invoice_total, invoice_amount_paid,
            invoice_amount_due, invoice_paid_in_full, invoice_detail, job_detail,
            attachments, metadata
         ) VALUES (
            $1, $2, $3, $4, $5,
            $6, $7, $8, $9, $10,
            $11, $12, '2026-08-01T12:00:00Z', $13, 'succeeded',
            false, 'paid', $14, $15,
            $16, true, $17::jsonb, $18::jsonb,
            $19::jsonb, $20::jsonb
         )`,
        [
            companyId,
            transactionId,
            overrides.invoiceId || `${TAG}-legacy-invoice`,
            overrides.jobId || `${TAG}-legacy-job`,
            overrides.jobNumber || 'LEGACY-100',
            overrides.client || 'Legacy Customer',
            overrides.jobType || 'Legacy Repair',
            overrides.status || 'Legacy Complete',
            overrides.paymentMethods || 'check',
            overrides.displayPaymentMethod || 'check',
            overrides.amount || 999,
            overrides.tags || 'legacy-tag',
            overrides.source || 'Legacy Source',
            overrides.invoiceTotal || 238.65,
            overrides.invoiceAmountPaid || 95,
            overrides.invoiceAmountDue || 143.65,
            JSON.stringify({
                status: 'paid',
                total: String(overrides.invoiceTotal || 238.65),
                amount_paid: String(overrides.invoiceAmountPaid || 95),
                amount_due: String(overrides.invoiceAmountDue || 143.65),
                paid_in_full: true,
            }),
            JSON.stringify({ job_number: overrides.jobNumber || 'LEGACY-100' }),
            JSON.stringify([{ url: 'https://cdn.example.test/receipt.jpg', kind: 'image' }]),
            JSON.stringify({ legacy_transaction_marker: transactionId }),
        ]
    );
}

beforeAll(async () => {
    originalQuery = db.query;
    client = await db.pool.connect();
    await client.query('BEGIN');
    db.query = (text, params) => client.query(text, params);

    await client.query(
        `INSERT INTO companies (id, name, slug)
         VALUES ($1, $2, $3), ($4, $5, $6)`,
        [
            COMPANY_A, `${TAG} A`, `${TAG.toLowerCase()}-a`,
            COMPANY_B, `${TAG} B`, `${TAG.toLowerCase()}-b`,
        ]
    );
    ({ rows: [{ id: contactA }] } = await client.query(
        `INSERT INTO contacts (company_id, full_name)
         VALUES ($1, 'Native Customer') RETURNING id`,
        [COMPANY_A]
    ));
    ({ rows: [{ id: jobA }] } = await client.query(
        `INSERT INTO jobs (
            company_id, contact_id, blanc_status, job_number, service_name,
            customer_name, job_source, assigned_techs, metadata
         ) VALUES (
            $1, $2, 'Completed', 'NATIVE-100', '',
            'Job Customer', 'Native Source',
            '[{"id":"provider-1","name":"Native Provider"}]'::jsonb,
            '{"claim":"ABC-1"}'::jsonb
         ) RETURNING id`,
        [COMPANY_A, contactA]
    ));

    const sharedExternalId = `${TAG}-shared`;
    historicalA = await insertPayment(COMPANY_A, {
        jobId: jobA,
        contactId: contactA,
        method: 'zenbooker_sync',
        source: 'zenbooker',
        externalId: sharedExternalId,
        amount: 95,
        metadata: { zb_job_id: `${TAG}-legacy-job` },
        memo: 'Canonical memo',
    });
    historicalB = await insertPayment(COMPANY_B, {
        method: 'zenbooker_sync',
        source: 'zenbooker',
        externalId: sharedExternalId,
        amount: 900,
        metadata: { check_deposited: false },
    });
    await insertArchivedPayment(COMPANY_A, sharedExternalId);
    await insertArchivedPayment(COMPANY_B, sharedExternalId, {
        client: 'Foreign Legacy Customer',
        jobType: 'Foreign Legacy Repair',
        invoiceTotal: 900,
        invoiceAmountPaid: 900,
        invoiceAmountDue: 0,
    });

    stripeA = await insertPayment(COMPANY_A, {
        method: 'credit_card', source: 'stripe', externalId: `${TAG}-stripe`, amount: 66,
    });
    manualA = await insertPayment(COMPANY_A, {
        method: 'cash', source: 'manual', externalId: `${TAG}-manual`, amount: 46,
    });
    sabotagePayment = await insertPayment(COMPANY_A, {
        jobId: jobA,
        method: 'zenbooker_sync',
        source: 'zenbooker',
        externalId: `${TAG}-sabotage`,
        amount: 12,
        metadata: { zb_job_id: `${TAG}-sabotage-job` },
    });
    await insertArchivedPayment(COMPANY_A, `${TAG}-sabotage`, {
        jobId: `${TAG}-sabotage-job`,
        jobType: 'Sabotage-only Job Type',
    });

    beforeRowsA = await captureRows(client, BEFORE_SQL, COMPANY_A);
    await client.query(MIGRATION_SQL);
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

test('1. runtime ledger path contains no archived-table or fallback-job join', () => {
    const files = [
        'backend/src/services/paymentLedgerService.js',
        'backend/src/routes/paymentLedger.js',
        'backend/src/routes/payments.js',
        'frontend/src/hooks/usePaymentsPage.ts',
    ];
    const source = files.map(file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8')).join('\n');
    expect(source).not.toMatch(/\bzb_payments\b|\bzb_job\b/);
});

test('2. imported row resolves native customer/job plus frozen type and invoice values', async () => {
    const afterRows = await captureRows(client, paymentLedgerService.PAYMENT_LEDGER_ROWS_SQL, COMPANY_A);
    expect(compareRows(beforeRowsA, afterRows)).toMatchObject({ ok: true, mismatches: [] });

    const detail = await paymentLedgerService.getPaymentDetail(COMPANY_A, historicalA.id);
    expect(detail).toMatchObject({
        client: 'Native Customer',
        job_number: 'NATIVE-100',
        job_type: 'Legacy Repair',
        amount_paid: '95.00',
        invoice_total: '238.65',
        invoice_amount_paid: '95.00',
        invoice_amount_due: '143.65',
        local_job_id: jobA,
        attachments: [],
    });
    const stored = await client.query(
        `SELECT metadata->'legacy' AS legacy FROM payment_transactions
         WHERE company_id = $1 AND id = $2`,
        [COMPANY_A, historicalA.id]
    );
    expect(stored.rows[0].legacy).not.toHaveProperty('attachments');
});

test('3. native Stripe and manual rows retain their canonical money and source', async () => {
    const page = await paymentLedgerService.listPayments(COMPANY_A, { limit: 50 });
    expect(page.rows.find(row => String(row.id) === String(stripeA.id))).toMatchObject({
        amount_paid: '66.00', external_source: 'stripe', payment_methods: 'card',
    });
    expect(page.rows.find(row => String(row.id) === String(manualA.id))).toMatchObject({
        amount_paid: '46.00', external_source: 'manual', payment_methods: 'cash',
    });
});

test('4. T-own/T-foreign and T-blast keep the same external id tenant-isolated', async () => {
    await expect(paymentLedgerService.getPaymentDetail(COMPANY_A, historicalA.id))
        .resolves.toMatchObject({ id: historicalA.id, client: 'Native Customer' });
    await expect(paymentLedgerService.getPaymentDetail(COMPANY_B, historicalA.id)).resolves.toBeNull();
    await expect(paymentLedgerService.getPaymentDetail(COMPANY_B, historicalB.id))
        .resolves.toMatchObject({ id: historicalB.id, client: 'Foreign Legacy Customer' });

    const beforeForeign = await client.query(
        `SELECT metadata::text AS metadata FROM payment_transactions
         WHERE company_id = $1 AND id = $2`,
        [COMPANY_B, historicalB.id]
    );
    await paymentLedgerService.updateCheckDeposited(COMPANY_A, historicalA.id, true, client);
    const afterForeign = await client.query(
        `SELECT metadata::text AS metadata FROM payment_transactions
         WHERE company_id = $1 AND id = $2`,
        [COMPANY_B, historicalB.id]
    );
    expect(afterForeign.rows).toEqual(beforeForeign.rows);
});

test('5. direct /api/payments/:id ledger link loads through the canonical router', async () => {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
        req.user = { crmUser: { id: randomUUID() } };
        req.authz = { scope: 'tenant', permissions: ['payments.view'] };
        req.companyFilter = { company_id: COMPANY_A };
        next();
    });
    app.use('/api/payments', paymentsRouter);

    const response = await request(app)
        .get(`/api/payments/${historicalA.id}`)
        .query({ view: 'ledger' });
    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({
        id: historicalA.id,
        job_number: 'NATIVE-100',
        attachments: [],
    });
});

test('6. sabotage: omitting job_type from the migration makes the row gate fail', async () => {
    const oldRows = await captureRows(client, BEFORE_SQL, COMPANY_A);
    await client.query(
        `UPDATE payment_transactions
         SET metadata = metadata - 'legacy' - 'pay_dezb_001_snapshot'
         WHERE company_id = $1 AND id = $2`,
        [COMPANY_A, sabotagePayment.id]
    );
    const sabotagedMigration = MIGRATION_SQL.replace(
        /\n\s*'job_type', COALESCE\(NULLIF\(fallback_job\.service_name, ''\), zp\.job_type\),/,
        ''
    );
    expect(sabotagedMigration).not.toBe(MIGRATION_SQL);
    await client.query(sabotagedMigration);

    const newRows = await captureRows(client, paymentLedgerService.PAYMENT_LEDGER_ROWS_SQL, COMPANY_A);
    const comparison = compareRows(oldRows, newRows);
    expect(comparison.ok).toBe(false);
    expect(comparison.mismatches).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: String(sabotagePayment.id) }),
    ]));
});
