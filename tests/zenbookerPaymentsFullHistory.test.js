/**
 * ZBPAY-MIGRATE-001 P1 — default-company payment gate and bounded full-history
 * continuation. No test in this file contacts Zenbooker or a real database.
 */

const DEFAULT_CO = '00000000-0000-0000-0000-000000000001';
const FOREIGN_CO = '11111111-1111-1111-1111-111111111111';

jest.mock('../backend/src/db/connection', () => ({
    query: jest.fn(),
    getClient: jest.fn(),
}));
jest.mock('../backend/src/services/zenbookerClient', () => ({
    ZENBOOKER_DEFAULT_COMPANY_ID: '00000000-0000-0000-0000-000000000001',
    getPaymentReaderForCompany: jest.fn(),
}));

const db = require('../backend/src/db/connection');
const zenbookerClient = require('../backend/src/services/zenbookerClient');
const syncService = require('../backend/src/services/zenbookerPaymentsSyncService');
const paymentsRouter = require('../backend/src/routes/zenbooker/payments');

function syncRouteHandler() {
    const layer = paymentsRouter.stack.find(candidate =>
        candidate.route?.path === '/sync' && candidate.route.methods.post
    );
    return layer.route.stack[layer.route.stack.length - 1].handle;
}

async function invokeSyncRoute(companyId, body) {
    const response = { status: 200, body: null };
    const req = {
        body,
        companyFilter: { company_id: companyId },
        setTimeout: jest.fn(),
    };
    const res = {
        setTimeout: jest.fn(),
        status(code) {
            response.status = code;
            return this;
        },
        json(payload) {
            response.body = payload;
            return this;
        },
    };
    await syncRouteHandler()(req, res);
    return response;
}

function fakeTxnClient() {
    return {
        query: jest.fn(sql => String(sql).includes('FILTER')
            ? Promise.resolve({ rows: [{ still_missing_body: '0', still_no_job_id: '0' }], rowCount: 0 })
            : Promise.resolve({ rows: [], rowCount: 0 })),
        release: jest.fn(),
    };
}

function transaction(id, date = '2026-01-02T12:00:00.000Z') {
    return { id, status: 'succeeded', amount_collected: '10.00', payment_date: date };
}

describe('payment sync route modes and tenant gate', () => {
    let syncSpy;

    beforeEach(() => {
        jest.clearAllMocks();
        syncSpy = jest.spyOn(syncService, 'syncPayments').mockResolvedValue({
            mode: 'full_history', imported: 0, skipped_existing: 0, remaining: false, cursor: null,
        });
    });

    afterEach(() => syncSpy.mockRestore());

    it('CTRL-ZBPAY-TENANT-GATE: foreign company returns 403 before service/network/write', async () => {
        const res = await invokeSyncRoute(FOREIGN_CO, {});
        expect(res.status).toBe(403);
        expect(syncSpy).not.toHaveBeenCalled();
        expect(zenbookerClient.getPaymentReaderForCompany).not.toHaveBeenCalled();
        expect(db.query).not.toHaveBeenCalled();
    });

    it('empty body and explicit cursor select full-history mode', async () => {
        const first = await invokeSyncRoute(DEFAULT_CO, {});
        expect(first.status).toBe(200);
        expect(syncSpy).toHaveBeenLastCalledWith(DEFAULT_CO, null, null, {
            fullHistory: true,
            cursor: null,
        });

        await invokeSyncRoute(DEFAULT_CO, { full_history: true, cursor: 'next-25' });
        expect(syncSpy).toHaveBeenLastCalledWith(DEFAULT_CO, null, null, {
            fullHistory: true,
            cursor: 'next-25',
        });
    });

    it('preserves range mode and rejects ambiguous/one-sided ranges before service', async () => {
        await invokeSyncRoute(DEFAULT_CO, { date_from: '2026-01-01', date_to: '2026-01-31' });
        expect(syncSpy).toHaveBeenLastCalledWith(DEFAULT_CO, '2026-01-01', '2026-01-31', {
            fullHistory: false,
            cursor: null,
        });

        syncSpy.mockClear();
        expect((await invokeSyncRoute(DEFAULT_CO, { date_from: '2026-01-01' })).status).toBe(400);
        expect((await invokeSyncRoute(DEFAULT_CO, {
            full_history: true,
            date_from: '2026-01-01',
            date_to: '2026-01-31',
        })).status).toBe(400);
        expect(syncSpy).not.toHaveBeenCalled();
    });
});

