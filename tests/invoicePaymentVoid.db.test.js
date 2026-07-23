'use strict';

/**
 * ESTINV-T3-VOID — real PostgreSQL coverage for manual invoice payment voids.
 * Production services and SQL queries are exercised; the ledger boundary is
 * not mocked.
 */

const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const db = require('../backend/src/db/connection');
const invoicesService = require('../backend/src/services/invoicesService');
const paymentsService = require('../backend/src/services/paymentsService');

jest.setTimeout(60000);

const TAG = `IPV-${Date.now().toString(36)}-${process.pid}`;
const MIGRATION_SQL = fs.readFileSync(
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
const ROLLBACK_SQL = fs.readFileSync(
    path.join(
        __dirname,
        '..',
        'backend',
        'db',
        'migrations',
        'rollback_197_invoice_payment_void.sql'
    ),
    'utf8'
);

let client;
let originalQuery;
let companyA;
let companyB;
let userA;
let userB;

async function createInvoice({
    companyId = companyA,
    label,
    total = 100,
    amountPaid = 0,
    status = amountPaid >= total ? 'paid' : amountPaid > 0 ? 'partial' : 'sent',
}) {
    const { rows } = await db.query(
        `INSERT INTO invoices (
            company_id, invoice_number, status, total, amount_paid,
            balance_due, currency, paid_at
         ) VALUES (
            $1::UUID, $2::VARCHAR, $3::VARCHAR, $4::NUMERIC, $5::NUMERIC,
            $4::NUMERIC - $5::NUMERIC, 'USD',
            CASE WHEN $3::VARCHAR = 'paid' THEN NOW() ELSE NULL END
         )
         RETURNING *`,
        [companyId, `${TAG}-${label}`, status, total, amountPaid]
    );
    return rows[0];
}

async function createPayment({
    companyId = companyA,
    invoiceId,
    amount,
    source,
    method = 'cash',
    recordedBy = companyId === companyA ? userA : userB,
}) {
    const { rows } = await db.query(
        `INSERT INTO payment_transactions (
            company_id, invoice_id, transaction_type, payment_method,
            status, amount, currency, external_source, processed_at,
            recorded_by
         ) VALUES (
            $1, $2, 'payment', $3, 'completed', $4, 'USD', $5, NOW(), $6
         )
         RETURNING *`,
        [companyId, invoiceId, method, amount, source, recordedBy]
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

beforeAll(async () => {
    originalQuery = db.query;
    client = await db.pool.connect();
    await client.query('BEGIN');
    db.query = (text, params) => client.query(text, params);

    await db.query(MIGRATION_SQL);

    companyA = randomUUID();
    companyB = randomUUID();
    userA = randomUUID();
    userB = randomUUID();

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
                ($5, $6, $7, 'Void Actor B', $8)`,
        [
            userA, `${TAG}-user-a`, `${TAG}-a@example.com`, companyA,
            userB, `${TAG}-user-b`, `${TAG}-b@example.com`, companyB,
        ]
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

describe('manual invoice payment void contract', () => {
    test('records card as a manual ledger row, then voids it without deleting it and reopens a paid invoice', async () => {
        const invoice = await createInvoice({ label: 'fully-paid-record-flow' });

        const paid = await invoicesService.recordPayment(
            companyA,
            userA,
            invoice.id,
            { amount: 100, payment_method: 'card', reference: 'OFFLINE-100' }
        );
        expect({
            amount_paid: Number(paid.amount_paid),
            balance_due: Number(paid.balance_due),
            status: paid.status,
        }).toEqual({ amount_paid: 100, balance_due: 0, status: 'paid' });

        const ledger = await paymentsService.getTransactionsForInvoice(companyA, invoice.id);
        expect(ledger).toHaveLength(1);
        expect(ledger[0]).toMatchObject({
            external_source: 'manual',
            payment_method: 'credit_card',
            status: 'completed',
            reference_number: 'OFFLINE-100',
        });
        expect(await paymentsService.getSummary(companyA)).toMatchObject({
            total_collected: 100,
            net_amount: 100,
        });

        const result = await paymentsService.voidInvoicePayment(
            companyA,
            userA,
            invoice.id,
            ledger[0].id
        );

        expect(result.idempotent).toBe(false);
        expect(result.payment).toMatchObject({
            id: ledger[0].id,
            status: 'voided',
            voided_by: userA,
        });
        expect(result.payment.voided_at).toBeTruthy();
        expect({
            amount_paid: Number(result.invoice.amount_paid),
            balance_due: Number(result.invoice.balance_due),
            status: result.invoice.status,
            paid_at: result.invoice.paid_at,
        }).toEqual({
            amount_paid: 0,
            balance_due: 100,
            status: 'sent',
            paid_at: null,
        });

        const stillListed = await invoicesService.getPayments(companyA, invoice.id);
        expect(stillListed).toHaveLength(1);
        expect(stillListed[0]).toMatchObject({
            id: ledger[0].id,
            payment_method: 'credit_card',
            status: 'voided',
        });
        expect(stillListed[0].voided_at).toBeTruthy();
        expect(stillListed[0].transaction_date).toBeTruthy();
        expect(await paymentsService.getSummary(companyA)).toMatchObject({
            total_collected: 0,
            net_amount: 0,
        });

        const { rows: audits } = await db.query(
            `SELECT actor_id, action, target_type, target_id, company_id, details
             FROM audit_log
             WHERE company_id = $1
               AND action = 'invoice.payment_voided'
               AND target_id = $2`,
            [companyA, String(invoice.id)]
        );
        expect(audits).toEqual([
            expect.objectContaining({
                actor_id: userA,
                action: 'invoice.payment_voided',
                target_type: 'invoice',
                target_id: String(invoice.id),
                company_id: companyA,
                details: expect.objectContaining({ payment_id: String(ledger[0].id) }),
            }),
        ]);
    });

    test('voiding a manual payment preserves remaining paid money and sorts the voided row last', async () => {
        const invoice = await createInvoice({
            label: 'partial-after-void',
            amountPaid: 70,
            status: 'partial',
        });
        const manual = await createPayment({
            invoiceId: invoice.id,
            amount: 20,
            source: 'manual',
            method: 'ach',
        });
        const stripe = await createPayment({
            invoiceId: invoice.id,
            amount: 50,
            source: 'stripe',
            method: 'credit_card',
        });

        const result = await paymentsService.voidInvoicePayment(
            companyA,
            userA,
            invoice.id,
            manual.id
        );

        expect({
            amount_paid: Number(result.invoice.amount_paid),
            balance_due: Number(result.invoice.balance_due),
            status: result.invoice.status,
        }).toEqual({ amount_paid: 50, balance_due: 50, status: 'partial' });

        const listed = await invoicesService.getPayments(companyA, invoice.id);
        expect(listed.map(row => String(row.id))).toEqual([
            String(stripe.id),
            String(manual.id),
        ]);
        expect(listed[0].voided_at).toBeNull();
        expect(listed[1].voided_at).toBeTruthy();
        expect(listed.every(row => row.transaction_date)).toBe(true);
    });

    test.each([
        ['stripe', 'credit_card'],
        ['zenbooker', 'cash'],
    ])('refuses %s-sourced rows and leaves payment plus invoice byte-unchanged', async (source, method) => {
        const invoice = await createInvoice({
            label: `${source}-origin`,
            amountPaid: 40,
            status: 'partial',
        });
        const payment = await createPayment({
            invoiceId: invoice.id,
            amount: 40,
            source,
            method,
        });
        const paymentBefore = await rowBytes('payment_transactions', payment.id);
        const invoiceBefore = await rowBytes('invoices', invoice.id);

        await expect(
            paymentsService.voidInvoicePayment(companyA, userA, invoice.id, payment.id)
        ).rejects.toMatchObject({
            code: 'EXTERNAL_PAYMENT_NOT_VOIDABLE',
            httpStatus: 409,
        });

        expect(await rowBytes('payment_transactions', payment.id)).toBe(paymentBefore);
        expect(await rowBytes('invoices', invoice.id)).toBe(invoiceBefore);
    });

    test('T-foreign/T-blast: a second-tenant payment returns 404 and neither tenant row changes', async () => {
        const invoice = await createInvoice({ label: 'tenant-a-target' });
        // The legacy schema permits a mismatched company_id/invoice_id pair.
        // This deliberately hostile fixture proves both IDs are company-scoped.
        const foreignPayment = await createPayment({
            companyId: companyB,
            invoiceId: invoice.id,
            amount: 25,
            source: 'manual',
            method: 'check',
        });
        const paymentBefore = await rowBytes('payment_transactions', foreignPayment.id);
        const invoiceBefore = await rowBytes('invoices', invoice.id);

        await expect(
            paymentsService.voidInvoicePayment(
                companyA,
                userA,
                invoice.id,
                foreignPayment.id
            )
        ).rejects.toMatchObject({ code: 'NOT_FOUND', httpStatus: 404 });

        expect(await rowBytes('payment_transactions', foreignPayment.id)).toBe(paymentBefore);
        expect(await rowBytes('invoices', invoice.id)).toBe(invoiceBefore);
    });

    test('repeat void is a 200-style no-op with no totals, row, or audit mutation', async () => {
        const invoice = await createInvoice({
            label: 'idempotent',
            amountPaid: 25,
            status: 'partial',
        });
        const payment = await createPayment({
            invoiceId: invoice.id,
            amount: 25,
            source: 'manual',
        });

        const first = await paymentsService.voidInvoicePayment(
            companyA,
            userA,
            invoice.id,
            payment.id
        );
        expect(first.idempotent).toBe(false);

        const paymentAfterFirst = await rowBytes('payment_transactions', payment.id);
        const invoiceAfterFirst = await rowBytes('invoices', invoice.id);
        const auditsAfterFirst = await db.query(
            `SELECT COUNT(*)::INT AS count
             FROM audit_log
             WHERE company_id = $1
               AND action = 'invoice.payment_voided'
               AND details->>'payment_id' = $2`,
            [companyA, String(payment.id)]
        );

        const second = await paymentsService.voidInvoicePayment(
            companyA,
            userA,
            invoice.id,
            payment.id
        );
        expect(second.idempotent).toBe(true);
        expect(await rowBytes('payment_transactions', payment.id)).toBe(paymentAfterFirst);
        expect(await rowBytes('invoices', invoice.id)).toBe(invoiceAfterFirst);

        const auditsAfterSecond = await db.query(
            `SELECT COUNT(*)::INT AS count
             FROM audit_log
             WHERE company_id = $1
               AND action = 'invoice.payment_voided'
               AND details->>'payment_id' = $2`,
            [companyA, String(payment.id)]
        );
        expect(auditsAfterSecond.rows[0].count).toBe(auditsAfterFirst.rows[0].count);
        expect(auditsAfterSecond.rows[0].count).toBe(1);
    });

    test('migration backfills legacy manual invoice events exactly once', async () => {
        const invoice = await createInvoice({
            label: 'legacy-event',
            amountPaid: 30,
            status: 'partial',
        });
        const { rows: events } = await db.query(
            `INSERT INTO invoice_events (
                invoice_id, event_type, actor_type, actor_id, metadata
             ) VALUES (
                $1, 'payment_recorded', 'user', $2,
                '{"amount":30,"payment_method":"check","reference":"LEGACY-30"}'::jsonb
             )
             RETURNING id`,
            [invoice.id, userA]
        );

        await db.query(MIGRATION_SQL);
        await db.query(MIGRATION_SQL);

        const { rows } = await db.query(
            `SELECT *
             FROM payment_transactions
             WHERE company_id = $1
               AND external_source = 'manual'
               AND external_id = $2`,
            [companyA, `invoice_event:${events[0].id}`]
        );
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({
            invoice_id: invoice.id,
            payment_method: 'check',
            reference_number: 'LEGACY-30',
            recorded_by: userA,
        });
        expect(Number(rows[0].amount)).toBe(30);
        expect(rows[0].metadata).toMatchObject({
            invoice_event_id: String(events[0].id),
            backfilled_by: '197_invoice_payment_void',
        });
    });

    test('rollback removes only migration backfill rows and both void columns', async () => {
        await db.query(ROLLBACK_SQL);
        await db.query(ROLLBACK_SQL);

        const { rows: columns } = await db.query(
            `SELECT column_name
             FROM information_schema.columns
             WHERE table_schema = current_schema()
               AND table_name = 'payment_transactions'
               AND column_name IN ('voided_at', 'voided_by')`
        );
        expect(columns).toHaveLength(0);

        const { rows: backfill } = await db.query(
            `SELECT COUNT(*)::INT AS count
             FROM payment_transactions
             WHERE metadata->>'backfilled_by' = '197_invoice_payment_void'`
        );
        expect(backfill[0].count).toBe(0);
    });
});
