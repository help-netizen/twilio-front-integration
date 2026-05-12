/**
 * Renderer integration tests for F015 (post @react-pdf/renderer migration).
 *
 * react-pdf encodes text via font glyph maps, so we no longer scan the buffer
 * for plain strings. Instead we verify the renderer:
 *  - returns a structurally valid PDF Buffer for default and edited descriptors
 *  - does not throw on edge cases (no descriptor, all sections hidden)
 */

'use strict';

const { renderEstimatePdf } = require('../../backend/src/services/estimatePdfService');
const { getFactory } = require('../../backend/src/services/documentTemplates/factory');

const SAMPLE_ESTIMATE = {
    estimate_number: 'ESTIMATE L-1001-1',
    status: 'draft',
    contact_name: 'Jane Customer',
    contact_email: 'jane@example.com',
    contact_phone: '(555) 555-1234',
    billing_address: '1 Main St',
    service_address: '1 Main St',
    job_number: 'J-7',
    summary: 'Replace heating element on dryer.',
    subtotal: 250,
    discount_amount: 0,
    tax_amount: 0,
    total: 250,
    items: [{ name: 'Diagnostic', quantity: 1, unit_price: 95, amount: 95 }],
    created_at: '2026-05-01T00:00:00Z',
    updated_at: '2026-05-01T00:00:00Z',
};

function isValidPdf(buffer) {
    if (!Buffer.isBuffer(buffer)) return false;
    const head = buffer.subarray(0, 8).toString('utf8');
    const tail = buffer.subarray(buffer.length - 16).toString('utf8');
    return head.startsWith('%PDF-') && tail.includes('%%EOF');
}

describe('renderEstimatePdf with descriptor', () => {
    test('produces a valid PDF buffer with no descriptor (factory fallback)', async () => {
        const buffer = await renderEstimatePdf(SAMPLE_ESTIMATE);
        expect(isValidPdf(buffer)).toBe(true);
    });

    test('explicit factory descriptor produces a valid PDF', async () => {
        const buffer = await renderEstimatePdf(SAMPLE_ESTIMATE, getFactory('estimate'));
        expect(isValidPdf(buffer)).toBe(true);
    });

    test('hiding the terms section produces a valid PDF', async () => {
        const descriptor = getFactory('estimate');
        const terms = descriptor.sections.find(s => s.key === 'terms');
        terms.visible = false;
        const buffer = await renderEstimatePdf(SAMPLE_ESTIMATE, descriptor);
        expect(isValidPdf(buffer)).toBe(true);
    });

    test('Bold preset produces a valid PDF', async () => {
        const descriptor = getFactory('estimate');
        descriptor.layout_preset = 'bold';
        descriptor.font_scale = 1.3;
        const buffer = await renderEstimatePdf(SAMPLE_ESTIMATE, descriptor);
        expect(isValidPdf(buffer)).toBe(true);
    });

    test('Minimal preset produces a valid PDF', async () => {
        const descriptor = getFactory('estimate');
        descriptor.layout_preset = 'minimal';
        const buffer = await renderEstimatePdf(SAMPLE_ESTIMATE, descriptor);
        expect(isValidPdf(buffer)).toBe(true);
    });

    test('hiding all sections still produces a valid PDF', async () => {
        const descriptor = getFactory('estimate');
        descriptor.sections.forEach(s => { s.visible = false; });
        const buffer = await renderEstimatePdf(SAMPLE_ESTIMATE, descriptor);
        expect(isValidPdf(buffer)).toBe(true);
    });
});
