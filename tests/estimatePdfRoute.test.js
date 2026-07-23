'use strict';

/**
 * ESTINV-BACKEND OB-29 — authenticated estimate PDF route characterization.
 * Exercises the real route, service orchestration, factory fallback, and
 * @react-pdf renderer for a production-shaped estimate with nullable fields.
 */

const express = require('express');
const request = require('supertest');

const mockGetEstimateById = jest.fn();
const mockGetEstimateItems = jest.fn();
const mockGetDefaultTemplate = jest.fn();
const mockBuildBrand = jest.fn();

jest.mock('../backend/src/db/estimatesQueries', () => ({
    getEstimateById: (...args) => mockGetEstimateById(...args),
    getEstimateItems: (...args) => mockGetEstimateItems(...args),
}));

jest.mock('../backend/src/db/documentTemplatesQueries', () => ({
    getDefaultByType: (...args) => mockGetDefaultTemplate(...args),
}));

jest.mock('../backend/src/services/companyProfileService', () => ({
    buildBrand: (...args) => mockBuildBrand(...args),
}));

const router = require('../backend/src/routes/estimates');

const COMPANY_ID = '00000000-0000-0000-0000-000000000057';

function app() {
    const instance = express();
    instance.use((req, _res, next) => {
        req.companyFilter = { company_id: COMPANY_ID };
        req.authz = { permissions: ['estimates.view'] };
        next();
    });
    instance.use('/', router);
    return instance;
}

beforeEach(() => {
    jest.clearAllMocks();
    mockGetDefaultTemplate.mockResolvedValue(null);
    mockBuildBrand.mockResolvedValue({});
    mockGetEstimateById.mockResolvedValue({
        id: 57,
        company_id: COMPANY_ID,
        estimate_number: 'ESTIMATE L-57-1',
        status: 'draft',
        contact_name: 'Healthy Customer',
        contact_email: null,
        contact_phone: null,
        billing_address: null,
        service_address: null,
        job_number: null,
        summary: 'Production-shaped healthy estimate',
        subtotal: '195.00',
        discount_amount: '90.00',
        tax_amount: '0.30',
        total: '105.30',
        created_at: '2026-07-23T12:00:00.000Z',
        updated_at: '2026-07-23T12:00:00.000Z',
    });
    mockGetEstimateItems.mockResolvedValue([
        {
            id: 1,
            name: 'Taxable part',
            description: null,
            quantity: '1.00',
            unit_price: '95.00',
            amount: '95.00',
            taxable: true,
        },
        {
            id: 2,
            name: 'Non-taxable labor',
            description: 'Installation labor',
            quantity: '1.00',
            unit_price: '100.00',
            amount: '100.00',
            taxable: false,
        },
    ]);
});

test('GET /:id/pdf returns a valid inline PDF with no stored template and nullable profile fields', async () => {
    const response = await request(app()).get('/57/pdf');

    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toMatch(/application\/pdf/);
    expect(response.headers['content-disposition']).toBe('inline; filename="ESTIMATE_L-57-1.pdf"');
    expect(Number(response.headers['content-length'])).toBeGreaterThan(100);
    expect(Buffer.isBuffer(response.body)).toBe(true);
    expect(response.body.subarray(0, 8).toString('utf8')).toMatch(/^%PDF-/);
    expect(response.body.subarray(-16).toString('utf8')).toContain('%%EOF');

    expect(mockGetEstimateById).toHaveBeenCalledWith(COMPANY_ID, '57');
    expect(mockGetEstimateItems).toHaveBeenCalledWith('57');
    expect(mockGetDefaultTemplate).toHaveBeenCalledWith(COMPANY_ID, 'estimate');
    expect(mockBuildBrand).toHaveBeenCalledWith(COMPANY_ID);
});
