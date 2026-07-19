'use strict';

const COMPANY = '00000000-0000-0000-0000-00000000e101';
const CURSOR_TS = '2026-07-18T15:00:00.654321Z';

jest.mock('../backend/src/db/connection', () => ({ query: jest.fn() }));
jest.mock('../backend/src/services/zenbookerClient', () => ({}));
jest.mock('../backend/src/services/auditService', () => ({ log: jest.fn(async () => {}) }));

const express = require('express');
const request = require('supertest');
const db = require('../backend/src/db/connection');
const paymentsService = require('../backend/src/services/zenbookerPaymentsSyncService');
const paymentsRouter = require('../backend/src/routes/zenbooker/payments');

function paymentRow(id, overrides = {}) {
    return {
        id,
        transaction_id: `txn-${id}`,
        invoice_id: `invoice-${id}`,
        job_id: `job-${id}`,
        job_number: String(id),
        client: `Client ${id}`,
        job_type: 'Repair',
        status: 'complete',
        payment_methods: 'check',
        display_payment_method: 'check',
        amount_paid: '10.00',
        tags: '',
        payment_date: new Date('2026-07-18T15:00:00.654Z'),
        source: 'Website',
        tech: 'Alex, Sam',
        transaction_status: 'succeeded',
        missing_job_link: false,
        invoice_status: 'paid',
        invoice_total: '10.00',
        invoice_amount_paid: '10.00',
        invoice_amount_due: '0.00',
        invoice_paid_in_full: true,
        check_deposited: false,
        custom_fields: '',
        __cursor_null: false,
        __cursor_value: CURSOR_TS,
        __cursor_id: String(id),
        ...overrides,
    };
}

function useListDispatch({
    transactionCount = 0,
    totalAmount = '0',
    paymentMethods = [],
    providers = [],
    undepositedCheckCount = 0,
    rows = [],
} = {}) {
    db.query.mockImplementation(async (sql) => {
        if (/WITH base_rows AS/i.test(sql)) {
            return {
                rows: [{
                    transaction_count: transactionCount,
                    total_amount: totalAmount,
                    payment_methods: paymentMethods,
                    providers,
                    undeposited_check_count: undepositedCheckCount,
                }],
            };
        }
        if (/SELECT\s+p\.id, p\.transaction_id/i.test(sql)) return { rows };
        throw new Error(`Unexpected Payments list SQL: ${sql}`);
    });
}

function appFor(companyId = COMPANY, permissions = ['payments.view']) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
        req.user = { sub: 'payments-list-user', crmUser: { id: 'payments-list-user' } };
        req.authz = { scope: 'tenant', permissions };
        if (companyId) req.companyFilter = { company_id: companyId };
        next();
    });
    app.use('/', paymentsRouter);
    return app;
}

beforeEach(() => {
    jest.clearAllMocks();
    useListDispatch();
});

describe('Payments list route and validation', () => {
    test('R-matrix: payments.view denies a role without permission and allows a permitted role', async () => {
        const denied = await request(appFor(COMPANY, [])).get('/').query({
            date_from: '2026-07-01',
            date_to: '2026-07-31',
        });

        expect(denied.status).toBe(403);
        expect(denied.body.code).toBe('ACCESS_DENIED');
        expect(db.query).not.toHaveBeenCalled();

        const allowed = await request(appFor()).get('/').query({
            date_from: '2026-07-01',
            date_to: '2026-07-31',
        });

        expect(allowed.status).toBe(200);
        expect(allowed.body.data.pagination).toMatchObject({ total: 0, returned: 0 });
        expect(db.query).toHaveBeenCalledTimes(2);
    });

    test('requires company context before SQL', async () => {
        const response = await request(appFor(null)).get('/').query({
            date_from: '2026-07-01',
            date_to: '2026-07-31',
        });

        expect(response.status).toBe(403);
        expect(db.query).not.toHaveBeenCalled();
    });

    test('service independently requires company context before SQL', async () => {
        await expect(paymentsService.listPayments(null, {
            dateFrom: '2026-07-01',
            dateTo: '2026-07-31',
        })).rejects.toMatchObject({ code: 'TENANT_CONTEXT_REQUIRED', statusCode: 403 });
        expect(db.query).not.toHaveBeenCalled();
    });

    test('route forwards the new controls and returns typed input errors', async () => {
        useListDispatch({ transactionCount: 1, totalAmount: '12.50' });
        const response = await request(appFor()).get('/').query({
            date_from: '2026-07-01',
            date_to: '2026-07-31',
            provider: 'Alex',
            paid_status: 'due',
            sort_by: 'tech',
            sort_order: 'asc',
            limit: '50',
        });

        expect(response.status).toBe(200);
        expect(response.body.data.pagination).toMatchObject({ mode: 'cursor', limit: 50, total: 1 });
        const pageSql = db.query.mock.calls[1][0];
        expect(pageSql).toMatch(/BTRIM\(provider_name\.value\) = \$4/);
        expect(pageSql).toMatch(/p\.invoice_paid_in_full IS NOT TRUE/);
        expect(pageSql).toMatch(/ORDER BY LOWER\(COALESCE\(p\.tech, ''\)\) COLLATE "C" ASC, p\.id ASC/);

        jest.clearAllMocks();
        const badSort = await request(appFor()).get('/').query({
            date_from: '2026-07-01',
            date_to: '2026-07-31',
            sort_by: 'drop;table',
        });
        expect(badSort.status).toBe(400);
        expect(badSort.body.code).toBe('INVALID_QUERY');
        expect(db.query).not.toHaveBeenCalled();

        const mixed = await request(appFor()).get('/').query({
            date_from: '2026-07-01',
            date_to: '2026-07-31',
            cursor: 'opaque',
            offset: '0',
        });
        expect(mixed.status).toBe(400);
        expect(mixed.body.code).toBe('INVALID_CURSOR_REQUEST');
        expect(db.query).not.toHaveBeenCalled();
    });
});

