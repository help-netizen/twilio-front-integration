'use strict';

/**
 * OB-79 — real PostgreSQL regression for a PaymentIntent that succeeds after a
 * failed attempt. The suite owns an isolated schema so the race uses real row
 * locks and the partial unique index without touching developer data.
 */

const { randomUUID } = require('crypto');

const mockLogFinancialActivity = jest.fn().mockResolvedValue({ ok: true });
const mockEmit = jest.fn().mockResolvedValue({ id: 1 });
let mockRunTransaction;

jest.mock('../backend/src/db/stripePaymentsQueries');
jest.mock('../backend/src/services/stripeConnectProvider');
jest.mock('../backend/src/services/transactionService', () => ({
    withTransaction: work => mockRunTransaction(work),
}));
jest.mock('../backend/src/services/financialActivityService', () => ({
    clientActor: jest.fn((label = 'Client', source = 'portal') => ({
        id: null, type: 'client', label, source,
    })),
    logFinancialActivity: (...args) => mockLogFinancialActivity(...args),
    stripeActor: jest.fn(() => ({
        id: null, type: 'system', label: 'Stripe', source: 'webhook',
    })),
    userActor: jest.fn(id => ({
        id: id || null, type: 'user', label: null, source: 'crm',
    })),
}));
jest.mock('../backend/src/services/eventBus', () => ({
    emit: (...args) => mockEmit(...args),
}));

const db = require('../backend/src/db/connection');
const paymentsQueries = require('../backend/src/db/paymentsQueries');
const invoicesService = require('../backend/src/services/invoicesService');
const q = require('../backend/src/db/stripePaymentsQueries');
const provider = require('../backend/src/services/stripeConnectProvider');
const svc = require('../backend/src/services/stripePaymentsService');

jest.setTimeout(60000);

const COMPANY_A = randomUUID();
const COMPANY_B = randomUUID();
const SCHEMA = `ob79_${Date.now().toString(36)}_${process.pid}`;
const ACTOR = { id: null, type: 'system', label: 'Stripe', source: 'webhook' };

let setupClient;

async function useSchema(client, local = false) {
    await client.query(`SET ${local ? 'LOCAL ' : ''}search_path TO ${SCHEMA}`);
}

async function inTransaction(work) {
    const client = await db.pool.connect();
    try {
        await client.query('BEGIN');
        await useSchema(client, true);
        const result = await work(client);
        await client.query('COMMIT');
        return result;
    } catch (error) {
        await client.query('ROLLBACK');
        throw error;
    } finally {
        client.release();
    }
}
mockRunTransaction = inTransaction;

async function createFixture(label) {
    return inTransaction(async client => {
        const { rows: contacts } = await client.query(
            `INSERT INTO contacts (company_id, full_name, email)
             VALUES ($1, $2, $3)
             RETURNING id`,
            [COMPANY_A, `OB-79 ${label}`, `${label}@example.test`]
        );
        const contactId = contacts[0].id;
        const { rows: jobs } = await client.query(
            `INSERT INTO jobs (company_id, contact_id, job_number, job_seq, service_name)
             VALUES ($1, $2, $3, $4, 'Repair')
             RETURNING id`,
            [COMPANY_A, contactId, `JOB-${label}`, Number(label.replace(/\D/g, '')) || 1]
        );
        const jobId = jobs[0].id;
        const { rows: invoices } = await client.query(
            `INSERT INTO invoices (
                company_id, invoice_number, status, contact_id, job_id,
                total, amount_paid, balance_due, currency
             ) VALUES ($1, $2, 'sent', $3, $4, 100, 0, 100, 'USD')
             RETURNING id`,
            [COMPANY_A, `INV-${label}`, contactId, jobId]
        );
        return { contactId, jobId, invoiceId: invoices[0].id };
    });
}

function successfulPayment(fixture, externalId, { invoice = true, tip = 15 } = {}) {
    return {
        externalId,
        invoiceId: invoice ? fixture.invoiceId : null,
        contactId: fixture.contactId,
        jobId: fixture.jobId,
        amount: 100 + tip,
        currency: 'usd',
        metadata: { surface: 'public_pay', tip },
    };
}

