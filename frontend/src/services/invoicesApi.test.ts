import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Invoice } from './invoicesApi';

const authedFetch = vi.hoisted(() => vi.fn());
vi.mock('./apiClient', () => ({ authedFetch }));

import {
    fetchHydratedInvoice,
    fetchInvoices,
    hydrateInvoice,
    invoicePageOffset,
    InvoiceItemsNotHydratedError,
    updateHydratedInvoice,
    updateInvoice,
} from './invoicesApi';

function response(data: unknown): Response {
    return {
        ok: true,
        status: 200,
        json: vi.fn(async () => ({ ok: true, data })),
    } as unknown as Response;
}

function invoice(overrides: Partial<Invoice> = {}): Invoice {
    return {
        id: 57,
        company_id: 'company-a',
        invoice_number: 'INVOICE L-10-1',
        status: 'draft',
        contact_id: 2,
        lead_id: 10,
        job_id: null,
        estimate_id: null,
        title: 'Service',
        notes: null,
        internal_note: null,
        subtotal: '100.00',
        tax_rate: '0.00',
        tax_amount: '0.00',
        discount_amount: '0.00',
        total: '100.00',
        amount_paid: '0.00',
        balance_due: '100.00',
        currency: 'USD',
        payment_terms: null,
        due_date: null,
        sent_at: null,
        paid_at: null,
        voided_at: null,
        created_by: null,
        updated_by: null,
        created_at: '2026-08-14T12:00:00Z',
        updated_at: '2026-08-14T12:00:00Z',
        ...overrides,
    };
}

beforeEach(() => {
    authedFetch.mockReset();
});

describe('invoice list offset contract', () => {
    it('sends offset rather than page and derives the display page', async () => {
        authedFetch.mockResolvedValueOnce(response({ rows: [invoice()], total: 76 }));

        await expect(fetchInvoices({ offset: 50, limit: 25 })).resolves.toMatchObject({
            total: 76,
            page: 3,
            limit: 25,
        });
        expect(authedFetch.mock.calls[0][0]).toBe('/api/invoices?offset=50&limit=25');
        expect(authedFetch.mock.calls[0][0]).not.toContain('page=');
        expect(invoicePageOffset(3, 25)).toBe(50);
        expect(invoicePageOffset(0, 25)).toBe(0);
    });
});

describe('full invoice hydration and guarded item replacement', () => {
    it('hydrates a list summary through the detail endpoint', async () => {
        const full = invoice({ items: [] });
        authedFetch.mockResolvedValueOnce(response(full));

        await expect(hydrateInvoice(invoice())).resolves.toEqual({
            ...full,
            __itemsHydrated: true,
        });
        expect(authedFetch).toHaveBeenCalledWith(
            '/api/invoices/57',
            expect.objectContaining({ headers: { 'Content-Type': 'application/json' } })
        );
    });

    it('rejects a malformed detail response that omitted items', async () => {
        authedFetch.mockResolvedValueOnce(response(invoice()));

        await expect(fetchHydratedInvoice(57)).rejects.toBeInstanceOf(InvoiceItemsNotHydratedError);
    });

    it('blocks item replacement through the scalar update seam before any request', async () => {
        await expect(updateInvoice(57, { items: [] }))
            .rejects.toBeInstanceOf(InvoiceItemsNotHydratedError);
        expect(authedFetch).not.toHaveBeenCalled();
    });

    it('sends the backend hydration proof only from a hydrated invoice', async () => {
        const full = invoice({ items: [] });
        authedFetch.mockResolvedValueOnce(response(full));
        const hydrated = await fetchHydratedInvoice(57);
        authedFetch.mockResolvedValueOnce(response(full));

        await expect(updateHydratedInvoice(hydrated, { items: [] })).resolves.toEqual({
            ...full,
            __itemsHydrated: true,
        });
        expect(authedFetch).toHaveBeenLastCalledWith(
            '/api/invoices/57',
            expect.objectContaining({
                method: 'PUT',
                headers: {
                    'Content-Type': 'application/json',
                    'X-Invoice-Items-Hydrated': 'true',
                },
                body: JSON.stringify({ items: [] }),
            })
        );
    });
});
