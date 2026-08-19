'use strict';

const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const db = require('../backend/src/db/connection');
const invoicesQueries = require('../backend/src/db/invoicesQueries');

jest.setTimeout(30000);

const MIGRATION = fs.readFileSync(
    path.join(__dirname, '..', 'backend', 'db', 'migrations', '287_invoice_percentage_discounts.sql'),
    'utf8'
);
const ROLLBACK = fs.readFileSync(
    path.join(__dirname, '..', 'backend', 'db', 'migrations', 'rollback_287_invoice_percentage_discounts.sql'),
    'utf8'
);
const ORDER_LIST_PREREQUISITE = fs.readFileSync(
    path.join(__dirname, '..', 'backend', 'db', 'migrations', '207_estimate_invoice_order_list.sql'),
    'utf8'
);
const TAG = `ob69-${Date.now().toString(36)}-${process.pid}`;

let client;
let companyA;
let companyB;
let legacyFixedId;
let legacyZeroId;

async function createInvoice(companyId, suffix, discountType, discountValue, amount) {
    const invoice = await invoicesQueries.createInvoice(companyId, {
        invoice_number: `${TAG}-${suffix}`,
        title: suffix,
        tax_rate: 0,
        discount_type: discountType,
        discount_value: discountValue,
        currency: 'USD',
        created_by: null,
    }, client);
    await invoicesQueries.addInvoiceItem(companyId, invoice.id, {
        name: 'Line item',
        quantity: 1,
        unit_price: amount,
        taxable: false,
    }, client);
    return invoicesQueries.recalculateInvoiceTotals(companyId, invoice.id, client);
}

