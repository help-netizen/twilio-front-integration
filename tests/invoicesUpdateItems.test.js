'use strict';

/**
 * INVOICE-EDIT-ITEMS-PERSIST-001 — invoicesService.updateInvoice line-item reconcile.
 *
 * BUG: editing an existing invoice via the full editor (InvoiceEditorDialog) silently
 * dropped all line-item changes. `updateInvoice` only wrote scalar fields via
 * `invoicesQueries.updateInvoice` and only recalced totals when tax_rate/discount_amount
 * changed — it never persisted `data.items`. The editor always sends the FULL `items`
 * array (no per-item id) on update, so edits/adds/removes were lost.
 *
 * FIX: when `Array.isArray(data.items)`, updateInvoice calls
 * invoicesQueries.replaceInvoiceItems(companyId, id, items) (delete-then-reinsert, atomic) and then
 * recalculateInvoiceTotals(id). Recalc also fires when a totals-affecting scalar changed.
 *
 * CRITICAL regression guard: scalar-only patches from InvoiceDetailPanel.persist()
 * (e.g. { notes }, { tax_rate }) omit `items` — those must NOT wipe items.
 *
 * These are SERVICE-level unit tests: the entire db-query layer is mocked so we assert
 * the orchestration (which queries run, with what args, in what order). Mirrors the mock
 * style of tests/sendDocInvoice.test.js.
 *
 * Run:
 *   npx jest tests/invoicesUpdateItems.test.js --testPathIgnorePatterns "/node_modules/"
 */

const COMPANY_A = '00000000-0000-0000-0000-00000000000a';
const USER_ID = '11111111-1111-4111-8111-111111111111';
const INV_ID = 501;

// ─── DB query layer (fully mocked) ───────────────────────────────────────────
const mockGetInvoiceById = jest.fn();
const mockGetInvoiceItems = jest.fn();
const mockUpdateInvoice = jest.fn();
const mockReplaceInvoiceItems = jest.fn();
const mockRecalculateInvoiceTotals = jest.fn();
const mockCreateRevision = jest.fn();
const mockCreateEvent = jest.fn();

jest.mock('../backend/src/db/invoicesQueries', () => ({
    getInvoiceById: (...a) => mockGetInvoiceById(...a),
    getInvoiceItems: (...a) => mockGetInvoiceItems(...a),
    updateInvoice: (...a) => mockUpdateInvoice(...a),
    replaceInvoiceItems: (...a) => mockReplaceInvoiceItems(...a),
    recalculateInvoiceTotals: (...a) => mockRecalculateInvoiceTotals(...a),
    createRevision: (...a) => mockCreateRevision(...a),
    createEvent: (...a) => mockCreateEvent(...a),
}));
// estimatesQueries is required at module top of invoicesService but unused on this path.
jest.mock('../backend/src/db/estimatesQueries', () => ({}));

const invoicesService = require('../backend/src/services/invoicesService');

function invoiceRow(overrides = {}) {
    return {
        id: INV_ID,
        company_id: COMPANY_A,
        invoice_number: 'INVOICE L-519-1',
        status: 'draft',
        contact_id: 7,
        tax_rate: 0,
        discount_amount: 0,
        ...overrides,
    };
}

const NEW_ITEMS = [
    { sort_order: 0, name: 'Labor', description: 'On-site', quantity: 2, unit: null, unit_price: 100, taxable: true },
    { sort_order: 1, name: 'Parts', description: null, quantity: 1, unit: null, unit_price: 50, taxable: false },
];

beforeEach(() => {
    jest.clearAllMocks();
    // Default happy-path stubs.
    mockGetInvoiceById.mockResolvedValue(invoiceRow());
    // getInvoiceItems is used both for the revision snapshot and for the final getInvoice().
    mockGetInvoiceItems.mockResolvedValue([]);
    mockUpdateInvoice.mockImplementation(async (_id, _co, data) => invoiceRow(data));
    mockReplaceInvoiceItems.mockResolvedValue(NEW_ITEMS);
    mockRecalculateInvoiceTotals.mockResolvedValue(invoiceRow());
    mockCreateRevision.mockResolvedValue({ id: 1 });
    mockCreateEvent.mockResolvedValue(undefined);
});

// ─── T1: changed items array → replace + recalc, returns invoice ─────────────
describe('T1 — updateInvoice with a changed items array', () => {
    it('calls company-scoped replaceInvoiceItems then recalculateInvoiceTotals and returns the invoice', async () => {
        const result = await invoicesService.updateInvoice(COMPANY_A, USER_ID, INV_ID, { items: NEW_ITEMS });

        expect(mockReplaceInvoiceItems).toHaveBeenCalledTimes(1);
        expect(mockReplaceInvoiceItems).toHaveBeenCalledWith(COMPANY_A, INV_ID, NEW_ITEMS, null);
        expect(mockRecalculateInvoiceTotals).toHaveBeenCalledTimes(1);
        expect(mockRecalculateInvoiceTotals).toHaveBeenCalledWith(COMPANY_A, INV_ID, null);

        // Ordering: items replaced BEFORE totals recalc (recalc reads the fresh items).
        expect(mockReplaceInvoiceItems.mock.invocationCallOrder[0])
            .toBeLessThan(mockRecalculateInvoiceTotals.mock.invocationCallOrder[0]);

        // Returns the full invoice (getInvoice → getInvoiceById + getInvoiceItems).
        expect(result).toMatchObject({ id: INV_ID, company_id: COMPANY_A });
        expect(result).toHaveProperty('items');
    });
});

