'use strict';

const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const db = require('../backend/src/db/connection');
const invoicesQueries = require('../backend/src/db/invoicesQueries');
const { listJobPaymentRollups } = require('../backend/src/db/jobFinanceQueries');
const invoiceRemovalService = require('../backend/src/services/invoiceRemovalService');

jest.setTimeout(60000);

const TAG = `OB70-${Date.now().toString(36)}-${process.pid}`;
const MIGRATIONS = [
    '207_estimate_invoice_order_list.sql',
    '287_invoice_percentage_discounts.sql',
    '288_invoice_removal.sql',
].map(file => fs.readFileSync(
    path.join(__dirname, '..', 'backend', 'db', 'migrations', file),
    'utf8'
));

let client;
let originalQuery;
let companyA;
let companyB;
let userA;
let userB;
let contactA;
let contactB;

async function createJob(companyId = companyA, contactId = contactA) {
    const { rows } = await client.query(
        `INSERT INTO jobs (company_id, contact_id, job_number, blanc_status)
         VALUES ($1, $2, $3, 'Submitted')
         RETURNING *`,
        [companyId, contactId, `${TAG}-${randomUUID().slice(0, 8)}`]
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
}) {
    const invoice = await invoicesQueries.createInvoice(companyId, {
        contact_id: contactId,
        job_id: jobId,
        invoice_number: `${TAG}-${label}`,
        currency: 'USD',
        created_by: userId,
    }, client);
    await invoicesQueries.addInvoiceItem(companyId, invoice.id, {
        name: label,
        quantity: 1,
        unit_price: total,
        taxable: false,
    }, client);
    await invoicesQueries.recalculateInvoiceTotals(companyId, invoice.id, client);
    return invoicesQueries.getInvoiceById(companyId, invoice.id, client);
}

async function createPayment({
    companyId = companyA,
    userId = userA,
    jobId,
    invoiceId,
    amount,
    externalId = `${TAG}-${randomUUID()}`,
    metadata = {},
    status = 'completed',
}) {
    const { rows } = await client.query(
        `INSERT INTO payment_transactions (
            company_id, job_id, invoice_id, transaction_type, payment_method,
            status, amount, currency, external_id, external_source, metadata,
            processed_at, recorded_by
         ) VALUES (
            $1, $2, $3, 'payment', 'cash',
            $4, $5, 'USD', $6, 'manual', $7::jsonb,
            NOW(), $8
         )
         RETURNING *`,
        [
            companyId,
            jobId,
            invoiceId,
            status,
            amount,
            externalId,
            JSON.stringify(metadata),
            userId,
        ]
    );
    return rows[0];
}

async function paymentSnapshot(companyId, paymentId) {
    const { rows } = await client.query(
        `SELECT id, company_id, job_id, invoice_id, origin_invoice_id,
                transaction_type, status, amount, currency, external_id, external_source
         FROM payment_transactions
         WHERE company_id = $1 AND id = $2`,
        [companyId, paymentId]
    );
    return rows[0] || null;
}

function removalChoice(preview, paymentAction = 'leave_unapplied', targetInvoiceId = null) {
    return {
        preview_version: preview.preview_version,
        request_id: randomUUID(),
        payment_action: paymentAction,
        ...(targetInvoiceId == null ? {} : { target_invoice_id: targetInvoiceId }),
    };
}

