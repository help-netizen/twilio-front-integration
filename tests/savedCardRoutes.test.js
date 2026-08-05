'use strict';

class StripePaymentsError extends Error {
    constructor(code, message, httpStatus = 400, details = null) {
        super(message);
        this.name = 'StripePaymentsError';
        this.code = code;
        this.httpStatus = httpStatus;
        this.details = details;
    }
}

const mockStripeService = {
    StripePaymentsError,
    listJobSavedCards: jest.fn(),
    chargeJobSavedCard: jest.fn(),
    createManualCardSession: jest.fn(),
    listContactSavedCards: jest.fn(),
    removeContactSavedCard: jest.fn(),
};

jest.mock('../backend/src/services/stripePaymentsService', () => mockStripeService);
jest.mock('../backend/src/services/transactionService', () => ({
    withTransaction: jest.fn(work => work({ query: jest.fn() })),
}));
jest.mock('../backend/src/services/financialActivityService', () => ({
    userActor: jest.fn(id => ({ id, type: 'user', source: 'crm' })),
}));
jest.mock('../backend/src/services/auditService', () => ({
    log: jest.fn().mockResolvedValue(undefined),
}));

const jobsRouter = require('../backend/src/routes/jobs');
const contactsRouter = require('../backend/src/routes/contacts');

const COMPANY_A = '00000000-0000-4000-8000-0000000000aa';
const COMPANY_B = '00000000-0000-4000-8000-0000000000bb';
const ACTOR = '11111111-1111-4111-8111-111111111111';

function route(router, path, method) {
    return router.stack.find(layer => (
        layer.route?.path === path && layer.route.methods[method]
    )).route;
}

async function dispatch(targetRoute, {
    method = 'GET',
    company = COMPANY_A,
    permissions = [],
    jobVisibility = 'all',
    body = {},
} = {}) {
    const req = {
        method,
        params: method === 'DELETE'
            ? { id: '5', savedCardId: '41' }
            : { id: '7' },
        body,
        user: { crmUser: { id: ACTOR } },
        authz: {
            permissions,
            scopes: { job_visibility: jobVisibility },
            company: { id: company },
        },
        companyFilter: { company_id: company },
        companyId: 'LEGACY-DO-NOT-USE',
        get: jest.fn(),
    };
    const res = {
        statusCode: 200,
        body: undefined,
        status(code) { this.statusCode = code; return this; },
        json(value) { this.body = value; return this; },
    };
    for (const layer of targetRoute.stack) {
        let nextCalled = false;
        let nextError;
        await Promise.resolve(layer.handle(req, res, error => {
            nextCalled = true;
            nextError = error;
        }));
        if (nextError) throw nextError;
        if (!nextCalled) break;
    }
    return { status: res.statusCode, body: res.body };
}

beforeEach(() => {
    jest.clearAllMocks();
});

