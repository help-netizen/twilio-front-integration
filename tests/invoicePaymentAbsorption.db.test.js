'use strict';

const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const db = require('../backend/src/db/connection');
const estimatesQueries = require('../backend/src/db/estimatesQueries');
const invoicesQueries = require('../backend/src/db/invoicesQueries');
const invoicesService = require('../backend/src/services/invoicesService');
const paymentsService = require('../backend/src/services/paymentsService');
const {
    getJobFinance,
    listJobPaymentRollups,
} = require('../backend/src/db/jobFinanceQueries');

jest.setTimeout(60000);

const TAG = `JPA-${Date.now().toString(36)}-${process.pid}`;
const ORDER_LIST_MIGRATION = fs.readFileSync(
    path.join(__dirname, '..', 'backend', 'db', 'migrations', '207_estimate_invoice_order_list.sql'),
    'utf8'
);
const DISCOUNT_MIGRATION = fs.readFileSync(
    path.join(__dirname, '..', 'backend', 'db', 'migrations', '287_invoice_percentage_discounts.sql'),
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
    transactionType = 'payment',
    metadata = {},
}) {
    const { rows } = await client.query(
        `INSERT INTO payment_transactions (
            company_id, job_id, invoice_id, transaction_type, payment_method,
            status, amount, currency, external_source, metadata, processed_at, recorded_by
         ) VALUES (
            $1, $2, $3, $4, 'cash',
            $5, $6, 'USD', $7, $8::JSONB, NOW(), $9
         )
         RETURNING *`,
        [
            companyId,
            jobId,
            invoiceId,
            transactionType,
            status,
            amount,
            source,
            JSON.stringify(metadata),
            userId,
        ]
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
    await client.query(
        'ALTER TABLE jobs ADD COLUMN IF NOT EXISTS job_seq INTEGER, '
        + 'ADD COLUMN IF NOT EXISTS public_code TEXT'
    );
    await client.query(ORDER_LIST_MIGRATION);
    await client.query(DISCOUNT_MIGRATION);

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
    test('SAB-OB70-TIPS-IN-PAID: canonical totals exclude tips and inactive documents', async () => {
        const job = await createJob();
        const activeEstimate = await createEstimate(job.id, 'finance-active', 250);
        const declinedEstimate = await createEstimate(job.id, 'finance-declined', 30);
        const archivedEstimate = await createEstimate(job.id, 'finance-archived', 40);
        await client.query(
            `UPDATE estimates SET status = 'declined'
             WHERE company_id = $1 AND id = $2`,
            [companyA, declinedEstimate.id]
        );
        await client.query(
            `UPDATE estimates SET archived_at = NOW()
             WHERE company_id = $1 AND id = $2`,
            [companyA, archivedEstimate.id]
        );
        expect(Number(activeEstimate.total)).toBe(250);

        await createInvoice({ jobId: job.id, label: 'finance-active', total: 100 });
        const voidInvoice = await createInvoice({ jobId: job.id, label: 'finance-void', total: 60 });
        await invoicesQueries.updateInvoiceStatus(
            voidInvoice.id,
            companyA,
            'sent',
            'sent_at',
            client
        );
        await invoicesQueries.voidIssuedInvoice(voidInvoice.id, companyA, client);
        await createPayment({ jobId: job.id, amount: 115, metadata: { tip: 15 } });

        await expect(getJobFinance(companyA, job.id, client)).resolves.toEqual({
            job_id: job.id,
            estimated: 250,
            invoiced: 100,
            paid: 100,
            due: 0,
            tips: 15,
            unapplied_credit: 100,
        });
        await expect(getJobFinance(companyB, job.id, client)).resolves.toBeNull();
    });

    test('SAB-OB70-SIGNED-DUE: Job credit stays negative and is never clamped', async () => {
        const job = await createJob();
        const invoice = await createInvoice({ jobId: job.id, label: 'signed-due', total: 30 });
        await createPayment({ jobId: job.id, invoiceId: invoice.id, amount: 50 });

        await expect(getJobFinance(companyA, job.id, client)).resolves.toMatchObject({
            invoiced: 30,
            paid: 50,
            due: -20,
            tips: 0,
            unapplied_credit: 0,
        });
    });

    test('PAY-JOB-CENTRIC-001: job 1603 linked and unlinked rows count once', async () => {
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
        await expect(getJobFinance(companyA, job.id, client)).resolves.toMatchObject({
            invoiced: 280,
            paid: 280,
            due: 0,
        });
    });

    test('SAB-OB70-LEGACY-PAID: materialized invoice money survives without ledger rows', async () => {
        const job = await createJob();
        const invoice = await createInvoice({ jobId: job.id, label: 'legacy-only', total: 100 });
        await client.query(
            `UPDATE invoices
             SET amount_paid = 100, balance_due = 0, status = 'paid'
             WHERE company_id = $1 AND id = $2`,
            [companyA, invoice.id]
        );

        await expect(getJobFinance(companyA, job.id, client)).resolves.toMatchObject({
            invoiced: 100,
            paid: 100,
            due: 0,
        });
    });

    test('linked native ledger is removed from legacy before Paid is summed', async () => {
        const job = await createJob();
        const invoice = await createInvoice({ jobId: job.id, label: 'native-dedup', total: 100 });
        await client.query(
            `UPDATE invoices
             SET amount_paid = 40, balance_due = 60, status = 'partial'
             WHERE company_id = $1 AND id = $2`,
            [companyA, invoice.id]
        );
        await createPayment({ jobId: job.id, invoiceId: invoice.id, amount: 40 });

        await expect(getJobFinance(companyA, job.id, client)).resolves.toMatchObject({
            invoiced: 100,
            paid: 40,
            due: 60,
        });
    });

    test('CTRL-ZBPAY-DUE-GUARD: unlinked Zenbooker money credits Paid and Due', async () => {
        const job = await createJob();
        await createInvoice({ jobId: job.id, label: 'zb-unlinked', total: 100 });
        await createPayment({ jobId: job.id, amount: 40, source: 'zenbooker' });

        await expect(getJobFinance(companyA, job.id, client)).resolves.toMatchObject({
            invoiced: 100,
            paid: 40,
            due: 60,
        });
    });

    test('CTRL-ZBPAY-DUE-GUARD: linked Zenbooker stays materialized without double count', async () => {
        const job = await createJob();
        const invoice = await createInvoice({ jobId: job.id, label: 'zb-linked', total: 100 });
        await client.query(
            `UPDATE invoices
             SET amount_paid = 40, balance_due = 60, status = 'partial'
             WHERE company_id = $1 AND id = $2`,
            [companyA, invoice.id]
        );
        await createPayment({
            jobId: job.id,
            invoiceId: invoice.id,
            amount: 40,
            source: 'zenbooker',
        });

        await expect(getJobFinance(companyA, job.id, client)).resolves.toMatchObject({
            invoiced: 100,
            paid: 40,
            due: 60,
        });
    });

    test('job 1498: standalone ZB money reduces Due instead of inflating it', async () => {
        const job = await createJob();
        const first = await createInvoice({ jobId: job.id, label: 'job-1498-main', total: 1665.81 });
        await createInvoice({ jobId: job.id, label: 'job-1498-second', total: 125 });
        await createInvoice({ jobId: job.id, label: 'job-1498-third', total: 125 });
        await createPayment({ jobId: job.id, amount: 125, source: 'zenbooker' });
        await createPayment({ jobId: job.id, invoiceId: first.id, amount: 1665.81 });

        await expect(getJobFinance(companyA, job.id, client)).resolves.toMatchObject({
            invoiced: 1915.81,
            paid: 1790.81,
            due: 125,
        });
    });

    test('Zenbooker refund inherits its source and nets both Paid and Due', async () => {
        const job = await createJob();
        await createInvoice({ jobId: job.id, label: 'zb-refund', total: 100 });
        const original = await createPayment({
            jobId: job.id,
            amount: 100,
            source: 'zenbooker',
            status: 'refunded',
        });
        await createPayment({
            jobId: job.id,
            amount: -30,
            source: null,
            transactionType: 'refund',
            metadata: { original_transaction_id: original.id },
        });

        await expect(getJobFinance(companyA, job.id, client)).resolves.toMatchObject({
            invoiced: 100,
            paid: 70,
            due: 30,
        });
    });

    test('TXN-STATUS-VOID-001: refunded original is gross, refund nets, voided is zero', async () => {
        const job = await createJob();
        await createInvoice({ jobId: job.id, label: 'status-effects', total: 100 });
        const original = await createPayment({
            jobId: job.id,
            amount: 100,
            source: 'manual',
            status: 'refunded',
        });
        await createPayment({
            jobId: job.id,
            amount: -30,
            source: null,
            transactionType: 'refund',
            metadata: { original_transaction_id: original.id },
        });
        await createPayment({ jobId: job.id, amount: 40, source: 'manual', status: 'voided' });

        await expect(getJobFinance(companyA, job.id, client)).resolves.toMatchObject({
            invoiced: 100,
            paid: 70,
            due: 30,
        });
    });

    test('void invoice drops its materialized amount from Invoiced, Paid, and Due', async () => {
        const job = await createJob();
        const invoice = await createInvoice({ jobId: job.id, label: 'void-legacy', total: 100 });
        await client.query(
            `UPDATE invoices
             SET amount_paid = 100, balance_due = 0, status = 'void', voided_at = NOW()
             WHERE company_id = $1 AND id = $2`,
            [companyA, invoice.id]
        );

        await expect(getJobFinance(companyA, job.id, client)).resolves.toMatchObject({
            invoiced: 0,
            paid: 0,
            due: 0,
        });
    });

    test('uses invoice_id application when several active invoices exist', async () => {
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
            .toEqual({ amount_paid: 0, balance_due: 100, status: 'draft', allocated: 0 });
        expect(money(await invoicesQueries.getInvoiceById(companyA, newest.id, client)))
            .toEqual({ amount_paid: 150, balance_due: 0, status: 'paid', allocated: 150 });
        const [rollup] = await listJobPaymentRollups(companyA, [job.id], client);
        expect(Number(rollup.total_paid)).toBe(150);
        expect(Number(rollup.total_due)).toBe(50);
    });

    test('SAB-OB70-LONE-INVOICE: unapplied money appears only on the sole active invoice', async () => {
        const job = await createJob();
        const first = await createInvoice({ jobId: job.id, label: 'unapplied-first', total: 100 });
        const second = await createInvoice({ jobId: job.id, label: 'unapplied-second', total: 100 });
        await createPayment({ jobId: job.id, amount: 60 });

        expect(money(await invoicesQueries.getInvoiceById(companyA, first.id, client)))
            .toEqual({ amount_paid: 0, balance_due: 100, status: 'draft', allocated: 0 });
        expect(money(await invoicesQueries.getInvoiceById(companyA, second.id, client)))
            .toEqual({ amount_paid: 0, balance_due: 100, status: 'draft', allocated: 0 });

        const [beforeRemoval] = await listJobPaymentRollups(companyA, [job.id], client);
        expect({
            paid: Number(beforeRemoval.total_paid),
            due: Number(beforeRemoval.total_due),
        }).toEqual({ paid: 60, due: 140 });

        await expect(invoicesQueries.deleteInvoice(first.id, companyA, client)).resolves.toBe(true);

        expect(money(await invoicesQueries.getInvoiceById(companyA, second.id, client)))
            .toEqual({ amount_paid: 60, balance_due: 40, status: 'partial', allocated: 60 });
        const [afterRemoval] = await listJobPaymentRollups(companyA, [job.id], client);
        expect({
            paid: Number(afterRemoval.total_paid),
            due: Number(afterRemoval.total_due),
        }).toEqual({ paid: 60, due: 40 });
    });

    test('SAB-OB70-CREDIT-VISIBILITY: credit is exposed only when this invoice does not display it', async () => {
        const job = await createJob();
        const first = await createInvoice({ jobId: job.id, label: 'credit-first', total: 100 });
        const second = await createInvoice({ jobId: job.id, label: 'credit-second', total: 100 });
        await createPayment({ jobId: job.id, amount: 60 });

        const firstDetail = await invoicesQueries.getInvoiceById(companyA, first.id, client);
        const secondDetail = await invoicesQueries.getInvoiceById(companyA, second.id, client);
        expect(firstDetail).toMatchObject({
            amount_paid: '0.00',
            job_unapplied_credit: '60.00',
        });
        expect(secondDetail).toMatchObject({
            amount_paid: '0.00',
            job_unapplied_credit: '60.00',
        });

        const beforeList = await invoicesQueries.listInvoices(companyA, {
            jobId: job.id,
            limit: 10,
        });
        expect(beforeList.rows.map(invoice => invoice.job_unapplied_credit))
            .toEqual(['60.00', '60.00']);

        await expect(invoicesQueries.deleteInvoice(first.id, companyA, client)).resolves.toBe(true);

        const soleDetail = await invoicesQueries.getInvoiceById(companyA, second.id, client);
        expect(soleDetail).toMatchObject({
            amount_paid: '60.00',
            job_unapplied_credit: '0.00',
        });
        const afterList = await invoicesQueries.listInvoices(companyA, {
            jobId: job.id,
            limit: 10,
        });
        expect(afterList.rows).toHaveLength(1);
        expect(afterList.rows[0].job_unapplied_credit).toBe('0.00');

        const standalone = await createInvoice({
            jobId: null,
            label: 'credit-no-job',
            total: 25,
        });
        await expect(invoicesQueries.getInvoiceById(companyA, standalone.id, client))
            .resolves.toMatchObject({ job_unapplied_credit: '0.00' });
    });

    test('over-collection: full explicitly applied charge keeps invoice due at zero', async () => {
        const job = await createJob();
        const invoice = await createInvoice({
            jobId: job.id,
            label: 'over-collection',
            total: 30,
        });
        await createPayment({
            jobId: job.id,
            invoiceId: invoice.id,
            amount: 50,
            metadata: { tip: 0 },
        });

        expect(money(await invoicesQueries.getInvoiceById(companyA, invoice.id, client)))
            .toEqual({ amount_paid: 50, balance_due: 0, status: 'paid', allocated: 50 });
        const [rollup] = await listJobPaymentRollups(companyA, [job.id], client);
        expect(Number(rollup.total_paid)).toBe(50);
        // $20 over-collected → job Due goes negative (credit), not clamped to 0.
        expect(Number(rollup.total_due)).toBe(-20);
    });

    test.each(['draft', 'paid', 'sent', 'void'])(
        'general update cannot mass-assign status=%s or fabricate an event',
        async forcedStatus => {
            const job = await createJob();
            const invoice = await createInvoice({
                jobId: job.id,
                label: `status-guard-${forcedStatus}`,
                total: 30,
            });
            await invoicesQueries.updateInvoiceStatus(
                invoice.id,
                companyA,
                'sent',
                'sent_at',
                client
            );
            const { rows: beforeEvents } = await client.query(
                `SELECT COUNT(*)::INT AS count
                 FROM invoice_events
                 WHERE invoice_id = $1`,
                [invoice.id]
            );

            await expect(invoicesService.updateInvoice(
                companyA,
                userA,
                invoice.id,
                { status: forcedStatus },
                client,
                null
            )).rejects.toMatchObject({
                code: 'WORKFLOW_FIELD_READ_ONLY',
                httpStatus: 400,
            });

            const unchanged = await rawInvoice(companyA, invoice.id);
            expect(unchanged.status).toBe('sent');
            const { rows: afterEvents } = await client.query(
                `SELECT COUNT(*)::INT AS count
                 FROM invoice_events
                 WHERE invoice_id = $1`,
                [invoice.id]
            );
            expect(afterEvents[0].count).toBe(beforeEvents[0].count);
            await expect(invoicesService.deleteInvoice(
                companyA,
                invoice.id,
                userA,
                client,
                null
            )).rejects.toMatchObject({ code: 'INVALID_STATUS', httpStatus: 409 });
            expect(await rawInvoice(companyA, invoice.id)).not.toBeNull();
        }
    );

    test('status-qualified destructive queries reject wrong-status and foreign rows', async () => {
        const job = await createJob();
        const issued = await createInvoice({ jobId: job.id, label: 'delete-predicate', total: 10 });
        await invoicesQueries.updateInvoiceStatus(
            issued.id,
            companyA,
            'sent',
            'sent_at',
            client
        );
        const draft = await createInvoice({ jobId: job.id, label: 'void-predicate', total: 10 });

        await expect(invoicesQueries.deleteInvoice(issued.id, companyA, client)).resolves.toBe(false);
        await expect(invoicesQueries.deleteInvoice(issued.id, companyB, client)).resolves.toBe(false);
        await expect(invoicesQueries.voidIssuedInvoice(draft.id, companyA, client)).resolves.toBeNull();
        await expect(invoicesQueries.voidIssuedInvoice(issued.id, companyB, client)).resolves.toBeNull();

        expect((await rawInvoice(companyA, issued.id)).status).toBe('sent');
        expect((await rawInvoice(companyA, draft.id)).status).toBe('draft');
    });

    test('keeps linked Zenbooker money out of the pool, and lets standalone ZB money settle documents', async () => {
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

        // 40 legacy (the linked ZB payment, already materialized) + 20 allocated
        // from the pool (the standalone one) = 60 of the 100 settled.
        expect(money(await invoicesQueries.getInvoiceById(companyA, invoice.id, client)))
            .toEqual({ amount_paid: 60, balance_due: 40, status: 'partial', allocated: 20 });
        // The $40 LINKED ZB payment stays out of the pool — it is already inside
        // the invoice's legacy amount_paid, and counting it again would settle
        // the same money twice. The $20 STANDALONE one is nowhere else, so it
        // reduces what is owed. The old contract dropped both, which is why real
        // Zenbooker money ($288,840 across 1403 payments, none of them linked)
        // never reached a document (corrected 2026-08-16).
        const [rollup] = await listJobPaymentRollups(companyA, [job.id], client);
        expect(Number(rollup.total_paid)).toBe(60);
        expect(Number(rollup.total_due)).toBe(40);
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
        // 20 legacy deposit + 75 stripe + 30 standalone Zenbooker: the ZB payment
        // carries no invoice, so it is real money the estimate must reflect.
        expect(Number(serialized.deposit_paid)).toBe(125);
        expect(Number(serialized.balance_due)).toBe(75);
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
