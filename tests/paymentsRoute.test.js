/**
 * Tests for Zenbooker Payments Export API
 * Tests GET / (list) and GET /:id (detail) endpoints.
 */

// ─── Mock zenbookerClient BEFORE requiring the route ──────────────────────────

const mockGetTransactions = jest.fn();
const mockGetInvoice = jest.fn();
const mockGetJob = jest.fn();

jest.mock('../backend/src/services/zenbookerClient', () => ({
    getTransactions: mockGetTransactions,
    getInvoice: mockGetInvoice,
    getJob: mockGetJob,
}));

const express = require('express');
const paymentsRouter = require('../backend/src/routes/zenbooker/payments');

// ─── Test helpers ─────────────────────────────────────────────────────────────

function createApp() {
    const app = express();
    app.use(express.json());
    app.use('/', paymentsRouter);
    return app;
}

function makeTxn(overrides = {}) {
    return {
        id: 'txn_001',
        invoice_id: 'inv_001',
        customer_id: 'cust_001',
        payment_date: '2026-02-13T12:34:56Z',
        amount: '95.00',
        amount_collected: '95.00',
        payment_method: 'stripe',
        stripe_card_brand: 'visa',
        custom_payment_method_name: null,
        status: 'succeeded',
        memo: 'Deposit for repair',
        territory_id: 'terr_01',
        initiated_by: 'admin_01',
        team_member_id: 'tm_01',
        ...overrides,
    };
}

function makeInvoice(overrides = {}) {
    return {
        id: 'inv_001',
        job_id: 'job_001',
        status: 'paid',
        total: '238.65',
        amount_paid: '238.65',
        amount_due: '0.00',
        primary_recipient: { name: 'Fallback Customer' },
        ...overrides,
    };
}

function makeJob(overrides = {}) {
    return {
        id: 'job_001',
        job_number: '525835',
        service_name: 'Refrigerator repair',
        status: 'complete',
        canceled: false,
        customer: { name: 'Fran Tufts' },
        assigned_providers: [{ id: 'p1', name: 'Jon Foster', email: 'jon@test.com', phone: '555-1234' }],
        service_address: { formatted: '123 Main St, Boston MA' },
        service_fields: [],
        tags: ['vip'],
        notes: [
            {
                id: 'note_1',
                text: 'Check attached',
                images: ['https://example.com/check.jpg'],
                files: ['https://example.com/contract.pdf'],
                created: '2026-02-12T10:00:00Z',
            },
        ],
        ...overrides,
    };
}

// ─── Supertest-like helper (no extra dep) ─────────────────────────────────────

const http = require('http');