beforeAll(async () => {
    originalQuery = db.query;
    client = await db.pool.connect();
    await client.query('BEGIN');
    db.query = (text, params) => client.query(text, params);
    // The shared dev DB intentionally lags the newest numbering migration; add
    // only the read-contract column inside this rolled-back test transaction.
    await client.query(
        'ALTER TABLE jobs ADD COLUMN IF NOT EXISTS job_seq INTEGER, '
        + 'ADD COLUMN IF NOT EXISTS public_code TEXT'
    );
    for (const migration of MIGRATIONS) await client.query(migration);

    companyA = randomUUID();
    companyB = randomUUID();
    userA = randomUUID();
    userB = randomUUID();
    await client.query(
        `INSERT INTO companies (id, name, slug)
         VALUES ($1, $2, $3), ($4, $5, $6)`,
        [
            companyA, `${TAG} A`, `${TAG.toLowerCase()}-a`,
            companyB, `${TAG} B`, `${TAG.toLowerCase()}-b`,
        ]
    );
    await client.query(
        `INSERT INTO crm_users (id, keycloak_sub, email, full_name, company_id)
         VALUES ($1, $2, $3, 'OB70 A', $4),
                ($5, $6, $7, 'OB70 B', $8)`,
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
        try { await client.query('ROLLBACK'); } finally { client.release(); }
    }
    await db.pool.end();
});

