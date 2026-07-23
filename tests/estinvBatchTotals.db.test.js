'use strict';

/**
 * ESTINV-BACKEND — real-PostgreSQL coverage for the shared estimate/invoice
 * totals contract. These tests execute the production query modules; they do
 * not inspect SQL strings or mock the recalculation boundary.
 */

const { randomUUID } = require('crypto');
const db = require('../backend/src/db/connection');
const estimatesQueries = require('../backend/src/db/estimatesQueries');
const invoicesQueries = require('../backend/src/db/invoicesQueries');
const estimatesService = require('../backend/src/services/estimatesService');
const { getFactory } = require('../backend/src/services/documentTemplates/factory');

jest.setTimeout(30000);

const TAG = `EIB-${Date.now().toString(36)}-${process.pid}`;
let client;
let companyId;
let originalQuery;

function amounts(row) {
    return {
        subtotal: Number(row.subtotal),
        discount_amount: Number(row.discount_amount),
        tax_amount: Number(row.tax_amount),
        total: Number(row.total),
        balance_due: Number(row.balance_due),
    };
}

async function createInvoice({ label, taxRate, discountAmount, amountPaid = 0, items }) {
    const invoice = await invoicesQueries.createInvoice(companyId, {
        invoice_number: `${TAG}-${label}`,
        title: label,
        tax_rate: taxRate,
        discount_amount: discountAmount,
        currency: 'USD',
        created_by: null,
    });

    for (const item of items) {
        await invoicesQueries.addInvoiceItem(companyId, invoice.id, {
            name: item.name,
            quantity: 1,
            unit_price: item.amount,
            taxable: item.taxable,
        });
    }

    if (amountPaid > 0) {
        await db.query(
            `UPDATE invoices
             SET amount_paid = $2
             WHERE id = $1 AND company_id = $3`,
            [invoice.id, amountPaid, companyId]
        );
    }

    return invoicesQueries.recalculateInvoiceTotals(companyId, invoice.id);
}

beforeAll(async () => {
    originalQuery = db.query;
    client = await db.pool.connect();
    await client.query('BEGIN');
    db.query = (text, params) => client.query(text, params);

    companyId = randomUUID();
    await db.query(
        `INSERT INTO companies (id, name, slug)
         VALUES ($1, $2, $3)`,
        [companyId, `ESTINV Batch ${TAG}`, TAG.toLowerCase()]
    );
    await db.query(
        `INSERT INTO document_templates
            (company_id, document_type, name, slug, is_default, schema_version, content)
         VALUES ($1, 'invoice', 'Default', 'default', true, 1, $2::jsonb)`,
        [companyId, JSON.stringify(getFactory('invoice'))]
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

describe('invoice recalculation totals contract', () => {
    test('taxes the post-discount taxable-only base and keeps balance_due consistent', async () => {
        const invoice = await createInvoice({
            label: 'mixed-discount',
            taxRate: 6,
            discountAmount: 90,
            amountPaid: 10,
            items: [
                { name: 'Taxable part', amount: 95, taxable: true },
                { name: 'Non-taxable labor', amount: 100, taxable: false },
            ],
        });

        expect(amounts(invoice)).toEqual({
            subtotal: 195,
            discount_amount: 90,
            tax_amount: 0.3,
            total: 105.3,
            balance_due: 95.3,
        });
    });

    test('clamps the taxable base at zero when discount exceeds taxable subtotal', async () => {
        const invoice = await createInvoice({
            label: 'discount-over-taxable',
            taxRate: 6,
            discountAmount: 80,
            items: [
                { name: 'Taxable part', amount: 50, taxable: true },
                { name: 'Non-taxable labor', amount: 100, taxable: false },
            ],
        });

        expect(amounts(invoice)).toEqual({
            subtotal: 150,
            discount_amount: 80,
            tax_amount: 0,
            total: 70,
            balance_due: 70,
        });
    });

    test('keeps the standard no-discount calculation unchanged', async () => {
        const invoice = await createInvoice({
            label: 'no-discount',
            taxRate: 6,
            discountAmount: 0,
            items: [
                { name: 'Taxable part A', amount: 95, taxable: true },
                { name: 'Taxable part B', amount: 5, taxable: true },
            ],
        });

        expect(amounts(invoice)).toEqual({
            subtotal: 100,
            discount_amount: 0,
            tax_amount: 6,
            total: 106,
            balance_due: 106,
        });
    });
});

describe('estimate to invoice conversion totals contract', () => {
    test('preserves taxable flags, discount, and post-discount tax', async () => {
        const estimate = await estimatesQueries.createEstimate(companyId, {
            estimate_number: `${TAG}-ESTIMATE`,
            estimate_sequence: 1,
            summary: 'Production-shaped healthy estimate',
            tax_rate: 6,
            discount_type: 'fixed',
            discount_value: 90,
            currency: 'USD',
            created_by: null,
        });

        await estimatesQueries.addEstimateItem(companyId, estimate.id, {
            name: 'Taxable part',
            quantity: 1,
            unit_price: 95,
            taxable: true,
        });
        await estimatesQueries.addEstimateItem(companyId, estimate.id, {
            name: 'Non-taxable labor',
            quantity: 1,
            unit_price: 100,
            taxable: false,
        });

        const recalculatedEstimate = await estimatesQueries.recalculateEstimateTotals(
            companyId,
            estimate.id
        );
        await estimatesQueries.updateEstimateStatus(estimate.id, companyId, 'approved');

        const converted = await estimatesService.convertToInvoice(
            companyId,
            null,
            estimate.id,
            client
        );

        expect({
            subtotal: Number(recalculatedEstimate.subtotal),
            discount_amount: Number(recalculatedEstimate.discount_amount),
            tax_amount: Number(recalculatedEstimate.tax_amount),
            total: Number(recalculatedEstimate.total),
        }).toEqual({
            subtotal: 195,
            discount_amount: 90,
            tax_amount: 0.3,
            total: 105.3,
        });
        expect(amounts(converted)).toEqual({
            subtotal: 195,
            discount_amount: 90,
            tax_amount: 0.3,
            total: 105.3,
            balance_due: 105.3,
        });
        expect(converted.items.map((item) => item.taxable)).toEqual([true, false]);
    });
});