function request(app, method, path) {
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
                let body = '';
                res.on('data', chunk => { body += chunk; });
                res.on('end', () => {
                    server.close();
                    try {
                        resolve({ status: res.statusCode, body: JSON.parse(body) });
                    } catch (e) {
                        resolve({ status: res.statusCode, body });
                    }
                });
            });
            req.on('error', err => { server.close(); reject(err); });
            req.end();
        });
    });
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('Payments Route', () => {
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

        test('returns assembled rows from transaction/invoice/job pipeline', async () => {
            const txn = makeTxn();
            const inv = makeInvoice();
            const job = makeJob();

            mockGetTransactions.mockResolvedValue([txn]);
            mockGetInvoice.mockResolvedValue(inv);
            mockGetJob.mockResolvedValue(job);

            const res = await request(app, 'GET', '/?date_from=2026-02-01&date_to=2026-02-28');

            expect(res.status).toBe(200);
            expect(res.body.ok).toBe(true);
            expect(res.body.data.rows).toHaveLength(1);

            const row = res.body.data.rows[0];
            expect(row.transaction_id).toBe('txn_001');
            expect(row.client).toBe('Fran Tufts');
            expect(row.job_number).toBe('525835');
            expect(row.amount_paid).toBe('95.00');
            expect(row.payment_methods).toBe('stripe (visa)');
            expect(row.tech).toBe('Jon Foster');
            expect(row.invoice_paid_in_full).toBe(true);
            expect(row.invoice_status).toBe('paid');
        });

        test('falls back to invoice recipient when job is missing', async () => {
            const txn = makeTxn();
            const inv = makeInvoice({ job_id: null });

            mockGetTransactions.mockResolvedValue([txn]);
            mockGetInvoice.mockResolvedValue(inv);

            const res = await request(app, 'GET', '/?date_from=2026-02-01&date_to=2026-02-28');

            const row = res.body.data.rows[0];
            expect(row.client).toBe('Fallback Customer');
            expect(row.job_number).toBe('—');
            expect(row.missing_job_link).toBe(true);
        });

        test('search param filters rows by client name', async () => {
            const txn1 = makeTxn({ id: 'txn_001' });
            const txn2 = makeTxn({ id: 'txn_002', invoice_id: 'inv_002' });

            const inv1 = makeInvoice();
            const inv2 = makeInvoice({ id: 'inv_002', job_id: 'job_002' });

            const job1 = makeJob();
            const job2 = makeJob({ id: 'job_002', customer: { name: 'Alice Smith' }, job_number: '999' });

            mockGetTransactions.mockResolvedValue([txn1, txn2]);
            mockGetInvoice.mockImplementation(id => {
                if (id === 'inv_001') return Promise.resolve(inv1);
                if (id === 'inv_002') return Promise.resolve(inv2);
                return Promise.reject(new Error('not found'));
            });
            mockGetJob.mockImplementation(id => {
                if (id === 'job_001') return Promise.resolve(job1);
                if (id === 'job_002') return Promise.resolve(job2);
                return Promise.reject(new Error('not found'));
            });

            const res = await request(app, 'GET', '/?date_from=2026-02-01&date_to=2026-02-28&search=alice');

            expect(res.body.data.rows).toHaveLength(1);
            expect(res.body.data.rows[0].client).toBe('Alice Smith');
        });
    });

    // ── GET /:id (detail) ─────────────────────────────────────────────────────

    describe('GET /:id (detail)', () => {
        test('returns 404 when transaction not found', async () => {
            mockGetTransactions.mockResolvedValue([]);

            const res = await request(app, 'GET', '/txn_missing?date_from=2026-02-01&date_to=2026-02-28');

            expect(res.status).toBe(404);
            expect(res.body.ok).toBe(false);
        });

        test('returns enriched detail with attachments', async () => {
            const txn = makeTxn();
            const inv = makeInvoice();
            const job = makeJob();

            mockGetTransactions.mockResolvedValue([txn]);
            mockGetInvoice.mockResolvedValue(inv);
            mockGetJob.mockResolvedValue(job);

            const res = await request(app, 'GET', '/txn_001?date_from=2026-02-01&date_to=2026-02-28');

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
            expect(d.job.service_name).toBe('Refrigerator repair');
            expect(d.job.service_address).toBe('123 Main St, Boston MA');
            expect(d.job.providers).toHaveLength(1);
            expect(d.job.providers[0].name).toBe('Jon Foster');

            // Attachments
            expect(d.attachments).toHaveLength(2);
            expect(d.attachments[0].kind).toBe('image');
            expect(d.attachments[0].url).toContain('check.jpg');
            expect(d.attachments[1].kind).toBe('file');
            expect(d.attachments[1].url).toContain('contract.pdf');

            // Metadata
            expect(d.metadata.transaction_id).toBe('txn_001');
            expect(d.metadata.memo).toBe('Deposit for repair');
        });

        test('returns warning when job fetch fails', async () => {
            const txn = makeTxn();
            const inv = makeInvoice();

            mockGetTransactions.mockResolvedValue([txn]);
            mockGetInvoice.mockResolvedValue(inv);
            mockGetJob.mockRejectedValue(new Error('Job API timeout'));

            const res = await request(app, 'GET', '/txn_001?date_from=2026-02-01&date_to=2026-02-28');

            expect(res.status).toBe(200);
            const d = res.body.data;
            expect(d._warning).toBeTruthy();
            expect(d.job).toBeNull();
            expect(d.attachments).toHaveLength(0);
        });
    });
});
