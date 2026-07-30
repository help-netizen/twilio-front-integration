/**
 * ROLE-PROVIDER-NO-PAYMENTS-001 — the standalone payments ledger is decoupled from the
 * job-level payment view.
 *   - payments.view (office) → full company ledger, any/unfiltered transaction.
 *   - financial_data.view only (Provider) → may read payments ONLY for a job assigned to
 *     them (the job finance panel's GET /?job_id and GET /:id). No job scope → 403, and a
 *     job that isn't theirs → 403, so a provider can never enumerate the company ledger.
 */

jest.mock('../backend/src/db/connection', () => ({ query: jest.fn() }));
jest.mock('../backend/src/services/paymentsService', () => ({
    listTransactions: jest.fn(async () => ({ transactions: [], total: 0 })),
    getTransaction: jest.fn(),
    getTransactionDetail: jest.fn(async () => ({ id: 7 })),
}));
jest.mock('../backend/src/services/jobsService', () => ({
    // Assignment check: only 'mine' resolves under the provider's assigned_only scope.
    getJobById: jest.fn(async (jobId) => (String(jobId) === 'mine' ? { id: jobId } : null)),
}));
jest.mock('../backend/src/services/financialActivityService', () => ({ userActor: jest.fn(() => ({})) }));
jest.mock('../backend/src/services/auditService', () => ({ log: jest.fn(async () => {}) }));

const http = require('http');
const express = require('express');
const paymentsService = require('../backend/src/services/paymentsService');
const jobsService = require('../backend/src/services/jobsService');

const COMPANY_A = '00000000-0000-0000-0000-00000000000a';
const PROVIDER_USER = '11111111-1111-1111-1111-111111111111';

beforeEach(() => {
    paymentsService.listTransactions.mockClear();
    paymentsService.getTransaction.mockReset();
    paymentsService.getTransactionDetail.mockClear();
    jobsService.getJobById.mockClear();
});

function request(app, method, path) {
    return new Promise((resolve, reject) => {
        const server = app.listen(0, () => {
            const req = http.request({
                hostname: '127.0.0.1', port: server.address().port, path, method,
                headers: { 'Content-Type': 'application/json' },
            }, (res) => {
                let data = '';
                res.on('data', c => (data += c));
                res.on('end', () => { server.close(); resolve({ status: res.statusCode, body: data ? JSON.parse(data) : null }); });
            });
            req.on('error', e => { server.close(); reject(e); });
            req.end();
        });
    });
}

function appWithAuthz({ permissions }) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
        req.user = { sub: 'kc', email: 'p@x.com', crmUser: { id: PROVIDER_USER } };
        req.authz = { scope: 'tenant', permissions, scopes: { job_visibility: 'assigned_only' } };
        req.companyFilter = { company_id: COMPANY_A };
        next();
    });
    app.use('/', require('../backend/src/routes/payments'));
    return app;
}

const OFFICE = ['payments.view'];
const PROVIDER = ['financial_data.view']; // no payments.view

describe('ROLE-PROVIDER-NO-PAYMENTS-001 — ledger list (GET /)', () => {
    it('office (payments.view) lists the whole ledger, no job scope required', async () => {
        const res = await request(appWithAuthz({ permissions: OFFICE }), 'GET', '/');
        expect(res.status).toBe(200);
        expect(paymentsService.listTransactions).toHaveBeenCalledTimes(1);
        expect(jobsService.getJobById).not.toHaveBeenCalled();
    });

    it('provider WITHOUT a job filter is refused the company-wide ledger → 403', async () => {
        const res = await request(appWithAuthz({ permissions: PROVIDER }), 'GET', '/');
        expect(res.status).toBe(403);
        expect(res.body.error.code).toBe('PAYMENTS_JOB_SCOPE_REQUIRED');
        expect(paymentsService.listTransactions).not.toHaveBeenCalled();
    });

    it('provider may list payments for a job assigned to them → 200', async () => {
        const res = await request(appWithAuthz({ permissions: PROVIDER }), 'GET', '/?job_id=mine');
        expect(res.status).toBe(200);
        expect(jobsService.getJobById).toHaveBeenCalled();
        expect(paymentsService.listTransactions).toHaveBeenCalledTimes(1);
    });

    it("provider is refused a job that isn't theirs → 403", async () => {
        const res = await request(appWithAuthz({ permissions: PROVIDER }), 'GET', '/?job_id=someone-else');
        expect(res.status).toBe(403);
        expect(res.body.error.code).toBe('ACCESS_DENIED');
        expect(paymentsService.listTransactions).not.toHaveBeenCalled();
    });

    it('a caller with neither permission is blocked by the route guard → 403', async () => {
        const res = await request(appWithAuthz({ permissions: ['jobs.view'] }), 'GET', '/?job_id=mine');
        expect(res.status).toBe(403);
    });
});

describe('ROLE-PROVIDER-NO-PAYMENTS-001 — transaction detail (GET /:id)', () => {
    it('provider may open a transaction on their assigned job → 200', async () => {
        paymentsService.getTransaction.mockResolvedValueOnce({ id: 7, job_id: 'mine' });
        const res = await request(appWithAuthz({ permissions: PROVIDER }), 'GET', '/7');
        expect(res.status).toBe(200);
        expect(paymentsService.getTransactionDetail).toHaveBeenCalledTimes(1);
    });

    it("provider is refused a transaction on someone else's job → 403", async () => {
        paymentsService.getTransaction.mockResolvedValueOnce({ id: 7, job_id: 'someone-else' });
        const res = await request(appWithAuthz({ permissions: PROVIDER }), 'GET', '/7');
        expect(res.status).toBe(403);
        expect(paymentsService.getTransactionDetail).not.toHaveBeenCalled();
    });

    it('provider is refused a job-less (ledger-only) transaction → 403', async () => {
        paymentsService.getTransaction.mockResolvedValueOnce({ id: 7, job_id: null });
        const res = await request(appWithAuthz({ permissions: PROVIDER }), 'GET', '/7');
        expect(res.status).toBe(403);
    });

    it('office reads any transaction detail without a job check → 200', async () => {
        const res = await request(appWithAuthz({ permissions: OFFICE }), 'GET', '/7');
        expect(res.status).toBe(200);
        expect(paymentsService.getTransaction).not.toHaveBeenCalled(); // office skips the scope load
        expect(paymentsService.getTransactionDetail).toHaveBeenCalledTimes(1);
    });
});
