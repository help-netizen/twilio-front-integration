'use strict';

const { renderEstimatePdf } = require('../backend/src/services/estimatePdfService');
const invoiceAdapter = require('../backend/src/services/documentTemplates/invoiceAdapter');
const { getFactory } = require('../backend/src/services/documentTemplates/factory');
const {
    fetchPdfLogo,
    MAX_LOGO_BYTES,
} = require('../backend/src/services/documentTemplates/pdfLogo');

const PNG = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
    'base64'
);
const LOGO_URL = 'https://tenant.fly.storage.tigris.dev/company/logo.png?X-Amz-Signature=test';

const ESTIMATE = {
    estimate_number: 'ESTIMATE L-16-1',
    status: 'draft',
    contact_name: 'Customer',
    subtotal: 100,
    discount_amount: 0,
    tax_amount: 0,
    total: 100,
    items: [{ name: 'Service', quantity: 1, unit_price: 100, amount: 100 }],
    created_at: '2026-07-26T00:00:00.000Z',
    updated_at: '2026-07-26T00:00:00.000Z',
};

const INVOICE = {
    invoice_number: 'INVOICE L-16-1',
    status: 'partial',
    contact_name: 'Customer',
    subtotal: 100,
    discount_amount: 0,
    tax_amount: 0,
    total: 100,
    amount_paid: 30,
    balance_due: 100,
    items: [{ name: 'Service', quantity: 1, unit_price: 100, amount: 100 }],
    created_at: '2026-07-26T00:00:00.000Z',
    due_date: '2026-08-09',
};

function response(buffer = PNG) {
    return {
        ok: true,
        headers: { get: () => String(buffer.length) },
        arrayBuffer: async () => buffer,
    };
}

function imageXObjects(buffer) {
    return (buffer.toString('latin1').match(/\/Subtype\s*\/Image/g) || []).length;
}

beforeAll(() => {
    process.env.AWS_ENDPOINT_URL_S3 = 'https://fly.storage.tigris.dev';
});

afterAll(() => {
    delete process.env.AWS_ENDPOINT_URL_S3;
});

test('fetchPdfLogo accepts configured Tigris PNG bytes and rejects arbitrary hosts/oversize payloads', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(response());
    const image = await fetchPdfLogo(LOGO_URL, { fetchImpl });

    expect(image).toEqual({ data: PNG, format: 'png' });
    expect(fetchImpl).toHaveBeenCalledWith(
        LOGO_URL,
        expect.objectContaining({ method: 'GET', redirect: 'error', signal: expect.any(AbortSignal) })
    );

    await expect(fetchPdfLogo('https://127.0.0.1/logo.png', { fetchImpl })).resolves.toBeNull();
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    const oversized = response(PNG);
    oversized.headers.get = () => String(MAX_LOGO_BYTES + 1);
    await expect(fetchPdfLogo(LOGO_URL, {
        fetchImpl: jest.fn().mockResolvedValue(oversized),
    })).resolves.toBeNull();
});

test('fetchPdfLogo decodes a safe template-owned inline PNG without making a network request', async () => {
    const fetchImpl = jest.fn();
    const inlineLogo = `data:image/png;base64,${PNG.toString('base64')}`;

    await expect(fetchPdfLogo(inlineLogo, { fetchImpl })).resolves.toEqual({
        data: PNG,
        format: 'png',
    });
    expect(fetchImpl).not.toHaveBeenCalled();
});

test.each([
    ['estimate', async (descriptor, options) => renderEstimatePdf(ESTIMATE, descriptor, options)],
    ['invoice', async (descriptor, options) => invoiceAdapter.render(INVOICE, descriptor, options)],
])('%s PDF embeds the prefetched logo as an image XObject', async (documentType, render) => {
    const descriptor = getFactory(documentType);
    descriptor.brand.logo_url = LOGO_URL;
    const noLogoDescriptor = getFactory(documentType);
    const fetchImpl = jest.fn().mockResolvedValue(response());

    const withLogo = await render(descriptor, { fetchImpl });
    const withoutLogo = await render(noLogoDescriptor, { fetchImpl });

    expect(imageXObjects(withLogo)).toBeGreaterThan(0);
    expect(imageXObjects(withoutLogo)).toBe(0);
    expect(withLogo.length).toBeGreaterThan(withoutLogo.length);
});

test('a failed logo fetch falls back to the brand-name document without breaking PDF generation', async () => {
    const descriptor = getFactory('estimate');
    descriptor.brand.logo_url = LOGO_URL;
    const fetchImpl = jest.fn().mockRejectedValue(new Error('storage unavailable'));

    const buffer = await renderEstimatePdf(ESTIMATE, descriptor, { fetchImpl });
    expect(buffer.subarray(0, 8).toString('utf8')).toMatch(/^%PDF-/);
    expect(buffer.subarray(-16).toString('utf8')).toContain('%%EOF');
    expect(imageXObjects(buffer)).toBe(0);
});
