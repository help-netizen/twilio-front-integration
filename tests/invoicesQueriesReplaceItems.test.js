'use strict';

/**
 * INVOICE-EDIT-ITEMS-PERSIST-001 — query-layer coverage of replaceInvoiceItems.
 *
 * replaceInvoiceItems(companyId, invoiceId, items) is a transactional delete-then-reinsert on
 * its OWN pooled client: db.getClient() → BEGIN → DELETE FROM invoice_items → one
 * INSERT per item → COMMIT (ROLLBACK on error), client.release() in finally, then it
 * returns getInvoiceItems(invoiceId) via the POOL (module-level `query`).
 *
 * These tests assert the transaction shape at the client-query level — that DELETE runs
 * before any INSERT, that the item count maps 1:1 to INSERTs, and that a mid-INSERT
 * failure rolls back (never commits) yet still releases the client. Mirrors the pooled-
 * client mock style of tests/zenbookerPaymentsJobLink.test.js (fake client whose `.query`
 * is a jest.fn(), asserting BEGIN/COMMIT/ROLLBACK ordering + release()).
 *
 * invoicesQueries requires the db as `./connection`, using db.getClient() for the
 * transaction and the module-level db.query (pool) for the final getInvoiceItems read.
 *
 * Run:
 *   npx jest tests/invoicesQueriesReplaceItems.test.js --testPathIgnorePatterns "/node_modules/"
 */

jest.mock('../backend/src/db/connection', () => ({
    query: jest.fn(),
    getClient: jest.fn(),
}));

const db = require('../backend/src/db/connection');
const invoicesQueries = require('../backend/src/db/invoicesQueries');

const COMPANY_ID = '00000000-0000-4000-8000-000000000501';
const INV_ID = 501;

// A fresh fake pooled client per test. `.query` resolves by default (BEGIN/DELETE/
// INSERT/COMMIT all succeed) unless a test overrides it to reject.
function fakeClient() {
    return { query: jest.fn().mockResolvedValue({ rows: [], rowCount: 0 }), release: jest.fn() };
}

// Index of the first client.query call whose SQL matches `re`, or -1.
function firstCallMatching(client, re) {
    return client.query.mock.calls.findIndex((c) => re.test(String(c[0])));
}
// Count of client.query calls whose SQL matches `re`.
function countCallsMatching(client, re) {
    return client.query.mock.calls.filter((c) => re.test(String(c[0]))).length;
}

const ITEMS = [
    { sort_order: 0, name: 'Labor', description: 'On-site', quantity: 2, unit_price: 100, taxable: true },
    { sort_order: 1, name: 'Parts', description: null, quantity: 1, unit_price: 50, taxable: false },
];

beforeEach(() => {
    db.query.mockReset();
    db.getClient.mockReset();
    // Final getInvoiceItems(invoiceId) reads through the pool — return an empty set.
    db.query.mockResolvedValue({ rows: [] });
});

