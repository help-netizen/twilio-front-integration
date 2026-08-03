'use strict';

const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const db = require('../backend/src/db/connection');
const estimatesQueries = require('../backend/src/db/estimatesQueries');
const invoicesQueries = require('../backend/src/db/invoicesQueries');
const paymentsService = require('../backend/src/services/paymentsService');
const { listJobPaymentRollups } = require('../backend/src/db/jobFinanceQueries');

jest.setTimeout(60000);

const TAG = `JPA-${Date.now().toString(36)}-${process.pid}`;
const ORDER_LIST_MIGRATION = fs.readFileSync(
    path.join(__dirname, '..', 'backend', 'db', 'migrations', '207_estimate_invoice_order_list.sql'),
    'utf8'
);

let client;
let companyA;
let companyB;
let userA;
let userB;
let contactA;
let contactB;
let originalQuery;

async function createJob(companyId = companyA, contactId = contactA) {
    const { rows } = await client.query(
        `INSERT INTO jobs (company_id, contact_id, job_number, blanc_status)
         VALUES ($1, $2, $3, 'Submitted')
         RETURNING *`,
        [companyId, contactId, `${TAG}-${randomUUID().slice(0, 8)}`]
    );
    return rows[0];
}

async function createPayment({
    companyId = companyA,
    userId = userA,
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
        [companyId, jobId, invoiceId, status, amount, source, userId]
    );
    return rows[0];
}

async function createInvoice({
    companyId = companyA,
    contactId = contactA,
    userId = userA,
    jobId,
    label,
    total,
    createdAt = null,
}) {
    const invoice = await invoicesQueries.createInvoice(companyId, {
        contact_id: contactId,
        job_id: jobId,
        invoice_number: `${TAG}-${label}`,
        due_date: '2026-08-15',
        created_by: userId,
    }, client);
    await invoicesQueries.addInvoiceItem(companyId, invoice.id, {
        name: label,
        quantity: 1,
        unit_price: total,
        taxable: false,
    }, client);
    await invoicesQueries.recalculateInvoiceTotals(companyId, invoice.id, client);
    if (createdAt) {
        await client.query(
            `UPDATE invoices SET created_at = $3 WHERE id = $1 AND company_id = $2`,
            [invoice.id, companyId, createdAt]
        );
    }
    return invoicesQueries.getInvoiceById(companyId, invoice.id, client);
}

async function createEstimate(jobId, label, total) {
    const estimate = await estimatesQueries.createEstimate(companyA, {
        contact_id: contactA,
        job_id: jobId,
        estimate_number: `${TAG}-EST-${label}`,
        created_by: userA,
    }, client);
    await estimatesQueries.addEstimateItem(companyA, estimate.id, {
        name: label,
        quantity: 1,
        unit_price: total,
        taxable: false,
    }, client);
    await estimatesQueries.recalculateEstimateTotals(companyA, estimate.id, client);
    return estimatesQueries.getEstimateById(companyA, estimate.id, client);
}

async function rawInvoice(companyId, invoiceId) {
    const { rows } = await client.query(
        `SELECT amount_paid, balance_due, status
         FROM invoices
         WHERE company_id = $1 AND id = $2`,
        [companyId, invoiceId]
    );
    return rows[0] || null;
}

function money(invoice) {
    return {
        amount_paid: Number(invoice.amount_paid),
        balance_due: Number(invoice.balance_due),
        status: invoice.status,
        allocated: Number(invoice.job_payment_allocated || 0),
    };
}

