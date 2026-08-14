import { describe, expect, it } from 'vitest';
import detailSource from './JobDetailPanel.tsx?raw';
import financialsSource from './JobFinancialsTab.tsx?raw';
import receiptSource from './JobRecordPaymentDialog.tsx?raw';

describe('JOB-EMAIL-SOT-001 job-linked send prefills', () => {
    it('passes the backend effective job identity when contact hydration is unavailable', () => {
        expect(detailSource.match(/contactEmail=\{contactInfo\?\.email \|\| job\.customer_email\}/g)).toHaveLength(2);
        expect(detailSource.match(/contactPhone=\{contactInfo\?\.phone \|\| job\.customer_phone\}/g)).toHaveLength(2);
    });

    it('keeps invoice send identity atomic and uses the job identity for receipt prefills', () => {
        expect(financialsSource).toContain('invoice={selectedInvoice}');
        expect(financialsSource).toContain('onSend={async (invoiceId, data) =>');
        expect(financialsSource).toContain('await sendInvoice(invoiceId, data)');
        expect(financialsSource).not.toContain('await sendInvoice(selectedInvoice.id, data)');
        expect(financialsSource).toMatch(/<JobRecordPaymentDialog[\s\S]*?contactEmail=\{contactEmail\}/);
        expect(receiptSource).toContain("setReceiptEmail((contactEmail || '').trim())");
    });
});