async function projectFailedWebhook(fixture, externalId, eventId) {
    provider.parseConnectWebhook.mockReturnValueOnce({
        id: eventId,
        type: 'payment_intent.payment_failed',
        account: 'acct_ob79',
        data: {
            id: externalId,
            amount: 10000,
            currency: 'usd',
            last_payment_error: { message: 'card_declined' },
        },
    });
    q.getSessionByPaymentIntent.mockResolvedValueOnce({
        id: Number(eventId.replace(/\D/g, '')) || 1,
        invoice_id: fixture.invoiceId,
        contact_id: fixture.contactId,
        job_id: fixture.jobId,
        amount: 100,
        currency: 'usd',
    });
    return svc.handleWebhook('{}', 'signature');
}

async function ledgerRows(externalId) {
    return inTransaction(async client => {
        const { rows } = await client.query(
            `SELECT * FROM payment_transactions
             WHERE company_id = $1 AND external_id = $2
             ORDER BY id`,
            [COMPANY_A, externalId]
        );
        return rows;
    });
}

beforeAll(async () => {
    setupClient = await db.pool.connect();
    await setupClient.query(`CREATE SCHEMA ${SCHEMA}`);
    await useSchema(setupClient);
    await setupClient.query(`
        CREATE TABLE leads (
            id BIGSERIAL PRIMARY KEY,
            company_id UUID NOT NULL,
            serial_id TEXT,
            lead_seq BIGINT
        );
        CREATE TABLE contacts (
            id BIGSERIAL PRIMARY KEY,
            company_id UUID NOT NULL,
            full_name TEXT,
            email TEXT,
            phone_e164 TEXT
        );
        CREATE TABLE jobs (
            id BIGSERIAL PRIMARY KEY,
            company_id UUID NOT NULL,
            lead_id BIGINT,
            contact_id BIGINT,
            job_number TEXT,
            job_seq BIGINT,
            service_name TEXT,
            customer_name TEXT,
            customer_email TEXT,
            customer_phone TEXT,
            address TEXT,
            start_date TIMESTAMPTZ
        );
        CREATE TABLE invoices (
            id BIGSERIAL PRIMARY KEY,
            company_id UUID NOT NULL,
            invoice_number TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'draft',
            contact_id BIGINT,
            lead_id BIGINT,
            job_id BIGINT,
            estimate_id BIGINT,
            total NUMERIC(12,2) NOT NULL DEFAULT 0,
            amount_paid NUMERIC(12,2) NOT NULL DEFAULT 0,
            balance_due NUMERIC(12,2) NOT NULL DEFAULT 0,
            currency TEXT NOT NULL DEFAULT 'USD'
        );
        CREATE TABLE invoice_items (
            id BIGSERIAL PRIMARY KEY,
            invoice_id BIGINT NOT NULL,
            sort_order INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE invoice_events (
            id BIGSERIAL PRIMARY KEY,
            invoice_id BIGINT NOT NULL,
            event_type TEXT NOT NULL,
            actor_type TEXT NOT NULL,
            actor_id TEXT,
            metadata JSONB NOT NULL DEFAULT '{}',
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        CREATE TABLE payment_transactions (
            id BIGSERIAL PRIMARY KEY,
            company_id UUID NOT NULL,
            contact_id BIGINT,
            estimate_id BIGINT,
            invoice_id BIGINT,
            job_id BIGINT,
            transaction_type TEXT NOT NULL,
            payment_method TEXT NOT NULL,
            status TEXT NOT NULL,
            amount NUMERIC(12,2) NOT NULL,
            currency TEXT NOT NULL DEFAULT 'USD',
            reference_number TEXT,
            external_id TEXT,
            external_source TEXT,
            memo TEXT,
            metadata JSONB NOT NULL DEFAULT '{}',
            processed_at TIMESTAMPTZ,
            recorded_by UUID,
            origin_invoice_id BIGINT,
            voided_at TIMESTAMPTZ,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        CREATE UNIQUE INDEX uniq_payment_tx_stripe_external
            ON payment_transactions(company_id, external_id)
            WHERE external_source = 'stripe' AND external_id IS NOT NULL;
    `);
    setupClient.release();
    setupClient = null;
});

