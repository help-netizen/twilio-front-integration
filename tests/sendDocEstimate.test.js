'use strict';

/**
 * SEND-DOC-001 (TASK-SD-15) — estimatesService.sendEstimate dispatch + routes.
 *
 * Covers TC-SD-010..013, 016..018, 020, 023..030, and the §2.7 STATUS-AFTER-SUCCESS
 * guarantee for estimates (the status flip + `sent` event are written STRICTLY AFTER
 * a resolved dispatch — never on a failure branch).
 *
 *   Email happy path  → sendEmail(files:[pdf], link in body) BEFORE status→'sent'+sent_at+event.
 *   SMS  happy path   → resolveProxy → getOrCreateConversation → sendMessage(link) BEFORE status.
 *   Error matrix      → 400 blank recipient · 400 bad channel · 409 MAILBOX_NOT_CONNECTED
 *                       (precheck AND sendEmail-throws-plain-Error) · 422 NO_PROXY (no conv) ·
 *                       422 NO_PHONE · 402 WALLET_BLOCKED · 404 missing doc · 403 missing perm.
 *
 * Strategy mirrors slotEngineSettings.test.js: every db-query module + collaborator
 * service the lazy `require()`s pull in is jest.mocked; the real service runs over the
 * mocks; the /send route is exercised through an appWith({permissions,companyId}) factory.
 *
 * Run:
 *   npx jest --runTestsByPath tests/sendDocEstimate.test.js \
 *     --testPathIgnorePatterns "/node_modules/"
 */

const express = require('express');
const request = require('supertest');

const COMPANY_A = '00000000-0000-0000-0000-00000000000a';
const USER_SUB = '11111111-1111-4111-8111-111111111111'; // valid v4-shaped UUID so getUserId() keeps it
const CRM_USER_ID = '22222222-2222-4222-8222-222222222222';
const EST_ID = 42;
const EST_ID_S = String(EST_ID); // route passes req.params.id as a string
const JOB_ID = 519;

// ─── DB query layer ──────────────────────────────────────────────────────────
const mockGetEstimateById = jest.fn();
const mockGetEstimateItems = jest.fn();
const mockSetPublicToken = jest.fn();
const mockUpdateEstimate = jest.fn();
const mockCreateEvent = jest.fn();

jest.mock('../backend/src/db/estimatesQueries', () => ({
    getEstimateById: (...a) => mockGetEstimateById(...a),
    getEstimateItems: (...a) => mockGetEstimateItems(...a),
    setPublicToken: (...a) => mockSetPublicToken(...a),
    updateEstimate: (...a) => mockUpdateEstimate(...a),
    createEvent: (...a) => mockCreateEvent(...a),
}));

// ─── Collaborator services (all lazy-required inside sendEstimate) ───────────
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

// generatePdf's template/render pipeline — mocked so the email path yields a buffer
// without exercising the real renderer (PDF content is not under test, only attachment).
jest.mock('../backend/src/services/documentTemplatesService', () => ({
    resolveTemplate: jest.fn().mockResolvedValue({ key: 'estimate' }),
}));
const mockRenderEstimatePdf = jest.fn().mockResolvedValue(Buffer.from('%PDF-1.4 mock'));
jest.mock('../backend/src/services/estimatePdfService', () => ({
    renderEstimatePdf: (...a) => mockRenderEstimatePdf(...a),
}));

// auditService.log fires on the 403 path; stub so no real DB write.
jest.mock('../backend/src/services/auditService', () => ({ log: jest.fn().mockResolvedValue(undefined) }));
const mockLogFinancialActivity = jest.fn();
const mockEmit = jest.fn();
jest.mock('../backend/src/services/transactionService', () => ({
    withTransaction: jest.fn(work => work(null)),
}));
jest.mock('../backend/src/services/financialActivityService', () => ({
    logFinancialActivity: (...args) => mockLogFinancialActivity(...args),
    userActor: jest.fn(id => ({
        id: id || null, type: 'user', label: null, source: 'crm',
    })),
}));
jest.mock('../backend/src/services/eventBus', () => ({
    emit: (...args) => mockEmit(...args),
}));

