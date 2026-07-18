/**
 * Regression guard: Zenbooker payments must keep their provider + job link.
 *
 * Bug (prod): payments synced with no provider and no linked job because the
 * sync resolved the job through a SINGLE hop (transaction.invoice_id →
 * invoice.job_id → getJob) and silently dropped the link when any hop missed.
 * The detail view compounded it by linking the local job on the fragile
 * job_number string instead of the stable zenbooker_job_id.
 *
 * These tests run in the normal jest suite so any regression in the
 * payment→job linkage fails CI before it ships.
 */

jest.mock('../backend/src/db/connection', () => ({ query: jest.fn(), getClient: jest.fn() }));
jest.mock('../backend/src/services/zenbookerClient', () => ({
    ZENBOOKER_DEFAULT_COMPANY_ID: '00000000-0000-0000-0000-000000000001',
    getPaymentReaderForCompany: jest.fn(),
    getTransactions: jest.fn(),
    getTransactionsPage: jest.fn(),
    getInvoice: jest.fn(),
    getJob: jest.fn(),
}));

const db = require('../backend/src/db/connection');
const zb = require('../backend/src/services/zenbookerClient');
const sync = require('../backend/src/services/zenbookerPaymentsSyncService');

const COMPANY = '00000000-0000-0000-0000-000000000001';
const ZB_JOB_ID = '1781974323252x656275605619673900'; // shape from the real ZB API

const reader = {
    getTransactions: (...args) => zb.getTransactions(...args),
    getTransactionsPage: (...args) => zb.getTransactionsPage(...args),
    getInvoice: (...args) => zb.getInvoice(...args),
    getJob: (...args) => zb.getJob(...args),
};

beforeEach(() => {
    db.query.mockReset();
    db.getClient.mockReset();
    zb.getTransactions.mockReset();
    zb.getTransactionsPage.mockReset();
    zb.getInvoice.mockReset();
    zb.getJob.mockReset();
    zb.getPaymentReaderForCompany.mockReset();
    zb.getPaymentReaderForCompany.mockResolvedValue(reader);
});

// ── job/invoice id resolution ────────────────────────────────────────────────

describe('resolveZbJobId / resolveZbInvoiceId', () => {
    it('prefers invoice.job_id, then nested invoice.job.id, then the transaction', () => {
        expect(sync.resolveZbJobId({ job_id: 'TX' }, { job_id: 'INV' })).toBe('INV');
        expect(sync.resolveZbJobId({ job_id: 'TX' }, { job: { id: 'INVNEST' } })).toBe('INVNEST');
        expect(sync.resolveZbJobId({ job_id: 'TX' }, null)).toBe('TX');
        expect(sync.resolveZbJobId({ job: { id: 'TXNEST' } }, {})).toBe('TXNEST');
        expect(sync.resolveZbJobId({}, {})).toBe('');
    });

    it('resolves the invoice id from flat or nested shapes and stringifies', () => {
        expect(sync.resolveZbInvoiceId({ invoice_id: 42 })).toBe('42');
        expect(sync.resolveZbInvoiceId({ invoice: { id: 'inv_1' } })).toBe('inv_1');
        expect(sync.resolveZbInvoiceId({})).toBe('');
    });

    // Regression (payment 10754): ZB returned the invoice as a JSON STRING (axios
    // doesn't parse a non-JSON content-type) — sometimes even malformed JSON — so
    // `invoice.job_id` was unreachable and the job link was dropped. The resolver
    // must dig the id out of a string / double-encoded / malformed payload too.
    it('resolves the job id when the invoice arrives as a (double-encoded/malformed) JSON string', () => {
        // invoice body delivered as a JSON string (the 10754 shape)
        expect(sync.resolveZbJobId({}, JSON.stringify({ job_id: 'JOBSTR' }))).toBe('JOBSTR');
        // MALFORMED JSON ("price":}) — JSON.parse throws, regex still finds the id
        expect(sync.resolveZbJobId({}, '{"job_id":"JOBBAD","service_order":{"price":}}')).toBe('JOBBAD');
        // transaction-carried id still wins as a fallback when the string has none
        expect(sync.resolveZbJobId({ job_id: 'TXFALL' }, '{"status":"paid"}')).toBe('TXFALL');
    });
});

// ── assembleRow linkage ──────────────────────────────────────────────────────

