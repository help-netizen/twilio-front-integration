const { renderEstimatePdf } = require('../backend/src/services/estimatePdfService');

describe('estimatePdfService', () => {
    it('renders a valid estimate PDF', async () => {
        const buffer = await renderEstimatePdf({
            id: 1,
            estimate_number: 'ESTIMATE L-53-1',
            status: 'approved',
            contact_name: 'ClaudeTest Lead474403',
            contact_email: 'claude.test+474403@example.com',
            contact_phone: '+16175554004',
            job_number: '971346',
            billing_address: '123 Main St, 1, Quincy, MA 02169, US',
            service_address: '123 Main St, 1, Quincy, MA 02169',
            subtotal: '375.00',
            discount_amount: '30.00',
            tax_amount: '4.06',
            total: '349.06',
            summary: 'Failure Issue:\nMicrowave door does not release.',
            created_at: '2026-04-27T08:30:00Z',
            updated_at: '2026-04-27T08:42:00Z',
            items: [
                { id: 1, name: 'Labor', description: 'Repair labor', quantity: '1', unit_price: '280.00', amount: '280.00', taxable: false },
                { id: 2, name: 'Turntable motor', description: 'OEM-compatible replacement part', quantity: '1', unit_price: '95.00', amount: '95.00', taxable: true },
            ],
        });

        const head = buffer.subarray(0, 8).toString('utf8');
        const tail = buffer.subarray(buffer.length - 8).toString('utf8');
        expect(Buffer.isBuffer(buffer)).toBe(true);
        expect(head.startsWith('%PDF-')).toBe(true);
        // PDF text is glyph-encoded after react-pdf migration; we just verify a
        // structurally valid file. Functional layout coverage lives in
        // tests/services/estimatePdfRendererTemplate.test.js.
        expect(tail.includes('%%EOF')).toBe(true);
    });
});