const mockAddNote = jest.fn();
jest.mock('../backend/src/services/jobsService', () => ({
    addNote: (...a) => mockAddNote(...a),
}));

const estimatesService = require('../backend/src/services/estimatesService');
const estimatesRouter = require('../backend/src/routes/estimates');

// Mount the REAL router behind a controllable auth context (mirrors production order:
// authenticate → requireCompanyAccess → requirePermission). No user → 401; wrong perm → 403.
function appWith({ permissions = ['estimates.send'], companyId = COMPANY_A } = {}) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
        req.user = {
            sub: USER_SUB,
            email: 'agent@x.com',
            name: 'Agent Smith',
            crmUser: { id: CRM_USER_ID },
        };
        req.authz = { permissions };
        req.companyFilter = { company_id: companyId };
        next();
    });
    app.use('/', estimatesRouter);
    return app;
}

function estimateRow(overrides = {}) {
    return {
        id: EST_ID,
        company_id: COMPANY_A,
        estimate_number: 'ESTIMATE 519-1',
        status: 'draft',
        archived_at: null,
        contact_id: 7,
        contact_email: 'c@x.com',
        contact_phone: '+15551234567',
        job_id: JOB_ID,
        public_token: 'tok_estABCDE',
        public_token_expires_at: '2099-01-01T00:00:00.000Z',
        order_list: [{
            part_number: 'EMAIL-ESTIMATE-SECRET',
            part_name: 'Internal pump',
            quantity: 1,
        }],
        ...overrides,
    };
}

const CONNECTED = { provider: 'gmail', status: 'connected', email_address: 'ops@x.com' };

beforeEach(() => {
    jest.clearAllMocks();
    process.env.PUBLIC_APP_URL = 'https://app.albusto.com';
    // Default happy collaborators; individual tests override.
    mockGetEstimateById.mockResolvedValue(estimateRow());
    mockGetEstimateItems.mockResolvedValue([{ id: 1, name: 'Labor', quantity: 1, unit_price: 100, amount: 100 }]);
    mockSetPublicToken.mockResolvedValue(estimateRow());
    mockUpdateEstimate.mockResolvedValue(estimateRow({ status: 'sent' }));
    mockCreateEvent.mockResolvedValue(undefined);
    mockLogFinancialActivity.mockResolvedValue({ ok: true });
    mockEmit.mockResolvedValue({ id: 1 });
    mockGetMailboxStatus.mockResolvedValue(CONNECTED);
    mockSendEmail.mockResolvedValue({ provider_message_id: 'gmail-1', provider_thread_id: 'thr-1' });
    mockResolveProxy.mockResolvedValue('+15550001111');
    mockGetOrCreateConversation.mockResolvedValue({ id: 7 });
    mockSendMessage.mockResolvedValue(undefined);
    mockGetCompanyById.mockResolvedValue({ name: 'Boston Masters' });
    mockAddNote.mockResolvedValue({ notes: [] });
});

