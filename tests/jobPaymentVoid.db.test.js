'use strict';

const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const db = require('../backend/src/db/connection');
const { listJobPaymentRollups } = require('../backend/src/db/jobFinanceQueries');
const paymentsService = require('../backend/src/services/paymentsService');
const { userActor } = require('../backend/src/services/financialActivityService');
const { withTransaction } = require('../backend/src/services/transactionService');

jest.setTimeout(60000);

const TAG = `JPV-${Date.now().toString(36)}-${process.pid}`;
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
const REASON_MIGRATION = fs.readFileSync(
    path.join(
        __dirname,
        '..',
        'backend',
        'db',
        'migrations',
        '211_payment_transaction_void_reason.sql'
    ),
    'utf8'
);

let companyA;
let companyB;
let userA;
let userB;
let inactiveUserA;

async function createJob(companyId = companyA) {
    const { rows } = await db.query(
        `INSERT INTO jobs (company_id, job_number, blanc_status)
         VALUES ($1, $2, 'Submitted')
         RETURNING *`,
        [companyId, `${TAG}-${randomUUID().slice(0, 8)}`]
    );
    return rows[0];
}

async function createPayment({
    companyId = companyA,
    jobId,
    invoiceId = null,
    transactionType = 'payment',
    status = 'completed',
    source = 'manual',
    amount = 100,
    recordedBy = companyId === companyA ? userA : userB,
}) {
    const { rows } = await db.query(
        `INSERT INTO payment_transactions (
            company_id, job_id, invoice_id, transaction_type, payment_method, status,
            amount, currency, external_source, processed_at, recorded_by
         ) VALUES ($1, $2, $3, $4, 'cash', $5, $6, 'USD', $7, NOW(), $8)
         RETURNING *`,
        [
            companyId,
            jobId,
            invoiceId,
            transactionType,
            status,
            amount,
            source,
            recordedBy,
        ]
    );
    return rows[0];
}

async function rowBytes(table, id) {
    const { rows } = await db.query(
        `SELECT row_to_json(t)::TEXT AS snapshot
         FROM ${table} t
         WHERE t.id = $1`,
        [id]
    );
    return rows[0]?.snapshot;
}

function voidPayment(companyId, actorId, paymentId, reason = 'Bounced check') {
    return withTransaction(client => paymentsService.voidPayment(
        companyId,
        actorId,
        paymentId,
        { reason },
        client,
        userActor(actorId)
    ));
}

beforeAll(async () => {
    await db.query(VOID_MIGRATION);
    await db.query(REASON_MIGRATION);

    companyA = randomUUID();
    companyB = randomUUID();
    userA = randomUUID();
    userB = randomUUID();
    inactiveUserA = randomUUID();

    await db.query(
        `INSERT INTO companies (id, name, slug)
         VALUES ($1, $2, $3), ($4, $5, $6)`,
        [
            companyA, `${TAG} Company A`, `${TAG.toLowerCase()}-a`,
            companyB, `${TAG} Company B`, `${TAG.toLowerCase()}-b`,
        ]
    );
    await db.query(
        `INSERT INTO crm_users (id, keycloak_sub, email, full_name, company_id)
         VALUES ($1, $2, $3, 'Void Actor A', $4),
                ($5, $6, $7, 'Void Actor B', $8),
                ($9, $10, $11, 'Inactive Void Actor', $4)`,
        [
            userA, `${TAG}-user-a`, `${TAG}-a@example.com`, companyA,
            userB, `${TAG}-user-b`, `${TAG}-b@example.com`, companyB,
            inactiveUserA, `${TAG}-user-inactive`, `${TAG}-inactive@example.com`,
        ]
    );
    await db.query(
        `INSERT INTO company_memberships (user_id, company_id, role, status)
         VALUES ($1, $2, 'company_member', 'active'),
                ($3, $4, 'company_member', 'active')`,
        [userA, companyA, userB, companyB]
    );
});

