/**
 * Tests for Zenbooker Payments API (Local DB-backed)
 * Tests the retained local GET/detail/export/deposited endpoints.
 */

// ─── Mock paymentsService BEFORE requiring the route ──────────────────────────

const mockListPayments = jest.fn();
const mockGetPaymentDetail = jest.fn();
const mockListPaymentsForExport = jest.fn();
const mockUpdateCheckDeposited = jest.fn();

// Mock the local imported-payments data layer used by the route.
jest.mock('../backend/src/services/paymentLedgerService', () => ({
    listPayments: mockListPayments,
    getPaymentDetail: mockGetPaymentDetail,
    listPaymentsForExport: mockListPaymentsForExport,
    updateCheckDeposited: mockUpdateCheckDeposited,
}));

const express = require('express');
const paymentsRouter = require('../backend/src/routes/zenbooker/payments');

// ─── Test helpers ─────────────────────────────────────────────────────────────

const TEST_COMPANY_ID = '00000000-0000-0000-0000-000000000001';

function createApp(permissions = [
    'payments.view',
    'payments.collect_offline',
    'tenant.integrations.manage',
]) {
    const app = express();
    app.use(express.json());
    // Simulate auth middleware
    app.use((req, _res, next) => {
        req.user = { company_id: TEST_COMPANY_ID, crmUser: { id: 'crm-user-1' } };
        req.authz = {
            scope: 'tenant',
            permissions,
        };
        req.companyFilter = { company_id: TEST_COMPANY_ID };
        next();
    });
    app.use('/', paymentsRouter);
    return app;
}

function makeRow(overrides = {}) {
    return {
        transaction_id: 'txn_001',
        invoice_id: 'inv_001',
        job_id: 'job_001',
        job_number: '525835',
        client: 'Fran Tufts',
        job_type: 'Refrigerator repair',
        status: 'complete',
        payment_methods: 'stripe (visa)',
        display_payment_method: 'visa',
        amount_paid: '95.00',
        tags: 'vip',
        payment_date: '2026-02-13T12:34:56Z',
        source: '',
        tech: 'Jon Foster',
        transaction_status: 'succeeded',
        missing_job_link: false,
        invoice_status: 'paid',
        invoice_total: '238.65',
        invoice_amount_paid: '238.65',
        invoice_amount_due: '0.00',
        invoice_paid_in_full: true,
        ...overrides,
    };
}

function makeDetail(overrides = {}) {
    return {
        ...makeRow(),
        invoice: {
            status: 'paid',
            total: '238.65',
            amount_paid: '238.65',
            amount_due: '0.00',
            paid_in_full: true,
        },
        job: {
            job_number: '525835',
            service_name: 'Refrigerator repair',
            service_address: '123 Main St, Boston MA',
            providers: [{ id: 'p1', name: 'Jon Foster', email: 'jon@test.com', phone: '555-1234' }],
        },
        attachments: [
            { url: 'https://example.com/check.jpg', kind: 'image', source: 'job_note', note_id: 'note_1', filename: 'check.jpg' },
            { url: 'https://example.com/contract.pdf', kind: 'file', source: 'job_note', note_id: 'note_1', filename: 'contract.pdf' },
        ],
        metadata: {
            transaction_id: 'txn_001',
            invoice_id: 'inv_001',
            customer_id: 'cust_001',
            territory_id: 'terr_01',
            initiated_by: 'admin_01',
            team_member_id: 'tm_01',
            memo: 'Deposit for repair',
        },
        _warning: null,
        ...overrides,
    };
}

// ─── Supertest-like helper (no extra dep) ─────────────────────────────────────

const http = require('http');

