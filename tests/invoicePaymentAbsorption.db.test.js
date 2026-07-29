'use strict';

const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const db = require('../backend/src/db/connection');
const invoicesQueries = require('../backend/src/db/invoicesQueries');
const { listJobPaymentRollups } = require('../backend/src/db/jobFinanceQueries');
const invoicesService = require('../backend/src/services/invoicesService');

jest.setTimeout(60000);

const TAG = `IPA-${Date.now().toString(36)}-${process.pid}`;
const ORDER_LIST_MIGRATION = fs.readFileSync(
    path.join(
        __dirname,
        '..',
        'backend',
        'db',
        'migrations',
        '207_estimate_invoice_order_list.sql'
    ),
    'utf8'
);

let client;
let companyA;
let companyB;
let userA;
let userB;
let contactA;

async function createJob() {
    const { rows } = await client.query(
        `INSERT INTO jobs (company_id, contact_id, job_number, blanc_status)
         VALUES ($1, $2, $3, 'Submitted')
         RETURNING *`,
        [companyA, contactA, `${TAG}-${randomUUID().slice(0, 8)}`]
    );
    return rows[0];
}

async function createPayment({
    companyId = companyA,
    jobId,
    invoiceId = null,
    amount,
    source = 'stripe',
    status = 'completed',
}) {
    const { rows } = await client.query(
        `INSERT INTO payment_transactions (
            company_id, job_id, invoice_id, transaction_type, payment_method,
            status, amount, currency, external_source, processed_at, recorded_by
         ) VALUES (
            $1, $2, $3, 'payment', 'cash',
            $4, $5, 'USD', $6, NOW(), $7
         )
         RETURNING *`,
        [
            companyId,
            jobId,
            invoiceId,
            status,
            amount,
            source,
            companyId === companyA ? userA : userB,
        ]
    );
    return rows[0];
}

async function createRawInvoice(jobId, label, total) {
    const invoice = await invoicesQueries.createInvoice(companyA, {
        contact_id: contactA,
        job_id: jobId,
        invoice_number: `${TAG}-${label}`,
        due_date: '2026-08-15',
        created_by: userA,
    }, client);
    await invoicesQueries.addInvoiceItem(companyA, invoice.id, {
        name: label,
        quantity: 1,
        unit_price: total,
        taxable: false,
    }, client);
    await invoicesQueries.recalculateInvoiceTotals(
        companyA,
        invoice.id,
        client
    );
    return invoicesQueries.getInvoiceById(companyA, invoice.id, client);
}

async function createThroughService(jobId, label, total) {
    return invoicesService.createInvoice(companyA, userA, {
        contact_id: contactA,
        job_id: jobId,
        invoice_number: `${TAG}-${label}`,
        due_date: '2026-08-15',
        items: [{
            name: label,
            quantity: 1,
            unit_price: total,
            taxable: false,
        }],
    }, client);
}

async function rowBytes(table, id) {
    const { rows } = await client.query(
        `SELECT row_to_json(t)::TEXT AS snapshot
         FROM ${table} t
         WHERE t.id = $1`,
        [id]
    );
    return rows[0]?.snapshot;
}

function money(invoice) {
    return {
        amount_paid: Number(invoice.amount_paid),
        balance_due: Number(invoice.balance_due),
        status: invoice.status,
    };
}

function rollup(rows) {
    return rows.map(row => ({
        paid: Number(row.total_paid),
        due: Number(row.total_due),
    }));
}

beforeAll(async () => {
    client = await db.pool.connect();
    await client.query('BEGIN');
    await client.query(ORDER_LIST_MIGRATION);

    companyA = randomUUID();
    companyB = randomUUID();
    userA = randomUUID();
    userB = randomUUID();

    await client.query(
        `INSERT INTO companies (id, name, slug)
         VALUES ($1, $2, $3), ($4, $5, $6)`,
        [
            companyA, `${TAG} Company A`, `${TAG.toLowerCase()}-a`,
            companyB, `${TAG} Company B`, `${TAG.toLowerCase()}-b`,
        ]
    );
    await client.query(
        `INSERT INTO crm_users (id, keycloak_sub, email, full_name, company_id)
         VALUES ($1, $2, $3, 'Absorb Actor A', $4),
                ($5, $6, $7, 'Absorb Actor B', $8)`,
        [
            userA, `${TAG}-user-a`, `${TAG}-a@example.com`, companyA,
            userB, `${TAG}-user-b`, `${TAG}-b@example.com`, companyB,
        ]
    );
    const { rows: contacts } = await client.query(
        `INSERT INTO contacts (company_id, full_name)
         VALUES ($1, $2)
         RETURNING id`,
        [companyA, `${TAG} Contact A`]
    );
    contactA = contacts[0].id;
});

afterAll(async () => {
    if (client) {
        try {
            await client.query('ROLLBACK');
        } finally {
            client.release();
        }
    }
    await db.pool.end();
});

