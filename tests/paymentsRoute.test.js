/**
 * Tests for Zenbooker Payments API (Local DB-backed)
 * Tests GET / (list), GET /:id (detail), and POST /sync endpoints.
 */

// ─── Mock paymentsService BEFORE requiring the route ──────────────────────────

const mockListPayments = jest.fn();
const mockGetPaymentDetail = jest.fn();
const mockSyncPayments = jest.fn();

jest.mock('../backend/src/services/paymentsService', () => ({
    listPayments: mockListPayments,
    getPaymentDetail: mockGetPaymentDetail,
    syncPayments: mockSyncPayments,
}));

const express = require('express');
const paymentsRouter = require('../backend/src/routes/zenbooker/payments');

// ─── Test helpers ─────────────────────────────────────────────────────────────

const TEST_COMPANY_ID = '00000000-0000-0000-0000-000000000001';

function createApp() {
    const app = express();
    app.use(express.json());
    // Simulate auth middleware
    app.use((req, _res, next) => {
        req.user = { company_id: TEST_COMPANY_ID };
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
        test('returns 404 when transaction not found', async () => {
            mockGetPaymentDetail.mockResolvedValue(null);

            const res = await request(app, 'GET', '/txn_missing');

            expect(res.status).toBe(404);
            expect(res.body.ok).toBe(false);
            expect(mockGetPaymentDetail).toHaveBeenCalledWith(TEST_COMPANY_ID, 'txn_missing');
        });

        test('returns enriched detail with attachments', async () => {
            const detail = makeDetail();
            mockGetPaymentDetail.mockResolvedValue(detail);

            const res = await request(app, 'GET', '/txn_001');

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
            expect(d.attachments).toHaveLength(2);

            // Metadata
            expect(d.metadata.transaction_id).toBe('txn_001');

            // Company scoping
            expect(mockGetPaymentDetail).toHaveBeenCalledWith(TEST_COMPANY_ID, 'txn_001');
        });
    });

    // ── POST /sync ────────────────────────────────────────────────────────────

    describe('POST /sync', () => {
        test('returns 400 when dates missing', async () => {
            const res = await request(app, 'POST', '/sync', { date_from: '2026-02-01' });
            expect(res.status).toBe(400);
            expect(res.body.ok).toBe(false);
        });

        test('syncs payments and returns count', async () => {
            mockSyncPayments.mockResolvedValue({ synced: 42, total_transactions: 42 });

            const res = await request(app, 'POST', '/sync', {
                date_from: '2026-02-01',
                date_to: '2026-02-28',
            });

            expect(res.status).toBe(200);
            expect(res.body.ok).toBe(true);
            expect(res.body.data.synced).toBe(42);

            expect(mockSyncPayments).toHaveBeenCalledWith(
                TEST_COMPANY_ID,
                '2026-02-01',
                '2026-02-28'
            );
        });

        test('returns error on sync failure', async () => {
            mockSyncPayments.mockRejectedValue(new Error('ZB API down'));

            const res = await request(app, 'POST', '/sync', {
                date_from: '2026-02-01',
                date_to: '2026-02-28',
            });

            expect(res.status).toBe(500);
            expect(res.body.ok).toBe(false);
            expect(res.body.error).toContain('ZB API down');
        });
    });
});
