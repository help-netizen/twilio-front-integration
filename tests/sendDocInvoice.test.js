'use strict';

/**
 * SEND-DOC-001 (TASK-SD-15) — invoicesService.sendInvoice dispatch + the
 * STATUS-FLIP-AFTER-SUCCESS regression (TC-SD-014/015/019/023/029..031).
 *
 * The invoice send is the highest-value regression: the OLD stub flipped status →
 * 'sent' + sent_at BEFORE doing any work, so a mailbox/wallet failure left an invoice
 * falsely "Sent". The fix writes status ONLY after dispatch resolves. These tests pin:
 *
 *   - email happy path uses the BRANDED PAY PAGE link `/pay/<token>` + invoice PDF,
 *     and flips status AFTER sendEmail resolves (assert order).
 *   - includePaymentLink:false omits the link from the body.
 *   - SMS happy path uses the `/pay/<token>` link.
 *   - REGRESSION: in EVERY failure branch (400/402/409/422) updateInvoiceStatus(...,'sent')
 *     and createEvent('sent') are NEVER called — the invoice stays 'draft'.
 *
 * Harness mirrors slotEngineSettings.test.js (mock db-query modules + collaborators;
 * run the real service; exercise /send through an appWith() supertest app).
 *
 * Run:
 *   npx jest --runTestsByPath tests/sendDocInvoice.test.js \
 *     --testPathIgnorePatterns "/node_modules/"
 */

const express = require('express');
const request = require('supertest');

const COMPANY_A = '00000000-0000-0000-0000-00000000000a';
const USER_SUB = '11111111-1111-4111-8111-111111111111';
const INV_ID = 77;
const INV_ID_S = String(INV_ID);

// ─── DB query layer ──────────────────────────────────────────────────────────
const mockGetInvoiceById = jest.fn();
const mockGetInvoiceItems = jest.fn();
const mockSetPublicToken = jest.fn();
const mockUpdateInvoiceStatus = jest.fn();
const mockCreateEvent = jest.fn();

jest.mock('../backend/src/db/invoicesQueries', () => ({
    getInvoiceById: (...a) => mockGetInvoiceById(...a),
    getInvoiceItems: (...a) => mockGetInvoiceItems(...a),
    setPublicToken: (...a) => mockSetPublicToken(...a),
    updateInvoiceStatus: (...a) => mockUpdateInvoiceStatus(...a),
    createEvent: (...a) => mockCreateEvent(...a),
}));
// estimatesQueries is required at module top of invoicesService but unused on the send path.
jest.mock('../backend/src/db/estimatesQueries', () => ({}));

// ─── Collaborators (lazy-required inside sendInvoice) ────────────────────────
const mockGetMailboxStatus = jest.fn();
jest.mock('../backend/src/services/emailMailboxService', () => ({
    getMailboxStatus: (...a) => mockGetMailboxStatus(...a),
}));

const mockSendEmail = jest.fn();
jest.mock('../backend/src/services/emailService', () => ({
    sendEmail: (...a) => mockSendEmail(...a),
}));

const mockResolveProxy = jest.fn();
jest.mock('../backend/src/services/messagingHelper', () => ({
    resolveCompanyProxyE164: (...a) => mockResolveProxy(...a),
}));

const mockGetOrCreateConversation = jest.fn();
const mockSendMessage = jest.fn();
jest.mock('../backend/src/services/conversationsService', () => ({
    getOrCreateConversation: (...a) => mockGetOrCreateConversation(...a),
    sendMessage: (...a) => mockSendMessage(...a),
}));

const mockGetCompanyById = jest.fn();
jest.mock('../backend/src/db/companyQueries', () => ({
    getCompanyById: (...a) => mockGetCompanyById(...a),
}));

// generatePdf pipeline: resolveTemplate + the renderer registry adapter.render.
const mockRender = jest.fn().mockResolvedValue(Buffer.from('%PDF-1.4 invoice'));
jest.mock('../backend/src/services/documentTemplatesService', () => ({
    resolveTemplate: jest.fn().mockResolvedValue({ key: 'invoice' }),
}));
jest.mock('../backend/src/services/documentTemplates', () => ({
    get: (type) => (type === 'invoice' ? { render: (...a) => mockRender(...a) } : null),
}));

jest.mock('../backend/src/services/auditService', () => ({ log: jest.fn().mockResolvedValue(undefined) }));

const invoicesRouter = require('../backend/src/routes/invoices');

function appWith({ permissions = ['invoices.send'], companyId = COMPANY_A } = {}) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
        req.user = { sub: USER_SUB, email: 'agent@x.com' };
        req.authz = { permissions };
        req.companyFilter = { company_id: companyId };
        next();
    });
    app.use('/', invoicesRouter);
    return app;
}