beforeAll(async () => {
    originalQuery = db.query;
    client = await db.pool.connect();
    await client.query('BEGIN');
    db.query = (text, params) => client.query(text, params);
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
         VALUES ($1, $2, $3, 'Pool Actor A', $4),
                ($5, $6, $7, 'Pool Actor B', $8)`,
        [
            userA, `${TAG}-user-a`, `${TAG}-a@example.com`, companyA,
            userB, `${TAG}-user-b`, `${TAG}-b@example.com`, companyB,
        ]
    );
    const { rows: contacts } = await client.query(
        `INSERT INTO contacts (company_id, full_name)
         VALUES ($1, $2), ($3, $4)
         RETURNING id, company_id`,
        [companyA, `${TAG} Contact A`, companyB, `${TAG} Contact B`]
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

describe('PAY-JOB-CENTRIC-001 real PostgreSQL contract', () => {
    test('job 1603 shape: $95 before + $185 after pays a $280 invoice without claiming either row', async () => {
        const job = await createJob();
        const before = await createPayment({ jobId: job.id, amount: 95 });
        const invoice = await createInvoice({ jobId: job.id, label: 'job-1603', total: 280 });
        const after = await createPayment({ jobId: job.id, invoiceId: invoice.id, amount: 185 });

        const serialized = await invoicesQueries.getInvoiceById(companyA, invoice.id, client);
        expect(money(serialized)).toEqual({
            amount_paid: 280,
            balance_due: 0,
            status: 'paid',
            allocated: 280,
        });

        // The serializer derives money; it does not repair/mutate historical rows.
        expect(await rawInvoice(companyA, invoice.id)).toMatchObject({
            amount_paid: '0.00',
            balance_due: '280.00',
            status: 'draft',
        });
        const { rows: paymentRows } = await client.query(
            `SELECT id, invoice_id FROM payment_transactions
             WHERE company_id = $1 AND id = ANY($2::BIGINT[])
             ORDER BY id`,
            [companyA, [before.id, after.id]]
        );
        expect(paymentRows).toEqual([
            { id: before.id, invoice_id: null },
            { id: after.id, invoice_id: invoice.id },
        ]);

        const history = await paymentsService.listTransactions(companyA, {
            jobId: job.id,
            limit: 20,
        });
        expect(history.rows.map(row => row.id)).toEqual(expect.arrayContaining([before.id, after.id]));
    });

    test('allocates one native Job pool across active invoices oldest first', async () => {
        const job = await createJob();
        const oldest = await createInvoice({
            jobId: job.id,
            label: 'oldest',
            total: 100,
            createdAt: '2026-01-01T00:00:00Z',
        });
        const newest = await createInvoice({
            jobId: job.id,
            label: 'newest',
            total: 100,
            createdAt: '2026-01-02T00:00:00Z',
        });
        await createPayment({ jobId: job.id, invoiceId: newest.id, amount: 150 });

        expect(money(await invoicesQueries.getInvoiceById(companyA, oldest.id, client)))
            .toEqual({ amount_paid: 100, balance_due: 0, status: 'paid', allocated: 100 });
        expect(money(await invoicesQueries.getInvoiceById(companyA, newest.id, client)))
            .toEqual({ amount_paid: 50, balance_due: 50, status: 'partial', allocated: 50 });
        const [rollup] = await listJobPaymentRollups(companyA, [job.id], client);
        expect(Number(rollup.total_paid)).toBe(150);
        expect(Number(rollup.total_due)).toBe(50);
    });

    test('keeps linked Zenbooker behavior and excludes standalone ZB money from document Due', async () => {
        const job = await createJob();
        const invoice = await createInvoice({ jobId: job.id, label: 'zenbooker', total: 100 });
        await client.query(
            `UPDATE invoices
             SET amount_paid = 40, balance_due = 60, status = 'partial'
             WHERE company_id = $1 AND id = $2`,
            [companyA, invoice.id]
        );
        await createPayment({ jobId: job.id, invoiceId: invoice.id, amount: 40, source: 'zenbooker' });
        await createPayment({ jobId: job.id, amount: 20, source: 'zenbooker' });

        expect(money(await invoicesQueries.getInvoiceById(companyA, invoice.id, client)))
            .toEqual({ amount_paid: 40, balance_due: 60, status: 'partial', allocated: 0 });
        const [rollup] = await listJobPaymentRollups(companyA, [job.id], client);
        expect(Number(rollup.total_paid)).toBe(60);
        expect(Number(rollup.total_due)).toBe(60);
    });

    test('derives estimate paid/due from the native Job pool while preserving legacy/ZB deposit money', async () => {
        const job = await createJob();
        const estimate = await createEstimate(job.id, 'pool-estimate', 200);
        await client.query(
            `UPDATE estimates
             SET deposit_paid = 20
             WHERE company_id = $1 AND id = $2`,
            [companyA, estimate.id]
        );
        await createPayment({ jobId: job.id, amount: 75, source: 'stripe' });
        await createPayment({ jobId: job.id, amount: 30, source: 'zenbooker' });

        const serialized = await estimatesQueries.getEstimateById(
            companyA,
            estimate.id,
            client
        );
        expect(Number(serialized.deposit_paid)).toBe(95);
        expect(Number(serialized.balance_due)).toBe(105);
    });

    test('T-foreign/T-blast: another tenant pool cannot affect or reveal its invoice', async () => {
        const jobA = await createJob();
        const jobB = await createJob(companyB, contactB);
        const invoiceA = await createInvoice({ jobId: jobA.id, label: 'tenant-a', total: 75 });
        const invoiceB = await createInvoice({
            companyId: companyB,
            contactId: contactB,
            userId: userB,
            jobId: jobB.id,
            label: 'tenant-b',
            total: 75,
        });
        await createPayment({ companyId: companyB, userId: userB, jobId: jobB.id, amount: 75 });

        expect(await invoicesQueries.getInvoiceById(companyA, invoiceB.id, client)).toBeNull();
        expect(money(await invoicesQueries.getInvoiceById(companyA, invoiceA.id, client)))
            .toEqual({ amount_paid: 0, balance_due: 75, status: 'draft', allocated: 0 });
        expect(await rawInvoice(companyB, invoiceB.id)).toMatchObject({ amount_paid: '0.00' });
    });
});