describe('job saved-card and manual-create route controls', () => {
    const listRoute = route(jobsRouter, '/:id/saved-payment-methods', 'get');
    const chargeRoute = route(jobsRouter, '/:id/charge-saved-payment-method', 'post');
    const manualRoute = route(jobsRouter, '/:id/stripe-manual-card-session', 'post');

    it('T-own forwards only companyFilter and the provider assigned-job scope', async () => {
        mockStripeService.listJobSavedCards.mockResolvedValue({ due: 95, cards: [] });

        await expect(dispatch(listRoute, {
            permissions: ['payments.collect_online'],
            jobVisibility: 'assigned_only',
        })).resolves.toMatchObject({ status: 200 });
        expect(mockStripeService.listJobSavedCards).toHaveBeenCalledWith(
            COMPANY_A,
            '7',
            {
                actorId: ACTOR,
                providerLimited: true,
                providerScope: { assignedOnly: true, userId: ACTOR },
            }
        );
    });

    it('charge forwards the strict body contract and never uses a legacy company id', async () => {
        mockStripeService.chargeJobSavedCard.mockResolvedValue({ status: 'succeeded', amount: 95 });
        const body = {
            saved_card_id: 41,
            amount: 1,
            expected_due: 95,
            request_key: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        };

        await expect(dispatch(chargeRoute, {
            method: 'POST',
            permissions: ['payments.collect_online'],
            body,
        })).resolves.toMatchObject({ status: 200 });
        expect(mockStripeService.chargeJobSavedCard).toHaveBeenCalledWith(
            COMPANY_A,
            { id: ACTOR },
            '7',
            {
                savedCardId: 41,
                amount: 1,
                expectedDue: 95,
                requestKey: body.request_key,
            },
            expect.objectContaining({ providerLimited: false })
        );
    });

    it('provider manual-card create receives assigned-job scope', async () => {
        mockStripeService.createManualCardSession.mockResolvedValue({ session_id: 71 });

        await dispatch(manualRoute, {
            method: 'POST',
            permissions: ['payments.collect_keyed'],
            jobVisibility: 'assigned_only',
            body: { amount: 95 },
        });

        expect(mockStripeService.createManualCardSession).toHaveBeenCalledWith(
            COMPANY_A,
            { id: ACTOR },
            { jobId: '7', amount: 95 },
            expect.any(Object),
            expect.any(Object),
            {
                actorId: ACTOR,
                providerLimited: true,
                providerScope: { assignedOnly: true, userId: ACTOR },
            }
        );
    });

    it.each([
        ['list', listRoute, 'GET', ['payments.view'], 'listJobSavedCards'],
        ['charge', chargeRoute, 'POST', ['payments.view'], 'chargeJobSavedCard'],
        ['manual create', manualRoute, 'POST', ['payments.collect_online'], 'createManualCardSession'],
    ])('R-matrix denies %s without its collect permission', async (
        _label, targetRoute, method, permissions, serviceMethod
    ) => {
        const response = await dispatch(targetRoute, { method, permissions });
        expect(response.status).toBe(403);
        expect(mockStripeService[serviceMethod]).not.toHaveBeenCalled();
    });

    it('T-foreign maps the service 404 without widening company scope', async () => {
        mockStripeService.chargeJobSavedCard.mockRejectedValue(
            new StripePaymentsError('NOT_FOUND', 'Job not found', 404)
        );

        const response = await dispatch(chargeRoute, {
            method: 'POST',
            company: COMPANY_B,
            permissions: ['payments.collect_online'],
        });
        expect(response.status).toBe(404);
        expect(mockStripeService.chargeJobSavedCard.mock.calls[0][0]).toBe(COMPANY_B);
    });
});

describe('contact saved-card route permission conjunctions', () => {
    const listRoute = route(contactsRouter, '/:id/saved-payment-methods', 'get');
    const removeRoute = route(contactsRouter, '/:id/saved-payment-methods/:savedCardId', 'delete');

    it('lists only with contacts.view AND payments.view', async () => {
        mockStripeService.listContactSavedCards.mockResolvedValue([]);

        await expect(dispatch(listRoute, {
            permissions: ['contacts.view', 'payments.view'],
        })).resolves.toMatchObject({ status: 200 });
        expect(mockStripeService.listContactSavedCards).toHaveBeenCalledWith(COMPANY_A, '7');

        for (const permissions of [['contacts.view'], ['payments.view']]) {
            jest.clearAllMocks();
            const response = await dispatch(listRoute, { permissions });
            expect(response.status).toBe(403);
            expect(mockStripeService.listContactSavedCards).not.toHaveBeenCalled();
        }
    });

    it('removes only with contacts.edit AND payments.view', async () => {
        mockStripeService.removeContactSavedCard.mockResolvedValue({ removed: true });

        await expect(dispatch(removeRoute, {
            method: 'DELETE',
            permissions: ['contacts.edit', 'payments.view'],
        })).resolves.toMatchObject({ status: 200 });
        expect(mockStripeService.removeContactSavedCard).toHaveBeenCalledWith(
            COMPANY_A,
            { id: ACTOR },
            '5',
            '41'
        );

        for (const permissions of [['contacts.edit'], ['payments.view']]) {
            jest.clearAllMocks();
            const response = await dispatch(removeRoute, { method: 'DELETE', permissions });
            expect(response.status).toBe(403);
            expect(mockStripeService.removeContactSavedCard).not.toHaveBeenCalled();
        }
    });
});
