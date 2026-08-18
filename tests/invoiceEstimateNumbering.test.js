'use strict';

const COMPANY_A = '00000000-0000-0000-0000-00000000000a';
const COMPANY_B = '00000000-0000-0000-0000-00000000000b';

const mockEstimateService = {
    listEstimates: jest.fn(),
    getEstimateByCode: jest.fn(),
    getEstimate: jest.fn(),
};
const mockInvoiceService = {
    listInvoices: jest.fn(),
    getInvoiceByCode: jest.fn(),
    getInvoice: jest.fn(),
};

jest.mock('../backend/src/services/estimatesService', () => mockEstimateService);
jest.mock('../backend/src/services/invoicesService', () => mockInvoiceService);
jest.mock('../backend/src/services/aiEstimateService', () => ({ generateDraft: jest.fn() }));
jest.mock('../backend/src/services/aiGenerationLogService', () => ({
    linkFinal: jest.fn(), record: jest.fn(), renderMarkdown: jest.fn(),
}));
jest.mock('../backend/src/services/reportPolishService', () => ({ polishReport: jest.fn() }));
jest.mock('../backend/src/services/marketplaceService', () => ({
    REPORT_TO_ESTIMATE_APP_KEY: 'report-to-estimate', isAppConnected: jest.fn(),
}));
jest.mock('../backend/src/services/documentSendNoteService', () => ({
    actorFromRequest: jest.fn(),
}));
jest.mock('../backend/src/services/financialActivityService', () => ({
    userActor: jest.fn(),
}));
jest.mock('../backend/src/services/transactionService', () => ({
    withTransaction: jest.fn(work => work({ query: jest.fn() })),
}));
jest.mock('../backend/src/services/auditService', () => ({
    log: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../backend/src/services/stripePaymentsService', () => {
    class StripePaymentsError extends Error {}
    return { StripePaymentsError };
});

const estimatesRouter = require('../backend/src/routes/estimates');
const invoicesRouter = require('../backend/src/routes/invoices');

async function invokeCodeRoute(
    router,
    code,
    { companyId = COMPANY_A, permissions = [], roleKey = 'dispatcher' } = {}
) {
    const layer = router.stack.find(candidate => (
        candidate.route?.path === '/by-code/:code' && candidate.route.methods.get
    ));
    const req = {
        method: 'GET',
        originalUrl: `/by-code/${code}`,
        params: { code },
        companyFilter: companyId ? { company_id: companyId } : null,
        user: { crmUser: { id: '22222222-2222-4222-8222-222222222222' } },
        authz: { permissions, membership: { role_key: roleKey } },
    };
    const res = {
        statusCode: 200,
        body: undefined,
        status(statusCode) {
            this.statusCode = statusCode;
            return this;
        },
        json(body) {
            this.body = body;
            return this;
        },
    };
    const handlers = layer.route.stack.map(candidate => candidate.handle);
    async function dispatch(index) {
        if (index >= handlers.length) return;
        let nextPromise = null;
        const next = (error) => {
            if (error) throw error;
            nextPromise = dispatch(index + 1);
            return nextPromise;
        };
        await handlers[index](req, res, next);
        if (nextPromise) await nextPromise;
    }
    await dispatch(0);
    return res;
}

beforeEach(() => {
    jest.clearAllMocks();
    mockEstimateService.getEstimateByCode.mockResolvedValue({
        id: 41,
        company_id: COMPANY_A,
        public_code: 'E3a9Z',
        estimate_number: 'ESTIMATE L31-2',
    });
    mockEstimateService.getEstimate.mockResolvedValue({
        id: 41,
        company_id: COMPANY_A,
        public_code: 'E3a9Z',
        estimate_number: 'ESTIMATE L31-2',
        items: [],
    });
    mockInvoiceService.getInvoiceByCode.mockResolvedValue({
        id: 51,
        company_id: COMPANY_A,
        public_code: 'I7b2Q',
        invoice_number: 'INVOICE L31-2',
    });
    mockInvoiceService.getInvoice.mockResolvedValue({
        id: 51,
        company_id: COMPANY_A,
        public_code: 'I7b2Q',
        invoice_number: 'INVOICE L31-2',
        items: [],
    });
});

test.each([
    ['Estimate', estimatesRouter],
    ['Invoice', invoicesRouter],
])('%s by-code route is registered before /:id', (_label, router) => {
    const paths = router.stack
        .map(layer => layer.route?.path)
        .filter(Boolean);
    expect(paths.indexOf('/by-code/:code')).toBeGreaterThanOrEqual(0);
    expect(paths.indexOf('/by-code/:code')).toBeLessThan(paths.indexOf('/:id'));
});

describe.each([
    {
        label: 'Estimate',
        router: estimatesRouter,
        permission: 'estimates.view',
        code: 'E3a9Z',
        key: 'estimate',
        resolver: mockEstimateService.getEstimateByCode,
        hydrator: mockEstimateService.getEstimate,
    },
    {
        label: 'Invoice',
        router: invoicesRouter,
        permission: 'invoices.view',
        code: 'I7b2Q',
        key: 'invoice',
        resolver: mockInvoiceService.getInvoiceByCode,
        hydrator: mockInvoiceService.getInvoice,
    },
])('$label by-code route', ({ router, permission, code, key, resolver, hydrator }) => {
    test('returns the locked DTO contract for the owning company', async () => {
        const response = await invokeCodeRoute(router, code, {
            permissions: [permission],
        });

        expect(response.statusCode).toBe(200);
        // Standard envelope { ok, data } — matches /:id and the request helper.
        expect(response.body.ok).toBe(true);
        expect(response.body.data).toEqual(expect.objectContaining({
            id: expect.any(Number),
            public_code: code,
        }));
        void key;
        expect(resolver).toHaveBeenCalledWith(code);
        expect(hydrator).toHaveBeenCalledWith(COMPANY_A, expect.any(Number));
    });

    test('returns 404 for a foreign company before scoped hydration', async () => {
        const response = await invokeCodeRoute(router, code, {
            companyId: COMPANY_B,
            permissions: [permission],
        });

        expect(response.statusCode).toBe(404);
        expect(hydrator).not.toHaveBeenCalled();
    });

    test('returns 404 when the global code is absent', async () => {
        resolver.mockResolvedValueOnce(null);

        const response = await invokeCodeRoute(router, 'xxxxx', {
            permissions: [permission],
        });

        expect(response.statusCode).toBe(404);
        expect(hydrator).not.toHaveBeenCalled();
    });

    test.each(['tenant_admin', 'manager', 'dispatcher', 'provider'])(
        'R-matrix: %s without the declared view permission is denied',
        async roleKey => {
            const response = await invokeCodeRoute(router, code, {
                permissions: [],
                roleKey,
            });

            expect(response.statusCode).toBe(403);
            expect(resolver).not.toHaveBeenCalled();
        }
    );

    test('fails closed without company context', async () => {
        const response = await invokeCodeRoute(router, code, {
            companyId: null,
            permissions: [permission],
        });

        expect(response.statusCode).toBe(403);
        expect(resolver).not.toHaveBeenCalled();
    });
});
