/**
 * Guard: the finance panels must never hold a COPY of the selected estimate/invoice.
 *
 * Paid for on 2026-08-15. `selectedInvoice` was `useState<Invoice | null>` — a snapshot
 * taken when the operator opened the row. Applying a discount saved fine and refreshed the
 * list, but the snapshot could not be reached by refresh(), so the send dialog composed the
 * customer's email from the pre-discount numbers: the letter quoted the full $501.89 while
 * the invoice, the PDF and the payment page all showed the discounted $385.44. Server-rendered
 * surfaces were right; only the client-composed letter was wrong, which is why it looked like
 * a money bug rather than a stale-state one.
 *
 * The fix keeps only the id in state and reads the row back out of the live list. This test
 * fails if anyone reintroduces the snapshot.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const source = readFileSync(join(__dirname, 'useJobFinancials.ts'), 'utf8');

describe('finance selection freshness', () => {
    it('keeps only the selected ids in state, never a copy of the row', () => {
        expect(source).not.toMatch(/useState<Invoice \| null>/);
        expect(source).not.toMatch(/useState<Estimate \| null>/);
        expect(source).toMatch(/useState<number \| null>\(null\)/);
    });

    it('derives the selected invoice and estimate from the live lists', () => {
        expect(source).toMatch(/invoices\.find\(\s*i\s*=>\s*i\.id === selectedInvoiceId\s*\)/);
        expect(source).toMatch(/estimates\.find\(\s*e\s*=>\s*e\.id === selectedEstimateId\s*\)/);
    });

    it('recomputes the selection whenever the lists change', () => {
        expect(source).toMatch(/\[invoices, selectedInvoiceId\]/);
        expect(source).toMatch(/\[estimates, selectedEstimateId\]/);
    });
});