// ─── A. EMAIL happy path + ordering (TC-SD-010/011/016) ──────────────────────
describe('sendEstimate — email happy path', () => {
    it('ORDER-LIST-001: email body and PDF attachment payload exclude the internal order_list', async () => {
        const res = await request(appWith())
            .post(`/${EST_ID}/send`)
            .send({ channel: 'email', recipient: 'c@x.com', message: 'Hi there' });

        expect(res.status).toBe(200);
        expect(mockRenderEstimatePdf).toHaveBeenCalledTimes(1);
        expect(mockRenderEstimatePdf.mock.calls[0][0]).not.toHaveProperty('order_list');
        expect(JSON.stringify(mockRenderEstimatePdf.mock.calls[0][0]))
            .not.toContain('EMAIL-ESTIMATE-SECRET');
        expect(JSON.stringify(mockSendEmail.mock.calls[0][1]))
            .not.toContain('EMAIL-ESTIMATE-SECRET');
    });

    it('TC-SD-010: sendEmail(files:[pdf] + link in body) THEN status→sent + sent_at + sent event', async () => {
        const res = await request(appWith())
            .post(`/${EST_ID}/send`)
            .send({ channel: 'email', recipient: 'c@x.com', message: 'Hi there' });

        expect(res.status).toBe(200);

        // sendEmail invoked with the synthesized subject, link-bearing body, PDF attachment.
        expect(mockSendEmail).toHaveBeenCalledTimes(1);
        const [coId, payload] = mockSendEmail.mock.calls[0];
        expect(coId).toBe(COMPANY_A);
        expect(payload.to).toBe('c@x.com');
        expect(payload.subject).toBe('Estimate 519-1 from Boston Masters');
        const rotatedToken = mockSetPublicToken.mock.calls[0][2];
        expect(payload.body).toContain(`https://app.albusto.com/e/${rotatedToken}`);
        expect(payload.body).not.toContain('tok_estABCDE');
        expect(payload.body).toContain('Hi there');
        expect(payload.files).toHaveLength(1);
        expect(payload.files[0].mimetype).toBe('application/pdf');
        expect(payload.files[0].buffer).toBeInstanceOf(Buffer);
        expect(payload.userEmail).toBe('agent@x.com');

        // status flip + event written (route passes id as the string "42")
        expect(mockUpdateEstimate).toHaveBeenCalledWith(
            EST_ID_S, COMPANY_A, expect.objectContaining({ status: 'sent', sent_at: expect.any(String) }),
        );
        expect(mockCreateEvent).toHaveBeenCalledWith(
            COMPANY_A, EST_ID_S, 'sent', 'user', CRM_USER_ID, {
                channel: 'email',
                recipient: 'c@x.com',
                recipient_source: 'contact',
            },
        );
        expect(mockAddNote).toHaveBeenCalledWith(
            JOB_ID,
            'Estimate 519-1 sent to c@x.com',
            [],
            'Agent',
            CRM_USER_ID,
            null,
            COMPANY_A,
        );

        // ORDER: dispatch resolved BEFORE the status flip (the §2.7 guarantee).
        const sendOrder = mockSendEmail.mock.invocationCallOrder[0];
        const updateOrder = mockUpdateEstimate.mock.invocationCallOrder[0];
        const eventOrder = mockCreateEvent.mock.invocationCallOrder[0];
        expect(sendOrder).toBeLessThan(updateOrder);
        expect(updateOrder).toBeLessThan(eventOrder);
    });

    it('TC-SD-013: no contact_id → email still sends + status flips (no extra stamp dependency)', async () => {
        mockGetEstimateById.mockResolvedValue(estimateRow({ contact_id: null }));
        const res = await request(appWith())
            .post(`/${EST_ID}/send`)
            .send({ channel: 'email', recipient: 'c@x.com', message: 'Hi' });
        expect(res.status).toBe(200);
        expect(mockSendEmail).toHaveBeenCalledTimes(1);
        expect(mockUpdateEstimate).toHaveBeenCalledWith(EST_ID_S, COMPANY_A, expect.objectContaining({ status: 'sent' }));
    });

    it('derives the recipient from the estimate contact when the payload omits recipient', async () => {
        const res = await request(appWith())
            .post(`/${EST_ID}/send`)
            .send({ channel: 'email', message: 'Hi' });

        expect(res.status).toBe(200);
        expect(mockSendEmail.mock.calls[0][1].to).toBe('c@x.com');
        expect(mockCreateEvent).toHaveBeenCalledWith(
            COMPANY_A,
            EST_ID_S,
            'sent',
            'user',
            CRM_USER_ID,
            expect.objectContaining({
                recipient: 'c@x.com',
                recipient_source: 'contact',
            }),
        );
    });

    it("rejects estimate A with contact B's address before dispatch or status writes", async () => {
        const res = await request(appWith())
            .post(`/${EST_ID}/send`)
            .send({ channel: 'email', recipient: 'contact-b@example.com', message: 'Wrong person' });

        expect(res.status).toBe(409);
        expect(res.body.error.code).toBe('RECIPIENT_MISMATCH');
        expect(mockSendEmail).not.toHaveBeenCalled();
        expect(mockSendMessage).not.toHaveBeenCalled();
        expect(mockUpdateEstimate).not.toHaveBeenCalled();
        expect(mockCreateEvent).not.toHaveBeenCalled();
    });

    it('requires an explicit override when the estimate has no contact email', async () => {
        mockGetEstimateById.mockResolvedValue(estimateRow({
            contact_id: null,
            contact_email: null,
        }));

        const res = await request(appWith())
            .post(`/${EST_ID}/send`)
            .send({ channel: 'email', message: 'No contact address' });

        expect(res.status).toBe(400);
        expect(res.body.error.code).toBe('VALIDATION');
        expect(mockSendEmail).not.toHaveBeenCalled();
        expect(mockUpdateEstimate).not.toHaveBeenCalled();
    });

    it('allows a deliberate recipient_override and records that source', async () => {
        const res = await request(appWith())
            .post(`/${EST_ID}/send`)
            .send({
                channel: 'email',
                recipient_override: 'dispatcher-entered@example.com',
                message: 'Requested alternate address',
            });

        expect(res.status).toBe(200);
        expect(mockSendEmail.mock.calls[0][1].to).toBe('dispatcher-entered@example.com');
        expect(mockCreateEvent).toHaveBeenCalledWith(
            COMPANY_A,
            EST_ID_S,
            'sent',
            'user',
            CRM_USER_ID,
            expect.objectContaining({
                recipient: 'dispatcher-entered@example.com',
                recipient_source: 'override',
            }),
        );
    });

    it('TC-SD-016: subject falls back to "Estimate <number>" when company name unavailable', async () => {
        mockGetCompanyById.mockResolvedValue(null);
        await request(appWith()).post(`/${EST_ID}/send`).send({ channel: 'email', recipient: 'c@x.com', message: 'm' });
        expect(mockSendEmail.mock.calls[0][1].subject).toBe('Estimate 519-1');
    });
});

