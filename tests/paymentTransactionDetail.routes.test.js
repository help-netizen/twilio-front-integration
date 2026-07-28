'use strict';

const mockGetTransactionDetail = jest.fn();

jest.mock('../backend/src/services/paymentsService', () => ({
    getTransactionDetail: mockGetTransactionDetail,
}));
jest.mock('../backend/src/services/auditService', () => ({
    log: jest.fn().mockResolvedValue(undefined),
}));

const paymentsRouter = require('../backend/src/routes/payments');

const COMPANY_A = '00000000-0000-0000-0000-0000000000aa';
const COMPANY_B = '00000000-0000-0000-0000-0000000000bb';
const detailRoute = paymentsRouter.stack.find(layer => layer.route?.path === '/:id').route;

async function dispatch({ company = COMPANY_A, permissions = ['payments.view'] } = {}) {
    const req = {
        method: 'GET',
        originalUrl: '/api/payments/71',
        params: { id: '71' },
        companyFilter: { company_id: company },
        companyId: 'LEGACY-DO-NOT-USE',
        authz: {
            scope: 'tenant',
            company: { id: company },
            permissions,
        },
    };
    const res = {
        statusCode: 200,
        body: undefined,
        status(code) { this.statusCode = code; return this; },
        json(body) { this.body = body; return this; },
    };
    for (const layer of detailRoute.stack) {
        let nextCalled = false;
        await Promise.resolve(layer.handle(req, res, () => {
            nextCalled = true;
        }));
        if (!nextCalled) break;
    }
    return { status: res.statusCode, body: res.body };
}

beforeEach(() => {
    jest.clearAllMocks();
});

test('GET /api/payments/:id returns enriched owned detail from companyFilter', async () => {
    const detail = {
        id: 71,
        amount: '95.00',
        created_by_name: 'Agent Smith',
        territory: 'Boston',
        receipt_history: [],
    };
    mockGetTransactionDetail.mockResolvedValue(detail);

    await expect(dispatch()).resolves.toEqual({
        status: 200,
        body: { ok: true, data: detail },
    });
    expect(mockGetTransactionDetail).toHaveBeenCalledWith(COMPANY_A, '71');
});

test('GET /api/payments/:id preserves foreign-company 404', async () => {
    mockGetTransactionDetail.mockRejectedValue(Object.assign(
        new Error('Transaction 71 not found'),
        { code: 'NOT_FOUND', httpStatus: 404 }
    ));

    const response = await dispatch({ company: COMPANY_B });

    expect(response.status).toBe(404);
    expect(mockGetTransactionDetail).toHaveBeenCalledWith(COMPANY_B, '71');
});

test('GET /api/payments/:id denies every request without payments.view', async () => {
    const response = await dispatch({ permissions: ['payments.collect_online'] });

    expect(response.status).toBe(403);
    expect(response.body.code).toBe('ACCESS_DENIED');
    expect(mockGetTransactionDetail).not.toHaveBeenCalled();
});