function invoiceRow(overrides = {}) {
    return {
        id: INV_ID,
        company_id: COMPANY_A,
        invoice_number: 'INVOICE L-519-1',
        status: 'draft',
        contact_id: 7,
        public_token: 'tok_invABCDE', // pre-seeded → ensurePublicLink never re-mints
        ...overrides,
    };
}

const CONNECTED = { provider: 'gmail', status: 'connected', email_address: 'ops@x.com' };

beforeEach(() => {
    jest.clearAllMocks();
    process.env.PUBLIC_APP_URL = 'https://app.albusto.com';
    mockGetInvoiceById.mockResolvedValue(invoiceRow());
    mockGetInvoiceItems.mockResolvedValue([{ id: 1, name: 'Labor', quantity: 1, unit_price: 100, amount: 100 }]);
    mockUpdateInvoiceStatus.mockResolvedValue(invoiceRow({ status: 'sent' }));
    mockCreateEvent.mockResolvedValue(undefined);
    mockGetMailboxStatus.mockResolvedValue(CONNECTED);
    mockSendEmail.mockResolvedValue({ provider_message_id: 'gmail-1' });
    mockResolveProxy.mockResolvedValue('+15550001111');
    mockGetOrCreateConversation.mockResolvedValue({ id: 7 });
    mockSendMessage.mockResolvedValue(undefined);
    mockGetCompanyById.mockResolvedValue({ name: 'Boston Masters' });
    mockRender.mockResolvedValue(Buffer.from('%PDF-1.4 invoice'));
});

// ─── A. Email happy path — pay-page link + PDF + AFTER-success order (TC-SD-014) ─
describe('sendInvoice — email happy path', () => {
    it('TC-SD-014: body has /pay/<token> link + invoice PDF; status flips AFTER sendEmail', async () => {
        const res = await request(appWith())
            .post(`/${INV_ID}/send`)
            .send({ channel: 'email', recipient: 'c@x.com', message: 'Hi', includePaymentLink: true });

        expect(res.status).toBe(200);
        expect(mockSendEmail).toHaveBeenCalledTimes(1);
        const [coId, payload] = mockSendEmail.mock.calls[0];
        expect(coId).toBe(COMPANY_A);
        expect(payload.subject).toBe('Invoice #INVOICE L-519-1 from Boston Masters');
        // PAY page link, NOT the /i/<token> PDF short link
        expect(payload.body).toContain('https://app.albusto.com/pay/tok_invABCDE');
        expect(payload.body).not.toContain('/i/tok_invABCDE');
        expect(payload.files[0].mimetype).toBe('application/pdf');

        // status + event written
        expect(mockUpdateInvoiceStatus).toHaveBeenCalledWith(INV_ID_S, COMPANY_A, 'sent', 'sent_at');
        expect(mockCreateEvent).toHaveBeenCalledWith(
            INV_ID_S, 'sent', 'user', USER_SUB, expect.objectContaining({ channel: 'email', recipient: 'c@x.com' }),
        );

        // ORDER: the §2.7 / flip-first-bug guarantee — dispatch BEFORE the status flip.
        expect(mockSendEmail.mock.invocationCallOrder[0])
            .toBeLessThan(mockUpdateInvoiceStatus.mock.invocationCallOrder[0]);
    });

    it('TC-SD-015: includePaymentLink:false → no pay-link anchor in the body, still flips', async () => {
        const res = await request(appWith())
            .post(`/${INV_ID}/send`)
            .send({ channel: 'email', recipient: 'c@x.com', message: 'Hi', includePaymentLink: false });
        expect(res.status).toBe(200);
        const payload = mockSendEmail.mock.calls[0][1];
        expect(payload.body).not.toContain('/pay/');
        expect(payload.body).not.toContain('tok_invABCDE');
        expect(mockUpdateInvoiceStatus).toHaveBeenCalledWith(INV_ID_S, COMPANY_A, 'sent', 'sent_at');
    });
});

// ─── B. SMS happy path — pay link (TC-SD-019) ────────────────────────────────
describe('sendInvoice — sms happy path', () => {
    it('TC-SD-019: SMS body contains /pay/<token>; status flips after sendMessage', async () => {
        const res = await request(appWith())
            .post(`/${INV_ID}/send`)
            .send({ channel: 'sms', recipient: '+15551234567', message: 'Pay here' });
        expect(res.status).toBe(200);
        expect(mockGetOrCreateConversation).toHaveBeenCalledWith('+15551234567', '+15550001111', COMPANY_A);
        const msg = mockSendMessage.mock.calls[0][1];
        expect(msg.body).toContain('https://app.albusto.com/pay/tok_invABCDE');
        expect(mockSendEmail).not.toHaveBeenCalled();
        expect(mockSendMessage.mock.invocationCallOrder[0])
            .toBeLessThan(mockUpdateInvoiceStatus.mock.invocationCallOrder[0]);
    });
});