function request(app, method, path, body = null) {
    return new Promise((resolve, reject) => {
        const server = app.listen(0, () => {
            const port = server.address().port;
            const options = {
                hostname: '127.0.0.1',
                port,
                path,
                method: method.toUpperCase(),
                headers: { 'Content-Type': 'application/json' },
            };
            const req = http.request(options, (res) => {
                let data = '';
                res.on('data', chunk => { data += chunk; });
                res.on('end', () => {
                    server.close();
                    try {
                        resolve({ status: res.statusCode, body: JSON.parse(data) });
                    } catch (e) {
                        resolve({ status: res.statusCode, body: data });
                    }
                });
            });
            req.on('error', err => { server.close(); reject(err); });
            if (body) req.write(JSON.stringify(body));
            req.end();
        });
    });
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('Payments Route (DB-backed)', () => {
    let app;

    beforeEach(() => {
        app = createApp();
        jest.clearAllMocks();
    });

    // ── GET / (list) ──────────────────────────────────────────────────────────

    describe('GET / (list)', () => {
        test('returns 400 when date_from or date_to is missing', async () => {
            const res = await request(app, 'GET', '/?date_from=2026-02-01');
            expect(res.status).toBe(400);
            expect(res.body.ok).toBe(false);
        });

        test('returns rows from paymentsService', async () => {
            const row = makeRow();
            mockListPayments.mockResolvedValue({ rows: [row], total: 1 });

            const res = await request(app, 'GET', '/?date_from=2026-02-01&date_to=2026-02-28');

            expect(res.status).toBe(200);
            expect(res.body.ok).toBe(true);
            expect(res.body.data.rows).toHaveLength(1);
            expect(res.body.data.total).toBe(1);

            const r = res.body.data.rows[0];
            expect(r.transaction_id).toBe('txn_001');
            expect(r.client).toBe('Fran Tufts');
            expect(r.amount_paid).toBe('95.00');

            // Verify company_id was passed
            expect(mockListPayments).toHaveBeenCalledWith(
                TEST_COMPANY_ID,
                expect.objectContaining({
                    dateFrom: '2026-02-01',
                    dateTo: '2026-02-28',
                })
            );
        });

        test('passes search and payment_method filters', async () => {
            mockListPayments.mockResolvedValue({ rows: [], total: 0 });

            await request(app, 'GET', '/?date_from=2026-02-01&date_to=2026-02-28&search=alice&payment_method=stripe');

            expect(mockListPayments).toHaveBeenCalledWith(
                TEST_COMPANY_ID,
                expect.objectContaining({
                    search: 'alice',
                    paymentMethod: 'stripe',
                })
            );
        });
    });

    // ── GET /:id (detail) ─────────────────────────────────────────────────────

    describe('GET /:id (detail)', () => {
        test('requires payments.view before reading detail', async () => {
            const res = await request(createApp(['tenant.integrations.manage']), 'GET', '/10778');

            expect(res.status).toBe(403);
            expect(mockGetPaymentDetail).not.toHaveBeenCalled();
        });

        test('returns 404 when transaction not found', async () => {
            mockGetPaymentDetail.mockResolvedValue(null);

            // Detail is keyed by the internal numeric Blanc payment id.
            const res = await request(app, 'GET', '/999');

            expect(res.status).toBe(404);
            expect(res.body.ok).toBe(false);
            expect(mockGetPaymentDetail).toHaveBeenCalledWith(TEST_COMPANY_ID, 999);
        });

        test('returns enriched detail without archived attachments', async () => {
            const detail = makeDetail({ attachments: [] });
            mockGetPaymentDetail.mockResolvedValue(detail);

            const res = await request(app, 'GET', '/10778');

            expect(res.status).toBe(200);
            expect(res.body.ok).toBe(true);

            const d = res.body.data;
            expect(d.transaction_id).toBe('txn_001');
            expect(d.client).toBe('Fran Tufts');

            // Invoice summary
            expect(d.invoice).toBeTruthy();
            expect(d.invoice.paid_in_full).toBe(true);
            expect(d.invoice.total).toBe('238.65');

            // Job info
            expect(d.job).toBeTruthy();
            expect(d.job.job_number).toBe('525835');
            expect(d.job.providers).toHaveLength(1);

            // Attachments
            expect(d.attachments).toEqual([]);

            // Metadata
            expect(d.metadata.transaction_id).toBe('txn_001');

            // Company scoping
            expect(mockGetPaymentDetail).toHaveBeenCalledWith(TEST_COMPANY_ID, 10778);
        });
    });

    describe('GET /export', () => {
        test('requires payments.view and exports the company-scoped canonical result', async () => {
            const denied = await request(
                createApp(['tenant.integrations.manage']),
                'GET',
                '/export?date_from=2026-02-01&date_to=2026-02-28'
            );
            expect(denied.status).toBe(403);
            expect(mockListPaymentsForExport).not.toHaveBeenCalled();

            mockListPaymentsForExport.mockResolvedValue([
                { external_source: 'stripe', amount_paid: '95.00' },
                { external_source: 'manual', amount_paid: '25.00' },
            ]);
            const allowed = await request(
                createApp(),
                'GET',
                '/export?date_from=2026-02-01&date_to=2026-02-28'
            );

            expect(allowed.status).toBe(200);
            expect(allowed.body.data.map(row => row.external_source)).toEqual(['stripe', 'manual']);
            expect(mockListPaymentsForExport).toHaveBeenCalledWith(TEST_COMPANY_ID, {
                dateFrom: '2026-02-01',
                dateTo: '2026-02-28',
                paymentMethod: undefined,
                search: undefined,
            });
        });
    });

    describe('PATCH /:id deposited state', () => {
        test('requires payments.collect_offline and preserves foreign 404 behavior', async () => {
            const denied = await request(
                createApp(['payments.view']),
                'PATCH',
                '/81',
                { check_deposited: true }
            );
            expect(denied.status).toBe(403);
            expect(mockUpdateCheckDeposited).not.toHaveBeenCalled();

            mockUpdateCheckDeposited.mockResolvedValue(null);
            const foreign = await request(
                createApp(),
                'PATCH',
                '/81',
                { check_deposited: true }
            );
            expect(foreign.status).toBe(404);
            expect(mockUpdateCheckDeposited).toHaveBeenCalledWith(
                TEST_COMPANY_ID,
                81,
                true,
                expect.objectContaining({ query: expect.any(Function) }),
                expect.objectContaining({ id: 'crm-user-1', type: 'user' })
            );
        });
    });

    test('POST /sync is not routable', async () => {
        const res = await request(app, 'POST', '/sync', {});
        expect(res.status).toBe(404);
    });
});

// =============================================================================
// PF007-HARDENING-001 / TASK-RBAC-017 — canonical /api/payments router:
// tenant context comes only from req.companyFilter and every action is
// permission-gated.
// =============================================================================

const mockCanonical = {
    listTransactions: jest.fn(),
    createTransaction: jest.fn(),
    getSummary: jest.fn(),
    recordManualPayment: jest.fn(),
    getTransactionDetail: jest.fn(),
    refundTransaction: jest.fn(),
    voidPayment: jest.fn(),
    voidTransaction: jest.fn(),
    getReceipt: jest.fn(),
    sendReceipt: jest.fn(),
};
jest.mock('../backend/src/services/paymentsService', () => mockCanonical);
jest.mock('../backend/src/services/auditService', () => ({ log: jest.fn(async () => {}) }));
jest.mock('../backend/src/services/transactionService', () => ({
    withTransaction: jest.fn(work => work({ query: jest.fn() })),
}));

describe('PF007: canonical payments router', () => {
    const COMPANY = '00000000-0000-0000-0000-00000000000a';

    function canonicalApp({ permissions = [] } = {}) {
        const app = express();
        app.use(express.json());
        app.use((req, _res, next) => {
            req.user = { sub: 'kc', email: 'u@x.com', crmUser: { id: 'u-1' } };
            req.authz = { scope: 'tenant', permissions, scopes: {} };
            req.companyFilter = { company_id: COMPANY };
            // Poison the legacy field: routes must never read it (PF007)
            req.companyId = 'LEGACY-DO-NOT-USE';
            next();
        });
        app.use('/', require('../backend/src/routes/payments'));
        return app;
    }

    beforeEach(() => {
        Object.values(mockCanonical).forEach(fn => fn.mockReset());
    });

    it('GET / denies without payments.view', async () => {
        const res = await request(canonicalApp({ permissions: [] }), 'GET', '/');
        expect(res.status).toBe(403);
        expect(mockCanonical.listTransactions).not.toHaveBeenCalled();
    });

    it('GET / uses req.companyFilter company, never req.companyId', async () => {
        mockCanonical.listTransactions.mockResolvedValue({ transactions: [], total: 0 });
        const res = await request(canonicalApp({ permissions: ['payments.view'] }), 'GET', '/');
        expect(res.status).toBe(200);
        expect(mockCanonical.listTransactions.mock.calls[0][0]).toBe(COMPANY);
    });

    it('summary totals are not readable without payments.view', async () => {
        const res = await request(canonicalApp({ permissions: ['invoices.view'] }), 'GET', '/summary');
        expect(res.status).toBe(403);
        expect(mockCanonical.getSummary).not.toHaveBeenCalled();
    });

    it('the generic ledger collection endpoint does not exist', async () => {
        const res = await request(canonicalApp({ permissions: ['payments.collect_online'] }), 'POST', '/', { amount: 10 });
        expect(res.status).toBe(404);
        expect(mockCanonical.createTransaction).not.toHaveBeenCalled();
    });

    it('the generic manual collection endpoint does not exist', async () => {
        const res = await request(canonicalApp({ permissions: ['payments.collect_offline'] }), 'POST', '/manual', { amount: 10 });
        expect(res.status).toBe(404);
        expect(mockCanonical.recordManualPayment).not.toHaveBeenCalled();
    });

    it('refund requires payments.refund', async () => {
        const res = await request(canonicalApp({ permissions: ['payments.view', 'payments.collect_online'] }), 'POST', '/tx-1/refund', { amount: 5 });
        expect(res.status).toBe(403);
        expect(mockCanonical.refundTransaction).not.toHaveBeenCalled();
    });

    it('manual void requires payments.collect_offline, not payments.refund', async () => {
        const denied = await request(
            canonicalApp({ permissions: ['payments.refund'] }),
            'POST',
            '/tx-1/void',
            { reason: 'Bounced check' }
        );
        expect(denied.status).toBe(403);
        expect(mockCanonical.voidPayment).not.toHaveBeenCalled();

        mockCanonical.voidPayment.mockResolvedValue({
            payment: {
                id: 'tx-1',
                status: 'voided',
                void_reason: 'Bounced check',
            },
            invoice: null,
            idempotent: false,
        });
        const allowed = await request(
            canonicalApp({ permissions: ['payments.collect_offline'] }),
            'POST',
            '/tx-1/void',
            { reason: '  Bounced check  ' }
        );

        expect(allowed.status).toBe(200);
        expect(allowed.body).toEqual({
            ok: true,
            data: {
                payment: {
                    id: 'tx-1',
                    status: 'voided',
                    void_reason: 'Bounced check',
                },
                invoice: null,
                idempotent: false,
            },
        });
        expect(mockCanonical.voidPayment).toHaveBeenCalledWith(
            COMPANY,
            'u-1',
            'tx-1',
            expect.objectContaining({
                reason: '  Bounced check  ',
                allowMissingReason: true,
            }),
            expect.objectContaining({ query: expect.any(Function) }),
            {
                id: 'u-1',
                type: 'user',
                label: null,
                source: 'crm',
            }
        );
        expect(mockCanonical.voidPayment.mock.calls[0]).not.toContain('kc');
        expect(mockCanonical.voidPayment.mock.calls[0]).not.toContain(
            'LEGACY-DO-NOT-USE'
        );
    });

    it('allows canonical manual void without a reason', async () => {
        mockCanonical.voidPayment.mockResolvedValue({
            payment: {
                id: 'tx-2',
                status: 'voided',
                void_reason: null,
            },
            invoice: null,
            idempotent: false,
        });

        const response = await request(
            canonicalApp({ permissions: ['payments.collect_offline'] }),
            'POST',
            '/tx-2/void'
        );

        expect(response.status).toBe(200);
        expect(response.body.data.payment.void_reason).toBeNull();
        expect(mockCanonical.voidPayment).toHaveBeenCalledWith(
            COMPANY,
            'u-1',
            'tx-2',
            { reason: undefined, allowMissingReason: true },
            expect.objectContaining({ query: expect.any(Function) }),
            expect.objectContaining({ id: 'u-1', type: 'user' })
        );
    });
});