// ─── B. SMS happy path + no-stamp + body-append (TC-SD-017/018/020) ──────────
describe('sendEstimate — sms happy path', () => {
    it('TC-SD-017: resolveProxy → getOrCreateConversation → sendMessage(link) THEN status', async () => {
        const res = await request(appWith())
            .post(`/${EST_ID}/send`)
            .send({ channel: 'sms', recipient: '+15551234567', message: "Here's your estimate" });

        expect(res.status).toBe(200);
        expect(mockGetOrCreateConversation).toHaveBeenCalledWith('+15551234567', '+15550001111', COMPANY_A);
        expect(mockSendMessage).toHaveBeenCalledTimes(1);
        const [convId, msg] = mockSendMessage.mock.calls[0];
        expect(convId).toBe(7);
        const rotatedToken = mockSetPublicToken.mock.calls[0][2];
        expect(msg.body).toContain(`https://app.albusto.com/e/${rotatedToken}`);
        expect(msg.body).not.toContain('tok_estABCDE');
        expect(msg.body.startsWith("Here's your estimate")).toBe(true);

        // no email/PDF on the SMS path
        expect(mockSendEmail).not.toHaveBeenCalled();

        // ORDER: sendMessage resolved before status flip
        expect(mockSendMessage.mock.invocationCallOrder[0])
            .toBeLessThan(mockUpdateEstimate.mock.invocationCallOrder[0]);
        expect(mockCreateEvent).toHaveBeenCalledWith(
            COMPANY_A, EST_ID_S, 'sent', 'user', CRM_USER_ID, {
                channel: 'sms',
                recipient: '+15551234567',
                recipient_source: 'contact',
            },
        );
        expect(mockAddNote).toHaveBeenCalledWith(
            JOB_ID,
            'Estimate 519-1 sent by SMS to +15551234567',
            [],
            'Agent',
            CRM_USER_ID,
            null,
            COMPANY_A,
        );
    });

    it('TC-SD-018: a prefilled old link is replaced by the rotated link, not double-appended', async () => {
        const withLink = 'See https://app.albusto.com/e/tok_estABCDE now';
        await request(appWith()).post(`/${EST_ID}/send`).send({ channel: 'sms', recipient: '+15551234567', message: withLink });
        const body = mockSendMessage.mock.calls[0][1].body;
        const rotatedToken = mockSetPublicToken.mock.calls[0][2];
        expect(body).toBe(`See https://app.albusto.com/e/${rotatedToken} now`);
        expect(body).not.toContain('tok_estABCDE');
    });

    it('TC-SD-020: SMS path does NOT mint a separate timeline stamp (projection lives in sendMessage)', async () => {
        await request(appWith()).post(`/${EST_ID}/send`).send({ channel: 'sms', recipient: '+15551234567', message: 'x' });
        // estimatesQueries has no linkMessageToContact; assert no stray email send either.
        expect(mockSendEmail).not.toHaveBeenCalled();
    });
});

