import { describe, expect, it } from 'vitest';
import detailSource from './JobDetailPanel.tsx?raw';
import financialsSource from './JobFinancialsTab.tsx?raw';
import receiptSource from './JobRecordPaymentDialog.tsx?raw';

describe('JOB-EMAIL-SOT-001 job-linked send prefills', () => {
    it('passes the backend effective job identity when contact hydration is unavailable', () => {
        expect(detailSource.match(/contactEmail=\{contactInfo\?\.email \|\| job\.customer_email\}/g)).toHaveLength(2);
        expect(detailSource.match(/contactPhone=\{contactInfo\?\.phone \|\| job\.customer_phone\}/g)).toHaveLength(2);
    });

    it('uses that identity for invoice and receipt prefills', () => {
        expect(financialsSource).toContain("contactEmail={selectedInvoice.contact_email || contactEmail || ''}");
        expect(financialsSource).toContain("contactPhone={selectedInvoice.contact_phone || contactPhone || ''}");
        expect(financialsSource).toMatch(/<JobRecordPaymentDialog[\s\S]*?contactEmail=\{contactEmail\}/);
        expect(receiptSource).toContain("setReceiptEmail((contactEmail || '').trim())");
    });
});