// ─── T2: REGRESSION GUARD — no items key → items untouched ───────────────────
describe('T2 — updateInvoice with NO items key (scalar-only patch)', () => {
    it('does NOT call replaceInvoiceItems when data has no items (e.g. { notes })', async () => {
        await invoicesService.updateInvoice(COMPANY_A, USER_ID, INV_ID, { notes: 'x' });

        expect(mockReplaceInvoiceItems).not.toHaveBeenCalled();
        // notes is not a totals-affecting scalar → no recalc either.
        expect(mockRecalculateInvoiceTotals).not.toHaveBeenCalled();
    });

    it('does NOT call replaceInvoiceItems for a tax_rate-only patch, but DOES recalc', async () => {
        await invoicesService.updateInvoice(COMPANY_A, USER_ID, INV_ID, { tax_rate: '8.25' });

        expect(mockReplaceInvoiceItems).not.toHaveBeenCalled();
        expect(mockRecalculateInvoiceTotals).toHaveBeenCalledTimes(1);
        expect(mockRecalculateInvoiceTotals).toHaveBeenCalledWith(COMPANY_A, INV_ID, null);
    });
});

// ─── T3: items: [] → clear all items + recalc ────────────────────────────────
describe('T3 — updateInvoice with items: [] (clear all)', () => {
    it('calls company-scoped replaceInvoiceItems with [] and recalculates totals', async () => {
        mockReplaceInvoiceItems.mockResolvedValue([]);

        await invoicesService.updateInvoice(COMPANY_A, USER_ID, INV_ID, { items: [] });

        expect(mockReplaceInvoiceItems).toHaveBeenCalledTimes(1);
        expect(mockReplaceInvoiceItems).toHaveBeenCalledWith(COMPANY_A, INV_ID, [], null);
        expect(mockRecalculateInvoiceTotals).toHaveBeenCalledTimes(1);
        expect(mockRecalculateInvoiceTotals).toHaveBeenCalledWith(COMPANY_A, INV_ID, null);
    });
});

// ─── T4: foreign/missing invoice → NOT_FOUND, no writes ──────────────────────
describe('T4 — foreign/missing invoice', () => {
    it('throws NOT_FOUND and never calls replaceInvoiceItems (multi-tenant guard)', async () => {
        mockGetInvoiceById.mockResolvedValue(null);

        await expect(
            invoicesService.updateInvoice(COMPANY_A, USER_ID, INV_ID, { items: NEW_ITEMS })
        ).rejects.toMatchObject({ code: 'NOT_FOUND', httpStatus: 404 });

        expect(mockReplaceInvoiceItems).not.toHaveBeenCalled();
        expect(mockUpdateInvoice).not.toHaveBeenCalled();
        expect(mockRecalculateInvoiceTotals).not.toHaveBeenCalled();
    });
});

// ─── T5: non-draft → revision snapshot BEFORE reconcile ──────────────────────
describe('T5 — non-draft invoice (status sent)', () => {
    it('creates a revision snapshot AND reconciles items, snapshot captured BEFORE replace', async () => {
        mockGetInvoiceById.mockResolvedValue(invoiceRow({ status: 'sent' }));
        const OLD_ITEMS = [{ id: 9, name: 'Old', quantity: 1, unit_price: 10, amount: 10 }];
        // getInvoiceItems is read TWICE on the non-draft path: first for the revision
        // snapshot (must see the OLD, pre-edit items), then again inside the final
        // getInvoice() (sees the NEW items after the reconcile). Distinguish the two so
        // the snapshot assertion can't pass by coincidence — the snapshot MUST capture
        // OLD_ITEMS, never NEW_ITEMS.
        mockGetInvoiceItems.mockResolvedValueOnce(OLD_ITEMS).mockResolvedValue(NEW_ITEMS);

        await invoicesService.updateInvoice(COMPANY_A, USER_ID, INV_ID, { items: NEW_ITEMS });

        // Revision snapshot was taken (old state) …
        expect(mockCreateRevision).toHaveBeenCalledTimes(1);
        const [snapCompanyId, snapInvoiceId, snapshot] = mockCreateRevision.mock.calls[0];
        expect(snapCompanyId).toBe(COMPANY_A);
        expect(snapInvoiceId).toBe(INV_ID);
        expect(snapshot).toMatchObject({ status: 'sent' });
        // Snapshot captured the OLD items (the pre-edit state), NOT the incoming NEW ones.
        expect(snapshot.items).toEqual(OLD_ITEMS);
        expect(snapshot.items).not.toEqual(NEW_ITEMS);

        // … and items were still reconciled.
        expect(mockReplaceInvoiceItems).toHaveBeenCalledWith(COMPANY_A, INV_ID, NEW_ITEMS, null);

        // ORDER: snapshot BEFORE the item replace (so it captures the pre-edit state).
        expect(mockCreateRevision.mock.invocationCallOrder[0])
            .toBeLessThan(mockReplaceInvoiceItems.mock.invocationCallOrder[0]);
    });
});