// ─── C. STATUS-FLIP-AFTER-SUCCESS regression (TC-SD-031) ─────────────────────
describe('sendInvoice — status-flip-after-success (the flip-first regression)', () => {
    // In EVERY failure branch the invoice must NOT be marked 'sent'.
    const assertStaysDraft = () => {
        // updateInvoiceStatus is the ONLY status writer on this path; it must never be
        // called with 'sent' on a failure, and the 'sent' event must never be recorded.
        for (const call of mockUpdateInvoiceStatus.mock.calls) {
            expect(call[2]).not.toBe('sent');
        }
        expect(mockCreateEvent).not.toHaveBeenCalledWith(
            expect.anything(), 'sent', expect.anything(), expect.anything(), expect.anything(),
        );
    };

    it('TC-SD-031a: email mailbox 409 (precheck) → invoice stays draft', async () => {
        mockGetMailboxStatus.mockResolvedValue({ status: 'disconnected' });
        const res = await request(appWith()).post(`/${INV_ID}/send`).send({ channel: 'email', recipient: 'c@x.com', message: 'x' });
        expect(res.status).toBe(409);
        expect(res.body.error.code).toBe('MAILBOX_NOT_CONNECTED');
        expect(mockSendEmail).not.toHaveBeenCalled();
        assertStaysDraft();
    });

    it('TC-SD-031b: email sendEmail throws (plain "not connected") → 409, stays draft', async () => {
        mockGetMailboxStatus.mockResolvedValue(CONNECTED);
        mockSendEmail.mockRejectedValue(new Error('Mailbox is not connected'));
        const res = await request(appWith()).post(`/${INV_ID}/send`).send({ channel: 'email', recipient: 'c@x.com', message: 'x' });
        expect(res.status).toBe(409);
        expect(res.body.error.code).toBe('MAILBOX_NOT_CONNECTED');
        assertStaysDraft();
    });

    it('TC-SD-031c: SMS wallet blocked (402) → stays draft', async () => {
        mockSendMessage.mockRejectedValue(Object.assign(new Error('blocked'), { code: 'WALLET_BLOCKED', httpStatus: 402 }));
        const res = await request(appWith()).post(`/${INV_ID}/send`).send({ channel: 'sms', recipient: '+15551234567', message: 'x' });
        expect(res.status).toBe(402);
        expect(res.body.error.code).toBe('WALLET_BLOCKED');
        assertStaysDraft();
    });

    it('TC-SD-031d: SMS no proxy (422 NO_PROXY) → no conv, stays draft', async () => {
        mockResolveProxy.mockResolvedValue(null);
        const res = await request(appWith()).post(`/${INV_ID}/send`).send({ channel: 'sms', recipient: '+15551234567', message: 'x' });
        expect(res.status).toBe(422);
        expect(res.body.error.code).toBe('NO_PROXY');
        expect(mockSendMessage).not.toHaveBeenCalled();
        assertStaysDraft();
    });

    it('TC-SD-031e: SMS bad phone (422 NO_PHONE) → stays draft', async () => {
        const res = await request(appWith()).post(`/${INV_ID}/send`).send({ channel: 'sms', recipient: 'abc', message: 'x' });
        expect(res.status).toBe(422);
        expect(res.body.error.code).toBe('NO_PHONE');
        assertStaysDraft();
    });

    it('TC-SD-031f: blank recipient (400 VALIDATION) → stays draft', async () => {
        const res = await request(appWith()).post(`/${INV_ID}/send`).send({ channel: 'email', recipient: '   ', message: 'x' });
        expect(res.status).toBe(400);
        expect(res.body.error.code).toBe('VALIDATION');
        assertStaysDraft();
    });
});

// ─── D. tenant + permission (TC-SD-029/030) ──────────────────────────────────
describe('sendInvoice — tenant + permission', () => {
    it('TC-SD-029: missing invoice → 404 NOT_FOUND', async () => {
        mockGetInvoiceById.mockResolvedValue(null);
        const res = await request(appWith()).post(`/${INV_ID}/send`).send({ channel: 'email', recipient: 'c@x.com', message: 'x' });
        expect(res.status).toBe(404);
        expect(res.body.error.code).toBe('NOT_FOUND');
    });

    it('TC-SD-030: missing invoices.send permission → 403, service never invoked', async () => {
        const res = await request(appWith({ permissions: ['invoices.view'] }))
            .post(`/${INV_ID}/send`).send({ channel: 'email', recipient: 'c@x.com', message: 'x' });
        expect(res.status).toBe(403);
        expect(mockGetInvoiceById).not.toHaveBeenCalled();
    });
});