describe('bounded full-history service', () => {
    const reader = {
        getTransactions: jest.fn(),
        getTransactionsPage: jest.fn(),
        getInvoice: jest.fn(),
        getJob: jest.fn(),
    };

    beforeEach(() => {
        jest.clearAllMocks();
        zenbookerClient.getPaymentReaderForCompany.mockResolvedValue(reader);
        db.getClient.mockResolvedValue(fakeTxnClient());
        db.query.mockImplementation(sql => {
            if (String(sql).includes('SELECT transaction_id')) return Promise.resolve({ rows: [] });
            return Promise.resolve({ rows: [], rowCount: 1 });
        });
        reader.getInvoice.mockResolvedValue(null);
        reader.getJob.mockResolvedValue(null);
    });

    it('defense-in-depth rejects a foreign company before reader/network/write', async () => {
        await expect(syncService.syncPayments(FOREIGN_CO, null, null, { fullHistory: true }))
            .rejects.toMatchObject({ httpStatus: 403, code: 'ZENBOOKER_SYNC_FORBIDDEN' });
        expect(zenbookerClient.getPaymentReaderForCompany).not.toHaveBeenCalled();
        expect(db.query).not.toHaveBeenCalled();
    });

    it('rejects an invalid continuation cursor before reader/network/write', async () => {
        await expect(syncService.syncPayments(DEFAULT_CO, null, null, {
            fullHistory: true,
            cursor: { offset: 25 },
        })).rejects.toMatchObject({ httpStatus: 400, code: 'VALIDATION' });
        expect(zenbookerClient.getPaymentReaderForCompany).not.toHaveBeenCalled();
        expect(db.query).not.toHaveBeenCalled();
    });

    it('returns an honest cursor at the budget boundary and resumes from it', async () => {
        reader.getTransactionsPage
            .mockResolvedValueOnce({ results: [transaction('tx-1')], has_more: true, next_cursor: 'cursor-25' })
            .mockResolvedValueOnce({ results: [transaction('tx-2', '2026-02-03T12:00:00.000Z')], has_more: false, next_cursor: null });

        const now = jest.fn().mockReturnValueOnce(0).mockReturnValueOnce(100);
        const partial = await syncService.syncPayments(DEFAULT_CO, null, null, {
            fullHistory: true,
            timeBudgetMs: 50,
            now,
        });

        expect(partial).toMatchObject({
            mode: 'full_history', imported: 1, skipped_existing: 0,
            remaining: true, cursor: 'cursor-25',
            last_range: { from: '2026-01-02T12:00:00.000Z', to: '2026-01-02T12:00:00.000Z' },
        });
        expect(reader.getTransactionsPage).toHaveBeenNthCalledWith(1, expect.objectContaining({ cursor: 0 }));

        const complete = await syncService.syncPayments(DEFAULT_CO, null, null, {
            fullHistory: true,
            cursor: partial.cursor,
            timeBudgetMs: 50,
            now: () => 0,
        });
        expect(reader.getTransactionsPage).toHaveBeenNthCalledWith(2, expect.objectContaining({ cursor: 'cursor-25' }));
        expect(complete).toMatchObject({ remaining: false, cursor: null, imported: 1 });
    });

    it('CTRL-ZBPAY-RERUN-DEDUPE: a repeated full-history run imports once then skips the same source id', async () => {
        reader.getTransactionsPage.mockResolvedValue({
            results: [transaction('tx-existing')], has_more: false, next_cursor: null,
        });
        const landingIds = new Set();
        db.query.mockImplementation((sql, params) => {
            if (String(sql).includes('SELECT transaction_id')) {
                return Promise.resolve({
                    rows: [...landingIds].map(transaction_id => ({ transaction_id })),
                });
            }
            if (String(sql).includes('INSERT INTO zb_payments')) landingIds.add(params[1]);
            return Promise.resolve({ rows: [], rowCount: 1 });
        });

        const first = await syncService.syncPayments(DEFAULT_CO, null, null, {
            fullHistory: true,
            now: () => 0,
        });
        const second = await syncService.syncPayments(DEFAULT_CO, null, null, {
            fullHistory: true,
            now: () => 0,
        });

        expect(first).toMatchObject({ imported: 1, skipped_existing: 0, remaining: false });
        expect(second).toMatchObject({ imported: 0, skipped_existing: 1, remaining: false });
        expect(landingIds).toEqual(new Set(['tx-existing']));
        const upsert = db.query.mock.calls.find(([sql]) => String(sql).includes('INSERT INTO zb_payments'));
        expect(upsert[0]).toContain('ON CONFLICT (company_id, transaction_id) DO UPDATE');
    });
});
