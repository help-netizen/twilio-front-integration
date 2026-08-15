'use strict';

/**
 * ESTIMATE-REDESIGN-001 P2 — real-PostgreSQL tenancy proof for conversion Undo.
 * Production queries run inside one rolled-back transaction.
 */

const { randomUUID } = require('crypto');
const db = require('../backend/src/db/connection');
const estimatesQueries = require('../backend/src/db/estimatesQueries');
const estimatesService = require('../backend/src/services/estimatesService');
const { getFactory } = require('../backend/src/services/documentTemplates/factory');

jest.setTimeout(30000);

const TAG = `ECU-${Date.now().toString(36)}-${process.pid}`;
let client;
let originalQuery;
let companyA;
let companyB;
let estimateA;
let estimateB;
let invoiceA;
let invoiceB;

async function seedCompany(label) {
    const id = randomUUID();
    await client.query(
        `INSERT INTO companies (id, name, slug)
         VALUES ($1, $2, $3)`,
        [id, `Conversion Undo ${label} ${TAG}`, `${TAG}-${label}`.toLowerCase()]
    );
    await client.query(
        `INSERT INTO document_templates
            (company_id, document_type, name, slug, is_default, schema_version, content)
         VALUES ($1, 'invoice', 'Default', 'default', true, 1, $2::jsonb)`,
        [id, JSON.stringify(getFactory('invoice'))]
    );
    return id;
}

async function seedApprovedEstimate(companyId) {
    const estimate = await estimatesQueries.createEstimate(companyId, {
        estimate_number: `${TAG}-SHARED`,
        estimate_sequence: 1,
        summary: 'Tenant-isolated conversion',
        currency: 'USD',
        created_by: null,
    }, client);
    await estimatesQueries.addEstimateItem(companyId, estimate.id, {
        name: 'Diagnostic labor',
        quantity: 1,
        unit_price: 125,
        taxable: false,
    }, client);
    await estimatesQueries.recalculateEstimateTotals(companyId, estimate.id, client);
    await estimatesQueries.updateEstimateStatus(
        estimate.id,
        companyId,
        'approved',
        'accepted_at',
        client
    );
    return estimatesQueries.getEstimateById(companyId, estimate.id, client);
}

async function tenantSnapshot(companyId, estimateId, invoiceId) {
    const { rows } = await client.query(
        `SELECT
            (SELECT to_jsonb(e) FROM estimates e
             WHERE e.id = $2 AND e.company_id = $1) AS estimate,
            (SELECT to_jsonb(i) FROM invoices i
             WHERE i.id = $3 AND i.company_id = $1) AS invoice,
            (SELECT COALESCE(jsonb_agg(to_jsonb(ii) ORDER BY ii.id), '[]'::jsonb)
             FROM invoice_items ii
             JOIN invoices owner ON owner.id = ii.invoice_id AND owner.company_id = $1
             WHERE ii.invoice_id = $3) AS items,
            (SELECT COALESCE(jsonb_agg(to_jsonb(ee) ORDER BY ee.id), '[]'::jsonb)
             FROM estimate_events ee
             JOIN estimates owner ON owner.id = ee.estimate_id AND owner.company_id = $1
             WHERE ee.estimate_id = $2) AS events`,
        [companyId, estimateId, invoiceId]
    );
    return rows[0];
}

