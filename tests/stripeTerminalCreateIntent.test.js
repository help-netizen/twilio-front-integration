/**
 * MTECH-T4 [v1.5] — POST /api/stripe-terminal/payment-intents (Tap to Pay create).
 *
 * Route-level tests: mounts the REAL router + REAL requirePermission middleware,
 * driving the gate from req.authz.permissions (mirrors the PF007 canonical
 * payments-router test). Only stripePaymentsService is mocked; the route's own
 * validation, error mapping, actor/company wiring, and tenant scoping are
 * exercised for real. (spec §4.4, §8.T4, §10; C8)
 *
 * Covers: create returns client_secret+session; assertCollectable-not-ready → 409
 * NOT_READY; invalid amount → 400 INVALID_AMOUNT; NOT_CONFIGURED → 503; 401/403;
 * cross-tenant isolation (company_id comes from the token/authz, never the body).
 */

// ── A real error class the mocked service throws, so the route's
//    `err instanceof stripePaymentsService.StripePaymentsError` check holds and
//    handle() maps err.httpStatus. ────────────────────────────────────────────
class StripePaymentsError extends Error {
    constructor(code, message, httpStatus = 400) {
        super(message);
        this.name = 'StripePaymentsError';
        this.code = code;
        this.httpStatus = httpStatus;
    }
}

const mockService = {
    StripePaymentsError,
    createTapToPayIntent: jest.fn(),
    // present so the router module loads; not exercised here
    getConnectionToken: jest.fn(),
    cancelTerminalIntent: jest.fn(),
};
jest.mock('../backend/src/services/stripePaymentsService', () => mockService);
jest.mock('../backend/src/services/auditService', () => ({ log: jest.fn(async () => {}) }));

const express = require('express');
const http = require('http');

const COMPANY_A = '00000000-0000-0000-0000-0000000000aa';
const COMPANY_B = '00000000-0000-0000-0000-0000000000bb';
const CRM_USER = 'crm-user-1';

// ── Test app: injects an authz/user context, then mounts the real router with
//    the same middleware chain the create route declares. `authed:false`
//    simulates an unauthenticated request (no req.user / req.authz — 401). ─────
function makeApp({ permissions = ['payments.collect_terminal'], company = COMPANY_A, authed = true } = {}) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
        if (authed) {
            req.user = { sub: 'kc-sub', email: 'tech@x.com', crmUser: { id: CRM_USER } };
            req.authz = { scope: 'tenant', company: { id: company }, permissions, scopes: {} };
            req.companyFilter = { company_id: company };
            // Poison the legacy field — the route must never read it.
            req.companyId = 'LEGACY-DO-NOT-USE';
        }
        next();
    });
    // Emulate `authenticate`: no auth context → 401 before the router runs.
    app.use((req, res, next) => {
        if (!req.user) return res.status(401).json({ ok: false, error: { code: 'UNAUTHENTICATED', message: 'Auth required' } });
        next();
    });
    app.use('/', require('../backend/src/routes/stripeTerminal'));
    return app;
}

function request(app, method, path, body = null) {
    return new Promise((resolve, reject) => {
        const server = app.listen(0, () => {
            const { port } = server.address();
            const req = http.request({ hostname: '127.0.0.1', port, path, method, headers: { 'Content-Type': 'application/json' } }, (res) => {
                let data = '';
                res.on('data', c => { data += c; });
                res.on('end', () => {
                    server.close();
                    try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
                    catch { resolve({ status: res.statusCode, body: data }); }
                });
            });
            req.on('error', err => { server.close(); reject(err); });
            if (body != null) req.write(JSON.stringify(body));
            req.end();
        });
    });
}

const OK_RESULT = {
    session_id: 11,
    client_secret: 'pi_tap_secret',
    payment_intent_id: 'pi_tap',
    account_id: 'acct_test_123',
    amount: 9500,
};

beforeEach(() => { jest.clearAllMocks(); });

