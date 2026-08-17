'use strict';

const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const db = require('../backend/src/db/connection');
const { listJobPaymentRollups } = require('../backend/src/db/jobFinanceQueries');
const paymentsQueries = require('../backend/src/db/paymentsQueries');
const analyticsService = require('../backend/src/services/analyticsService');

jest.setTimeout(60000);

const TAG = `PRA-${Date.now().toString(36)}-${process.pid}`;
const VOID_MIGRATION = fs.readFileSync(
    path.join(
        __dirname,
        '..',
        'backend',
        'db',
        'migrations',
        '197_invoice_payment_void.sql'
    ),
    'utf8'
);

let client;
let originalQuery;
let partial;
let full;
let zenbooker;

async function createFixture(label, refundAmount, source = 'manual') {
    const companyId = randomUUID();
    await db.query(
        `INSERT INTO companies (id, name, slug)
         VALUES ($1, $2, $3)`,
        [companyId, `${TAG} ${label}`, `${TAG.toLowerCase()}-${label}`]
    );
    const { rows: leads } = await db.query(
        `INSERT INTO leads (
            company_id, uuid, status, first_name, created_at
         ) VALUES (
            $1, $2, 'Submitted', $3, '2026-07-15T12:00:00Z'
         )
         RETURNING *`,
        [
            companyId,
            `PRA${randomUUID().replace(/-/g, '').slice(0, 14)}`,
            `${TAG}-${label}`,
        ]
    );
    const { rows: jobs } = await db.query(
        `INSERT INTO jobs (
            company_id, lead_id, job_number, blanc_status,
            invoice_status, created_at
         ) VALUES (
            $1, $2, $3, 'Submitted', 'partially_paid',
            '2026-07-15T12:00:00Z'
         )
         RETURNING *`,
        [companyId, leads[0].id, `${TAG}-${label}`]
    );
    const jobId = jobs[0].id;
    const { rows: originals } = await db.query(
        `INSERT INTO payment_transactions (
            company_id, job_id, transaction_type, payment_method, status,
            amount, currency, external_source, processed_at, created_at
         ) VALUES (
            $1, $2, 'payment', 'cash', 'refunded',
            100, 'USD', $3, NOW(), '2026-07-15T12:01:00Z'
         )
         RETURNING id`,
        [companyId, jobId, source]
    );
    await db.query(
        `INSERT INTO payment_transactions (
            company_id, job_id, transaction_type, payment_method, status,
            amount, currency, external_source, metadata, processed_at, created_at
         ) VALUES
            ($1, $2, 'refund', 'cash', 'completed',
             $3, 'USD', NULL,
             jsonb_build_object('original_transaction_id', $4::TEXT),
             NOW(), '2026-07-15T12:02:00Z'),
            ($1, $2, 'payment', 'cash', 'voided',
             999, 'USD', $5, '{}'::JSONB,
             NOW(), '2026-07-15T12:03:00Z')`,
        [
            companyId,
            jobId,
            -Math.abs(refundAmount),
            originals[0].id,
            source,
        ]
    );
    await db.query(
        `UPDATE payment_transactions
         SET voided_at = NOW()
         WHERE company_id = $1
           AND job_id = $2
           AND status = 'voided'`,
        [companyId, jobId]
    );
    return { companyId, jobId };
}

beforeAll(async () => {
    originalQuery = db.query;
    client = await db.pool.connect();
    await client.query('BEGIN');
    db.query = (text, params) => client.query(text, params);

    await db.query(VOID_MIGRATION);
    partial = await createFixture('partial', 30);
    full = await createFixture('full', 100);
    zenbooker = await createFixture('zenbooker', 30, 'zenbooker');
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

describe('refund accounting uses gross payment minus completed refund offsets', () => {
    test.each([
        ['partial', () => partial, 30, 70, -70],
        ['full', () => full, 100, 0, 0],
        // Standalone Zenbooker money settles documents like any other (corrected
        // 2026-08-16): $100 paid less a $30 refund nets $70, and that $70 now
        // reduces Due instead of leaving the customer owing the full amount.
        ['Zenbooker partial', () => zenbooker, 30, 70, -70],
    ])('%s refund has the correct Job Paid/Due', async (
        _label,
        getFixture,
        _refundAmount,
        expectedNet,
        expectedDue
    ) => {
        const fixture = getFixture();
        const rows = await listJobPaymentRollups(
            fixture.companyId,
            [fixture.jobId],
            client
        );
        expect(rows).toHaveLength(1);
        expect({
            paid: Number(rows[0].total_paid),
            due: Number(rows[0].total_due),
        }).toEqual({
            paid: expectedNet,
            due: expectedDue,
        });
    });

    test.each([
        ['partial', () => partial, 30, 70],
        ['full', () => full, 100, 0],
        ['Zenbooker partial', () => zenbooker, 30, 70],
    ])('%s company summary retains $100 gross and nets the refund', async (
        _label,
        getFixture,
        expectedRefunded,
        expectedNet
    ) => {
        const summary = await paymentsQueries.getTransactionSummary(
            getFixture().companyId
        );
        expect(summary).toEqual({
            total_collected: 100,
            total_refunded: expectedRefunded,
            total_pending: 0,
            net_amount: expectedNet,
        });
    });

    test.each([
        ['partial', () => partial, 70],
        ['full', () => full, 0],
        ['Zenbooker partial', () => zenbooker, 70],
    ])('%s analytics paid and amount_paid use the same net formula', async (
        _label,
        getFixture,
        expectedNet
    ) => {
        const fixture = getFixture();
        const result = await analyticsService.listJobs({
            from: '2026-07-15',
            to: '2026-07-15',
            companyId: fixture.companyId,
            limit: 100,
        });
        const job = result.items.find(row => String(row.id) === String(fixture.jobId));
        expect(job).toBeTruthy();
        expect({
            paid: Number(job.paid),
            amount_paid: Number(job.amount_paid),
        }).toEqual({
            paid: expectedNet,
            amount_paid: expectedNet,
        });
    });
});
