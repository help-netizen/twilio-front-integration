/** STRIPE-RECEIPT-001 — real payments router/authz contract for native receipts. */

class StripePaymentsError extends Error {
    constructor(code, message, httpStatus = 400) {
        super(message);
        this.name = 'StripePaymentsError';
        this.code = code;
        this.httpStatus = httpStatus;
    }
}

const mockStripeService = {
    StripePaymentsError,
    sendManualCardReceipt: jest.fn(),
};

jest.mock('../backend/src/services/stripePaymentsService', () => mockStripeService);
jest.mock('../backend/src/services/paymentsService', () => ({}));
jest.mock('../backend/src/services/auditService', () => ({ log: jest.fn().mockResolvedValue(undefined) }));

const paymentsRouter = require('../backend/src/routes/payments');
const { ALL_PERMISSION_KEYS } = require('../backend/src/services/permissionCatalog');

const COMPANY_A = '00000000-0000-0000-0000-0000000000aa';
const COMPANY_B = '00000000-0000-0000-0000-0000000000bb';
const CRM_USER_ID = '22222222-2222-4222-8222-222222222222';

const receiptRouteIndex = paymentsRouter.stack.findIndex(
    layer => layer.route?.path === '/manual-card-sessions/:sessionId/receipt'
);
const transactionRouteIndex = paymentsRouter.stack.findIndex(layer => layer.route?.path === '/:id');
const receiptRoute = paymentsRouter.stack[receiptRouteIndex].route;

async function dispatch({
    permissions = ['payments.collect_keyed'],
    company = COMPANY_A,
    authed = true,
    email = 'customer@example.com',
    crmUserId = CRM_USER_ID,
} = {}) {
    const req = {
        method: 'POST',
        originalUrl: '/api/payments/manual-card-sessions/11/receipt',
        params: { sessionId: '11' },
        body: { email },
        ip: '127.0.0.1',
        user: authed ? {
            sub: 'kc-sub',
            name: 'Agent Smith',
            email: 'agent@x.com',
            crmUser: crmUserId ? { id: crmUserId } : undefined,
        } : undefined,
        authz: authed ? { scope: 'tenant', company: { id: company }, permissions } : undefined,
        companyFilter: authed ? { company_id: company } : undefined,
        companyId: 'LEGACY-DO-NOT-USE',
    };
    const res = {
        statusCode: 200,
        body: undefined,
        status(code) { this.statusCode = code; return this; },
        json(body) { this.body = body; return this; },
    };

    // Emulate authenticate + requireCompanyAccess on the protected /api/payments mount.
    if (!req.user) {
        res.status(401).json({ ok: false, error: { code: 'UNAUTHENTICATED', message: 'Auth required' } });
        return { status: res.statusCode, body: res.body };
    }

    for (const layer of receiptRoute.stack) {
        let nextCalled = false;
        let nextError;
        await Promise.resolve(layer.handle(req, res, (err) => {
            nextCalled = true;
            nextError = err;
        }));
        if (nextError) throw nextError;
        if (!nextCalled) break;
    }
    return { status: res.statusCode, body: res.body };
}

beforeEach(() => { jest.clearAllMocks(); });

describe('POST /api/payments/manual-card-sessions/:sessionId/receipt', () => {
    it('uses the real keyed-collection permission and resolves before /:id', () => {
        expect(ALL_PERMISSION_KEYS).toContain('payments.collect_keyed');
        expect(receiptRouteIndex).toBeGreaterThanOrEqual(0);
        expect(receiptRouteIndex).toBeLessThan(transactionRouteIndex);
    });

    it('uses req.companyFilter and forwards the strict acting CRM user', async () => {
        const result = {
            sent: true,
            receipt_url: 'https://pay.stripe.com/receipts/test',
            contact_email_saved: true,
        };
        mockStripeService.sendManualCardReceipt.mockResolvedValue(result);

        const res = await dispatch({ email: 'customer@example.com' });

        expect(res).toEqual({ status: 200, body: result });
        expect(mockStripeService.sendManualCardReceipt).toHaveBeenCalledWith(
            COMPANY_A,
            '11',
            'customer@example.com',
            { id: CRM_USER_ID, name: 'Agent' }
        );
    });

    it('never substitutes the Keycloak sub when the CRM user is unavailable', async () => {
        mockStripeService.sendManualCardReceipt.mockResolvedValue({ sent: true });

        await dispatch({ crmUserId: null });

        expect(mockStripeService.sendManualCardReceipt).toHaveBeenCalledWith(
            COMPANY_A,
            '11',
            'customer@example.com',
            { id: null, name: 'Agent' }
        );
    });

    it('returns 401 when unauthenticated', async () => {
        const res = await dispatch({ authed: false });
        expect(res.status).toBe(401);
        expect(mockStripeService.sendManualCardReceipt).not.toHaveBeenCalled();
    });

    it('returns 403 without payments.collect_keyed', async () => {
        const res = await dispatch({ permissions: ['payments.view'] });
        expect(res.status).toBe(403);
        expect(res.body.code).toBe('ACCESS_DENIED');
        expect(mockStripeService.sendManualCardReceipt).not.toHaveBeenCalled();
    });

    it('maps a foreign-company session to 404', async () => {
        mockStripeService.sendManualCardReceipt.mockRejectedValue(
            new StripePaymentsError('NOT_FOUND', 'Manual card session not found', 404)
        );

        const res = await dispatch({ company: COMPANY_B });

        expect(res).toEqual({
            status: 404,
            body: { ok: false, error: { code: 'NOT_FOUND', message: 'Manual card session not found' } },
        });
        expect(mockStripeService.sendManualCardReceipt).toHaveBeenCalledWith(
            COMPANY_B,
            '11',
            'customer@example.com',
            { id: CRM_USER_ID, name: 'Agent' }
        );
    });

    it('returns the server-side email validation error without echoing the address', async () => {
        mockStripeService.sendManualCardReceipt.mockRejectedValue(
            new StripePaymentsError('INVALID_EMAIL', 'Enter a valid customer email', 400)
        );

        const res = await dispatch({ email: 'not-an-email' });

        expect(res).toEqual({
            status: 400,
            body: { ok: false, error: { code: 'INVALID_EMAIL', message: 'Enter a valid customer email' } },
        });
        expect(JSON.stringify(res.body)).not.toContain('not-an-email');
    });
});
