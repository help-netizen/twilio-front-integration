/**
 * F018 STRIPE-PAY-001 — stripePaymentsService + Connect webhook provider.
 * Covers: readiness state machine, webhook signature, event idempotency,
 * tenant-scope rejection, ledger idempotency. (docs/test-cases/STRIPE-PAY-001.md)
 */

const crypto = require('crypto');

// Mock all DB / service dependencies so the service can be unit-tested in isolation.
jest.mock('../backend/src/db/stripePaymentsQueries');
jest.mock('../backend/src/db/paymentsQueries');
jest.mock('../backend/src/services/paymentsService');
jest.mock('../backend/src/services/invoicesService');
jest.mock('../backend/src/db/invoicesQueries');
jest.mock('../backend/src/db/estimatesQueries');
jest.mock('../backend/src/services/eventBus', () => ({
    emit: jest.fn().mockResolvedValue(null),
}));
jest.mock('../backend/src/services/contactPropagationService', () => ({
    propagateContactDetails: jest.fn(),
}));
jest.mock('../backend/src/services/marketplaceService');
jest.mock('../backend/src/db/marketplaceQueries', () => ({
    ensureMarketplaceSchema: jest.fn().mockResolvedValue(undefined),
    listInstallations: jest.fn().mockResolvedValue([]),
}));
jest.mock('../backend/src/services/auditService', () => ({ log: jest.fn().mockResolvedValue(undefined) }));