describe('assembleRow keeps the job link', () => {
    const txn = (over = {}) => ({ id: 't1', status: 'succeeded', amount_collected: '120.00', ...over });

    it('attaches provider + job when the job body is present', () => {
        const job = { id: ZB_JOB_ID, job_number: '#002202-4', service_name: 'Repair', assigned_providers: [{ name: 'Tech A' }, { name: 'Tech B' }] };
        const row = sync.assembleRow(txn({ invoice_id: 'inv1' }), { job_id: ZB_JOB_ID }, job);
        expect(row.missing_job_link).toBe(false);
        expect(row.job_id).toBe(ZB_JOB_ID);
        expect(row.job_number).toBe('#002202-4');
        expect(row.tech).toBe('Tech A, Tech B');
    });

    it('still records the ZB job id when the job body could not be fetched (the bug)', () => {
        // invoice resolved the job id, but getJob failed → job arg is null.
        // Previously job_id was taken from invoice but the row was unlinkable;
        // now we persist job_id so the row links by zenbooker_job_id on read.
        const row = sync.assembleRow(txn({ invoice_id: 'inv1' }), { job_id: ZB_JOB_ID }, null);
        expect(row.job_id).toBe(ZB_JOB_ID);
        expect(row.missing_job_link).toBe(true);
    });

    it('resolves the job id straight from the transaction when there is no invoice', () => {
        const row = sync.assembleRow(txn({ job_id: ZB_JOB_ID }), null, null);
        expect(row.job_id).toBe(ZB_JOB_ID);
    });

    it('marks missing_job_link with no resolvable job at all', () => {
        const row = sync.assembleRow(txn(), null, null);
        expect(row.job_id).toBe('');
        expect(row.missing_job_link).toBe(true);
        expect(row.tech).toBe('—');
    });
});

// ── syncPayments fan-out ─────────────────────────────────────────────────────

function fakeTxnClient() {
    // Stands in for the reconcile transaction opened after the upserts.
    return {
        query: jest.fn((sql) =>
            String(sql).includes('FILTER')
                ? Promise.resolve({ rows: [{ still_missing_body: '0', still_no_job_id: '0' }], rowCount: 0 })
                : Promise.resolve({ rowCount: 0 })),
        release: jest.fn(),
    };
}

describe('syncPayments resolves jobs beyond the invoice hop', () => {
    it('fetches + links a job referenced directly on an invoice-less transaction', async () => {
        zb.getTransactions.mockResolvedValue([{ id: 't1', job_id: ZB_JOB_ID, status: 'succeeded', amount_collected: '120.00' }]);
        zb.getJob.mockResolvedValue({ id: ZB_JOB_ID, job_number: '#002202-4', service_name: 'Repair', assigned_providers: [{ id: 'p1', name: 'Tech A' }], status: 'complete' });
        db.query.mockResolvedValue({ rows: [], rowCount: 1 });
        db.getClient.mockResolvedValue(fakeTxnClient());

        const res = await sync.syncPayments(COMPANY, '2026-06-01', '2026-06-30');

        expect(zb.getInvoice).not.toHaveBeenCalled();        // no invoice id → no invoice fetch
        expect(zb.getJob).toHaveBeenCalledWith(ZB_JOB_ID);   // resolved from txn.job_id
        expect(res.unlinked).toBe(0);

        const upsert = db.query.mock.calls.find(c => String(c[0]).includes('INSERT INTO zb_payments'));
        expect(upsert[1][3]).toBe(ZB_JOB_ID);                // job_id param
        expect(upsert[1][14]).toBe('Tech A');                // tech param
    });

    it('reports unlinked payments instead of swallowing the miss', async () => {
        zb.getTransactions.mockResolvedValue([{ id: 't2', status: 'succeeded', amount_collected: '50.00' }]);
        db.query.mockResolvedValue({ rows: [], rowCount: 1 });
        db.getClient.mockResolvedValue(fakeTxnClient());

        const res = await sync.syncPayments(COMPANY, '2026-06-01', '2026-06-30');

        expect(zb.getJob).not.toHaveBeenCalled();
        expect(res.unlinked).toBe(1);
        expect(res.unresolved_job_id).toBe(1);
    });

    // Regression: a re-sync where getJob fails must NOT wipe the work-note
    // images (and other job-body fields) already stored on the payment. The
    // upsert guards them behind EXCLUDED.missing_job_link so a body-less run
    // keeps the existing value instead of overwriting it with empties.
    it('does not overwrite attachments/job_detail when the job body is missing', async () => {
        zb.getTransactions.mockResolvedValue([{ id: 't3', status: 'succeeded', amount_collected: '75.00' }]);
        db.query.mockResolvedValue({ rows: [], rowCount: 1 });
        db.getClient.mockResolvedValue(fakeTxnClient());

        await sync.syncPayments(COMPANY, '2026-06-01', '2026-06-30');

        const upsert = db.query.mock.calls.find(c => String(c[0]).includes('INSERT INTO zb_payments'));
        const sql = String(upsert[0]).replace(/\s+/g, ' ');
        // body-derived columns keep the existing row value on a body-less run
        expect(sql).toContain('attachments = CASE WHEN EXCLUDED.missing_job_link THEN zb_payments.attachments ELSE EXCLUDED.attachments END');
        expect(sql).toContain('zb_raw_job = CASE WHEN EXCLUDED.missing_job_link THEN zb_payments.zb_raw_job ELSE EXCLUDED.zb_raw_job END');
        expect(sql).toContain('job_detail = CASE WHEN EXCLUDED.missing_job_link THEN zb_payments.job_detail ELSE EXCLUDED.job_detail END');
        // a body-less re-sync never regresses a previously-linked row to "missing"
        expect(sql).toContain('missing_job_link = CASE WHEN EXCLUDED.missing_job_link THEN zb_payments.missing_job_link ELSE false END');
    });
});

