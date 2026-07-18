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
jest.mock('../backend/src/services/marketplaceService');
jest.mock('../backend/src/db/marketplaceQueries', () => ({
    ensureMarketplaceSchema: jest.fn().mockResolvedValue(undefined),
    listInstallations: jest.fn().mockResolvedValue([]),
}));
jest.mock('../backend/src/services/auditService', () => ({ log: jest.fn().mockResolvedValue(undefined) }));

const q = require('../backend/src/db/stripePaymentsQueries');
const paymentsQueries = require('../backend/src/db/paymentsQueries');
const paymentsService = require('../backend/src/services/paymentsService');
const invoicesService = require('../backend/src/services/invoicesService');
const invoicesQueries = require('../backend/src/db/invoicesQueries');

const svc = require('../backend/src/services/stripePaymentsService');
const provider = require('../backend/src/services/stripeConnectProvider');

const COMPANY = '11111111-1111-1111-1111-111111111111';
const ACCT = 'acct_test_123';

beforeEach(() => { jest.clearAllMocks(); });

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
        expect(invoicesQueries.recordPayment).toHaveBeenCalledWith(42, COMPANY, 50);
        expect(invoicesQueries.updateInvoiceStatus).toHaveBeenCalledWith(42, COMPANY, 'paid', 'paid_at');
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
        expect(invoicesQueries.recordPayment).toHaveBeenCalledWith(42, COMPANY, 100); // only balance to invoice
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

    it('TC-34 payment_failed marks session failed, no completed ledger row', async () => {
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
        expect(q.updateSession).toHaveBeenCalledWith(9, { status: 'failed', failure_reason: 'card_declined' });
        expect(paymentsService.createTransaction).not.toHaveBeenCalled();
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

        const result = await svc.createPublicPayIntent('public-token', { tip: 15 });

        expect(result).toMatchObject({ amount: 95, tip: 15, balance_due: 80 });
        expect(provider.createPaymentIntent).toHaveBeenCalledWith(
            ACCT,
            expect.objectContaining({ amount: 95, metadata: expect.objectContaining({ surface: 'public_pay' }) }),
            expect.objectContaining({ idempotencyKey: expect.any(String) })
        );
        expect(provider.createCardPaymentIntent).not.toHaveBeenCalled();
        expect(q.insertSession).toHaveBeenCalledWith(COMPANY, expect.objectContaining({
            surface: 'manual_card',
            metadata: { tip: 15, public: true },
        }));
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
        expect(q.getSessionById).toHaveBeenCalledWith(COMPANY, 11);
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
        expect(invoicesQueries.recordPayment).toHaveBeenCalledWith(42, COMPANY, -100);
    });
});