describe('sendEstimate — document send note is best-effort', () => {
    it('keeps a successful send successful when the job note write fails', async () => {
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
        mockAddNote.mockRejectedValueOnce(new Error('notes unavailable'));

        const res = await request(appWith())
            .post(`/${EST_ID}/send`)
            .send({ channel: 'email', recipient_override: 'one-off@example.com', message: 'Hi' });

        expect(res.status).toBe(200);
        expect(mockUpdateEstimate).toHaveBeenCalledWith(
            EST_ID_S,
            COMPANY_A,
            expect.objectContaining({ status: 'sent' }),
        );
        expect(warn).toHaveBeenCalledWith('[DocumentSendNote] Job note failed after successful send (non-fatal)');
        expect(JSON.stringify(warn.mock.calls)).not.toContain('one-off@example.com');
        warn.mockRestore();
    });
});

describe('sendEstimate — lifecycle guards', () => {
    it.each(['viewed', 'approved'])(
        'resends a %s estimate without demoting it back to sent',
        async status => {
            mockGetEstimateById.mockResolvedValue(estimateRow({ status }));

            const res = await request(appWith())
                .post(`/${EST_ID}/send`)
                .send({ channel: 'email', recipient: 'c@x.com', message: 'Another copy' });

            expect(res.status).toBe(200);
            expect(mockUpdateEstimate).toHaveBeenCalledWith(
                EST_ID_S,
                COMPANY_A,
                expect.objectContaining({ status, sent_at: expect.any(String) })
            );
        }
    );

    it('rejects sending a declined estimate before dispatch or status writes', async () => {
        mockGetEstimateById.mockResolvedValue(estimateRow({ status: 'declined' }));

        const res = await request(appWith())
            .post(`/${EST_ID}/send`)
            .send({ channel: 'email', recipient: 'c@x.com', message: 'Old copy' });

        expect(res.status).toBe(409);
        expect(res.body.error.code).toBe('INVALID_TRANSITION');
        expect(mockSendEmail).not.toHaveBeenCalled();
        expect(mockSendMessage).not.toHaveBeenCalled();
        expect(mockUpdateEstimate).not.toHaveBeenCalled();
    });
});