const mockTransactionClient = {
    query: jest.fn(),
    release: jest.fn(),
};
const mockLogFinancialActivity = jest.fn();
jest.mock('../backend/src/services/transactionService', () => ({
    withTransaction: jest.fn(work => work(mockTransactionClient)),
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

const mockAddNote = jest.fn();
jest.mock('../backend/src/services/jobsService', () => ({
    addNote: (...a) => mockAddNote(...a),
}));

const q = require('../backend/src/db/stripePaymentsQueries');
const paymentsQueries = require('../backend/src/db/paymentsQueries');
const paymentsService = require('../backend/src/services/paymentsService');
const invoicesService = require('../backend/src/services/invoicesService');
const invoicesQueries = require('../backend/src/db/invoicesQueries');
const estimatesQueries = require('../backend/src/db/estimatesQueries');
const eventBus = require('../backend/src/services/eventBus');
const contactPropagationService = require('../backend/src/services/contactPropagationService');

const svc = require('../backend/src/services/stripePaymentsService');
const provider = require('../backend/src/services/stripeConnectProvider');

const COMPANY = '11111111-1111-1111-1111-111111111111';
const ACCT = 'acct_test_123';

beforeEach(() => {
    jest.clearAllMocks();
    mockTransactionClient.query.mockResolvedValue({ rows: [], rowCount: 0 });
    mockLogFinancialActivity.mockResolvedValue({ ok: true });
    eventBus.emit.mockResolvedValue(null);
    paymentsQueries.findByExternalSourceId.mockResolvedValue(null);
    paymentsQueries.createTransaction.mockImplementation(async (companyId, data) => ({
        id: 909,
        company_id: companyId,
        ...data,
    }));
    estimatesQueries.getContactContext.mockImplementation(
        async (companyId, id) => (companyId === COMPANY ? { id, company_id: companyId } : null)
    );
    estimatesQueries.getJobContext.mockImplementation(
        async (companyId, id) => (companyId === COMPANY ? { id, company_id: companyId } : null)
    );
    invoicesQueries.getInvoiceById.mockImplementation(
        async (companyId, id) => (
            companyId === COMPANY
                ? {
                    id,
                    company_id: companyId,
                    contact_id: 5,
                    job_id: null,
                    estimate_id: null,
                    balance_due: 0,
                    amount_paid: 50,
                }
                : null
        )
    );
});

// ── TC-01..06: readiness state machine (pure) ───────────────────────────────
describe('computeReadiness', () => {
    it('TC-01 no account → not_connected', () => expect(svc.computeReadiness(null)).toBe('not_connected'));
    it('TC-02 no details → onboarding_incomplete', () =>
        expect(svc.computeReadiness({ details_submitted: false })).toBe('onboarding_incomplete'));
    it('TC-03 past_due → action_required', () =>
        expect(svc.computeReadiness({ details_submitted: true, requirements_past_due: ['x'] })).toBe('action_required'));
    it('TC-04 no charges → payments_disabled', () =>
        expect(svc.computeReadiness({ details_submitted: true, charges_enabled: false, capabilities: {} })).toBe('payments_disabled'));
    it('TC-05 charges but no payouts → payouts_disabled (collect allowed)', () => {
        const r = svc.computeReadiness({ details_submitted: true, charges_enabled: true, capabilities: { card_payments: 'active' }, payouts_enabled: false });
        expect(r).toBe('payouts_disabled');
        expect(svc.canCollect(r)).toBe(true);
    });
    it('TC-06 fully ready → connected_ready', () => {
        const r = svc.computeReadiness({ details_submitted: true, charges_enabled: true, capabilities: { card_payments: 'active' }, payouts_enabled: true });
        expect(r).toBe('connected_ready');
        expect(svc.canCollect(r)).toBe(true);
    });
    it('payments_disabled blocks collection', () => expect(svc.canCollect('payments_disabled')).toBe(false));
});

// ── TC-30: webhook signature ────────────────────────────────────────────────
describe('parseConnectWebhook', () => {
    const SECRET = 'whsec_connect_test';
    beforeAll(() => { process.env.STRIPE_CONNECT_WEBHOOK_SECRET = SECRET; });

    function sign(body, secret = SECRET) {
        const t = 1700000000;
        const v1 = crypto.createHmac('sha256', secret).update(`${t}.${body}`).digest('hex');
        return `t=${t},v1=${v1}`;
    }

    it('TC-30 rejects missing signature', () => expect(provider.parseConnectWebhook('{}', null)).toBeNull());
    it('TC-30 rejects bad signature', () => {
        const body = JSON.stringify({ id: 'evt_1', type: 'x' });
        expect(provider.parseConnectWebhook(body, sign(body, 'wrong'))).toBeNull();
    });
    it('accepts a valid signature and parses account/event', () => {
        const body = JSON.stringify({ id: 'evt_1', type: 'account.updated', account: ACCT, data: { object: { id: ACCT } } });
        const evt = provider.parseConnectWebhook(body, sign(body));
        expect(evt).toMatchObject({ id: 'evt_1', type: 'account.updated', account: ACCT });
    });
});

// ── TC-32/35: webhook idempotency + tenant scope ────────────────────────────
describe('handleWebhook', () => {
    const SECRET = 'whsec_connect_test';
    beforeAll(() => { process.env.STRIPE_CONNECT_WEBHOOK_SECRET = SECRET; });
    function signed(payload) {
        const body = JSON.stringify(payload);
        const t = 1700000000;
        const v1 = crypto.createHmac('sha256', SECRET).update(`${t}.${body}`).digest('hex');
        return { body, sig: `t=${t},v1=${v1}` };
    }

    it('TC-30 throws 400 on bad signature', async () => {
        await expect(svc.handleWebhook('{}', null)).rejects.toMatchObject({ httpStatus: 400 });
    });

    it('TC-32 deduplicates a repeated event id', async () => {
        q.getAccountByStripeId.mockResolvedValue({ company_id: COMPANY, stripe_account_id: ACCT });
        q.insertWebhookEvent.mockResolvedValue({ inserted: false, row: null }); // already seen
        const { body, sig } = signed({ id: 'evt_dup', type: 'checkout.session.completed', account: ACCT, data: { object: {} } });
        const res = await svc.handleWebhook(body, sig);
        expect(res).toEqual({ ok: true, deduped: true });
        expect(paymentsService.createTransaction).not.toHaveBeenCalled();
        expect(paymentsQueries.createTransaction).not.toHaveBeenCalled();
        expect(eventBus.emit).not.toHaveBeenCalled();
    });

    it('projects an ad-hoc job payment failure to one tenant-owned payment event', async () => {
        q.getAccountByStripeId.mockResolvedValue({ company_id: COMPANY, stripe_account_id: ACCT });
        q.insertWebhookEvent.mockResolvedValue({ inserted: true, row: {} });
        q.getSessionByPaymentIntent.mockResolvedValue({
            id: 10,
            job_id: 77,
            contact_id: 5,
            amount: 25,
            currency: 'usd',
        });
        q.updateSession.mockResolvedValue({});
        q.markWebhookEvent.mockResolvedValue(undefined);
        const { body, sig } = signed({
            id: 'evt_job_fail',
            type: 'payment_intent.payment_failed',
            account: ACCT,
            data: { object: { id: 'pi_job_fail', amount: 2500, currency: 'usd' } },
        });

        await svc.handleWebhook(body, sig);

        expect(paymentsQueries.createTransaction).toHaveBeenCalledWith(
            COMPANY,
            expect.objectContaining({
                job_id: 77,
                contact_id: 5,
                amount: 25,
                status: 'failed',
            }),
            mockTransactionClient
        );
        expect(eventBus.emit).toHaveBeenCalledTimes(1);
        expect(eventBus.emit).toHaveBeenCalledWith(
            COMPANY,
            'payment.failed',
            expect.objectContaining({ payment_id: 909 }),
            expect.objectContaining({ aggregateType: 'payment', aggregateId: 909 })
        );
    });

    it('TC-35 rejects an unknown connected account (no ledger mutation)', async () => {
        q.getAccountByStripeId.mockResolvedValue(null); // account not mapped to a company
        q.insertWebhookEvent.mockResolvedValue({ inserted: true, row: {} });
        q.markWebhookEvent.mockResolvedValue(undefined);
        const { body, sig } = signed({ id: 'evt_unknown', type: 'checkout.session.completed', account: 'acct_unknown', data: { object: {} } });
        const res = await svc.handleWebhook(body, sig);
        expect(res).toEqual({ ok: true, ignored: true });
        expect(q.markWebhookEvent).toHaveBeenCalledWith('evt_unknown', 'failed', { error: 'unknown_connected_account' });
        expect(paymentsService.createTransaction).not.toHaveBeenCalled();
    });

    it('TC-31 checkout.session.completed writes one ledger row + flips invoice to paid', async () => {
        q.getAccountByStripeId.mockResolvedValue({ company_id: COMPANY, stripe_account_id: ACCT });
        q.insertWebhookEvent.mockResolvedValue({ inserted: true, row: {} });
        q.getSessionByCheckoutId.mockResolvedValue({ id: 7, invoice_id: 42, contact_id: 5, job_id: null });
        q.updateSession.mockResolvedValue({});
        q.markWebhookEvent.mockResolvedValue(undefined);
        paymentsQueries.findByExternalSourceId.mockResolvedValue(null); // not seen
        paymentsQueries.createTransaction.mockResolvedValue({ id: 100, external_id: 'pi_1' });
        invoicesQueries.recordPayment.mockResolvedValue({});
        invoicesService.getInvoice.mockResolvedValue({ id: 42, balance_due: 0, amount_paid: 50 });
        invoicesQueries.updateInvoiceStatus.mockResolvedValue({});
        invoicesQueries.createEvent.mockResolvedValue({});

        const { body, sig } = signed({
            id: 'evt_ok', type: 'checkout.session.completed', account: ACCT,
            data: { object: { id: 'cs_1', payment_intent: 'pi_1', amount_total: 5000, currency: 'usd', metadata: { invoice_id: '42' } } },
        });
        const res = await svc.handleWebhook(body, sig);
        expect(res).toEqual({ ok: true });
        // Ledger write goes through the low-level query (so the service can split balance vs tip).
        expect(paymentsQueries.createTransaction).toHaveBeenCalledTimes(1);
        const txArg = paymentsQueries.createTransaction.mock.calls[0][1];
        expect(txArg).toMatchObject({ external_source: 'stripe', external_id: 'pi_1', invoice_id: 42, amount: 50 });
        // No tip → full amount applied to the invoice.
        expect(invoicesQueries.recordPayment).toHaveBeenCalledWith(
            42,
            COMPANY,
            50,
            mockTransactionClient
        );
        expect(invoicesQueries.updateInvoiceStatus).toHaveBeenCalledWith(
            42,
            COMPANY,
            'paid',
            'paid_at',
            mockTransactionClient
        );
        expect(mockLogFinancialActivity.mock.calls.map(([activity]) => activity.action))
            .toEqual(['payment.succeeded', 'invoice.payment_succeeded']);
        expect(mockLogFinancialActivity.mock.calls.every(([activity]) => (
            activity.actor.type === 'system'
                && activity.actor.label === 'Stripe'
                && activity.actor.id === null
        ))).toBe(true);
    });

    it('TC-31b tip is split: full charge to ledger, only balance applied to invoice', async () => {
        q.getAccountByStripeId.mockResolvedValue({ company_id: COMPANY, stripe_account_id: ACCT });
        q.insertWebhookEvent.mockResolvedValue({ inserted: true, row: {} });
        q.getSessionByPaymentIntent.mockResolvedValue({ id: 9, invoice_id: 42 });
        q.updateSession.mockResolvedValue({});
        q.markWebhookEvent.mockResolvedValue(undefined);
        paymentsQueries.findByExternalSourceId.mockResolvedValue(null);
        paymentsQueries.createTransaction.mockResolvedValue({ id: 101, external_id: 'pi_tip' });
        invoicesQueries.recordPayment.mockResolvedValue({});
        invoicesService.getInvoice.mockResolvedValue({ id: 42, balance_due: 0, amount_paid: 100 });
        invoicesQueries.updateInvoiceStatus.mockResolvedValue({});
        invoicesQueries.createEvent.mockResolvedValue({});
        // amount_received 11500 = $115 ($100 balance + $15 tip)
        const { body, sig } = signed({
            id: 'evt_tip', type: 'payment_intent.succeeded', account: ACCT,
            data: { object: { id: 'pi_tip', amount_received: 11500, currency: 'usd', metadata: { invoice_id: '42', tip: '15', surface: 'public_pay' } } },
        });
        await svc.handleWebhook(body, sig);
        const txArg = paymentsQueries.createTransaction.mock.calls[0][1];
        expect(Number(txArg.amount)).toBe(115);            // full charge on ledger
        expect(txArg.metadata.tip).toBe(15);               // tip recorded
        expect(invoicesQueries.recordPayment).toHaveBeenCalledWith(
            42,
            COMPANY,
            100,
            mockTransactionClient
        ); // only balance to invoice
    });

    it('TC-33 idempotent on (company, external_id) — existing tx → no duplicate', async () => {
        q.getAccountByStripeId.mockResolvedValue({ company_id: COMPANY, stripe_account_id: ACCT });
        q.insertWebhookEvent.mockResolvedValue({ inserted: true, row: {} });
        q.getSessionByPaymentIntent.mockResolvedValue({ id: 8, invoice_id: 42 });
        q.updateSession.mockResolvedValue({});
        q.markWebhookEvent.mockResolvedValue(undefined);
        paymentsQueries.findByExternalSourceId.mockResolvedValue({ id: 100, external_id: 'pi_1' }); // already in ledger
        const { body, sig } = signed({
            id: 'evt_pi', type: 'payment_intent.succeeded', account: ACCT,
            data: { object: { id: 'pi_1', amount_received: 5000, currency: 'usd', metadata: { invoice_id: '42' } } },
        });
        const res = await svc.handleWebhook(body, sig);
        expect(res).toEqual({ ok: true });
        expect(paymentsService.createTransaction).not.toHaveBeenCalled();
    });

    it('TC-34 payment_failed marks session failed and records no completed ledger row', async () => {
        q.getAccountByStripeId.mockResolvedValue({ company_id: COMPANY, stripe_account_id: ACCT });
        q.insertWebhookEvent.mockResolvedValue({ inserted: true, row: {} });
        q.getSessionByPaymentIntent.mockResolvedValue({ id: 9, invoice_id: 42 });
        q.updateSession.mockResolvedValue({});
        q.markWebhookEvent.mockResolvedValue(undefined);
        const { body, sig } = signed({
            id: 'evt_fail', type: 'payment_intent.payment_failed', account: ACCT,
            data: { object: { id: 'pi_2', last_payment_error: { message: 'card_declined' } } },
        });
        const res = await svc.handleWebhook(body, sig);
        expect(res).toEqual({ ok: true });
        expect(q.updateSession).toHaveBeenCalledWith(
            COMPANY,
            9,
            { status: 'failed', failure_reason: 'card_declined' },
            mockTransactionClient
        );
        expect(paymentsService.createTransaction).not.toHaveBeenCalled();
        expect(paymentsQueries.createTransaction).toHaveBeenCalledWith(
            COMPANY,
            expect.objectContaining({
                invoice_id: 42,
                external_id: 'pi_2',
                external_source: 'stripe',
                status: 'failed',
            }),
            mockTransactionClient
        );
        expect(eventBus.emit).toHaveBeenCalledWith(
            COMPANY,
            'payment.failed',
            {
                payment_id: 909,
                record_refs: [{ type: 'payment', id: 909 }],
            },
            expect.objectContaining({
                aggregateType: 'payment',
                aggregateId: 909,
                idempotencyKey: 'payment.failed:stripe:pi_2',
                client: mockTransactionClient,
            })
        );
        expect(mockLogFinancialActivity).toHaveBeenCalledWith(
            expect.objectContaining({
                action: 'payment.failed',
                actor: {
                    id: null,
                    type: 'system',
                    label: 'Stripe',
                    source: 'webhook',
                },
            }),
            { client: mockTransactionClient }
        );
        expect(mockLogFinancialActivity).toHaveBeenCalledWith(
            expect.objectContaining({
                action: 'invoice.payment_failed',
                entity: expect.objectContaining({ id: 42 }),
            }),
            { client: mockTransactionClient }
        );
    });

    it('logs invoice.payment_failed from owned metadata when no local session exists', async () => {
        q.getAccountByStripeId.mockResolvedValue({
            company_id: COMPANY,
            stripe_account_id: ACCT,
        });
        q.insertWebhookEvent.mockResolvedValue({ inserted: true, row: {} });
        q.getSessionByPaymentIntent.mockResolvedValue(null);
        q.markWebhookEvent.mockResolvedValue(undefined);
        const { body, sig } = signed({
            id: 'evt_fail_metadata',
            type: 'payment_intent.payment_failed',
            account: ACCT,
            data: {
                object: {
                    id: 'pi_fail_metadata',
                    metadata: { invoice_id: '42', contact_id: '5' },
                    last_payment_error: { message: 'card_declined' },
                },
            },
        });

        const res = await svc.handleWebhook(body, sig);

        expect(res).toEqual({ ok: true });
        expect(invoicesQueries.getInvoiceById).toHaveBeenCalledWith(
            COMPANY,
            42,
            mockTransactionClient
        );
        expect(mockLogFinancialActivity).toHaveBeenCalledWith(
            expect.objectContaining({
                action: 'invoice.payment_failed',
                entity: expect.objectContaining({ id: 42 }),
            }),
            { client: mockTransactionClient }
        );
    });

    it('logs refund.failed with the Stripe system actor when local refund projection fails', async () => {
        q.getAccountByStripeId.mockResolvedValue({
            company_id: COMPANY,
            stripe_account_id: ACCT,
        });
        q.insertWebhookEvent.mockResolvedValue({ inserted: true, row: {} });
        q.markWebhookEvent.mockResolvedValue(undefined);
        const original = {
            id: 100,
            external_id: 'pi_refund_failed',
            invoice_id: 42,
            amount: 50,
            currency: 'USD',
        };
        paymentsQueries.findByExternalSourceId
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce(original)
            .mockResolvedValueOnce(original);
        paymentsQueries.createTransaction.mockRejectedValue(
            new Error('ledger unavailable')
        );
        const { body, sig } = signed({
            id: 'evt_refund_failed',
            type: 'charge.refunded',
            account: ACCT,
            data: {
                object: {
                    id: 'ch_refund_failed',
                    payment_intent: 'pi_refund_failed',
                    amount_refunded: 5000,
                    currency: 'usd',
                    refunds: {
                        data: [{ id: 're_refund_failed', amount: 5000 }],
                    },
                },
            },
        });

        const res = await svc.handleWebhook(body, sig);

        expect(res).toEqual({ ok: false, error: 'ledger unavailable' });
        expect(mockLogFinancialActivity).toHaveBeenCalledWith(
            expect.objectContaining({
                action: 'refund.failed',
                entity: original,
                actor: {
                    id: null,
                    type: 'system',
                    label: 'Stripe',
                    source: 'webhook',
                },
            })
        );
        expect(q.markWebhookEvent).toHaveBeenCalledWith(
            'evt_refund_failed',
            'failed',
            { error: 'ledger unavailable', companyId: COMPANY }
        );
    });

    it('TC-39 unknown event type → ignored', async () => {
        q.getAccountByStripeId.mockResolvedValue({ company_id: COMPANY, stripe_account_id: ACCT });
        q.insertWebhookEvent.mockResolvedValue({ inserted: true, row: {} });
        q.markWebhookEvent.mockResolvedValue(undefined);
        const { body, sig } = signed({ id: 'evt_x', type: 'invoice.created', account: ACCT, data: { object: {} } });
        const res = await svc.handleWebhook(body, sig);
        expect(res).toEqual({ ok: true, ignored: true });
    });
});

// ── TC-20..23: payment link creation / reuse ────────────────────────────────
describe('ensurePaymentLink', () => {
    const readyAccount = { company_id: COMPANY, stripe_account_id: ACCT, details_submitted: true, charges_enabled: true, payouts_enabled: true, capabilities: { card_payments: 'active' }, status: 'connected_ready' };

    it('TC-21 blocks when Stripe not ready', async () => {
        q.getAccountByCompany.mockResolvedValue(null);
        await expect(svc.ensurePaymentLink(COMPANY, { id: null }, 42)).rejects.toMatchObject({ code: 'NOT_READY', httpStatus: 409 });
    });

    it('TC-22 blocks void/paid invoice', async () => {
        q.getAccountByCompany.mockResolvedValue(readyAccount);
        invoicesService.getInvoice.mockResolvedValue({ id: 42, status: 'void', balance_due: 10, total: 10 });
        await expect(svc.ensurePaymentLink(COMPANY, { id: null }, 42)).rejects.toMatchObject({ code: 'INVALID_STATUS' });
    });

    it('TC-23 reuses an existing open session (no duplicate)', async () => {
        q.getAccountByCompany.mockResolvedValue(readyAccount);
        invoicesService.getInvoice.mockResolvedValue({ id: 42, status: 'sent', balance_due: 100, total: 100, currency: 'USD' });
        q.findOpenSession.mockResolvedValue({ id: 5, url: 'https://pay/existing', expires_at: null });
        const link = await svc.ensurePaymentLink(COMPANY, { id: null }, 42);
        expect(link).toMatchObject({ reused: true, url: 'https://pay/existing' });
        expect(q.insertSession).not.toHaveBeenCalled();
    });
});

// ── Phase 3: manual card session ────────────────────────────────────────────
describe('createManualCardSession (Phase 3)', () => {
    const readyAccount = { company_id: COMPANY, stripe_account_id: ACCT, details_submitted: true, charges_enabled: true, payouts_enabled: true, capabilities: { card_payments: 'active' }, status: 'connected_ready' };
    beforeEach(() => {
        provider.createPaymentIntent = jest.fn();
        provider.createCardPaymentIntent = jest.fn();
    });

    it('creates a card-only PaymentIntent + session and returns client_secret', async () => {
        q.getAccountByCompany.mockResolvedValue(readyAccount);
        invoicesService.getInvoice.mockResolvedValue({ id: 42, status: 'sent', balance_due: 80, total: 80, currency: 'USD', contact_id: 5 });
        provider.createCardPaymentIntent.mockResolvedValue({ id: 'pi_m', client_secret: 'pi_m_secret' });
        q.insertSession.mockResolvedValue({ id: 11 });
        const res = await svc.createManualCardSession(COMPANY, { id: null }, { invoiceId: 42 });
        expect(res).toMatchObject({ client_secret: 'pi_m_secret', payment_intent_id: 'pi_m', account_id: ACCT, amount: 80 });
        expect(q.insertSession.mock.calls[0][1]).toMatchObject({ surface: 'manual_card' });
        expect(provider.createCardPaymentIntent).toHaveBeenCalledWith(
            ACCT,
            expect.objectContaining({ amount: 80, metadata: expect.objectContaining({ surface: 'manual_card' }) }),
            expect.objectContaining({ idempotencyKey: expect.any(String) })
        );
        expect(provider.createPaymentIntent).not.toHaveBeenCalled();
    });

    it('blocks when Stripe not ready', async () => {
        q.getAccountByCompany.mockResolvedValue(null);
        await expect(svc.createManualCardSession(COMPANY, { id: null }, { invoiceId: 42 })).rejects.toMatchObject({ code: 'NOT_READY' });
    });
});

describe('createPublicPayIntent provider invariant', () => {
    const readyAccount = { company_id: COMPANY, stripe_account_id: ACCT, details_submitted: true, charges_enabled: true, payouts_enabled: true, capabilities: { card_payments: 'active' }, status: 'connected_ready' };

    beforeEach(() => {
        provider.createPaymentIntent = jest.fn();
        provider.createCardPaymentIntent = jest.fn();
    });

    it('CTRL-PUBLIC-AUTOMATIC: public pay uses the automatic provider and stamps public session metadata', async () => {
        invoicesQueries.getInvoiceByPublicToken.mockResolvedValue({
            id: 42,
            company_id: COMPANY,
            status: 'sent',
            balance_due: 80,
            currency: 'USD',
            job_id: 7,
            contact_id: 5,
        });
        q.getAccountByCompany.mockResolvedValue(readyAccount);
        provider.createPaymentIntent.mockResolvedValue({ id: 'pi_public', client_secret: 'pi_public_secret' });
        q.insertSession.mockResolvedValue({ id: 12 });

        const result = await svc.createPublicPayIntent(
            'public-token',
            { tip: 15 },
            null,
            { recordActivity: true }
        );

        expect(result).toMatchObject({ amount: 95, tip: 15, balance_due: 80 });
        expect(provider.createPaymentIntent).toHaveBeenCalledWith(
            ACCT,
            expect.objectContaining({ amount: 95, metadata: expect.objectContaining({ surface: 'public_pay' }) }),
            expect.objectContaining({ idempotencyKey: expect.any(String) })
        );
        expect(provider.createCardPaymentIntent).not.toHaveBeenCalled();
        expect(q.insertSession).toHaveBeenCalledWith(
            COMPANY,
            expect.objectContaining({
                surface: 'manual_card',
                metadata: { tip: 15, public: true },
            }),
            null
        );
        expect(mockLogFinancialActivity.mock.calls.map(([activity]) => activity.action))
            .toEqual(['payment.session_started', 'invoice.card_session_started']);
        expect(mockLogFinancialActivity.mock.calls.every(([activity]) => (
            activity.actor.type === 'client' && activity.actor.id === null
        ))).toBe(true);
    });
});

describe('contact-only payment sessions', () => {
    const readyAccount = {
        company_id: COMPANY,
        stripe_account_id: ACCT,
        details_submitted: true,
        charges_enabled: true,
        payouts_enabled: true,
        capabilities: { card_payments: 'active' },
        status: 'connected_ready',
    };
    const actor = {
        id: '22222222-2222-4222-8222-222222222222',
        type: 'user',
        label: null,
        source: 'crm',
    };

    beforeEach(() => {
        provider.createCardPaymentIntent = jest.fn().mockResolvedValue({
            id: 'pi_contact',
            client_secret: 'pi_contact_secret',
        });
        q.getAccountByCompany.mockResolvedValue(readyAccount);
        q.insertSession.mockResolvedValue({
            id: 15,
            contact_id: 5,
            invoice_id: null,
            job_id: null,
            currency: 'USD',
        });
    });

    it('validates and retains Contact as the parent for an otherwise parentless session', async () => {
        await svc.createManualCardSession(
            COMPANY,
            { id: actor.id },
            { contactId: 5, amount: 25 },
            mockTransactionClient,
            actor
        );

        expect(estimatesQueries.getContactContext).toHaveBeenCalledWith(
            COMPANY,
            5,
            mockTransactionClient
        );
        expect(q.insertSession).toHaveBeenCalledWith(
            COMPANY,
            expect.objectContaining({
                contact_id: 5,
                invoice_id: null,
                job_id: null,
            }),
            mockTransactionClient
        );
        expect(mockLogFinancialActivity).toHaveBeenCalledWith(
            expect.objectContaining({
                action: 'payment.session_started',
                entity: expect.objectContaining({ contact_id: 5 }),
            }),
            { client: mockTransactionClient }
        );
    });

    it('rejects a foreign Contact before provider or session mutation', async () => {
        estimatesQueries.getContactContext.mockResolvedValueOnce(null);

        await expect(svc.createManualCardSession(
            COMPANY,
            { id: actor.id },
            { contactId: 999, amount: 25 },
            mockTransactionClient,
            actor
        )).rejects.toMatchObject({ code: 'NOT_FOUND', httpStatus: 404 });

        expect(provider.createCardPaymentIntent).not.toHaveBeenCalled();
        expect(q.insertSession).not.toHaveBeenCalled();
        expect(mockLogFinancialActivity).not.toHaveBeenCalled();
    });
});

describe('getManualCardSessionResult', () => {
    const merchantSession = {
        id: 11,
        company_id: COMPANY,
        surface: 'manual_card',
        stripe_payment_intent_id: 'pi_merchant',
        stripe_account_id: ACCT,
        metadata: {},
    };

    beforeEach(() => {
        provider.retrievePaymentIntent = jest.fn();
        provider.retrievePaymentMethod = jest.fn();
    });

    it('projects exactly status, dollar amount, brand, and last4', async () => {
        q.getSessionById.mockResolvedValue(merchantSession);
        provider.retrievePaymentIntent.mockResolvedValue({
            id: 'pi_merchant', status: 'succeeded', amount: 9500, payment_method: 'pm_1',
        });
        provider.retrievePaymentMethod.mockResolvedValue({ card: { brand: 'visa', last4: '4242' } });

        const result = await svc.getManualCardSessionResult(COMPANY, 11);

        expect(result).toEqual({ status: 'succeeded', amount: 95, brand: 'visa', last4: '4242' });
        expect(Object.keys(result)).toEqual(['status', 'amount', 'brand', 'last4']);
        expect(q.getSessionById).toHaveBeenCalledWith(COMPANY, 11, null);
        expect(provider.retrievePaymentIntent).toHaveBeenCalledWith(ACCT, 'pi_merchant');
        expect(provider.retrievePaymentMethod).toHaveBeenCalledWith(ACCT, 'pm_1');
    });

    it('uses an expanded PaymentMethod without another Stripe request', async () => {
        q.getSessionById.mockResolvedValue(merchantSession);
        provider.retrievePaymentIntent.mockResolvedValue({
            status: 'requires_payment_method',
            amount: 1234,
            payment_method: { card: { brand: 'mastercard', last4: '4444' } },
        });

        await expect(svc.getManualCardSessionResult(COMPANY, 11)).resolves.toEqual({
            status: 'requires_payment_method', amount: 12.34, brand: 'mastercard', last4: '4444',
        });
        expect(provider.retrievePaymentMethod).not.toHaveBeenCalled();
    });

    it('keeps authoritative PI status when card enrichment fails', async () => {
        q.getSessionById.mockResolvedValue(merchantSession);
        provider.retrievePaymentIntent.mockResolvedValue({ status: 'succeeded', amount: 9500, payment_method: 'pm_missing' });
        provider.retrievePaymentMethod.mockRejectedValue(new Error('Stripe unavailable'));

        await expect(svc.getManualCardSessionResult(COMPANY, 11)).resolves.toEqual({
            status: 'succeeded', amount: 95, brand: null, last4: null,
        });
    });

    it.each([
        ['foreign/missing session', null],
        ['public session', { ...merchantSession, metadata: { public: true } }],
        ['string-encoded public metadata', { ...merchantSession, metadata: '{"public":true}' }],
        ['non-manual session', { ...merchantSession, surface: 'tap_to_pay' }],
    ])('404s before Stripe for %s', async (_label, session) => {
        q.getSessionById.mockResolvedValue(session);

        await expect(svc.getManualCardSessionResult(COMPANY, 11))
            .rejects.toMatchObject({ code: 'NOT_FOUND', httpStatus: 404 });
        expect(provider.retrievePaymentIntent).not.toHaveBeenCalled();
        expect(provider.retrievePaymentMethod).not.toHaveBeenCalled();
    });

    it('rejects an invalid session id before DB or Stripe', async () => {
        await expect(svc.getManualCardSessionResult(COMPANY, 'not-an-id'))
            .rejects.toMatchObject({ code: 'NOT_FOUND', httpStatus: 404 });
        expect(q.getSessionById).not.toHaveBeenCalled();
        expect(provider.retrievePaymentIntent).not.toHaveBeenCalled();
    });
});

describe('manual-card server confirmation (CARDFRAME-001 P2a)', () => {
    const merchantSession = {
        id: 11,
        company_id: COMPANY,
        surface: 'manual_card',
        stripe_payment_intent_id: 'pi_merchant',
        stripe_account_id: ACCT,
        invoice_id: null,
        job_id: null,
        contact_id: null,
        metadata: {},
    };

    beforeEach(() => {
        provider.confirmPaymentIntent = jest.fn();
        provider.retrievePaymentIntent = jest.fn();
        q.updateSession.mockResolvedValue({ ...merchantSession, status: 'complete' });
        paymentsQueries.findByExternalSourceId.mockResolvedValue(null);
        paymentsQueries.createTransaction.mockResolvedValue({
            id: 501,
            external_id: 'pi_merchant',
            currency: 'USD',
        });
    });

    it('confirms the owned PI with pmId and synchronously reconciles the ledger', async () => {
        q.getSessionById.mockResolvedValue(merchantSession);
        provider.confirmPaymentIntent.mockResolvedValue({
            id: 'pi_merchant',
            status: 'succeeded',
            amount: 9500,
            amount_received: 9500,
            currency: 'usd',
            latest_charge: 'ch_merchant',
            metadata: { surface: 'manual_card' },
        });

        await expect(svc.confirmManualCardSession(
            COMPANY,
            11,
            'pm_card_11'
        )).resolves.toEqual({ status: 'succeeded' });

        expect(provider.confirmPaymentIntent).toHaveBeenCalledWith(
            ACCT,
            'pi_merchant',
            { paymentMethodId: 'pm_card_11' },
            {
                idempotencyKey:
                    `manual-card-confirm-${COMPANY}-11-pm_card_11`,
            }
        );
        expect(q.getSessionById).toHaveBeenCalledWith(
            COMPANY,
            11,
            mockTransactionClient
        );
        expect(q.updateSession).toHaveBeenCalledWith(
            COMPANY,
            11,
            { status: 'complete', stripe_charge_id: 'ch_merchant' },
            mockTransactionClient
        );
        expect(paymentsQueries.createTransaction).toHaveBeenCalledWith(
            COMPANY,
            expect.objectContaining({
                transaction_type: 'payment',
                status: 'completed',
                amount: 95,
                external_id: 'pi_merchant',
                external_source: 'stripe',
            }),
            mockTransactionClient
        );
    });

    it('returns the client secret for popup authentication without writing the ledger', async () => {
        q.getSessionById.mockResolvedValue(merchantSession);
        provider.confirmPaymentIntent.mockResolvedValue({
            id: 'pi_merchant',
            status: 'requires_action',
            client_secret: 'pi_action_secret',
        });

        await expect(svc.confirmManualCardSession(
            COMPANY,
            11,
            'pm_3ds'
        )).resolves.toEqual({
            status: 'requires_action',
            clientSecret: 'pi_action_secret',
        });
        expect(paymentsQueries.createTransaction).not.toHaveBeenCalled();
        expect(q.updateSession).not.toHaveBeenCalled();
    });

    it('maps a Stripe decline to a structured error and leaves the ledger unchanged', async () => {
        q.getSessionById.mockResolvedValue(merchantSession);
        const decline = new Error('Your card was declined.');
        decline.stripeCode = 'card_declined';
        decline.httpStatus = 402;
        decline.stripePaymentIntent = { status: 'requires_payment_method' };
        provider.confirmPaymentIntent.mockRejectedValue(decline);

        await expect(svc.confirmManualCardSession(
            COMPANY,
            11,
            'pm_declined'
        )).rejects.toMatchObject({
            code: 'CARD_DECLINED',
            httpStatus: 402,
            message: 'Your card was declined.',
        });
        expect(paymentsQueries.createTransaction).not.toHaveBeenCalled();
        expect(q.updateSession).not.toHaveBeenCalled();
    });

    it('finalizes the authenticated PI through the same idempotent ledger path', async () => {
        q.getSessionById.mockResolvedValue(merchantSession);
        provider.retrievePaymentIntent.mockResolvedValue({
            id: 'pi_merchant',
            status: 'succeeded',
            amount: 9500,
            amount_received: 9500,
            currency: 'usd',
            latest_charge: { id: 'ch_after_3ds' },
            metadata: { surface: 'manual_card' },
        });

        await expect(svc.finalizeManualCardSession(COMPANY, 11))
            .resolves.toEqual({ status: 'succeeded' });
        expect(provider.retrievePaymentIntent).toHaveBeenCalledWith(
            ACCT,
            'pi_merchant'
        );
        expect(q.updateSession).toHaveBeenCalledWith(
            COMPANY,
            11,
            { status: 'complete', stripe_charge_id: 'ch_after_3ds' },
            mockTransactionClient
        );
        expect(paymentsQueries.createTransaction).toHaveBeenCalledTimes(1);
    });

    it('T-foreign: rejects before Stripe or ledger mutation', async () => {
        q.getSessionById.mockResolvedValue(null);

        await expect(svc.confirmManualCardSession(
            '22222222-2222-2222-2222-222222222222',
            11,
            'pm_card_11'
        )).rejects.toMatchObject({ code: 'NOT_FOUND', httpStatus: 404 });
        expect(provider.confirmPaymentIntent).not.toHaveBeenCalled();
        expect(paymentsQueries.createTransaction).not.toHaveBeenCalled();
        expect(q.updateSession).not.toHaveBeenCalled();
    });
});

describe('sendManualCardReceipt', () => {
    const noteActor = { id: '22222222-2222-4222-8222-222222222222', name: 'Agent' };
    const activityActor = { id: noteActor.id, type: 'user', label: null, source: 'crm' };
    const merchantSession = {
        id: 11,
        company_id: COMPANY,
        surface: 'manual_card',
        stripe_payment_intent_id: 'pi_merchant',
        stripe_account_id: ACCT,
        invoice_id: 42,
        job_id: 7,
        contact_id: 5,
        metadata: {},
    };

    it('delegates an owned canonical ledger payment to the Albusto email sender', async () => {
        q.getSessionById.mockResolvedValue(merchantSession);
        paymentsQueries.findByExternalSourceId.mockResolvedValue({ id: 91 });
        paymentsService.emailTransactionReceipt.mockResolvedValue({
            sent: true,
            delivery: 'email',
            idempotent: false,
        });

        const result = await svc.sendManualCardReceipt(
            COMPANY,
            11,
            'customer@example.com',
            noteActor,
            null,
            activityActor,
            'manual-card-receipt-11'
        );

        expect(paymentsQueries.findByExternalSourceId).toHaveBeenCalledWith(
            COMPANY,
            'stripe',
            'pi_merchant',
            null
        );
        expect(paymentsService.emailTransactionReceipt).toHaveBeenCalledWith(
            COMPANY,
            91,
            'customer@example.com',
            noteActor,
            null,
            activityActor,
            'manual-card-receipt-11'
        );
        expect(result).toEqual({
            sent: true,
            delivery: 'email',
            idempotent: false,
        });
    });

    it('returns a retryable conflict while a successful session is not yet in the ledger', async () => {
        q.getSessionById.mockResolvedValue(merchantSession);
        paymentsQueries.findByExternalSourceId.mockResolvedValue(null);

        await expect(svc.sendManualCardReceipt(COMPANY, 11, 'customer@example.com'))
            .rejects.toMatchObject({ code: 'PAYMENT_NOT_SYNCED', httpStatus: 409 });
        expect(paymentsService.emailTransactionReceipt).not.toHaveBeenCalled();
    });

    it.each([
        ['foreign/missing session', null],
        ['public session', { ...merchantSession, metadata: { public: true } }],
        ['non-manual session', { ...merchantSession, surface: 'tap_to_pay' }],
    ])('404s before Stripe for %s', async (_label, session) => {
        q.getSessionById.mockResolvedValue(session);

        await expect(svc.sendManualCardReceipt(COMPANY, 11, 'customer@example.com'))
            .rejects.toMatchObject({ code: 'NOT_FOUND', httpStatus: 404 });
        expect(paymentsQueries.findByExternalSourceId).not.toHaveBeenCalled();
        expect(paymentsService.emailTransactionReceipt).not.toHaveBeenCalled();
    });
});

// ── Phase 4: terminal connection token ──────────────────────────────────────
describe('getConnectionToken (Phase 4)', () => {
    const readyAccount = { company_id: COMPANY, stripe_account_id: ACCT, details_submitted: true, charges_enabled: true, payouts_enabled: true, capabilities: { card_payments: 'active' }, status: 'connected_ready' };
    beforeEach(() => { provider.createConnectionToken = jest.fn(); });

    it('returns a connection token secret', async () => {
        q.getAccountByCompany.mockResolvedValue(readyAccount);
        q.listTerminalLocations.mockResolvedValue([{ stripe_location_id: 'tml_1' }]);
        provider.createConnectionToken.mockResolvedValue({ secret: 'pst_secret' });
        const res = await svc.getConnectionToken(COMPANY);
        expect(res).toEqual({ secret: 'pst_secret', location_id: 'tml_1' });
    });
});

describe('cancelTerminalIntent activity', () => {
    const session = {
        id: 71,
        surface: 'tap_to_pay',
        invoice_id: 42,
        job_id: null,
        contact_id: 5,
        amount: 25,
        currency: 'USD',
    };
    const activityActor = {
        id: '22222222-2222-4222-8222-222222222222',
        type: 'user',
        label: null,
        source: 'crm',
    };

    beforeEach(() => {
        provider.cancelPaymentIntent = jest.fn().mockResolvedValue({});
        q.getSessionByPaymentIntent.mockResolvedValue(session);
        q.getAccountByCompany.mockResolvedValue({ stripe_account_id: ACCT });
        q.updateSession.mockResolvedValue({ ...session, status: 'canceled' });
    });

    it('cancels the owned terminal session and emits payment.session_canceled', async () => {
        await expect(svc.cancelTerminalIntent(
            COMPANY,
            { id: activityActor.id },
            'pi_terminal',
            mockTransactionClient,
            activityActor
        )).resolves.toEqual({ canceled: true });

        expect(q.getSessionByPaymentIntent).toHaveBeenCalledWith(
            COMPANY,
            'pi_terminal',
            mockTransactionClient
        );
        expect(provider.cancelPaymentIntent).toHaveBeenCalledWith(ACCT, 'pi_terminal');
        expect(q.updateSession).toHaveBeenCalledWith(
            COMPANY,
            session.id,
            { status: 'canceled' },
            mockTransactionClient
        );
        expect(mockLogFinancialActivity).toHaveBeenCalledWith({
            companyId: COMPANY,
            entityType: 'payment',
            action: 'payment.session_canceled',
            entity: expect.objectContaining({ id: session.id, status: 'canceled' }),
            actor: activityActor,
            summary: { status: 'canceled' },
        }, { client: mockTransactionClient });
    });

    it('404s a foreign/missing session before calling Stripe', async () => {
        q.getSessionByPaymentIntent.mockResolvedValue(null);

        await expect(svc.cancelTerminalIntent(
            COMPANY,
            { id: activityActor.id },
            'pi_foreign',
            mockTransactionClient,
            activityActor
        )).rejects.toMatchObject({ code: 'NOT_FOUND', httpStatus: 404 });

        expect(provider.cancelPaymentIntent).not.toHaveBeenCalled();
        expect(mockLogFinancialActivity).not.toHaveBeenCalled();
    });
});

// ── Phase 5: refunds ────────────────────────────────────────────────────────
describe('refunds (Phase 5)', () => {
    beforeEach(() => { provider.createRefund = jest.fn(); });

    it('refundStripePayment calls Stripe then records idempotently', async () => {
        paymentsQueries.getTransactionById.mockResolvedValue({ id: 100, external_source: 'stripe', external_id: 'pi_1', status: 'completed', amount: 50, invoice_id: 42 });
        q.getAccountByCompany.mockResolvedValue({ company_id: COMPANY, stripe_account_id: ACCT });
        provider.createRefund.mockResolvedValue({ id: 're_1' });
        paymentsQueries.findByExternalSourceId
            .mockResolvedValueOnce(null)                                   // applyStripeRefund: refund not seen
            .mockResolvedValueOnce({ id: 100, invoice_id: 42, external_id: 'pi_1' }); // original lookup
        paymentsQueries.createTransaction.mockResolvedValue({ id: 200, external_id: 're_1' });
        paymentsQueries.updateTransactionStatus.mockResolvedValue({});
        invoicesQueries.recordPayment.mockResolvedValue({});
        invoicesService.getInvoice.mockResolvedValue({ id: 42, balance_due: 50, amount_paid: 0 });
        invoicesQueries.updateInvoiceStatus.mockResolvedValue({});
        invoicesQueries.createEvent.mockResolvedValue({});

        const res = await svc.refundStripePayment(COMPANY, { id: null }, 100, { amount: 50 });
        expect(provider.createRefund).toHaveBeenCalledWith(ACCT, expect.objectContaining({ paymentIntent: 'pi_1', amount: 50 }), expect.any(Object));
        expect(res.refund_id).toBe('re_1');
        const refundRow = paymentsQueries.createTransaction.mock.calls[0][1];
        expect(refundRow).toMatchObject({ transaction_type: 'refund', external_id: 're_1', external_source: 'stripe' });
        expect(Number(refundRow.amount)).toBeLessThan(0);
    });

    it('rejects refunding a non-Stripe transaction', async () => {
        paymentsQueries.getTransactionById.mockResolvedValue({ id: 100, external_source: 'zenbooker', status: 'completed', amount: 50 });
        await expect(svc.refundStripePayment(COMPANY, { id: null }, 100, {})).rejects.toMatchObject({ code: 'INVALID' });
    });

    it('applyStripeRefund is idempotent on refund id', async () => {
        paymentsQueries.findByExternalSourceId.mockResolvedValueOnce({ id: 200, external_id: 're_1' });
        const res = await svc.applyStripeRefund(COMPANY, { refundId: 're_1', paymentIntentId: 'pi_1', amount: 50 });
        expect(res).toMatchObject({ deduped: true });
        expect(paymentsQueries.createTransaction).not.toHaveBeenCalled();
    });

    it('refunding a TIPPED payment reverses only the balance portion (not the tip)', async () => {
        // Original $115 charge = $100 balance + $15 tip. Full refund of $115.
        paymentsQueries.findByExternalSourceId
            .mockResolvedValueOnce(null) // refund not seen
            .mockResolvedValueOnce({ id: 100, invoice_id: 42, amount: 115, metadata: { tip: 15 } }); // original
        paymentsQueries.createTransaction.mockResolvedValue({ id: 201, external_id: 're_tip' });
        paymentsQueries.updateTransactionStatus.mockResolvedValue({});
        invoicesQueries.recordPayment.mockResolvedValue({});
        invoicesService.getInvoice.mockResolvedValue({ id: 42, balance_due: 100, amount_paid: 0 });
        invoicesQueries.updateInvoiceStatus.mockResolvedValue({});
        invoicesQueries.createEvent.mockResolvedValue({});

        await svc.applyStripeRefund(COMPANY, { refundId: 're_tip', paymentIntentId: 'pi_tip', amount: 115 });
        // Ledger refund row is the full -$115...
        expect(Number(paymentsQueries.createTransaction.mock.calls[0][1].amount)).toBe(-115);
        // ...but only the $100 balance portion is reversed against the invoice.
        expect(invoicesQueries.recordPayment).toHaveBeenCalledWith(42, COMPANY, -100, null);
    });
});

// STRIPE-REVOKED-HEAL-001: the merchant deleted their connected account on
// Stripe (or revoked platform access) — the platform key gets 403
// account_invalid. The service must flip the local row to disconnected and
// re-connect must mint a fresh account in the same click.
describe('STRIPE-REVOKED-HEAL-001 revoked/deleted connected account', () => {
    const staleRow = {
        stripe_account_id: 'acct_dead', status: 'connected_ready',
        charges_enabled: true, payouts_enabled: true, details_submitted: true,
        requirements_past_due: [], capabilities: { card_payments: 'active' },
    };
    const revokedErr = Object.assign(
        new Error("The provided key 'sk_live_x' does not have access to account 'acct_dead' (or that account does not exist). Application access may have been revoked."),
        { httpStatus: 403 }
    );

    it('refresh-status flips a revoked account to disconnected instead of throwing', async () => {
        q.getAccountByCompany
            .mockResolvedValueOnce(staleRow)
            .mockResolvedValueOnce({ ...staleRow, status: 'disconnected' });
        provider.getAccount = jest.fn().mockRejectedValue(revokedErr);
        const status = await svc.refreshStatus('c-1');
        expect(q.setAccountStatus).toHaveBeenCalledWith('c-1', 'disconnected');
        expect(status.readiness).toBe('disconnected');
        expect(status.can_collect).toBe(false);
    });

    it('non-revoked provider errors still surface from refresh-status', async () => {
        q.getAccountByCompany.mockResolvedValueOnce(staleRow);
        provider.getAccount = jest.fn().mockRejectedValue(Object.assign(new Error('rate limited'), { httpStatus: 429 }));
        await expect(svc.refreshStatus('c-1')).rejects.toThrow('rate limited');
        expect(q.setAccountStatus).not.toHaveBeenCalled();
    });

    it('connect self-heals a dead account and mints a fresh one in the same click', async () => {
        provider.isConfigured = jest.fn(() => true);
        q.getAccountByCompany
            .mockResolvedValueOnce(staleRow)
            .mockResolvedValueOnce({ ...staleRow, status: 'disconnected' });
        provider.createAccountLink = jest.fn()
            .mockRejectedValueOnce(revokedErr)
            .mockResolvedValueOnce({ url: 'https://connect.stripe.com/setup/new' });
        provider.deleteAccount = jest.fn().mockRejectedValue(Object.assign(new Error('gone'), { httpStatus: 403 }));
        provider.createAccount = jest.fn().mockResolvedValue({ id: 'acct_new' });
        q.insertAccount.mockResolvedValue({ stripe_account_id: 'acct_new', status: 'onboarding_incomplete' });

        const result = await svc.connect('c-1', { id: 'u-1' }, { name: 'ACME' });
        expect(q.setAccountStatus).toHaveBeenCalledWith('c-1', 'disconnected');
        expect(provider.createAccount).toHaveBeenCalled();
        expect(result.account_id).toBe('acct_new');
        expect(result.onboarding_url).toContain('connect.stripe.com/setup/new');
    });
});