describe('INVOICE-REMOVE-001 real PostgreSQL contract', () => {
    test('SAB-OB70-NO-SILENT-MATCH: preview proposes but leave_unapplied only changes application', async () => {
        const job = await createJob();
        const source = await createInvoice({ jobId: job.id, label: 'leave-source', total: 100 });
        const target = await createInvoice({ jobId: job.id, label: 'leave-target', total: 100 });
        const payment = await createPayment({
            jobId: job.id,
            invoiceId: source.id,
            amount: 115,
            metadata: { tip: 15 },
        });
        await client.query(
            `INSERT INTO stripe_payment_sessions (
                company_id, invoice_id, job_id, contact_id, created_by, surface,
                amount, currency, status, stripe_payment_intent_id, metadata
             ) VALUES ($1, $2, $3, $4, $5, 'manual_card', 115, 'USD', 'open', $6, $7)`,
            [companyA, source.id, job.id, contactA, userA, `${TAG}-pi-late`, JSON.stringify({ tip: 15 })]
        );
        const before = await paymentSnapshot(companyA, payment.id);

        const preview = await invoiceRemovalService.previewInvoiceRemoval(companyA, source.id, client);

        expect(preview).toMatchObject({
            disposition: 'voided',
            payments_total: '100.00',
            payments_count: 1,
            candidate: {
                id: target.id,
                balance_due: '100.00',
            },
        });
        expect(await paymentSnapshot(companyA, payment.id)).toEqual(before);

        const removed = await invoiceRemovalService.removeInvoice(
            companyA,
            source.id,
            userA,
            removalChoice(preview),
            client,
            null
        );
        expect(removed).toMatchObject({
            disposition: 'void',
            payment_action: 'leave_unapplied',
            job_finance: {
                estimated: 0,
                invoiced: 100,
                paid: 100,
                due: 0,
                tips: 15,
                unapplied_credit: 100,
            },
        });

        const after = await paymentSnapshot(companyA, payment.id);
        expect(after).toMatchObject({
            invoice_id: null,
            origin_invoice_id: source.id,
            job_id: job.id,
            amount: before.amount,
            status: before.status,
            external_id: before.external_id,
        });
        const targetView = await invoicesQueries.getInvoiceById(companyA, target.id, client);
        expect(Number(targetView.amount_paid)).toBe(100);
        expect(Number(targetView.balance_due)).toBe(0);
        const { rows: sessions } = await client.query(
            `SELECT invoice_id, job_id, status, metadata
             FROM stripe_payment_sessions
             WHERE company_id = $1 AND stripe_payment_intent_id = $2`,
            [companyA, `${TAG}-pi-late`]
        );
        expect(sessions[0]).toMatchObject({ invoice_id: null, job_id: job.id, status: 'open' });
        expect(sessions[0].metadata).toMatchObject({
            removed_invoice_id: String(source.id),
            removed_invoice_number: source.invoice_number,
        });
    });

    test('SAB-OB70-APPLICATION-ONLY: multiple payments start at balance-due matching and move whole rows', async () => {
        const job = await createJob();
        const distractor = await createInvoice({ jobId: job.id, label: 'multi-total-trap', total: 195 });
        await createPayment({ jobId: job.id, invoiceId: distractor.id, amount: 95 });
        const target = await createInvoice({ jobId: job.id, label: 'multi-balance', total: 250 });
        await createPayment({ jobId: job.id, invoiceId: target.id, amount: 55 });
        const source = await createInvoice({ jobId: job.id, label: 'multi-source', total: 195 });
        const first = await createPayment({ jobId: job.id, invoiceId: source.id, amount: 95 });
        const second = await createPayment({ jobId: job.id, invoiceId: source.id, amount: 100 });
        const beforeFirst = await paymentSnapshot(companyA, first.id);
        const beforeSecond = await paymentSnapshot(companyA, second.id);

        const preview = await invoiceRemovalService.previewInvoiceRemoval(companyA, source.id, client);
        expect(preview).toMatchObject({ payments_total: '195.00', payments_count: 2 });
        expect(preview.candidate).toMatchObject({
            id: target.id,
            balance_due: '195.00',
        });

        await invoiceRemovalService.removeInvoice(
            companyA,
            source.id,
            userA,
            removalChoice(preview, 'apply', target.id),
            client,
            null
        );

        for (const [before, id] of [[beforeFirst, first.id], [beforeSecond, second.id]]) {
            const after = await paymentSnapshot(companyA, id);
            expect(after).toMatchObject({
                invoice_id: target.id,
                origin_invoice_id: source.id,
                job_id: before.job_id,
                amount: before.amount,
                status: before.status,
                external_id: before.external_id,
                external_source: before.external_source,
            });
        }
        const targetView = await invoicesQueries.getInvoiceById(companyA, target.id, client);
        expect(Number(targetView.amount_paid)).toBe(250);
        expect(Number(targetView.balance_due)).toBe(0);
    });

    test('SAB-OB70-MONEY-PRESERVE: nets refund and preserves both immutable ledger rows', async () => {
        const job = await createJob();
        const source = await createInvoice({ jobId: job.id, label: 'refund-source', total: 100 });
        const target = await createInvoice({ jobId: job.id, label: 'refund-target', total: 70 });
        const original = await createPayment({
            jobId: job.id,
            invoiceId: source.id,
            amount: 100,
            status: 'refunded',
        });
        const { rows: refunds } = await client.query(
            `INSERT INTO payment_transactions (
                company_id, job_id, invoice_id, transaction_type, payment_method,
                status, amount, currency, external_id, external_source, metadata,
                processed_at, recorded_by
             ) VALUES (
                $1, $2, $3, 'refund', 'cash',
                'completed', -30, 'USD', $4, 'manual', $5::jsonb,
                NOW(), $6
             )
             RETURNING *`,
            [
                companyA,
                job.id,
                source.id,
                `${TAG}-refund-${randomUUID()}`,
                JSON.stringify({ original_transaction_id: original.id }),
                userA,
            ]
        );

        const preview = await invoiceRemovalService.previewInvoiceRemoval(companyA, source.id, client);
        expect(preview).toMatchObject({ payments_total: '70.00', payments_count: 1 });
        expect(preview.candidate).toMatchObject({ id: target.id, balance_due: '70.00' });
        await invoiceRemovalService.removeInvoice(
            companyA,
            source.id,
            userA,
            removalChoice(preview),
            client,
            null
        );

        expect(await paymentSnapshot(companyA, original.id)).toMatchObject({
            invoice_id: null,
            origin_invoice_id: source.id,
            status: 'refunded',
            amount: '100.00',
        });
        expect(await paymentSnapshot(companyA, refunds[0].id)).toMatchObject({
            invoice_id: null,
            origin_invoice_id: source.id,
            transaction_type: 'refund',
            status: 'completed',
            amount: '-30.00',
        });
    });

    test('allows whole-payment over-application with document floor and negative job due', async () => {
        const job = await createJob();
        const target = await createInvoice({ jobId: job.id, label: 'over-target', total: 100 });
        await createInvoice({ jobId: job.id, label: 'over-other', total: 50 });
        const source = await createInvoice({ jobId: job.id, label: 'over-source', total: 195 });
        await createPayment({ jobId: job.id, invoiceId: source.id, amount: 195 });

        const preview = await invoiceRemovalService.previewInvoiceRemoval(companyA, source.id, client);
        expect(preview.candidate).toMatchObject({ id: target.id, balance_due: '100.00' });
        await invoiceRemovalService.removeInvoice(
            companyA,
            source.id,
            userA,
            removalChoice(preview, 'apply', target.id),
            client,
            null
        );

        const targetView = await invoicesQueries.getInvoiceById(companyA, target.id, client);
        expect(Number(targetView.amount_paid)).toBe(195);
        expect(Number(targetView.balance_due)).toBe(0);
        expect(targetView.status).toBe('paid');
        const [rollup] = await listJobPaymentRollups(companyA, [job.id], client);
        expect(Number(rollup.total_paid)).toBe(195);
        expect(Number(rollup.total_due)).toBe(-45);
    });

    test('SAB-OB70-AUDIT-BOUNDARY: pristine draft deletes, history-bearing draft voids', async () => {
        const job = await createJob();
        const pristine = await createInvoice({ jobId: job.id, label: 'pristine', total: 10 });
        const pristinePreview = await invoiceRemovalService.previewInvoiceRemoval(
            companyA,
            pristine.id,
            client
        );
        expect(pristinePreview.disposition).toBe('deleted');
        const first = await invoiceRemovalService.removeInvoice(
            companyA,
            pristine.id,
            userA,
            removalChoice(pristinePreview),
            client,
            null
        );
        expect(first).toMatchObject({ disposition: 'delete', idempotent: false });
        expect(await invoicesQueries.getInvoiceById(companyA, pristine.id, client)).toBeNull();

        const linked = await createInvoice({ jobId: job.id, label: 'public-history', total: 10 });
        await client.query(
            `UPDATE invoices SET public_token = $3 WHERE company_id = $1 AND id = $2`,
            [companyA, linked.id, randomUUID()]
        );
        const linkedPreview = await invoiceRemovalService.previewInvoiceRemoval(companyA, linked.id, client);
        expect(linkedPreview.disposition).toBe('voided');
        await invoiceRemovalService.removeInvoice(
            companyA,
            linked.id,
            userA,
            removalChoice(linkedPreview),
            client,
            null
        );
        const { rows: retained } = await client.query(
            `SELECT status, public_token FROM invoices WHERE company_id = $1 AND id = $2`,
            [companyA, linked.id]
        );
        expect(retained[0]).toMatchObject({ status: 'void', public_token: expect.any(String) });

        const legacyPaid = await createInvoice({
            jobId: job.id,
            label: 'legacy-paid-marker',
            total: 20,
        });
        await client.query(
            `UPDATE invoices
             SET amount_paid = 5, balance_due = total - 5
             WHERE company_id = $1 AND id = $2`,
            [companyA, legacyPaid.id]
        );
        const legacyPreview = await invoiceRemovalService.previewInvoiceRemoval(
            companyA,
            legacyPaid.id,
            client
        );
        expect(legacyPreview.disposition).toBe('voided');
        await expect(
            invoicesQueries.deleteInvoice(legacyPaid.id, companyA, client)
        ).resolves.toBe(false);
        expect(await invoicesQueries.getInvoiceById(companyA, legacyPaid.id, client)).not.toBeNull();
    });

    test('SAB-OB70-IDEMPOTENCY: replay removes once and a stale preview writes nothing', async () => {
        const job = await createJob();
        const source = await createInvoice({ jobId: job.id, label: 'idempotent', total: 10 });
        const preview = await invoiceRemovalService.previewInvoiceRemoval(companyA, source.id, client);
        const choice = removalChoice(preview);

        const first = await invoiceRemovalService.removeInvoice(
            companyA,
            source.id,
            userA,
            choice,
            client,
            null
        );
        const replay = await invoiceRemovalService.removeInvoice(
            companyA,
            source.id,
            userA,
            choice,
            client,
            null
        );
        expect(replay).toMatchObject({ removal_id: first.removal_id, idempotent: true });
        const { rows: counts } = await client.query(
            `SELECT COUNT(*)::INTEGER AS count
             FROM invoice_removals
             WHERE company_id = $1 AND source_invoice_id = $2`,
            [companyA, source.id]
        );
        expect(counts[0].count).toBe(1);

        const stale = await createInvoice({ jobId: job.id, label: 'stale-preview', total: 10 });
        const stalePreview = await invoiceRemovalService.previewInvoiceRemoval(companyA, stale.id, client);
        await invoicesQueries.createEvent(
            companyA,
            stale.id,
            'updated',
            'user',
            userA,
            { fields: ['notes'] },
            client
        );
        await expect(invoiceRemovalService.removeInvoice(
            companyA,
            stale.id,
            userA,
            removalChoice(stalePreview),
            client,
            null
        )).rejects.toMatchObject({ code: 'PREVIEW_STALE', httpStatus: 409 });
        expect(await invoicesQueries.getInvoiceById(companyA, stale.id, client)).not.toBeNull();
    });

    test('SAB-OB70-TENANT-DETACH: T-foreign/T-blast leave the other company byte-unchanged', async () => {
        const jobA = await createJob();
        const jobB = await createJob(companyB, contactB);
        const invoiceA = await createInvoice({ jobId: jobA.id, label: 'tenant-a', total: 25 });
        const invoiceB = await createInvoice({
            companyId: companyB,
            contactId: contactB,
            userId: userB,
            jobId: jobB.id,
            label: 'tenant-b',
            total: 25,
        });
        const sharedExternalId = `${TAG}-shared-natural-key`;
        await createPayment({
            jobId: jobA.id,
            invoiceId: invoiceA.id,
            amount: 25,
            externalId: sharedExternalId,
        });
        const paymentB = await createPayment({
            companyId: companyB,
            userId: userB,
            jobId: jobB.id,
            invoiceId: invoiceB.id,
            amount: 25,
            externalId: sharedExternalId,
        });
        const beforeB = await paymentSnapshot(companyB, paymentB.id);

        await expect(
            invoiceRemovalService.previewInvoiceRemoval(companyA, invoiceB.id, client)
        ).rejects.toMatchObject({ code: 'NOT_FOUND', httpStatus: 404 });
        const previewA = await invoiceRemovalService.previewInvoiceRemoval(companyA, invoiceA.id, client);
        await invoiceRemovalService.removeInvoice(
            companyA,
            invoiceA.id,
            userA,
            removalChoice(previewA),
            client,
            null
        );

        expect(await paymentSnapshot(companyB, paymentB.id)).toEqual(beforeB);
        const foreignInvoice = await invoicesQueries.getInvoiceById(companyB, invoiceB.id, client);
        expect(foreignInvoice.status).not.toBe('void');
    });

    test('blocks an anomalous cross-company reference instead of partly detaching it', async () => {
        const jobA = await createJob();
        const jobB = await createJob(companyB, contactB);
        const source = await createInvoice({ jobId: jobA.id, label: 'cross-ref', total: 15 });
        const foreignPayment = await createPayment({
            companyId: companyB,
            userId: userB,
            jobId: jobB.id,
            invoiceId: source.id,
            amount: 15,
        });
        const before = await paymentSnapshot(companyB, foreignPayment.id);

        await expect(
            invoiceRemovalService.previewInvoiceRemoval(companyA, source.id, client)
        ).rejects.toMatchObject({ code: 'TENANT_INTEGRITY_BLOCKED', httpStatus: 409 });
        expect(await paymentSnapshot(companyB, foreignPayment.id)).toEqual(before);
        expect((await invoicesQueries.getInvoiceById(companyA, source.id, client)).status)
            .not.toBe('void');
    });
});