// ─── C. Error matrix (TC-SD-023..030) ────────────────────────────────────────
describe('sendEstimate — error matrix (status NEVER flips on failure)', () => {
    const assertNoStatusFlip = () => {
        expect(mockUpdateEstimate).not.toHaveBeenCalled();
        expect(mockCreateEvent).not.toHaveBeenCalledWith(EST_ID, 'sent', expect.anything(), expect.anything(), expect.anything());
    };

    it('TC-SD-023: blank / whitespace recipient → 400 VALIDATION, sendEmail not called, no flip', async () => {
        for (const recipient of ['', '   ']) {
            jest.clearAllMocks();
            mockGetEstimateById.mockResolvedValue(estimateRow());
            mockGetEstimateItems.mockResolvedValue([{ id: 1, name: 'L', quantity: 1, unit_price: 1, amount: 1 }]);
            const res = await request(appWith()).post(`/${EST_ID}/send`).send({ channel: 'email', recipient, message: 'x' });
            expect(res.status).toBe(400);
            expect(res.body.error.code).toBe('VALIDATION');
            expect(mockSendEmail).not.toHaveBeenCalled();
            assertNoStatusFlip();
        }
    });

    it('TC-SD-023b: unknown channel → 400 VALIDATION', async () => {
        const res = await request(appWith()).post(`/${EST_ID}/send`).send({ channel: 'carrier-pigeon', recipient: 'c@x.com', message: 'x' });
        expect(res.status).toBe(400);
        expect(res.body.error.code).toBe('VALIDATION');
        assertNoStatusFlip();
    });

    it('TC-SD-024: mailbox not connected (precheck) → 409 MAILBOX_NOT_CONNECTED, sendEmail NOT called', async () => {
        for (const mailbox of [{ status: 'disconnected' }, null]) {
            jest.clearAllMocks();
            mockGetEstimateById.mockResolvedValue(estimateRow());
            mockGetEstimateItems.mockResolvedValue([{ id: 1, name: 'L', quantity: 1, unit_price: 1, amount: 1 }]);
            mockGetMailboxStatus.mockResolvedValue(mailbox);
            const res = await request(appWith()).post(`/${EST_ID}/send`).send({ channel: 'email', recipient: 'c@x.com', message: 'x' });
            expect(res.status).toBe(409);
            expect(res.body.error.code).toBe('MAILBOX_NOT_CONNECTED');
            expect(mockSendEmail).not.toHaveBeenCalled();
            assertNoStatusFlip();
        }
    });

    it('TC-SD-025: sendEmail throws (plain Error AND statusCode=409) → mapped to 409, not 500', async () => {
        for (const err of [
            new Error('Mailbox is not connected'),                                  // plain, no statusCode
            Object.assign(new Error('Mailbox requires reconnection'), { statusCode: 409 }),
        ]) {
            jest.clearAllMocks();
            mockGetEstimateById.mockResolvedValue(estimateRow());
            mockGetEstimateItems.mockResolvedValue([{ id: 1, name: 'L', quantity: 1, unit_price: 1, amount: 1 }]);
            mockGetMailboxStatus.mockResolvedValue(CONNECTED); // passes precheck
            mockGetCompanyById.mockResolvedValue({ name: 'Co' });
            mockSendEmail.mockRejectedValue(err);
            const res = await request(appWith()).post(`/${EST_ID}/send`).send({ channel: 'email', recipient: 'c@x.com', message: 'x' });
            expect(res.status).toBe(409);
            expect(res.body.error.code).toBe('MAILBOX_NOT_CONNECTED');
            assertNoStatusFlip();
        }
    });

    it('TC-SD-026: SMS wallet blocked (sendMessage throws WALLET_BLOCKED/402) → 402, no flip', async () => {
        mockSendMessage.mockRejectedValue(Object.assign(new Error('blocked'), { code: 'WALLET_BLOCKED', httpStatus: 402 }));
        const res = await request(appWith()).post(`/${EST_ID}/send`).send({ channel: 'sms', recipient: '+15551234567', message: 'x' });
        expect(res.status).toBe(402);
        expect(res.body.error.code).toBe('WALLET_BLOCKED');
        assertNoStatusFlip();
    });

    it('TC-SD-027: no company sending number → 422 NO_PROXY, NO conversation created', async () => {
        mockResolveProxy.mockResolvedValue(null);
        const res = await request(appWith()).post(`/${EST_ID}/send`).send({ channel: 'sms', recipient: '+15551234567', message: 'x' });
        expect(res.status).toBe(422);
        expect(res.body.error.code).toBe('NO_PROXY');
        expect(mockGetOrCreateConversation).not.toHaveBeenCalled();
        expect(mockSendMessage).not.toHaveBeenCalled();
        assertNoStatusFlip();
    });

    it('TC-SD-028: invalid recipient phone → 422 NO_PHONE (conv not reached)', async () => {
        const res = await request(appWith()).post(`/${EST_ID}/send`).send({
            channel: 'sms',
            recipient_override: 'abc',
            message: 'x',
        });
        expect(res.status).toBe(422);
        expect(res.body.error.code).toBe('NO_PHONE');
        expect(mockGetOrCreateConversation).not.toHaveBeenCalled();
        assertNoStatusFlip();
    });

    it('TC-SD-029: missing doc → 404 NOT_FOUND (not 403)', async () => {
        mockGetEstimateById.mockResolvedValue(null);
        const res = await request(appWith()).post(`/${EST_ID}/send`).send({ channel: 'email', recipient: 'c@x.com', message: 'x' });
        expect(res.status).toBe(404);
        expect(res.body.error.code).toBe('NOT_FOUND');
    });

    it('TC-SD-030: missing estimates.send permission → 403, service never invoked', async () => {
        const res = await request(appWith({ permissions: ['estimates.view'] }))
            .post(`/${EST_ID}/send`).send({ channel: 'email', recipient: 'c@x.com', message: 'x' });
        expect(res.status).toBe(403);
        expect(mockGetEstimateById).not.toHaveBeenCalled();
        expect(mockSendEmail).not.toHaveBeenCalled();
    });
});