// ─── (a) happy path: 2 items ─────────────────────────────────────────────────
describe('replaceInvoiceItems — happy path (2 items)', () => {
    it('runs BEGIN → DELETE (before any INSERT) → 2× INSERT → COMMIT, releases once, no ROLLBACK', async () => {
        const client = fakeClient();
        db.getClient.mockResolvedValue(client);

        const result = await invoicesQueries.replaceInvoiceItems(COMPANY_ID, INV_ID, ITEMS);

        const calls = client.query.mock.calls;

        // BEGIN is the very first statement on the client.
        expect(String(calls[0][0])).toMatch(/BEGIN/);

        const beginIdx = firstCallMatching(client, /BEGIN/);
        const deleteIdx = firstCallMatching(client, /DELETE FROM invoice_items/i);
        const firstInsertIdx = firstCallMatching(client, /INSERT INTO invoice_items/i);
        const commitIdx = firstCallMatching(client, /COMMIT/);

        // Every phase actually happened.
        expect(beginIdx).toBeGreaterThanOrEqual(0);
        expect(deleteIdx).toBeGreaterThanOrEqual(0);
        expect(firstInsertIdx).toBeGreaterThanOrEqual(0);
        expect(commitIdx).toBeGreaterThanOrEqual(0);

        // Ordering: BEGIN < DELETE < first INSERT < COMMIT. Crucially DELETE precedes
        // ANY insert, so a re-insert can never race ahead of the wipe.
        expect(beginIdx).toBeLessThan(deleteIdx);
        expect(deleteIdx).toBeLessThan(firstInsertIdx);
        expect(firstInsertIdx).toBeLessThan(commitIdx);

        // Exactly one INSERT per item.
        expect(countCallsMatching(client, /INSERT INTO invoice_items/i)).toBe(2);

        // The DELETE targeted this invoice.
        expect(calls[deleteIdx][1]).toEqual([COMPANY_ID, INV_ID]);

        // Committed, never rolled back, released exactly once.
        expect(countCallsMatching(client, /COMMIT/)).toBe(1);
        expect(countCallsMatching(client, /ROLLBACK/)).toBe(0);
        expect(client.release).toHaveBeenCalledTimes(1);

        // Returns the freshly-read items via the pool (getInvoiceItems).
        expect(db.query).toHaveBeenCalledTimes(1);
        expect(result).toEqual([]);
    });
});

// ─── (b) items: [] → clear, zero INSERTs ─────────────────────────────────────
describe('replaceInvoiceItems — empty items array (clear all)', () => {
    it('runs BEGIN → DELETE → COMMIT with ZERO INSERTs, releases the client', async () => {
        const client = fakeClient();
        db.getClient.mockResolvedValue(client);

        await invoicesQueries.replaceInvoiceItems(COMPANY_ID, INV_ID, []);

        const beginIdx = firstCallMatching(client, /BEGIN/);
        const deleteIdx = firstCallMatching(client, /DELETE FROM invoice_items/i);
        const commitIdx = firstCallMatching(client, /COMMIT/);

        expect(beginIdx).toBeGreaterThanOrEqual(0);
        expect(deleteIdx).toBeGreaterThan(beginIdx);
        expect(commitIdx).toBeGreaterThan(deleteIdx);

        // Summary-only invoice: nothing re-inserted.
        expect(countCallsMatching(client, /INSERT INTO invoice_items/i)).toBe(0);
        expect(countCallsMatching(client, /COMMIT/)).toBe(1);
        expect(countCallsMatching(client, /ROLLBACK/)).toBe(0);
        expect(client.release).toHaveBeenCalledTimes(1);
    });
});

// ─── (c) failure mid-INSERT → ROLLBACK, no COMMIT, still released ─────────────
describe('replaceInvoiceItems — INSERT failure', () => {
    it('rethrows, issues ROLLBACK (not COMMIT), and still releases the client', async () => {
        const boom = new Error('insert exploded');
        const client = fakeClient();
        // Succeed on BEGIN + DELETE, then blow up on the FIRST INSERT.
        client.query.mockImplementation((sql) => {
            if (/INSERT INTO invoice_items/i.test(String(sql))) {
                return Promise.reject(boom);
            }
            return Promise.resolve({ rows: [], rowCount: 0 });
        });
        db.getClient.mockResolvedValue(client);

        await expect(invoicesQueries.replaceInvoiceItems(COMPANY_ID, INV_ID, ITEMS)).rejects.toBe(boom);

        // Transaction was opened, the doomed insert was attempted, then unwound.
        expect(countCallsMatching(client, /BEGIN/)).toBe(1);
        expect(firstCallMatching(client, /INSERT INTO invoice_items/i)).toBeGreaterThanOrEqual(0);
        expect(countCallsMatching(client, /ROLLBACK/)).toBe(1);
        expect(countCallsMatching(client, /COMMIT/)).toBe(0);

        // finally { client.release() } always runs.
        expect(client.release).toHaveBeenCalledTimes(1);

        // A rejected transaction never reaches the final getInvoiceItems pool read.
        expect(db.query).not.toHaveBeenCalled();
    });
});
