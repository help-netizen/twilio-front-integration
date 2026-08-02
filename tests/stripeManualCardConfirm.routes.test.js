/** CARDFRAME-001 P2a — authenticated, tenant-scoped manual-card confirm/finalize routes. */

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
    confirmManualCardSession: jest.fn(),
    finalizeManualCardSession: jest.fn(),
};

jest.mock('../backend/src/services/stripePaymentsService', () => mockStripeService);
jest.mock('../backend/src/services/paymentsService', () => ({}));
jest.mock('../backend/src/services/auditService', () => ({
    log: jest.fn().mockResolvedValue(undefined),
}));

const paymentsRouter = require('../backend/src/routes/payments');
const { ALL_PERMISSION_KEYS } = require('../backend/src/services/permissionCatalog');

const COMPANY_A = '00000000-0000-0000-0000-0000000000aa';
const COMPANY_B = '00000000-0000-0000-0000-0000000000bb';
const routeByPath = path => paymentsRouter.stack.find(
    layer => layer.route?.path === path
).route;

async function dispatch(
    path,
    {
        permissions = ['payments.collect_keyed'],
        company = COMPANY_A,
        authed = true,
        body = {},
        jobVisibility = 'all',
    } = {}
) {
    const route = routeByPath(path);
    const req = {
        method: 'POST',
        originalUrl: `/api/payments/manual-card-sessions/11/${path.endsWith('confirm') ? 'confirm' : 'finalize'}`,
        params: { sessionId: '11' },
        body,
        ip: '127.0.0.1',
        user: authed ? { sub: 'kc-sub', crmUser: { id: 'crm-user-1' } } : undefined,
        authz: authed
            ? { scope: 'tenant', company: { id: company }, permissions, scopes: { job_visibility: jobVisibility } }
            : undefined,
        companyFilter: authed ? { company_id: company } : undefined,
        companyId: 'LEGACY-DO-NOT-USE',
    };
    const res = {
        statusCode: 200,
        body: undefined,
        status(code) { this.statusCode = code; return this; },
        json(responseBody) { this.body = responseBody; return this; },
    };

    if (!req.user) {
        res.status(401).json({
            ok: false,
            error: { code: 'UNAUTHENTICATED', message: 'Auth required' },
        });
        return { status: res.statusCode, body: res.body };
    }

    for (const layer of route.stack) {
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

beforeEach(() => {
    jest.clearAllMocks();
});

describe('manual-card confirm/finalize routes', () => {
    const confirmPath = '/manual-card-sessions/:sessionId/confirm';
    const finalizePath = '/manual-card-sessions/:sessionId/finalize';

    it('uses the catalogued keyed-card permission', () => {
        expect(ALL_PERMISSION_KEYS).toContain('payments.collect_keyed');
    });

    it('T-own confirms with req.companyFilter and the submitted PaymentMethod', async () => {
        mockStripeService.confirmManualCardSession.mockResolvedValue({
            status: 'requires_action',
            clientSecret: 'pi_action_secret',
        });

        const res = await dispatch(confirmPath, {
            body: { payment_method_id: 'pm_card_11' },
        });

        expect(res).toEqual({
            status: 200,
            body: {
                status: 'requires_action',
                clientSecret: 'pi_action_secret',
            },
        });
        expect(mockStripeService.confirmManualCardSession).toHaveBeenCalledWith(
            COMPANY_A,
            '11',
            'pm_card_11',
            {
                actorId: 'crm-user-1',
                providerLimited: false,
                providerScope: { assignedOnly: false, userId: null },
            }
        );
    });

    it('T-own finalizes the same company-owned session', async () => {
        mockStripeService.finalizeManualCardSession.mockResolvedValue({
            status: 'succeeded',
        });

        await expect(dispatch(finalizePath)).resolves.toEqual({
            status: 200,
            body: { status: 'succeeded' },
        });
        expect(mockStripeService.finalizeManualCardSession).toHaveBeenCalledWith(
            COMPANY_A,
            '11',
            {
                actorId: 'crm-user-1',
                providerLimited: false,
                providerScope: { assignedOnly: false, userId: null },
            }
        );
    });

    it.each([
        ['confirm', confirmPath, 'confirmManualCardSession'],
        ['finalize', finalizePath, 'finalizeManualCardSession'],
    ])('provider %s forwards own-session + assigned-job scope', async (_label, path, method) => {
        mockStripeService[method].mockResolvedValue({ status: 'succeeded' });

        await dispatch(path, {
            jobVisibility: 'assigned_only',
            body: { payment_method_id: 'pm_card_11' },
        });

        expect(mockStripeService[method]).toHaveBeenCalledWith(
            COMPANY_A,
            '11',
            ...(method === 'confirmManualCardSession' ? ['pm_card_11'] : []),
            {
                actorId: 'crm-user-1',
                providerLimited: true,
                providerScope: { assignedOnly: true, userId: 'crm-user-1' },
            }
        );
    });

    it.each([
        ['confirm', confirmPath, 'confirmManualCardSession'],
        ['finalize', finalizePath, 'finalizeManualCardSession'],
    ])('T-foreign %s maps to 404 and never substitutes a legacy company id', async (
        _label,
        path,
        method
    ) => {
        mockStripeService[method].mockRejectedValue(
            new StripePaymentsError(
                'NOT_FOUND',
                'Manual card session not found',
                404
            )
        );

        const res = await dispatch(path, {
            company: COMPANY_B,
            body: { payment_method_id: 'pm_card_11' },
        });

        expect(res.status).toBe(404);
        expect(res.body).toEqual({
            ok: false,
            error: {
                code: 'NOT_FOUND',
                message: 'Manual card session not found',
            },
        });
        expect(mockStripeService[method].mock.calls[0][0]).toBe(COMPANY_B);
    });

    it.each([confirmPath, finalizePath])(
        'R-matrix deny and unauthenticated requests never reach %s',
        async path => {
            const method = path.endsWith('/confirm')
                ? 'confirmManualCardSession'
                : 'finalizeManualCardSession';

            const denied = await dispatch(path, {
                permissions: ['payments.view'],
            });
            expect(denied.status).toBe(403);
            expect(denied.body.code).toBe('ACCESS_DENIED');

            const unauthenticated = await dispatch(path, { authed: false });
            expect(unauthenticated.status).toBe(401);
            expect(mockStripeService[method]).not.toHaveBeenCalled();
        }
    );
});