beforeAll(async () => {
    client = await db.pool.connect();
    await client.query('BEGIN');
    await client.query(ROLLBACK);
    await client.query(ORDER_LIST_PREREQUISITE);

    companyA = randomUUID();
    companyB = randomUUID();
    await client.query(
        `INSERT INTO companies (id, name, slug)
         VALUES ($1, $2, $3), ($4, $5, $6)`,
        [companyA, `OB-69 A ${TAG}`, `${TAG}-a`, companyB, `OB-69 B ${TAG}`, `${TAG}-b`]
    );

    const legacy = await client.query(
        `INSERT INTO invoices (company_id, invoice_number, title, discount_amount)
         VALUES
            ($1, $2, 'Legacy fixed', 25),
            ($1, $3, 'Legacy zero', 0)
         RETURNING id, title`,
        [companyA, `${TAG}-legacy-fixed`, `${TAG}-legacy-zero`]
    );
    legacyFixedId = legacy.rows.find(row => row.title === 'Legacy fixed').id;
    legacyZeroId = legacy.rows.find(row => row.title === 'Legacy zero').id;

    await client.query(MIGRATION);
    await client.query(MIGRATION);
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

test('migration 287 backfills legacy amounts and enforces the estimate discount domain', async () => {
    const { rows } = await client.query(
        `SELECT id, discount_type, discount_value
         FROM invoices
         WHERE company_id = $1 AND id = ANY($2::bigint[])
         ORDER BY id`,
        [companyA, [legacyFixedId, legacyZeroId]]
    );
    expect(rows).toEqual([
        { id: legacyFixedId, discount_type: 'fixed', discount_value: '25.00' },
        { id: legacyZeroId, discount_type: null, discount_value: '0.00' },
    ]);

    await client.query('SAVEPOINT invalid_discount_type');
    await expect(client.query(
        `UPDATE invoices
         SET discount_type = 'percent'
         WHERE id = $1 AND company_id = $2`,
        [legacyFixedId, companyA]
    )).rejects.toMatchObject({ code: '23514' });
    await client.query('ROLLBACK TO SAVEPOINT invalid_discount_type');
});

test('create and edit round-trip fixed/percentage fields and derive discount_amount', async () => {
    const fixed = await createInvoice(companyA, 'fixed', 'fixed', 25, 125);
    expect(fixed).toMatchObject({
        discount_type: 'fixed',
        discount_value: '25.00',
        discount_amount: '25.00',
        subtotal: '125.00',
        total: '100.00',
    });

    const percentage = await createInvoice(companyA, 'percentage', 'percentage', 10, 123.45);
    expect(percentage).toMatchObject({
        discount_type: 'percentage',
        discount_value: '10.00',
        discount_amount: '12.35',
        subtotal: '123.45',
        total: '111.10',
    });

    await invoicesQueries.updateInvoice(percentage.id, companyA, {
        discount_type: 'fixed',
        discount_value: 20,
        discount_amount: 999,
    }, client);
    const edited = await invoicesQueries.recalculateInvoiceTotals(
        companyA,
        percentage.id,
        client
    );
    expect(edited).toMatchObject({
        discount_type: 'fixed',
        discount_value: '20.00',
        discount_amount: '20.00',
        total: '103.45',
    });

    const legacy = await invoicesQueries.createInvoice(companyA, {
        invoice_number: `${TAG}-amount-only`,
        title: 'Amount-only caller',
        discount_amount: 30,
        currency: 'USD',
        created_by: null,
    }, client);
    await invoicesQueries.addInvoiceItem(companyA, legacy.id, {
        name: 'Legacy line item',
        quantity: 1,
        unit_price: 100,
        taxable: false,
    }, client);
    const amountOnly = await invoicesQueries.recalculateInvoiceTotals(
        companyA,
        legacy.id,
        client
    );
    expect(amountOnly).toMatchObject({
        discount_type: null,
        discount_value: '0.00',
        discount_amount: '30.00',
        total: '70.00',
    });
});

test('database derivation clamps a fixed discount to subtotal as defense in depth', async () => {
    const fixed = await createInvoice(companyA, 'fixed-clamp', 'fixed', 500, 125);
    expect(fixed).toMatchObject({
        discount_type: 'fixed',
        discount_value: '500.00',
        discount_amount: '125.00',
        total: '0.00',
    });
});

test('T-own/T-foreign/T-blast: foreign discount writes return no row and change nothing', async () => {
    const foreign = await createInvoice(companyB, 'foreign', 'percentage', 15, 200);
    const before = await client.query(
        `SELECT row_to_json(i)::text AS snapshot
         FROM invoices i
         WHERE id = $1 AND company_id = $2`,
        [foreign.id, companyB]
    );

    await expect(invoicesQueries.updateInvoice(foreign.id, companyA, {
        discount_type: 'fixed',
        discount_value: 1,
    }, client)).resolves.toBeNull();
    await expect(invoicesQueries.recalculateInvoiceTotals(companyA, foreign.id, client))
        .resolves.toBeNull();

    const after = await client.query(
        `SELECT row_to_json(i)::text AS snapshot
         FROM invoices i
         WHERE id = $1 AND company_id = $2`,
        [foreign.id, companyB]
    );
    expect(after.rows[0].snapshot).toBe(before.rows[0].snapshot);
});

test('rollback 287 removes only the invoice source discount columns and can be reapplied', async () => {
    await client.query(ROLLBACK);
    await client.query(ROLLBACK);

    const removed = await client.query(
        `SELECT column_name
         FROM information_schema.columns
         WHERE table_schema = current_schema()
           AND table_name = 'invoices'
           AND column_name IN ('discount_type', 'discount_value')`
    );
    expect(removed.rows).toEqual([]);

    await client.query(MIGRATION);
    const restored = await client.query(
        `SELECT column_name
         FROM information_schema.columns
         WHERE table_schema = current_schema()
           AND table_name = 'invoices'
           AND column_name IN ('discount_type', 'discount_value')
         ORDER BY column_name`
    );
    expect(restored.rows.map(row => row.column_name)).toEqual([
        'discount_type',
        'discount_value',
    ]);
});