describe('Payments complete predicates, aggregates, and facets', () => {
    test('all final predicates are shared by aggregate and rows while facets use the base predicate', async () => {
        useListDispatch({
            transactionCount: 72,
            totalAmount: '-12.3450',
            paymentMethods: ['cash', 'check'],
            providers: ['Alex', 'Sam'],
            undepositedCheckCount: 9,
            rows: [paymentRow(72)],
        });

        const result = await paymentsService.listPayments(COMPANY, {
            dateFrom: '2026-07-01',
            dateTo: '2026-07-31',
            paymentMethod: 'check',
            quickFilter: 'new_checks',
            search: 'repair',
            provider: 'Alex',
            paidStatus: 'due',
            limit: 50,
        });

        expect(result.total).toBe(72);
        expect(result.pagination.total).toBe(72);
        expect(result.aggregates).toEqual({ transaction_count: 72, total_amount: '-12.3450' });
        expect(result.facets).toEqual({
            payment_methods: ['cash', 'check'],
            providers: ['Alex', 'Sam'],
            undeposited_check_count: 9,
        });

        const [metadataSql, metadataParams] = db.query.mock.calls[0];
        const [pageSql, pageParams] = db.query.mock.calls[1];
        expect(metadataSql).toMatch(/WITH base_rows AS \([\s\S]*p\.company_id = \$1[\s\S]*aggregate AS \(/);
        expect(metadataSql.match(/BTRIM\(provider_name\.value\) = \$7/g)).toHaveLength(1);
        expect(metadataSql.match(/p\.invoice_paid_in_full IS NOT TRUE/g)).toHaveLength(1);
        expect(metadataSql).toMatch(/SUM\(COALESCE\(p\.amount_paid, 0\)\)/);
        expect(metadataSql).toMatch(/FROM base_rows[\s\S]*display_payment_method/);
        expect(pageSql).toMatch(/BTRIM\(provider_name\.value\) = \$7/);
        expect(pageSql).toMatch(/p\.invoice_paid_in_full IS NOT TRUE/);
        expect(metadataParams).toEqual([
            COMPANY,
            '2026-07-01',
            '2026-07-31',
            '%check%',
            '%check%',
            '%repair%',
            'Alex',
        ]);
        expect(pageParams.slice(0, 7)).toEqual(metadataParams);
    });

    test('provider matching is exact across trimmed comma-separated names', async () => {
        await paymentsService.listPayments(COMPANY, { provider: 'Alex', limit: 50 });

        for (const [sql, params] of db.query.mock.calls) {
            expect(sql).toMatch(/unnest\(string_to_array\(COALESCE\(p\.tech, ''\), ','\)\)/);
            expect(sql).toMatch(/BTRIM\(provider_name\.value\) = \$2/);
            expect(sql).not.toMatch(/p\.tech ILIKE/);
            expect(params.slice(0, 2)).toEqual([COMPANY, 'Alex']);
        }
    });

    test.each([
        'payment_date',
        'amount_paid',
        'invoice_amount_due',
        'job_number',
        'client',
        'payment_methods',
        'tech',
    ])('%s is a closed server sort and always ties by ID', async (sortField) => {
        await paymentsService.listPayments(COMPANY, { sortField, sortDir: 'asc', limit: 50 });

        const pageSql = db.query.mock.calls[1][0];
        expect(pageSql).toMatch(/ORDER BY[\s\S]*p\.id ASC/);
    });

    test('unknown sorts and invalid filter values fail before SQL', async () => {
        await expect(paymentsService.listPayments(COMPANY, { sortField: 'unknown' }))
            .rejects.toMatchObject({ code: 'INVALID_QUERY', statusCode: 400 });
        await expect(paymentsService.listPayments(COMPANY, { paidStatus: 'partial' }))
            .rejects.toMatchObject({ code: 'INVALID_QUERY', statusCode: 400 });
        await expect(paymentsService.listPayments(COMPANY, { quickFilter: 'surprise' }))
            .rejects.toMatchObject({ code: 'INVALID_QUERY', statusCode: 400 });
        expect(db.query).not.toHaveBeenCalled();
    });
});

describe('Payments cursor boundaries', () => {
    test('exactly 50 matching rows end without a false continuation', async () => {
        useListDispatch({
            transactionCount: 50,
            totalAmount: '500.00',
            rows: Array.from({ length: 50 }, (_unused, index) => paymentRow(100 - index)),
        });

        const page = await paymentsService.listPayments(COMPANY, { limit: 50 });

        expect(page.rows).toHaveLength(50);
        expect(page.pagination).toMatchObject({
            mode: 'cursor',
            returned: 50,
            total: 50,
            has_more: false,
            next_cursor: null,
        });
        expect(db.query.mock.calls[1][1].at(-1)).toBe(51);
    });

    test('51 rows produce a cursor and continuation runs no metadata query', async () => {
        useListDispatch({
            transactionCount: 51,
            totalAmount: '510.00',
            rows: Array.from({ length: 51 }, (_unused, index) => paymentRow(100 - index)),
        });
        const first = await paymentsService.listPayments(COMPANY, {
            dateFrom: '2026-07-01',
            dateTo: '2026-07-31',
            limit: 50,
        });

        expect(first.pagination).toMatchObject({ total: 51, has_more: true });
        expect(first.pagination.next_cursor).toEqual(expect.any(String));

        jest.clearAllMocks();
        useListDispatch({ rows: [paymentRow(50)] });
        const second = await paymentsService.listPayments(COMPANY, {
            dateFrom: '2026-07-01',
            dateTo: '2026-07-31',
            limit: 50,
            cursor: first.pagination.next_cursor,
        });

        expect(second.rows.map(row => row.id)).toEqual([50]);
        expect(second.total).toBeNull();
        expect(second.aggregates).toBeNull();
        expect(second.facets).toBeNull();
        expect(second.pagination).toMatchObject({ total: null, has_more: false, next_cursor: null });
        expect(db.query).toHaveBeenCalledTimes(1);
        const [pageSql, pageParams] = db.query.mock.calls[0];
        expect(pageSql).toMatch(/\(p\.payment_date IS NULL\) > \$4::boolean/);
        expect(pageSql).toMatch(/p\.payment_date IS NOT DISTINCT FROM \$5::timestamptz AND p\.id < \$6::bigint/);
        expect(pageParams.slice(0, 6)).toEqual([
            COMPANY,
            '2026-07-01',
            '2026-07-31',
            false,
            CURSOR_TS,
            '51',
        ]);
    });

    test('dynamic numeric sort preserves exact decimal cursor values', async () => {
        useListDispatch({
            transactionCount: 51,
            totalAmount: '1.000000000000000001',
            rows: Array.from({ length: 51 }, (_unused, index) => paymentRow(100 - index, {
                amount_paid: '0.000000000000000001',
                __cursor_value: '0.000000000000000001',
            })),
        });
        const first = await paymentsService.listPayments(COMPANY, {
            sortField: 'amount_paid',
            sortDir: 'desc',
            limit: 50,
        });

        jest.clearAllMocks();
        useListDispatch({ rows: [] });
        await paymentsService.listPayments(COMPANY, {
            sortField: 'amount_paid',
            sortDir: 'desc',
            limit: 50,
            cursor: first.pagination.next_cursor,
        });

        const [sql, params] = db.query.mock.calls[0];
        expect(sql).toMatch(/COALESCE\(p\.amount_paid, 0\) < \$2::numeric/);
        expect(params.slice(0, 3)).toEqual([COMPANY, '0.000000000000000001', '51']);
    });

    test('filter changes reject cursor reuse before SQL', async () => {
        useListDispatch({
            transactionCount: 51,
            totalAmount: '510.00',
            rows: Array.from({ length: 51 }, (_unused, index) => paymentRow(100 - index)),
        });
        const first = await paymentsService.listPayments(COMPANY, { provider: 'Alex', limit: 50 });

        jest.clearAllMocks();
        await expect(paymentsService.listPayments(COMPANY, {
            provider: 'Sam',
            limit: 50,
            cursor: first.pagination.next_cursor,
        })).rejects.toMatchObject({ code: 'INVALID_CURSOR' });
        expect(db.query).not.toHaveBeenCalled();
    });
});