// ─── D. ensurePublicLink idempotency / mint (TC-SD-001/002/003) ──────────────
describe('ensurePublicLink', () => {
    it('TC-SD-002: reuses an existing unexpired token when rotation is not requested', async () => {
        mockGetEstimateById.mockResolvedValue(estimateRow({
            public_token: 'tok_estABCDE',
            public_token_expires_at: '2099-01-01T00:00:00.000Z',
        }));
        const out = await estimatesService.ensurePublicLink(COMPANY_A, EST_ID);
        expect(out).toEqual({ token: 'tok_estABCDE', url: 'https://app.albusto.com/e/tok_estABCDE' });
        expect(mockSetPublicToken).not.toHaveBeenCalled();
    });

    it('TC-SD-001: mints + persists a base64url token when absent, returns /e/<token>', async () => {
        mockGetEstimateById.mockResolvedValue(estimateRow({ public_token: null }));
        const activityActor = {
            id: CRM_USER_ID,
            type: 'user',
            label: null,
            source: 'crm',
        };
        const out = await estimatesService.ensurePublicLink(
            COMPANY_A,
            EST_ID,
            null,
            activityActor
        );
        expect(out.token).toMatch(/^[A-Za-z0-9_-]{11}$/); // 8 bytes → 11 url-safe chars
        expect(out.url).toBe(`https://app.albusto.com/e/${out.token}`);
        expect(mockSetPublicToken).toHaveBeenCalledWith(EST_ID, COMPANY_A, out.token, null, 18);
        expect(mockLogFinancialActivity).toHaveBeenCalledWith({
            companyId: COMPANY_A,
            entityType: 'estimate',
            action: 'estimate.link_created',
            entity: expect.objectContaining({ id: EST_ID }),
            actor: activityActor,
        }, { client: null });
    });

    it('rotates on resend and replaces expired or legacy no-expiry tokens', async () => {
        for (const row of [
            estimateRow({ public_token_expires_at: '2020-01-01T00:00:00.000Z' }),
            estimateRow({ public_token_expires_at: null }),
        ]) {
            jest.clearAllMocks();
            mockGetEstimateById.mockResolvedValue(row);
            const out = await estimatesService.ensurePublicLink(COMPANY_A, EST_ID);
            expect(out.token).not.toBe('tok_estABCDE');
            expect(mockSetPublicToken).toHaveBeenCalledWith(EST_ID, COMPANY_A, out.token, null, 18);
        }

        jest.clearAllMocks();
        mockGetEstimateById.mockResolvedValue(estimateRow());
        const rotated = await estimatesService.ensurePublicLink(
            COMPANY_A,
            EST_ID,
            null,
            null,
            { rotate: true }
        );
        expect(rotated.token).not.toBe('tok_estABCDE');
        expect(mockSetPublicToken).toHaveBeenCalledWith(EST_ID, COMPANY_A, rotated.token, null, 18);
    });

    it('TC-SD-003: missing/cross-tenant estimate → NOT_FOUND 404', async () => {
        mockGetEstimateById.mockResolvedValue(null);
        await expect(estimatesService.ensurePublicLink(COMPANY_A, EST_ID))
            .rejects.toMatchObject({ code: 'NOT_FOUND', httpStatus: 404 });
    });
});
