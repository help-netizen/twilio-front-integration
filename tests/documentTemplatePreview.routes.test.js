'use strict';

const express = require('express');
const request = require('supertest');

const COMPANY_A = '00000000-0000-0000-0000-00000000000a';
const COMPANY_B = '00000000-0000-0000-0000-00000000000b';
const mockGetTemplate = jest.fn();
const mockResolvePreviewDescriptor = jest.fn();

jest.mock('../backend/src/services/documentTemplatesService', () => {
    class DocumentTemplateServiceError extends Error {
        constructor(code, httpStatus, message) {
            super(message);
            this.code = code;
            this.httpStatus = httpStatus;
        }
    }
    return {
        DocumentTemplateServiceError,
        getTemplate: (...args) => mockGetTemplate(...args),
        resolvePreviewDescriptor: (...args) => mockResolvePreviewDescriptor(...args),
    };
});

const router = require('../backend/src/routes/document-templates');
const { DocumentTemplateServiceError } = require('../backend/src/services/documentTemplatesService');

function app(companyId) {
    const instance = express();
    instance.use(express.json());
    instance.use((req, _res, next) => {
        req.companyFilter = companyId ? { company_id: companyId } : null;
        next();
    });
    instance.use('/', router);
    return instance;
}

beforeEach(() => {
    jest.clearAllMocks();
    mockGetTemplate.mockResolvedValue({
        id: 41,
        company_id: COMPANY_A,
        document_type: 'estimate',
        content: { schema_version: 1, brand: { logo_url: '' } },
    });
    mockResolvePreviewDescriptor.mockResolvedValue({
        schema_version: 1,
        brand: { logo_url: 'https://bucket.fly.storage.tigris.dev/logo.png' },
    });
});

test('POST /:id/preview resolves the tenant-scoped template brand', async () => {
    const response = await request(app(COMPANY_A)).post('/41/preview');

    expect(response.status).toBe(200);
    expect(response.body.descriptor.brand.logo_url).toContain('logo.png');
    expect(mockGetTemplate).toHaveBeenCalledWith(COMPANY_A, 41);
    expect(mockResolvePreviewDescriptor).toHaveBeenCalledWith(
        COMPANY_A,
        'estimate',
        expect.objectContaining({ brand: { logo_url: '' } })
    );
});

test('POST /:id/preview returns 404 for a foreign template and performs no brand resolution', async () => {
    mockGetTemplate.mockRejectedValueOnce(
        new DocumentTemplateServiceError('template_not_found', 404, 'Template 41 not found')
    );

    const response = await request(app(COMPANY_B)).post('/41/preview');

    expect(response.status).toBe(404);
    expect(mockGetTemplate).toHaveBeenCalledWith(COMPANY_B, 41);
    expect(mockResolvePreviewDescriptor).not.toHaveBeenCalled();
});

test('POST /:id/preview rejects missing company context before any lookup', async () => {
    const response = await request(app(null)).post('/41/preview');

    expect(response.status).toBe(403);
    expect(mockGetTemplate).not.toHaveBeenCalled();
    expect(mockResolvePreviewDescriptor).not.toHaveBeenCalled();
});
