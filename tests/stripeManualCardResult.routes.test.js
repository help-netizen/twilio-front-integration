/** STRIPE-PAYFORM-UX-001 — real payments router/authz contract for result lookup. */

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
    getManualCardSessionResult: jest.fn(),
};
const mockPaymentsService = {
    getTransaction: jest.fn(),
};

jest.mock('../backend/src/services/stripePaymentsService', () => mockStripeService);
jest.mock('../backend/src/services/paymentsService', () => mockPaymentsService);
jest.mock('../backend/src/services/auditService', () => ({ log: jest.fn().mockResolvedValue(undefined) }));

const paymentsRouter = require('../backend/src/routes/payments');
const { ALL_PERMISSION_KEYS } = require('../backend/src/services/permissionCatalog');

const COMPANY_A = '00000000-0000-0000-0000-0000000000aa';
const COMPANY_B = '00000000-0000-0000-0000-0000000000bb';

const resultRouteIndex = paymentsRouter.stack.findIndex(
    layer => layer.route?.path === '/manual-card-sessions/:sessionId/result'
);
const transactionRouteIndex = paymentsRouter.stack.findIndex(layer => layer.route?.path === '/:id');
const resultRoute = paymentsRouter.stack[resultRouteIndex].route;

async function dispatch({ permissions = ['payments.collect_keyed'], company = COMPANY_A, authed = true } = {}) {
    const req = {
        method: 'GET',
        originalUrl: '/api/payments/manual-card-sessions/11/result',
        params: { sessionId: '11' },
        ip: '127.0.0.1',
        user: authed ? { sub: 'kc-sub', crmUser: { id: 'crm-user-1' } } : undefined,
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

    // Emulate the authenticate middleware on the protected /api/payments mount.
    if (!req.user) {
        res.status(401).json({ ok: false, error: { code: 'UNAUTHENTICATED', message: 'Auth required' } });
        return { status: res.statusCode, body: res.body };
    }

    for (const layer of resultRoute.stack) {
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

describe('GET /api/payments/manual-card-sessions/:sessionId/result', () => {
    it('uses a permission present in the real catalog', () => {
        expect(ALL_PERMISSION_KEYS).toContain('payments.collect_keyed');
    });

    it('returns exactly the four-key result body and resolves before /:id', async () => {
        const result = { status: 'succeeded', amount: 95, brand: 'visa', last4: '4242' };
        mockStripeService.getManualCardSessionResult.mockResolvedValue(result);

        const res = await dispatch();

        expect(res.status).toBe(200);
        expect(res.body).toEqual(result);
        expect(Object.keys(res.body)).toEqual(['status', 'amount', 'brand', 'last4']);
        expect(mockStripeService.getManualCardSessionResult).toHaveBeenCalledWith(COMPANY_A, '11');
        expect(mockPaymentsService.getTransaction).not.toHaveBeenCalled();
        expect(resultRouteIndex).toBeGreaterThanOrEqual(0);
        expect(resultRouteIndex).toBeLessThan(transactionRouteIndex);
    });

    it('returns 401 when unauthenticated', async () => {
        const res = await dispatch({ authed: false });
        expect(res.status).toBe(401);
        expect(mockStripeService.getManualCardSessionResult).not.toHaveBeenCalled();
    });

    it('returns 403 without the real payments.collect_keyed permission', async () => {
        const res = await dispatch({ permissions: ['payments.view'] });
        expect(res.status).toBe(403);
        expect(res.body.code).toBe('ACCESS_DENIED');
        expect(mockStripeService.getManualCardSessionResult).not.toHaveBeenCalled();
    });

    it('uses req.companyFilter and maps a foreign-company session to 404', async () => {
        mockStripeService.getManualCardSessionResult.mockRejectedValue(
            new StripePaymentsError('NOT_FOUND', 'Manual card session not found', 404)
        );

        const res = await dispatch({ company: COMPANY_B });

        expect(res.status).toBe(404);
        expect(res.body).toEqual({
            ok: false,
            error: { code: 'NOT_FOUND', message: 'Manual card session not found' },
        });
        expect(mockStripeService.getManualCardSessionResult).toHaveBeenCalledWith(COMPANY_B, '11');
    });
});
