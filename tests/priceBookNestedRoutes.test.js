'use strict';

const express = require('express');
const request = require('supertest');

jest.mock('../backend/src/services/priceBookService', () => {
    class MockPriceBookError extends Error {
        constructor(code, httpStatus, message, details = null) { super(message); this.code = code; this.httpStatus = httpStatus; this.details = details; }
    }
    return {
        PriceBookError: MockPriceBookError,
        listCategories: jest.fn(), listCategoryTree: jest.fn(), createCategory: jest.fn(), updateCategory: jest.fn(), archiveCategory: jest.fn(),
        listGroups: jest.fn(), getGroup: jest.fn(), getGroupExpansion: jest.fn(), createGroup: jest.fn(), updateGroup: jest.fn(), archiveGroup: jest.fn(),
        templateCsv: jest.fn(), exportCsv: jest.fn(), importCsv: jest.fn(),
    };
});
jest.mock('../backend/src/services/estimateItemPresetsService', () => ({
    EstimateItemPresetError: class MockEstimateItemPresetError extends Error {},
    listForManage: jest.fn(), create: jest.fn(), bulkSaveItems: jest.fn(), update: jest.fn(), archive: jest.fn(),
}));
jest.mock('../backend/src/services/auditService', () => ({ log: jest.fn(async () => {}) }));

const router = require('../backend/src/routes/price-book');
const priceBook = require('../backend/src/services/priceBookService');
const presets = require('../backend/src/services/estimateItemPresetsService');
const { PriceBookError } = priceBook;

function app({ companyId = 'company-a', permissions = [] } = {}) {
    const server = express();
    server.use(express.json());
    server.use((req, _res, next) => {
        req.companyFilter = { company_id: companyId };
        req.user = { crmUser: { id: 'crm-user-a' } };
        req.authz = { permissions, company: { id: companyId }, membership: { role_key: permissions.includes('price_book.manage') ? 'manager' : 'provider' } };
        next();
    });
    server.use('/api/price-book', router);
    return server;
}

beforeEach(() => {
    for (const value of [...Object.values(priceBook), ...Object.values(presets)]) if (typeof value?.mockReset === 'function') value.mockReset();
});

describe('PRICEBOOK-NESTED-001 routes', () => {
    test('T-own tree uses req.companyFilter company and preserves response shape', async () => {
        priceBook.listCategoryTree.mockResolvedValue([{ id: 1, children: [] }]);
        const response = await request(app({ permissions: ['price_book.view'] })).get('/api/price-book/categories/tree');
        expect(response.status).toBe(200);
        expect(response.body).toEqual({ categories: [{ id: 1, children: [] }] });
        expect(priceBook.listCategoryTree).toHaveBeenCalledWith('company-a');
    });

    test('SAB-PB-FLAT-LEGACY: old flat endpoint remains an array and includes uncategorized-era category DTOs unchanged', async () => {
        priceBook.listCategories.mockResolvedValue([{ id: 1, parent_id: null, name: 'Legacy root' }]);
        const response = await request(app({ permissions: ['price_book.view'] })).get('/api/price-book/categories');
        expect(response.status).toBe(200);
        expect(response.body).toEqual({ categories: [{ id: 1, parent_id: null, name: 'Legacy root' }] });
    });

    test.each([
        ['get', '/api/price-book/categories/tree'],
        ['get', '/api/price-book/categories'],
        ['get', '/api/price-book/items?uncategorized=true'],
    ])('R-matrix missing view permission denies %s %s before service', async (method, path) => {
        const response = await request(app({ permissions: [] }))[method](path);
        expect(response.status).toBe(403);
        expect(priceBook.listCategoryTree).not.toHaveBeenCalled();
        expect(priceBook.listCategories).not.toHaveBeenCalled();
        expect(presets.listForManage).not.toHaveBeenCalled();
    });

    test.each([
        ['post', '/api/price-book/categories'],
        ['patch', '/api/price-book/categories/7'],
        ['delete', '/api/price-book/categories/7'],
    ])('R-matrix provider cannot mutate: %s %s', async (method, path) => {
        const response = await request(app({ permissions: ['price_book.view'] }))[method](path).send({ name: 'Nope' });
        expect(response.status).toBe(403);
    });

    test('manager create uses company filter and crm_users actor', async () => {
        priceBook.createCategory.mockResolvedValue({ id: 8, name: 'Child' });
        const response = await request(app({ permissions: ['price_book.manage'] }))
            .post('/api/price-book/categories').send({ name: 'Child', parent_id: 7 });
        expect(response.status).toBe(201);
        expect(priceBook.createCategory).toHaveBeenCalledWith('company-a', { name: 'Child', parent_id: 7 }, { createdBy: 'crm-user-a' });
    });

    test('T-foreign parent service error is 404 and exposes no foreign row', async () => {
        priceBook.createCategory.mockRejectedValue(new PriceBookError('category_not_found', 404, 'Category 99 not found'));
        const response = await request(app({ permissions: ['price_book.manage'] }))
            .post('/api/price-book/categories').send({ name: 'Child', parent_id: 99 });
        expect(response.status).toBe(404);
        expect(response.body).toEqual({ error: 'category_not_found', message: 'Category 99 not found' });
    });

    test('uncategorized item filter keeps legacy presets reachable', async () => {
        presets.listForManage.mockResolvedValue(Array.from({ length: 6 }, (_, index) => ({ id: index + 1, category_id: null })));
        const response = await request(app({ permissions: ['price_book.view'] })).get('/api/price-book/items?uncategorized=true&limit=1000');
        expect(response.status).toBe(200);
        expect(response.body.items).toHaveLength(6);
        expect(presets.listForManage).toHaveBeenCalledWith('company-a', expect.objectContaining({ uncategorized: true, limit: 1000 }));
    });
});