afterAll(async () => {
    try {
        await db.query(
            `DELETE FROM audit_log WHERE company_id IN ($1, $2)`,
            [companyA, companyB]
        );
        await db.query(
            `DELETE FROM payment_transactions WHERE company_id IN ($1, $2)`,
            [companyA, companyB]
        );
        await db.query(
            `DELETE FROM invoices WHERE company_id IN ($1, $2)`,
            [companyA, companyB]
        );
        await db.query(
            `DELETE FROM jobs WHERE company_id IN ($1, $2)`,
            [companyA, companyB]
        );
        await db.query(
            `DELETE FROM company_memberships WHERE company_id IN ($1, $2)`,
            [companyA, companyB]
        );
        await db.query(
            `DELETE FROM crm_users WHERE company_id IN ($1, $2)`,
            [companyA, companyB]
        );
        await db.query(
            `DELETE FROM companies WHERE id IN ($1, $2)`,
            [companyA, companyB]
        );
    } finally {
        await db.pool.end();
    }
});

describe('canonical standalone Job payment void', () => {
    test('keeps the row, trims the reason, excludes money, and logs safe activity once', async () => {
        const job = await createJob();
        const payment = await createPayment({ jobId: job.id });
        const before = await listJobPaymentRollups(companyA, [job.id]);
        expect(before.map(row => ({
            paid: Number(row.total_paid),
            due: Number(row.total_due),
        }))).toEqual([{ paid: 100, due: -100 }]);

        const result = await voidPayment(
            companyA,
            userA,
            payment.id,
            '  Bounced check  '
        );

        expect(result).toMatchObject({
            payment: {
                id: payment.id,
                status: 'voided',
                voided_by: userA,
                void_reason: 'Bounced check',
            },
            invoice: null,
            idempotent: false,
        });
        expect(result.payment.voided_at).toBeTruthy();
        expect(await listJobPaymentRollups(companyA, [job.id])).toEqual([]);

        const { rows: activities } = await db.query(
            `SELECT action, target_type, target_id, actor_id, details
             FROM audit_log
             WHERE company_id = $1
               AND action = 'payment.voided'
               AND target_id = $2`,
            [companyA, String(payment.id)]
        );
        expect(activities).toEqual([
            expect.objectContaining({
                action: 'payment.voided',
                target_type: 'payment',
                target_id: String(payment.id),
                actor_id: userA,
                details: expect.objectContaining({
                    summary: {
                        status: 'voided',
                        amount: 100,
                        currency: 'USD',
                    },
                    parent_type: 'job',
                    parent_id: String(job.id),
                }),
            }),
        ]);
        expect(JSON.stringify(activities[0].details)).not.toContain('Bounced check');
    });

    test('canonical compatibility mode persists null when reason is omitted', async () => {
        const job = await createJob();
        const payment = await createPayment({ jobId: job.id, amount: 20 });

        const result = await withTransaction(client => paymentsService.voidPayment(
            companyA,
            userA,
            payment.id,
            { allowMissingReason: true },
            client,
            userActor(userA)
        ));

        expect(result).toMatchObject({
            payment: {
                id: payment.id,
                status: 'voided',
                void_reason: null,
            },
            invoice: null,
            idempotent: false,
        });
        const { rows } = await db.query(
            `SELECT void_reason
             FROM payment_transactions
             WHERE company_id = $1 AND id = $2`,
            [companyA, payment.id]
        );
        expect(rows).toEqual([{ void_reason: null }]);
    });

    test.each([
        ['Stripe source', { source: 'stripe' }, 'EXTERNAL_PAYMENT_NOT_VOIDABLE'],
        ['Zenbooker source', { source: 'zenbooker' }, 'EXTERNAL_PAYMENT_NOT_VOIDABLE'],
        ['null source', { source: null }, 'EXTERNAL_PAYMENT_NOT_VOIDABLE'],
        ['empty source', { source: '' }, 'EXTERNAL_PAYMENT_NOT_VOIDABLE'],
        ['refund row', { transactionType: 'refund', amount: -10 }, 'INVALID_STATUS'],
        ['adjustment row', { transactionType: 'adjustment' }, 'INVALID_STATUS'],
        ['pending payment', { status: 'pending' }, 'INVALID_STATUS'],
        ['processing payment', { status: 'processing' }, 'INVALID_STATUS'],
        ['failed payment', { status: 'failed' }, 'INVALID_STATUS'],
        ['refunded payment', { status: 'refunded' }, 'INVALID_STATUS'],
    ])('rejects %s with 409 and leaves the row byte-unchanged', async (
        _label,
        overrides,
        code
    ) => {
        const job = await createJob();
        const payment = await createPayment({ jobId: job.id, ...overrides });
        const before = await rowBytes('payment_transactions', payment.id);

        await expect(
            voidPayment(companyA, userA, payment.id)
        ).rejects.toMatchObject({ code, httpStatus: 409 });
        expect(await rowBytes('payment_transactions', payment.id)).toBe(before);
    });

    test('T-foreign/T-blast returns 404 and leaves both tenants byte-unchanged', async () => {
        const ownJob = await createJob(companyA);
        const foreignJob = await createJob(companyB);
        const ownPayment = await createPayment({
            companyId: companyA,
            jobId: ownJob.id,
            amount: 25,
        });
        const foreignPayment = await createPayment({
            companyId: companyB,
            jobId: foreignJob.id,
            amount: 25,
        });
        const ownBefore = await rowBytes('payment_transactions', ownPayment.id);
        const foreignBefore = await rowBytes('payment_transactions', foreignPayment.id);

        await expect(
            voidPayment(companyA, userA, foreignPayment.id)
        ).rejects.toMatchObject({ code: 'NOT_FOUND', httpStatus: 404 });
        expect(await rowBytes('payment_transactions', ownPayment.id)).toBe(ownBefore);
        expect(await rowBytes('payment_transactions', foreignPayment.id)).toBe(
            foreignBefore
        );
    });

    test('T-blast rejects an own payment linked to a foreign invoice with 404', async () => {
        const ownJob = await createJob(companyA);
        const { rows: foreignInvoices } = await db.query(
            `INSERT INTO invoices (
                company_id, invoice_number, status, total,
                amount_paid, balance_due, currency
             ) VALUES ($1, $2, 'sent', 40, 40, 0, 'USD')
             RETURNING *`,
            [companyB, `${TAG}-foreign-invoice`]
        );
        const payment = await createPayment({
            companyId: companyA,
            jobId: ownJob.id,
            invoiceId: foreignInvoices[0].id,
            amount: 40,
        });
        const paymentBefore = await rowBytes('payment_transactions', payment.id);
        const invoiceBefore = await rowBytes('invoices', foreignInvoices[0].id);

        await expect(
            voidPayment(companyA, userA, payment.id)
        ).rejects.toMatchObject({ code: 'NOT_FOUND', httpStatus: 404 });
        expect(await rowBytes('payment_transactions', payment.id)).toBe(paymentBefore);
        expect(await rowBytes('invoices', foreignInvoices[0].id)).toBe(invoiceBefore);
    });

    test('concurrent repeats converge to one void and one activity row', async () => {
        const job = await createJob();
        const payment = await createPayment({ jobId: job.id, amount: 35 });

        const results = await Promise.all([
            voidPayment(companyA, userA, payment.id, 'First request'),
            voidPayment(companyA, userA, payment.id, 'Concurrent request'),
        ]);
        expect(results.map(result => result.idempotent).sort()).toEqual([false, true]);

        const { rows } = await db.query(
            `SELECT pt.status, pt.void_reason, COUNT(al.id)::INT AS activity_count
             FROM payment_transactions pt
             LEFT JOIN audit_log al
               ON al.company_id = pt.company_id
              AND al.action = 'payment.voided'
              AND al.target_id = pt.id::TEXT
             WHERE pt.company_id = $1 AND pt.id = $2
             GROUP BY pt.id`,
            [companyA, payment.id]
        );
        expect(rows).toHaveLength(1);
        expect(rows[0].status).toBe('voided');
        expect(['First request', 'Concurrent request']).toContain(rows[0].void_reason);
        expect(rows[0].activity_count).toBe(1);
    });

    test('activity failure rolls the payment mutation back atomically', async () => {
        const job = await createJob();
        const payment = await createPayment({ jobId: job.id, amount: 45 });
        const before = await rowBytes('payment_transactions', payment.id);

        await expect(
            voidPayment(companyA, inactiveUserA, payment.id, 'Audit must fail')
        ).rejects.toThrow('actor_id is not an active crm user');
        expect(await rowBytes('payment_transactions', payment.id)).toBe(before);

        const { rows } = await db.query(
            `SELECT COUNT(*)::INT AS count
             FROM audit_log
             WHERE company_id = $1
               AND action = 'payment.voided'
               AND target_id = $2`,
            [companyA, String(payment.id)]
        );
        expect(rows[0].count).toBe(0);
    });
});
