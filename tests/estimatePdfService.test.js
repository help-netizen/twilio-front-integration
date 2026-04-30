const { renderEstimatePdf } = require('../backend/src/services/estimatePdfService');

describe('estimatePdfService', () => {
    it('renders a valid estimate PDF with company, totals, items, terms, and ACH details', () => {
        const buffer = renderEstimatePdf({
            id: 1,
            estimate_number: 'ESTIMATE L-53-1',
            status: 'approved',
            contact_name: 'ClaudeTest Lead474403',
            job_number: '971346',
            subtotal: '375.00',
            discount_amount: '30.00',
            tax_amount: '4.06',
            total: '349.06',
            summary: 'Make\nSharp\n\nFailure Issue:\nMicrowave door does not release.',
            created_at: '2026-04-27T08:30:00Z',
            updated_at: '2026-04-27T08:42:00Z',
            items: [
                { id: 1, name: 'Labor', description: 'Repair labor', quantity: '1', unit_price: '280.00', amount: '280.00' },
                { id: 2, name: 'Turntable motor', description: 'OEM-compatible replacement part', quantity: '1', unit_price: '95.00', amount: '95.00' },
            ],
        });

        const pdf = buffer.toString('utf8');
        expect(pdf.startsWith('%PDF-1.4')).toBe(true);
        expect(pdf).toContain('ABC Homes');
        expect(pdf).toContain('ESTIMATE L-53-1');
        expect(pdf).toContain('Turntable motor');
        expect(pdf).toContain('$349.06');
        expect(pdf).toContain('TERMS & WARRANTY');
        expect(pdf).toContain('Routing Number: 011000138');
        expect(pdf.endsWith('%%EOF\n')).toBe(true);
    });
});