describe('POST /api/stripe-terminal/payment-intents (MTECH-T4)', () => {
    // ── happy path ──────────────────────────────────────────────────────────
    it('creates a Tap to Pay intent → 200 with client_secret + session', async () => {
        mockService.createTapToPayIntent.mockResolvedValue(OK_RESULT);
        const res = await request(makeApp(), 'POST', '/payment-intents', { amount: 9500, invoice_id: 42 });

        expect(res.status).toBe(200);
        expect(res.body).toEqual({ ok: true, data: OK_RESULT });
        // Field names in the envelope match the spec contract.
        expect(res.body.data).toMatchObject({
            session_id: 11, client_secret: 'pi_tap_secret', payment_intent_id: 'pi_tap', account_id: 'acct_test_123', amount: 9500,
        });
    });

    it('maps snake_case body → camelCase service params (invoice_id/job_id/contact_id) and passes actor', async () => {
        mockService.createTapToPayIntent.mockResolvedValue(OK_RESULT);
        await request(makeApp(), 'POST', '/payment-intents', { amount: 5000, invoice_id: 42, job_id: 7, contact_id: 9 });

        expect(mockService.createTapToPayIntent).toHaveBeenCalledTimes(1);
        const [companyArg, actorArg, paramsArg] = mockService.createTapToPayIntent.mock.calls[0];
        expect(companyArg).toBe(COMPANY_A);
        expect(actorArg).toEqual({ id: CRM_USER });
        expect(paramsArg).toEqual({ amount: 5000, invoiceId: 42, jobId: 7, contactId: 9 });
    });

    it('works for a job-only linkage (no invoice)', async () => {
        mockService.createTapToPayIntent.mockResolvedValue({ ...OK_RESULT, amount: 12000 });
        const res = await request(makeApp(), 'POST', '/payment-intents', { amount: 12000, job_id: 7 });
        expect(res.status).toBe(200);
        expect(mockService.createTapToPayIntent.mock.calls[0][2]).toMatchObject({ amount: 12000, jobId: 7 });
    });

    // ── validation: amount ──────────────────────────────────────────────────
    it('rejects a missing amount → 400 INVALID_AMOUNT (service not called)', async () => {
        const res = await request(makeApp(), 'POST', '/payment-intents', { invoice_id: 42 });
        expect(res.status).toBe(400);
        expect(res.body.error.code).toBe('INVALID_AMOUNT');
        expect(mockService.createTapToPayIntent).not.toHaveBeenCalled();
    });

    it('rejects a non-integer amount → 400 INVALID_AMOUNT', async () => {
        const res = await request(makeApp(), 'POST', '/payment-intents', { amount: 95.5, invoice_id: 42 });
        expect(res.status).toBe(400);
        expect(res.body.error.code).toBe('INVALID_AMOUNT');
        expect(mockService.createTapToPayIntent).not.toHaveBeenCalled();
    });

    it('rejects a zero / negative amount → 400 INVALID_AMOUNT', async () => {
        for (const amount of [0, -100]) {
            const res = await request(makeApp(), 'POST', '/payment-intents', { amount, invoice_id: 42 });
            expect(res.status).toBe(400);
            expect(res.body.error.code).toBe('INVALID_AMOUNT');
        }
        expect(mockService.createTapToPayIntent).not.toHaveBeenCalled();
    });

    it('rejects a string amount → 400 INVALID_AMOUNT', async () => {
        const res = await request(makeApp(), 'POST', '/payment-intents', { amount: '9500', invoice_id: 42 });
        expect(res.status).toBe(400);
        expect(res.body.error.code).toBe('INVALID_AMOUNT');
        expect(mockService.createTapToPayIntent).not.toHaveBeenCalled();
    });

    // ── service error → HTTP mapping (mirrors handle() in the route) ──────────
    it('assertCollectable not ready → 409 NOT_READY', async () => {
        mockService.createTapToPayIntent.mockRejectedValue(new StripePaymentsError('NOT_READY', 'Stripe payment collection is not ready', 409));
        const res = await request(makeApp(), 'POST', '/payment-intents', { amount: 9500, invoice_id: 42 });
        expect(res.status).toBe(409);
        expect(res.body).toEqual({ ok: false, error: { code: 'NOT_READY', message: 'Stripe payment collection is not ready' } });
    });

    it('service INVALID_AMOUNT (e.g. amount > invoice balance) → 400', async () => {
        mockService.createTapToPayIntent.mockRejectedValue(new StripePaymentsError('INVALID_AMOUNT', 'Amount must be > 0 and <= invoice balance', 400));
        const res = await request(makeApp(), 'POST', '/payment-intents', { amount: 999999, invoice_id: 42 });
        expect(res.status).toBe(400);
        expect(res.body.error.code).toBe('INVALID_AMOUNT');
    });

    it('not configured → 503 NOT_CONFIGURED', async () => {
        mockService.createTapToPayIntent.mockRejectedValue(new StripePaymentsError('NOT_CONFIGURED', 'Stripe is not configured', 503));
        const res = await request(makeApp(), 'POST', '/payment-intents', { amount: 9500, invoice_id: 42 });
        expect(res.status).toBe(503);
        expect(res.body.error.code).toBe('NOT_CONFIGURED');
    });

    it('unexpected error → 500 INTERNAL', async () => {
        mockService.createTapToPayIntent.mockRejectedValue(new Error('boom'));
        const res = await request(makeApp(), 'POST', '/payment-intents', { amount: 9500, invoice_id: 42 });
        expect(res.status).toBe(500);
        expect(res.body.ok).toBe(false);
        expect(res.body.error.code).toBe('INTERNAL');
    });

    // ── auth / authz ─────────────────────────────────────────────────────────
    it('401 when unauthenticated', async () => {
        const res = await request(makeApp({ authed: false }), 'POST', '/payment-intents', { amount: 9500, invoice_id: 42 });
        expect(res.status).toBe(401);
        expect(mockService.createTapToPayIntent).not.toHaveBeenCalled();
    });

    it('403 without payments.collect_terminal', async () => {
        const res = await request(makeApp({ permissions: ['payments.view'] }), 'POST', '/payment-intents', { amount: 9500, invoice_id: 42 });
        expect(res.status).toBe(403);
        expect(res.body.code).toBe('ACCESS_DENIED');
        expect(mockService.createTapToPayIntent).not.toHaveBeenCalled();
    });

    // ── cross-tenant isolation: company comes from authz, never the body ──────
    it('uses the token company_id, ignoring any company_id in the body', async () => {
        mockService.createTapToPayIntent.mockResolvedValue(OK_RESULT);
        await request(makeApp({ company: COMPANY_A }), 'POST', '/payment-intents', { amount: 9500, invoice_id: 42, company_id: COMPANY_B });
        expect(mockService.createTapToPayIntent.mock.calls[0][0]).toBe(COMPANY_A);
    });

    it('scopes to company B when the token is company B', async () => {
        mockService.createTapToPayIntent.mockResolvedValue(OK_RESULT);
        await request(makeApp({ company: COMPANY_B }), 'POST', '/payment-intents', { amount: 9500, invoice_id: 42 });
        expect(mockService.createTapToPayIntent.mock.calls[0][0]).toBe(COMPANY_B);
    });
});