// ── getPaymentDetail join key ────────────────────────────────────────────────

describe('getPaymentDetail links the local job by stable id', () => {
    it('joins on zenbooker_job_id, not the fragile job_number string', async () => {
        db.query.mockResolvedValueOnce({ rows: [{ id: 10778, job_number: '#002202-4', local_job_id: 1283, missing_job_link: false }] });

        const detail = await sync.getPaymentDetail(COMPANY, 10778);

        const sql = db.query.mock.calls[0][0];
        expect(sql).toContain('j.zenbooker_job_id = p.job_id');
        expect(sql).not.toMatch(/LEFT JOIN jobs j ON j\.job_number = p\.job_number/);
        expect(detail.local_job_id).toBe(1283);
    });
});

// ── reconcileJobLinks ────────────────────────────────────────────────────────

describe('reconcileJobLinks', () => {
    it('backfills job_id, heals from local jobs, projects the ledger, and commits', async () => {
        const calls = [];
        const client = {
            query: jest.fn((sql) => {
                calls.push(String(sql));
                if (String(sql).includes('FILTER')) {
                    return Promise.resolve({ rows: [{ still_missing_body: '2', still_no_job_id: '1' }], rowCount: 0 });
                }
                return Promise.resolve({ rowCount: 3 });
            }),
            release: jest.fn(),
        };
        db.getClient.mockResolvedValue(client);

        const r = await sync.reconcileJobLinks(COMPANY, { dryRun: false });

        expect(calls.some(s => s.includes('BEGIN'))).toBe(true);
        expect(calls.some(s => s.includes('UPDATE zb_payments') && s.includes('zb_raw_invoice'))).toBe(true);
        expect(calls.some(s => s.includes('FROM jobs j') && s.includes('j.zenbooker_job_id = zp.job_id'))).toBe(true);
        expect(calls.some(s => s.includes('INSERT INTO payment_transactions'))).toBe(true);
        expect(calls.some(s => s.includes('COMMIT'))).toBe(true);
        expect(calls.some(s => s.includes('ROLLBACK'))).toBe(false);
        expect(r.still_missing_job_body).toBe(2);
        expect(r.still_no_job_id).toBe(1);
        expect(client.release).toHaveBeenCalled();
    });

    it('dry-run rolls back and writes nothing', async () => {
        const calls = [];
        const client = {
            query: jest.fn((sql) => {
                calls.push(String(sql));
                if (String(sql).includes('FILTER')) {
                    return Promise.resolve({ rows: [{ still_missing_body: '0', still_no_job_id: '0' }], rowCount: 0 });
                }
                return Promise.resolve({ rowCount: 0 });
            }),
            release: jest.fn(),
        };
        db.getClient.mockResolvedValue(client);

        await sync.reconcileJobLinks(COMPANY, { dryRun: true });

        expect(calls.some(s => s.includes('ROLLBACK'))).toBe(true);
        expect(calls.some(s => s.includes('COMMIT'))).toBe(false);
    });
});