describe('INV-ABSORB-PAYMENTS-001 real PostgreSQL contract', () => {
    test('T-happy: creating a $320 Job invoice absorbs a completed $160 Stripe payment', async () => {
        const job = await createJob();
        const payment = await createPayment({ jobId: job.id, amount: 160 });

        const invoice = await createThroughService(job.id, 'happy', 320);

        expect(await invoicesQueries.getInvoiceById(
            companyA,
            invoice.id,
            client
        )).toMatchObject({
            amount_paid: '160.00',
            balance_due: '160.00',
            status: 'partial',
        });
        const { rows } = await client.query(
            `SELECT invoice_id
             FROM payment_transactions
             WHERE company_id = $1 AND id = $2`,
            [companyA, payment.id]
        );
        expect(rows).toEqual([{ invoice_id: invoice.id }]);
    });

    test('Job Paid/Due is unchanged when a standalone payment moves under an existing invoice', async () => {
        const job = await createJob();
        await createPayment({ jobId: job.id, amount: 160 });
        const invoice = await createRawInvoice(job.id, 'rollup-invariant', 320);
        const before = rollup(await listJobPaymentRollups(
            companyA,
            [job.id],
            client
        ));

        await invoicesService.absorbUnappliedJobPayments(
            companyA,
            invoice.id,
            client
        );

        const after = rollup(await listJobPaymentRollups(
            companyA,
            [job.id],
            client
        ));
        expect(before).toEqual([{ paid: 160, due: 160 }]);
        expect(after).toEqual(before);
    });

    test('T-zb: a completed Zenbooker standalone payment remains unapplied', async () => {
        const job = await createJob();
        const payment = await createPayment({
            jobId: job.id,
            amount: 160,
            source: 'zenbooker',
        });

        const invoice = await createThroughService(job.id, 'zenbooker', 320);

        expect(money(invoice)).toEqual({
            amount_paid: 0,
            balance_due: 320,
            status: 'draft',
        });
        expect(JSON.parse(await rowBytes('payment_transactions', payment.id)))
            .toMatchObject({ invoice_id: null });
    });

    test('T-excluded: voided, refunded-original, and already-linked payments are untouched', async () => {
        const job = await createJob();
        const target = await createRawInvoice(job.id, 'excluded-target', 300);
        const other = await createRawInvoice(job.id, 'excluded-other', 50);
        const payments = [
            await createPayment({
                jobId: job.id,
                amount: 20,
                status: 'voided',
            }),
            await createPayment({
                jobId: job.id,
                amount: 30,
                status: 'refunded',
            }),
            await createPayment({
                jobId: job.id,
                invoiceId: other.id,
                amount: 40,
            }),
        ];
        const paymentBytes = await Promise.all(
            payments.map(payment => rowBytes('payment_transactions', payment.id))
        );
        const invoiceBytes = await rowBytes('invoices', target.id);

        await invoicesService.absorbUnappliedJobPayments(
            companyA,
            target.id,
            client
        );

        await expect(Promise.all(
            payments.map(payment => rowBytes('payment_transactions', payment.id))
        )).resolves.toEqual(paymentBytes);
        await expect(rowBytes('invoices', target.id)).resolves.toBe(invoiceBytes);
    });

    test('T-over: all payments are absorbed when their sum exceeds invoice total', async () => {
        const job = await createJob();
        const first = await createPayment({ jobId: job.id, amount: 70 });
        const second = await createPayment({ jobId: job.id, amount: 50 });

        const invoice = await createThroughService(job.id, 'overpaid', 100);

        expect(money(invoice)).toEqual({
            amount_paid: 120,
            balance_due: -20,
            status: 'paid',
        });
        const { rows } = await client.query(
            `SELECT id, invoice_id
             FROM payment_transactions
             WHERE company_id = $1 AND id = ANY($2::BIGINT[])
             ORDER BY id`,
            [companyA, [first.id, second.id]]
        );
        expect(rows).toEqual([
            { id: first.id, invoice_id: invoice.id },
            { id: second.id, invoice_id: invoice.id },
        ]);
    });

    test('T-idempotent: a second absorption does not count the payment twice', async () => {
        const job = await createJob();
        await createPayment({ jobId: job.id, amount: 45 });
        const invoice = await createRawInvoice(job.id, 'idempotent', 100);

        await invoicesService.absorbUnappliedJobPayments(
            companyA,
            invoice.id,
            client
        );
        const afterFirst = await rowBytes('invoices', invoice.id);
        await invoicesService.absorbUnappliedJobPayments(
            companyA,
            invoice.id,
            client
        );

        expect(await rowBytes('invoices', invoice.id)).toBe(afterFirst);
        expect(money(await invoicesQueries.getInvoiceById(
            companyA,
            invoice.id,
            client
        ))).toEqual({
            amount_paid: 45,
            balance_due: 55,
            status: 'partial',
        });
    });

    test('T-tenant: another company payment carrying the same job id stays byte-stable', async () => {
        const job = await createJob();
        const foreignPayment = await createPayment({
            companyId: companyB,
            jobId: job.id,
            amount: 75,
        });
        const before = await rowBytes('payment_transactions', foreignPayment.id);
        const invoice = await createRawInvoice(job.id, 'tenant', 100);

        await invoicesService.absorbUnappliedJobPayments(
            companyA,
            invoice.id,
            client
        );

        expect(await rowBytes('payment_transactions', foreignPayment.id)).toBe(before);
        expect(money(await invoicesQueries.getInvoiceById(
            companyA,
            invoice.id,
            client
        ))).toEqual({
            amount_paid: 0,
            balance_due: 100,
            status: 'draft',
        });
    });
});