afterAll(async () => {
    if (setupClient) setupClient.release();
    const cleanupClient = await db.pool.connect();
    try {
        await cleanupClient.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    } finally {
        cleanupClient.release();
        await db.pool.end();
    }
});

beforeEach(() => {
    jest.clearAllMocks();
    mockLogFinancialActivity.mockClear();
    mockEmit.mockClear();
    q.getAccountByStripeId.mockResolvedValue({
        company_id: COMPANY_A,
        stripe_account_id: 'acct_ob79',
    });
    q.insertWebhookEvent.mockResolvedValue({ inserted: true, row: {} });
    q.updateSession.mockResolvedValue({});
    q.markWebhookEvent.mockResolvedValue({});
});

describe('OB-79 failed PaymentIntent retry promotion', () => {
    test('failed pi_X then succeeded pi_X leaves one completed row and applies amount minus tip', async () => {
        const fixture = await createFixture('1');
        const externalId = 'pi_ob79_retry_1';

        await expect(projectFailedWebhook(fixture, externalId, 'evt_ob79_1'))
            .resolves.toEqual({ ok: true });
        const result = await inTransaction(client => svc.applyStripePayment(
            COMPANY_A,
            successfulPayment(fixture, externalId),
            client,
            ACTOR
        ));

        expect(result).toMatchObject({
            deduped: false,
            tx: {
                status: 'completed',
                amount: '115.00',
                invoice_id: fixture.invoiceId,
                origin_invoice_id: fixture.invoiceId,
                metadata: { surface: 'public_pay', tip: 15 },
            },
        });
        const rows = await ledgerRows(externalId);
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({
            status: 'completed',
            amount: '115.00',
            invoice_id: fixture.invoiceId,
            metadata: { surface: 'public_pay', tip: 15 },
        });

        const invoice = await inTransaction(client => invoicesService.getInvoice(
            COMPANY_A,
            fixture.invoiceId,
            client
        ));
        expect(invoice).toMatchObject({
            status: 'paid',
            amount_paid: '100.00',
            balance_due: '0.00',
            job_payment_allocated: '100.00',
        });
        const events = await inTransaction(async client => (await client.query(
            `SELECT event_type, metadata FROM invoice_events WHERE invoice_id = $1`,
            [fixture.invoiceId]
        )).rows);
        expect(events).toEqual([{
            event_type: 'payment_recorded',
            metadata: expect.objectContaining({ amount: 100, tip: 15, external_id: externalId }),
        }]);
        expect(mockLogFinancialActivity.mock.calls.map(([event]) => event.action))
            .toEqual([
                'payment.failed',
                'invoice.payment_failed',
                'payment.succeeded',
                'invoice.payment_succeeded',
            ]);
        expect(mockEmit.mock.calls.map(([, eventType]) => eventType))
            .toEqual(['payment.failed', 'payment.succeeded']);
    });

    test('repeated succeeded delivery is deduped without another ledger effect', async () => {
        const fixture = await createFixture('2');
        const externalId = 'pi_ob79_retry_2';
        const payment = successfulPayment(fixture, externalId, { tip: 0 });

        const first = await inTransaction(client => svc.applyStripePayment(
            COMPANY_A, payment, client, ACTOR
        ));
        const second = await inTransaction(client => svc.applyStripePayment(
            COMPANY_A, payment, client, ACTOR
        ));

        expect(first.deduped).toBe(false);
        expect(second).toMatchObject({ deduped: true, tx: { status: 'completed' } });
        expect(await ledgerRows(externalId)).toHaveLength(1);
        const eventCount = await inTransaction(async client => (await client.query(
            `SELECT COUNT(*)::INTEGER AS count
             FROM invoice_events
             WHERE invoice_id = $1 AND event_type = 'payment_recorded'`,
            [fixture.invoiceId]
        )).rows[0].count);
        expect(eventCount).toBe(1);
        expect(mockEmit).toHaveBeenCalledTimes(1);
    });

    test('late payment_failed after success cannot downgrade the completed row', async () => {
        const fixture = await createFixture('3');
        const externalId = 'pi_ob79_retry_3';
        await inTransaction(client => svc.applyStripePayment(
            COMPANY_A,
            successfulPayment(fixture, externalId, { tip: 0 }),
            client,
            ACTOR
        ));
        mockLogFinancialActivity.mockClear();
        mockEmit.mockClear();

        const lateFailure = await projectFailedWebhook(
            fixture,
            externalId,
            'evt_ob79_3_late'
        );

        expect(lateFailure).toEqual({ ok: true });
        const rows = await ledgerRows(externalId);
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ status: 'completed', amount: '100.00' });
        expect(mockLogFinancialActivity.mock.calls.map(([event]) => event.action))
            .toEqual(['invoice.payment_failed']);
        expect(mockEmit).not.toHaveBeenCalled();
    });

    test('two concurrent succeeded deliveries have exactly one winning promotion', async () => {
        const fixture = await createFixture('4');
        const externalId = 'pi_ob79_retry_4';
        await expect(projectFailedWebhook(fixture, externalId, 'evt_ob79_4'))
            .resolves.toEqual({ ok: true });
        mockLogFinancialActivity.mockClear();
        mockEmit.mockClear();

        const realFind = paymentsQueries.findByExternalSourceId;
        let reads = 0;
        let releaseInitial;
        let releaseCollision;
        const initialPair = new Promise(resolve => { releaseInitial = resolve; });
        const collisionPair = new Promise(resolve => { releaseCollision = resolve; });
        const findSpy = jest.spyOn(paymentsQueries, 'findByExternalSourceId')
            .mockImplementation(async (...args) => {
                const row = await realFind(...args);
                if (args[2] !== externalId) return row;
                reads += 1;
                if (reads <= 2) {
                    if (reads === 2) releaseInitial();
                    await initialPair;
                } else if (reads <= 4) {
                    if (reads === 4) releaseCollision();
                    await collisionPair;
                }
                return row;
            });

        try {
            const payment = successfulPayment(fixture, externalId, {
                invoice: false,
                tip: 0,
            });
            const results = await Promise.all([
                inTransaction(client => svc.applyStripePayment(
                    COMPANY_A, payment, client, ACTOR
                )),
                inTransaction(client => svc.applyStripePayment(
                    COMPANY_A, payment, client, ACTOR
                )),
            ]);

            expect(results.map(result => result.deduped).sort())
                .toEqual([false, true]);
            expect(results.filter(result => result.tx.status === 'completed')).toHaveLength(1);
            const rows = await ledgerRows(externalId);
            expect(rows).toHaveLength(1);
            expect(rows[0]).toMatchObject({ status: 'completed', amount: '100.00' });
            expect(mockLogFinancialActivity.mock.calls.map(([event]) => event.action))
                .toEqual(['payment.succeeded']);
            expect(mockEmit).toHaveBeenCalledTimes(1);
        } finally {
            findSpy.mockRestore();
        }
    });

    test('T-foreign cannot promote another company row and leaves it byte-unchanged', async () => {
        const fixture = await createFixture('5');
        const externalId = 'pi_ob79_retry_5';
        await expect(projectFailedWebhook(fixture, externalId, 'evt_ob79_5'))
            .resolves.toEqual({ ok: true });
        const [before] = await ledgerRows(externalId);

        const foreignPromotion = await inTransaction(client => (
            paymentsQueries.promoteStripeTransaction(
                COMPANY_B,
                externalId,
                {
                    amount: 999,
                    invoice_id: fixture.invoiceId,
                    origin_invoice_id: fixture.invoiceId,
                    metadata: { tampered: true },
                    processed_at: new Date().toISOString(),
                },
                client
            )
        ));
        expect(foreignPromotion).toBeNull();
        await expect(inTransaction(client => svc.applyStripePayment(
            COMPANY_B,
            successfulPayment(fixture, externalId),
            client,
            ACTOR
        ))).rejects.toMatchObject({ code: 'NOT_FOUND', httpStatus: 404 });

        const [after] = await ledgerRows(externalId);
        expect(after).toEqual(before);
    });
});