beforeAll(async () => {
    originalQuery = db.query;
    client = await db.pool.connect();
    await client.query('BEGIN');
    db.query = (text, params) => client.query(text, params);

    // The shared local test DB can lag committed migration 207. Add its two
    // columns only inside this rolled-back test transaction so the production
    // conversion queries can run without mutating the developer database.
    await client.query(
        `ALTER TABLE estimates
            ADD COLUMN IF NOT EXISTS order_list JSONB NOT NULL DEFAULT '[]'::jsonb;
         ALTER TABLE invoices
            ADD COLUMN IF NOT EXISTS order_list JSONB NOT NULL DEFAULT '[]'::jsonb;`
    );

    companyA = await seedCompany('a');
    companyB = await seedCompany('b');
    estimateA = await seedApprovedEstimate(companyA);
    estimateB = await seedApprovedEstimate(companyB);
    invoiceA = await estimatesService.convertToInvoice(
        companyA,
        null,
        estimateA.id,
        client
    );
    invoiceB = await estimatesService.convertToInvoice(
        companyB,
        null,
        estimateB.id,
        client
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

test('T-foreign returns 404 and leaves the foreign estimate/invoice unchanged', async () => {
    const beforeA = await tenantSnapshot(companyA, estimateA.id, invoiceA.id);

    await expect(estimatesService.undoInvoiceConversion(
        companyB,
        null,
        estimateA.id,
        invoiceA.id,
        client
    )).rejects.toMatchObject({ code: 'NOT_FOUND', httpStatus: 404 });

    expect(await tenantSnapshot(companyA, estimateA.id, invoiceA.id)).toStrictEqual(beforeA);
});

test('T-own/T-blast undoes only A despite the same estimate number in A and B', async () => {
    const beforeB = await tenantSnapshot(companyB, estimateB.id, invoiceB.id);

    const undone = await estimatesService.undoInvoiceConversion(
        companyA,
        null,
        estimateA.id,
        invoiceA.id,
        client
    );

    expect(undone).toMatchObject({
        invoice_id: invoiceA.id,
        undone: true,
        estimate: { id: estimateA.id, status: 'approved', invoice_id: null },
    });
    expect((await client.query(
        `SELECT COUNT(*)::INTEGER AS count
         FROM invoices
         WHERE company_id = $1 AND estimate_id = $2`,
        [companyA, estimateA.id]
    )).rows[0].count).toBe(0);
    expect((await client.query(
        `SELECT event_type, actor_type, actor_id, metadata
         FROM estimate_events
         WHERE estimate_id = $2
           AND EXISTS (
               SELECT 1 FROM estimates e
               WHERE e.id = estimate_events.estimate_id AND e.company_id = $1
           )
         ORDER BY id DESC
         LIMIT 1`,
        [companyA, estimateA.id]
    )).rows[0]).toMatchObject({
        event_type: 'conversion_undone',
        actor_type: 'user',
        actor_id: null,
        metadata: {
            invoice_id: invoiceA.id,
            restored_status: 'approved',
            source: 'internal_undo',
        },
    });
    expect(await tenantSnapshot(companyB, estimateB.id, invoiceB.id)).toStrictEqual(beforeB);
});

/**
 * The blocker that matters most, proven against real SQL rather than a mock.
 *
 * The unit suite asserts the SERVICE refuses when the payment flag is set, and
 * the tests above prove tenancy — but nothing ran the query that decides the
 * flag. Blanking that EXISTS clause left every suite green while Undo would
 * happily delete an invoice with money recorded against it. This is the test
 * that goes red for it.
 */
test('a paid invoice can never be undone away', async () => {
    const companyC = await seedCompany('c');
    const estimateC = await seedApprovedEstimate(companyC);
    const invoiceC = await estimatesService.convertToInvoice(companyC, null, estimateC.id, client);

    // Only the columns this table has required since it was created — the shared
    // local database lags later migrations, and a test that needs today's schema
    // to prove a guard is a test nobody can run.
    await client.query(
        `INSERT INTO payment_transactions
            (company_id, invoice_id, transaction_type, payment_method, amount)
         VALUES ($1, $2, 'payment', 'cash', 125)`,
        [companyC, invoiceC.id]
    );

    const blockers = await require('../backend/src/db/invoicesQueries')
        .getConversionUndoBlockers(companyC, invoiceC.id, estimateC.id, client);
    expect(blockers.has_payment_activity).toBe(true);

    await expect(estimatesService.undoInvoiceConversion(
        companyC,
        null,
        estimateC.id,
        invoiceC.id,
        client
    )).rejects.toMatchObject({ httpStatus: 409 });

    // The money and the invoice are both still there.
    expect((await client.query(
        `SELECT COUNT(*)::INTEGER AS count FROM invoices
         WHERE id = $1 AND company_id = $2`,
        [invoiceC.id, companyC]
    )).rows[0].count).toBe(1);
});
