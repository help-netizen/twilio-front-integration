/**
 * STRIPE-ADHOC-PAY-001 — invoice-independent Stripe collect from the Job Finance tab.
 * Sibling of tests/stripePayments.test.js — reuses its mock harness, adds job mocks
 * (jobsService, emailService, conversationsService, emailMailboxService, messagingHelper,
 * phoneUtils). Covers: assertAdhocAmount, resolveSurfaceContext job branch,
 * ensureJobPaymentLink, getJobPaymentLink, sendJobPaymentLink, job webhook ledger.
 * (docs/test-cases/STRIPE-ADHOC-PAY-001.md TC-ADHOC/RSC/LINK/GET/QUERY/SEND/LEDGER)
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// Mirror the invoice harness.
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
// NEW mocks the job path needs.
jest.mock('../backend/src/services/jobsService');
jest.mock('../backend/src/services/emailService');
jest.mock('../backend/src/services/conversationsService');
jest.mock('../backend/src/services/emailMailboxService');
jest.mock('../backend/src/services/messagingHelper', () => ({ resolveCompanyProxyE164: jest.fn() }));
jest.mock('../backend/src/utils/phoneUtils', () => ({ toE164: jest.fn() }));
jest.mock('../backend/src/db/companyQueries', () => ({ getCompanyById: jest.fn().mockResolvedValue({ name: 'Acme' }) }));

const q = require('../backend/src/db/stripePaymentsQueries');
const paymentsQueries = require('../backend/src/db/paymentsQueries');
const invoicesService = require('../backend/src/services/invoicesService');
const invoicesQueries = require('../backend/src/db/invoicesQueries');
const auditService = require('../backend/src/services/auditService');
const jobsService = require('../backend/src/services/jobsService');
const emailService = require('../backend/src/services/emailService');
const conversationsService = require('../backend/src/services/conversationsService');
const emailMailboxService = require('../backend/src/services/emailMailboxService');
const { resolveCompanyProxyE164 } = require('../backend/src/services/messagingHelper');
const { toE164 } = require('../backend/src/utils/phoneUtils');

const svc = require('../backend/src/services/stripePaymentsService');
const provider = require('../backend/src/services/stripeConnectProvider');

const COMPANY = '11111111-1111-1111-1111-111111111111';
const ACCT = 'acct_test_123';
const readyAccount = { company_id: COMPANY, stripe_account_id: ACCT, details_submitted: true, charges_enabled: true, payouts_enabled: true, capabilities: { card_payments: 'active' }, status: 'connected_ready' };

beforeEach(() => {
    jest.clearAllMocks();
    provider.createCheckoutSession = jest.fn();
    provider.createPaymentIntent = jest.fn();
});

// ── A. assertAdhocAmount (§4.4) ─────────────────────────────────────────────
describe('assertAdhocAmount', () => {
    it('TC-ADHOC-1 min $0.50 boundary passes', () => expect(svc.assertAdhocAmount(0.5)).toBe(0.5));
    it('TC-ADHOC-2 below min rejects', () =>
        expect(() => svc.assertAdhocAmount(0.49)).toThrow(expect.objectContaining({ code: 'INVALID_AMOUNT', httpStatus: 400, message: 'Amount must be at least $0.50' })));
    it('TC-ADHOC-3 zero and blank reject', () => {
        for (const bad of [0, '', undefined]) {
            expect(() => svc.assertAdhocAmount(bad)).toThrow(expect.objectContaining({ code: 'INVALID_AMOUNT', httpStatus: 400 }));
        }
    });
    it('TC-ADHOC-4 max $100,000 boundary passes', () => expect(svc.assertAdhocAmount(100000)).toBe(100000));
    it('TC-ADHOC-5 above max rejects', () =>
        expect(() => svc.assertAdhocAmount(100000.01)).toThrow(expect.objectContaining({ code: 'INVALID_AMOUNT', httpStatus: 400, message: 'Amount exceeds the $100,000 limit' })));
    it('TC-ADHOC-6 non-numeric / NaN / null reject', () => {
        for (const bad of ['abc', NaN, null]) {
            expect(() => svc.assertAdhocAmount(bad)).toThrow(expect.objectContaining({ code: 'INVALID_AMOUNT', httpStatus: 400 }));
        }
    });
    it('TC-ADHOC-7 negative rejects', () =>
        expect(() => svc.assertAdhocAmount(-10)).toThrow(expect.objectContaining({ code: 'INVALID_AMOUNT', httpStatus: 400 })));
    it('TC-ADHOC-8 2dp rounding', () => {
        expect(svc.assertAdhocAmount(10.999)).toBe(11);
        expect(svc.assertAdhocAmount(10.005)).toBe(10.01);
        expect(svc.assertAdhocAmount(99.9)).toBe(99.9);
    });
    it('TC-ADHOC-9 string coercion of a valid amount', () => {
        expect(svc.assertAdhocAmount('180')).toBe(180);
        expect(svc.assertAdhocAmount('180.50')).toBe(180.5);
    });
});

// ── B. resolveSurfaceContext job branch ─────────────────────────────────────
// resolveSurfaceContext is exercised through the public ensureJobPaymentLink /
// sendJobPaymentLink entry points (it is not itself exported).
describe('resolveSurfaceContext (job branch)', () => {
    it('TC-RSC-1 jobId branch loads job → contactId + email/phone/name', async () => {
        q.getAccountByCompany.mockResolvedValue(readyAccount);
        jobsService.getJobById.mockResolvedValue({ id: 'job-1', contact_id: 5, customer_email: 'c@x.com', customer_phone: '+16175551212', customer_name: 'Ann' });
        q.findOpenJobSession.mockResolvedValue(null);
        provider.createCheckoutSession.mockResolvedValue({ id: 'cs_1', url: 'https://checkout/1' });
        q.insertSession.mockResolvedValue({ id: 11, url: 'https://checkout/1', expires_at: null });
        await svc.ensureJobPaymentLink(COMPANY, { id: 'u1' }, 'job-1', { amount: 180 });
        expect(jobsService.getJobById).toHaveBeenCalledWith('job-1', COMPANY);
        expect(q.insertSession.mock.calls[0][1]).toMatchObject({ job_id: 'job-1', contact_id: 5, amount: 180 });
    });

    it('TC-RSC-2 foreign/absent job → 404', async () => {
        q.getAccountByCompany.mockResolvedValue(readyAccount);
        jobsService.getJobById.mockResolvedValue(null);
        await expect(svc.ensureJobPaymentLink(COMPANY, { id: 'u1' }, 'foreign', { amount: 50 }))
            .rejects.toMatchObject({ code: 'NOT_FOUND', httpStatus: 404 });
    });

    it('TC-RSC-3 job with no contact → contactId null (link still allowed)', async () => {
        q.getAccountByCompany.mockResolvedValue(readyAccount);
        jobsService.getJobById.mockResolvedValue({ id: 'job-2', contact_id: null, customer_email: null, customer_phone: null });
        q.findOpenJobSession.mockResolvedValue(null);
        provider.createCheckoutSession.mockResolvedValue({ id: 'cs_2', url: 'https://checkout/2' });
        q.insertSession.mockResolvedValue({ id: 12, url: 'https://checkout/2', expires_at: null });
        await svc.ensureJobPaymentLink(COMPANY, { id: 'u1' }, 'job-2', { amount: 50 });
        expect(q.insertSession.mock.calls[0][1]).toMatchObject({ contact_id: null });
        expect(provider.createCheckoutSession.mock.calls[0][0]).toBe(ACCT);
        expect(provider.createCheckoutSession.mock.calls[0][1].metadata).toMatchObject({ contact_id: '' });
    });

    it('TC-RSC-4 job branch runs assertAdhocAmount ($0.50 floor)', async () => {
        q.getAccountByCompany.mockResolvedValue(readyAccount);
        jobsService.getJobById.mockResolvedValue({ id: 'job-1', contact_id: 5 });
        await expect(svc.ensureJobPaymentLink(COMPANY, { id: 'u1' }, 'job-1', { amount: 0.1 }))
            .rejects.toMatchObject({ code: 'INVALID_AMOUNT', httpStatus: 400 });
    });

    it('TC-RSC-5 invoice branch untouched (getJobById NOT called)', async () => {
        q.getAccountByCompany.mockResolvedValue(readyAccount);
        invoicesService.getInvoice.mockResolvedValue({ id: 42, status: 'sent', total: 100, balance_due: 100, contact_id: 5, job_id: 7 });
        q.findOpenSession.mockResolvedValue({ id: 9, url: 'https://pay/x', expires_at: null });
        await svc.ensurePaymentLink(COMPANY, { id: 'u1' }, 42);
        expect(jobsService.getJobById).not.toHaveBeenCalled();
    });
});

// ── C. ensureJobPaymentLink (§4.5) ──────────────────────────────────────────
describe('ensureJobPaymentLink', () => {
    function primeCreate() {
        q.getAccountByCompany.mockResolvedValue(readyAccount);
        jobsService.getJobById.mockResolvedValue({ id: 'job-1', contact_id: 5 });
        q.findOpenJobSession.mockResolvedValue(null);
        provider.createCheckoutSession.mockResolvedValue({ id: 'cs_1', url: 'https://checkout/stripe/1', payment_intent: 'pi_1' });
        q.insertSession.mockResolvedValue({ id: 11, url: 'https://checkout/stripe/1', expires_at: '2026-07-08T00:00:00Z' });
    }

    it('TC-LINK-1 session shape: job_id set, invoice_id NULL, surface checkout_link', async () => {
        primeCreate();
        const res = await svc.ensureJobPaymentLink(COMPANY, { id: 'u1' }, 'job-1', { amount: 180 });
        expect(q.insertSession.mock.calls[0][1]).toMatchObject({ invoice_id: null, job_id: 'job-1', contact_id: 5, surface: 'checkout_link', status: 'open', amount: 180 });
        expect(provider.createCheckoutSession.mock.calls[0][1].metadata).toEqual({ company_id: COMPANY, invoice_id: '', job_id: 'job-1', contact_id: '5' });
        expect(res).toMatchObject({ url: 'https://checkout/stripe/1', reused: false, session_id: 11 });
    });

    it('TC-LINK-2 idempotency key job-${company}-${job}-${amount}-v2 + no varying expires_at', async () => {
        primeCreate();
        await svc.ensureJobPaymentLink(COMPANY, { id: 'u1' }, 'job-1', { amount: 180 });
        // Versioned key retires pre-fix keys; params must stay stable across retries.
        expect(provider.createCheckoutSession.mock.calls[0][2]).toMatchObject({ idempotencyKey: `job-${COMPANY}-job-1-180-v2` });
        // Date.now()-derived expiry must NOT be sent to Stripe (it poisoned the key).
        expect(provider.createCheckoutSession.mock.calls[0][1].expiresAt).toBeUndefined();
    });

    it('TC-LINK-3 successUrl == cancelUrl == baseUrl()/pay/thanks', async () => {
        primeCreate();
        await svc.ensureJobPaymentLink(COMPANY, { id: 'u1' }, 'job-1', { amount: 180 });
        const payload = provider.createCheckoutSession.mock.calls[0][1];
        expect(payload.successUrl.endsWith('/pay/thanks')).toBe(true);
        expect(payload.cancelUrl.endsWith('/pay/thanks')).toBe(true);
    });

    it('TC-LINK-4 reuses valid open job session (reused:true)', async () => {
        q.getAccountByCompany.mockResolvedValue(readyAccount);
        jobsService.getJobById.mockResolvedValue({ id: 'job-1', contact_id: 5 });
        q.findOpenJobSession.mockResolvedValue({ id: 5, url: 'https://checkout/existing', expires_at: null });
        const res = await svc.ensureJobPaymentLink(COMPANY, { id: 'u1' }, 'job-1', { amount: 180 });
        expect(res).toMatchObject({ reused: true, url: 'https://checkout/existing', session_id: 5 });
        expect(provider.createCheckoutSession).not.toHaveBeenCalled();
        expect(q.insertSession).not.toHaveBeenCalled();
        expect(q.findOpenJobSession).toHaveBeenCalledWith(COMPANY, 'job-1', 180);
    });

    it('TC-LINK-5 different amount → new session (no reuse)', async () => {
        primeCreate();
        await svc.ensureJobPaymentLink(COMPANY, { id: 'u1' }, 'job-1', { amount: 200 });
        expect(q.findOpenJobSession).toHaveBeenCalledWith(COMPANY, 'job-1', 200);
        expect(provider.createCheckoutSession).toHaveBeenCalled();
        expect(q.insertSession).toHaveBeenCalled();
    });

    it('TC-LINK-6 NOT_READY when Stripe not collectable (409)', async () => {
        q.getAccountByCompany.mockResolvedValue(null);
        await expect(svc.ensureJobPaymentLink(COMPANY, { id: 'u1' }, 'job-1', { amount: 180 }))
            .rejects.toMatchObject({ code: 'NOT_READY', httpStatus: 409 });
        expect(jobsService.getJobById).not.toHaveBeenCalled();
    });

    it('TC-LINK-7 amount validated (INVALID_AMOUNT 400) min + max', async () => {
        q.getAccountByCompany.mockResolvedValue(readyAccount);
        jobsService.getJobById.mockResolvedValue({ id: 'job-1' });
        await expect(svc.ensureJobPaymentLink(COMPANY, { id: 'u1' }, 'job-1', { amount: 0.1 })).rejects.toMatchObject({ code: 'INVALID_AMOUNT', httpStatus: 400 });
        await expect(svc.ensureJobPaymentLink(COMPANY, { id: 'u1' }, 'job-1', { amount: 200000 })).rejects.toMatchObject({ code: 'INVALID_AMOUNT', httpStatus: 400 });
        expect(provider.createCheckoutSession).not.toHaveBeenCalled();
    });

    it('TC-LINK-8 foreign job → 404 (company-scoped)', async () => {
        q.getAccountByCompany.mockResolvedValue(readyAccount);
        jobsService.getJobById.mockResolvedValue(null);
        await expect(svc.ensureJobPaymentLink(COMPANY, { id: 'u1' }, 'job-foreign', { amount: 50 }))
            .rejects.toMatchObject({ code: 'NOT_FOUND', httpStatus: 404 });
        expect(provider.createCheckoutSession).not.toHaveBeenCalled();
    });

    it('TC-LINK-9 audit-logs payment_link_created target_type job', async () => {
        primeCreate();
        await svc.ensureJobPaymentLink(COMPANY, { id: 'u1' }, 'job-1', { amount: 180 });
        expect(auditService.log).toHaveBeenCalledWith(expect.objectContaining({ action: 'stripe_payments.payment_link_created', target_type: 'job', target_id: 'job-1', company_id: COMPANY }));
    });
});

// ── D. getJobPaymentLink (§4.5/§4.6) ────────────────────────────────────────
describe('getJobPaymentLink', () => {
    it('TC-GET-1 returns active + history', async () => {
        const future = new Date(Date.now() + 3600e3).toISOString();
        q.listSessionsForJob.mockResolvedValue([
            { id: 2, surface: 'checkout_link', status: 'open', expires_at: future, url: 'u2', amount: 180 },
            { id: 1, surface: 'checkout_link', status: 'expired', amount: 90 },
        ]);
        const res = await svc.getJobPaymentLink(COMPANY, 'job-1');
        expect(res.active).toMatchObject({ url: 'u2', amount: 180 });
        expect(res.history).toHaveLength(2);
        expect(res.history[0]).toEqual(expect.objectContaining({ id: 2, status: 'open', amount: 180, surface: 'checkout_link' }));
        expect(q.listSessionsForJob).toHaveBeenCalledWith(COMPANY, 'job-1');
    });

    it('TC-GET-2 no open session → active null', async () => {
        q.listSessionsForJob.mockResolvedValue([{ id: 1, surface: 'checkout_link', status: 'expired' }]);
        const res = await svc.getJobPaymentLink(COMPANY, 'job-1');
        expect(res.active).toBeNull();
    });

    it('TC-GET-3 expired open session excluded from active', async () => {
        const past = new Date(Date.now() - 3600e3).toISOString();
        q.listSessionsForJob.mockResolvedValue([{ id: 3, surface: 'checkout_link', status: 'open', expires_at: past }]);
        const res = await svc.getJobPaymentLink(COMPANY, 'job-1');
        expect(res.active).toBeNull();
    });
});

// ── D. STATIC — query bodies assert invoice_id IS NULL ──────────────────────
describe('TC-QUERY-1 findOpenJobSession/listSessionsForJob SQL', () => {
    const src = fs.readFileSync(path.join(__dirname, '../backend/src/db/stripePaymentsQueries.js'), 'utf8');
    it('findOpenJobSession filters invoice_id IS NULL + checkout_link + status/amount/expiry', () => {
        const body = src.slice(src.indexOf('function findOpenJobSession'), src.indexOf('function insertSession'));
        expect(body).toMatch(/invoice_id IS NULL/);
        expect(body).toMatch(/surface = 'checkout_link'/);
        expect(body).toMatch(/status = 'open'/);
        expect(body).toMatch(/amount = \$3/);
        expect(body).toMatch(/expires_at IS NULL OR expires_at > NOW\(\)/);
        expect(body).toMatch(/ensureMarketplaceSchema\(\)/);
    });
    it('listSessionsForJob filters invoice_id IS NULL + job_id=$2 + company_id=$1', () => {
        const body = src.slice(src.indexOf('function listSessionsForJob'), src.indexOf('function getSessionById'));
        expect(body).toMatch(/invoice_id IS NULL/);
        expect(body).toMatch(/job_id = \$2/);
        expect(body).toMatch(/company_id = \$1/);
        expect(body).toMatch(/ensureMarketplaceSchema\(\)/);
    });
});

// ── E. sendJobPaymentLink — real dispatch (§3.4, §0.5) ──────────────────────
describe('sendJobPaymentLink', () => {
    function primeLink() {
        q.getAccountByCompany.mockResolvedValue(readyAccount);
        q.findOpenJobSession.mockResolvedValue(null);
        provider.createCheckoutSession.mockResolvedValue({ id: 'cs_1', url: 'https://checkout/1' });
        q.insertSession.mockResolvedValue({ id: 11, url: 'https://checkout/1', expires_at: null });
    }

    it('TC-SEND-1 email path dispatches via emailService.sendEmail', async () => {
        jobsService.getJobById.mockResolvedValue({ id: 'job-1', contact_id: 5, customer_email: 'c@x.com', customer_phone: null, customer_name: 'Ann' });
        emailMailboxService.getMailboxStatus.mockResolvedValue({ status: 'connected' });
        emailService.sendEmail.mockResolvedValue({});
        primeLink();
        const res = await svc.sendJobPaymentLink(COMPANY, { id: 'u1', email: 'agent@x.com' }, 'job-1', { channel: 'email', message: 'hi', amount: 180 });
        expect(emailService.sendEmail).toHaveBeenCalledWith(COMPANY, expect.objectContaining({ to: 'c@x.com', subject: expect.stringMatching(/Payment request/), body: expect.stringContaining('https://checkout/1'), userId: 'u1' }));
        expect(emailService.sendEmail.mock.calls[0][1].files).toEqual([]);
        expect(res).toMatchObject({ sent: true, url: 'https://checkout/1', channel: 'email' });
        expect(auditService.log).toHaveBeenCalledWith(expect.objectContaining({ action: 'stripe_payments.payment_link_sent', target_type: 'job' }));
    });

    it('TC-SEND-2 SMS path dispatches via conversationsService.sendMessage', async () => {
        jobsService.getJobById.mockResolvedValue({ id: 'job-1', contact_id: 5, customer_email: null, customer_phone: '+16175551212' });
        resolveCompanyProxyE164.mockResolvedValue('+16175550000');
        toE164.mockReturnValue('+16175551212');
        conversationsService.getOrCreateConversation.mockResolvedValue({ id: 99 });
        conversationsService.sendMessage.mockResolvedValue({});
        primeLink();
        const res = await svc.sendJobPaymentLink(COMPANY, { id: 'u1' }, 'job-1', { channel: 'sms', amount: 180 });
        expect(conversationsService.sendMessage).toHaveBeenCalledWith(99, { body: expect.stringContaining('https://checkout/1') });
        expect(res).toMatchObject({ sent: true, channel: 'sms' });
        expect(emailService.sendEmail).not.toHaveBeenCalled();
    });

    it('TC-SEND-3a fallback: default email when present', async () => {
        jobsService.getJobById.mockResolvedValue({ id: 'job-1', customer_email: 'c@x.com', customer_phone: '+16175551212' });
        emailMailboxService.getMailboxStatus.mockResolvedValue({ status: 'connected' });
        emailService.sendEmail.mockResolvedValue({});
        primeLink();
        const res = await svc.sendJobPaymentLink(COMPANY, { id: 'u1' }, 'job-1', { amount: 180 });
        expect(emailService.sendEmail).toHaveBeenCalled();
        expect(conversationsService.sendMessage).not.toHaveBeenCalled();
        expect(res.channel).toBe('email');
    });

    it('TC-SEND-3b fallback: SMS when no email', async () => {
        jobsService.getJobById.mockResolvedValue({ id: 'job-1', customer_email: null, customer_phone: '+16175551212' });
        resolveCompanyProxyE164.mockResolvedValue('+16175550000');
        toE164.mockReturnValue('+16175551212');
        conversationsService.getOrCreateConversation.mockResolvedValue({ id: 99 });
        conversationsService.sendMessage.mockResolvedValue({});
        primeLink();
        const res = await svc.sendJobPaymentLink(COMPANY, { id: 'u1' }, 'job-1', { amount: 180 });
        expect(conversationsService.sendMessage).toHaveBeenCalled();
        expect(emailService.sendEmail).not.toHaveBeenCalled();
        expect(res.channel).toBe('sms');
    });

    it('TC-SEND-4 NO_CONTACT 422 when neither email nor phone', async () => {
        jobsService.getJobById.mockResolvedValue({ id: 'job-1', customer_email: null, customer_phone: null });
        q.getAccountByCompany.mockResolvedValue(readyAccount);
        await expect(svc.sendJobPaymentLink(COMPANY, { id: 'u1' }, 'job-1', {}))
            .rejects.toMatchObject({ code: 'NO_CONTACT', httpStatus: 422 });
        expect(provider.createCheckoutSession).not.toHaveBeenCalled();
    });

    it('TC-SEND-5 forced channel missing its contact → NO_CONTACT 422', async () => {
        jobsService.getJobById.mockResolvedValue({ id: 'job-1', customer_email: null, customer_phone: '+16175551212' });
        q.getAccountByCompany.mockResolvedValue(readyAccount);
        await expect(svc.sendJobPaymentLink(COMPANY, { id: 'u1' }, 'job-1', { channel: 'email' }))
            .rejects.toMatchObject({ code: 'NO_CONTACT', httpStatus: 422 });
        expect(conversationsService.sendMessage).not.toHaveBeenCalled();
    });

    it('TC-SEND-6 email path propagates MAILBOX_NOT_CONNECTED 409', async () => {
        jobsService.getJobById.mockResolvedValue({ id: 'job-1', customer_email: 'c@x.com', customer_phone: null });
        emailMailboxService.getMailboxStatus.mockResolvedValue({ status: 'disconnected' });
        primeLink();
        await expect(svc.sendJobPaymentLink(COMPANY, { id: 'u1' }, 'job-1', { channel: 'email', amount: 180 }))
            .rejects.toMatchObject({ code: 'MAILBOX_NOT_CONNECTED', httpStatus: 409 });
        expect(emailService.sendEmail).not.toHaveBeenCalled();
    });

    it('TC-SEND-7 SMS path propagates NO_PROXY 422', async () => {
        jobsService.getJobById.mockResolvedValue({ id: 'job-1', customer_email: null, customer_phone: '+16175551212' });
        resolveCompanyProxyE164.mockResolvedValue(null);
        primeLink();
        await expect(svc.sendJobPaymentLink(COMPANY, { id: 'u1' }, 'job-1', { channel: 'sms', amount: 180 }))
            .rejects.toMatchObject({ code: 'NO_PROXY', httpStatus: 422 });
        expect(conversationsService.sendMessage).not.toHaveBeenCalled();
    });

    it('TC-SEND-8 SMS path propagates NO_PHONE 422 on invalid E164', async () => {
        jobsService.getJobById.mockResolvedValue({ id: 'job-1', customer_email: null, customer_phone: '123' });
        resolveCompanyProxyE164.mockResolvedValue('+16175550000');
        toE164.mockReturnValue(null);
        primeLink();
        await expect(svc.sendJobPaymentLink(COMPANY, { id: 'u1' }, 'job-1', { channel: 'sms', amount: 180 }))
            .rejects.toMatchObject({ code: 'NO_PHONE', httpStatus: 422 });
    });

    it('TC-SEND-9 SMS wallet gate propagates WALLET_BLOCKED 402', async () => {
        jobsService.getJobById.mockResolvedValue({ id: 'job-1', customer_email: null, customer_phone: '+16175551212' });
        resolveCompanyProxyE164.mockResolvedValue('+16175550000');
        toE164.mockReturnValue('+16175551212');
        conversationsService.getOrCreateConversation.mockResolvedValue({ id: 99 });
        conversationsService.sendMessage.mockRejectedValue({ httpStatus: 402, code: 'WALLET_BLOCKED' });
        primeLink();
        await expect(svc.sendJobPaymentLink(COMPANY, { id: 'u1' }, 'job-1', { channel: 'sms', amount: 180 }))
            .rejects.toMatchObject({ code: 'WALLET_BLOCKED', httpStatus: 402 });
    });

    it('TC-SEND-10 audit-logged, NO invoicesQueries.createEvent', async () => {
        jobsService.getJobById.mockResolvedValue({ id: 'job-1', customer_email: 'c@x.com', customer_phone: null });
        emailMailboxService.getMailboxStatus.mockResolvedValue({ status: 'connected' });
        emailService.sendEmail.mockResolvedValue({});
        primeLink();
        await svc.sendJobPaymentLink(COMPANY, { id: 'u1' }, 'job-1', { channel: 'email', amount: 180 });
        expect(auditService.log).toHaveBeenCalledWith(expect.objectContaining({ action: 'stripe_payments.payment_link_sent', target_type: 'job', details: { channel: 'email' } }));
        expect(invoicesQueries.createEvent).not.toHaveBeenCalled();
    });

    // Regression (send-amount plumbing): the send path ensures the link itself, so it
    // NEEDS the amount. A send with a valid contact but no amount (the old frontend
    // called sendLink(jobId, {})) hits ensureJobPaymentLink → assertAdhocAmount(undefined)
    // → INVALID_AMOUNT. The frontend now threads amount through sendLink(jobId,{amount}).
    it('TC-SEND-11 amount threads through to the ensured link + dispatch', async () => {
        jobsService.getJobById.mockResolvedValue({ id: 'job-1', contact_id: 5, customer_email: 'c@x.com', customer_phone: null });
        emailMailboxService.getMailboxStatus.mockResolvedValue({ status: 'connected' });
        emailService.sendEmail.mockResolvedValue({});
        primeLink();
        const res = await svc.sendJobPaymentLink(COMPANY, { id: 'u1' }, 'job-1', { channel: 'email', amount: 242.5 });
        expect(q.insertSession.mock.calls[0][1]).toMatchObject({ amount: 242.5, job_id: 'job-1', invoice_id: null });
        expect(res).toMatchObject({ sent: true, channel: 'email' });
    });

    it('TC-SEND-12 valid contact but NO amount → INVALID_AMOUNT 400 (send needs the amount)', async () => {
        jobsService.getJobById.mockResolvedValue({ id: 'job-1', contact_id: 5, customer_email: 'c@x.com', customer_phone: null });
        emailMailboxService.getMailboxStatus.mockResolvedValue({ status: 'connected' });
        q.getAccountByCompany.mockResolvedValue(readyAccount);
        q.findOpenJobSession.mockResolvedValue(null);
        await expect(svc.sendJobPaymentLink(COMPANY, { id: 'u1' }, 'job-1', { channel: 'email' }))
            .rejects.toMatchObject({ code: 'INVALID_AMOUNT', httpStatus: 400 });
        expect(emailService.sendEmail).not.toHaveBeenCalled();
    });
});

// ── G. Ledger idempotency for the job-only session (§3.3, §4.7) ─────────────
describe('webhook job ledger (invoice_id NULL)', () => {
    const SECRET = 'whsec_connect_test';
    beforeAll(() => { process.env.STRIPE_CONNECT_WEBHOOK_SECRET = SECRET; });
    function signed(payload) {
        const body = JSON.stringify(payload);
        const t = 1700000000;
        const v1 = crypto.createHmac('sha256', SECRET).update(`${t}.${body}`).digest('hex');
        return { body, sig: `t=${t},v1=${v1}` };
    }

    it('TC-LEDGER-1 writes one job row (job_id set, invoice_id NULL, no auto-invoice)', async () => {
        q.getAccountByStripeId.mockResolvedValue({ company_id: COMPANY, stripe_account_id: ACCT });
        q.insertWebhookEvent.mockResolvedValue({ inserted: true, row: {} });
        q.getSessionByCheckoutId.mockResolvedValue({ id: 12, invoice_id: null, job_id: 'job-1', contact_id: 5 });
        q.updateSession.mockResolvedValue({});
        q.markWebhookEvent.mockResolvedValue(undefined);
        paymentsQueries.findByExternalSourceId.mockResolvedValue(null);
        paymentsQueries.createTransaction.mockResolvedValue({ id: 300, external_id: 'pi_job' });
        const { body, sig } = signed({ id: 'evt_job', type: 'checkout.session.completed', account: ACCT, data: { object: { id: 'cs_job', payment_intent: 'pi_job', amount_total: 18000, currency: 'usd', metadata: { job_id: 'job-1' } } } });
        const res = await svc.handleWebhook(body, sig);
        expect(res).toEqual({ ok: true });
        expect(paymentsQueries.createTransaction).toHaveBeenCalledTimes(1);
        expect(paymentsQueries.createTransaction.mock.calls[0][1]).toMatchObject({ external_source: 'stripe', external_id: 'pi_job', invoice_id: null, job_id: 'job-1', amount: 180 });
        expect(invoicesQueries.recordPayment).not.toHaveBeenCalled();
        expect(invoicesQueries.updateInvoiceStatus).not.toHaveBeenCalled();
    });

    it('TC-LEDGER-2 webhook retry deduped — no double charge', async () => {
        q.getAccountByStripeId.mockResolvedValue({ company_id: COMPANY, stripe_account_id: ACCT });
        q.insertWebhookEvent.mockResolvedValue({ inserted: true, row: {} });
        q.getSessionByCheckoutId.mockResolvedValue({ id: 12, invoice_id: null, job_id: 'job-1', contact_id: 5 });
        q.updateSession.mockResolvedValue({});
        q.markWebhookEvent.mockResolvedValue(undefined);
        paymentsQueries.findByExternalSourceId.mockResolvedValue({ id: 300, external_id: 'pi_job' });
        const { body, sig } = signed({ id: 'evt_job2', type: 'checkout.session.completed', account: ACCT, data: { object: { id: 'cs_job', payment_intent: 'pi_job', amount_total: 18000, currency: 'usd', metadata: { job_id: 'job-1' } } } });
        const res = await svc.handleWebhook(body, sig);
        expect(res).toEqual({ ok: true });
        expect(paymentsQueries.createTransaction).not.toHaveBeenCalled();
    });

    it('TC-LEDGER-3 contact attributed on job payment', async () => {
        q.getAccountByStripeId.mockResolvedValue({ company_id: COMPANY, stripe_account_id: ACCT });
        q.insertWebhookEvent.mockResolvedValue({ inserted: true, row: {} });
        q.getSessionByCheckoutId.mockResolvedValue({ id: 12, invoice_id: null, job_id: 'job-1', contact_id: 5 });
        q.updateSession.mockResolvedValue({});
        q.markWebhookEvent.mockResolvedValue(undefined);
        paymentsQueries.findByExternalSourceId.mockResolvedValue(null);
        paymentsQueries.createTransaction.mockResolvedValue({ id: 301, external_id: 'pi_job3' });
        const { body, sig } = signed({ id: 'evt_job3', type: 'checkout.session.completed', account: ACCT, data: { object: { id: 'cs_job3', payment_intent: 'pi_job3', amount_total: 5000, currency: 'usd', metadata: { job_id: 'job-1', contact_id: '5' } } } });
        await svc.handleWebhook(body, sig);
        expect(paymentsQueries.createTransaction.mock.calls[0][1]).toMatchObject({ contact_id: 5 });
    });
});
