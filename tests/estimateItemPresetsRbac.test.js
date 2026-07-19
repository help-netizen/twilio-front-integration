const express = require('express');
const request = require('supertest');

const mockQuery = jest.fn();
jest.mock('../backend/src/db/connection', () => ({ query: mockQuery }));
jest.mock('../backend/src/services/auditService', () => ({ log: jest.fn(async () => {}) }));

const router = require('../backend/src/routes/estimate-item-presets');

const COMPANY_A = 'company-a';
const COMPANY_B = 'company-b';

function preset(id, companyId = COMPANY_A, overrides = {}) {
    return {
        id,
        company_id: companyId,
        name: `Item ${id}`,
        description: null,
        default_quantity: 1,
        default_unit_price: 25,
        default_taxable: false,
        category_id: null,
        code: null,
        unit: null,
        usage_count: 0,
        last_used_at: null,
        archived_at: null,
        created_at: new Date('2026-01-01T00:00:00Z'),
        updated_at: new Date('2026-01-01T00:00:00Z'),
        ...overrides,
    };
}

function makeApp({ permissions, roleKey = 'provider', companyId = COMPANY_A } = {}) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
        req.companyFilter = { company_id: companyId };
        req.user = { crmUser: { id: 'crm-user-a' } };
        req.authz = {
            permissions: permissions || [],
            company: { id: companyId },
            membership: { role_key: roleKey },
        };
        next();
    });
    app.use('/api/estimate-item-presets', router);
    return app;
}

beforeEach(() => {
    jest.clearAllMocks();
});

describe('/api/estimate-item-presets Wave 2 RBAC', () => {
    test.each([
        ['get', '/api/estimate-item-presets'],
        ['post', '/api/estimate-item-presets/7/used'],
    ])('effective-permission deny blocks %s %s', async (method, path) => {
        const res = await request(makeApp({ permissions: [] }))[method](path);

        expect(res.status).toBe(403);
        expect(mockQuery).not.toHaveBeenCalled();
    });

    test('provider can search and use presets with price_book.view', async () => {
        mockQuery
            .mockResolvedValueOnce({ rows: [preset(7)] })
            .mockResolvedValueOnce({ rows: [preset(7, COMPANY_A, { usage_count: 1 })] });
        const app = makeApp({ permissions: ['price_book.view'], roleKey: 'provider' });

        const search = await request(app).get('/api/estimate-item-presets');
        const used = await request(app).post('/api/estimate-item-presets/7/used');

        expect(search.status).toBe(200);
        expect(used.status).toBe(200);
        expect(mockQuery.mock.calls[0][1][0]).toBe(COMPANY_A);
        expect(mockQuery.mock.calls[1][1]).toEqual([7, COMPANY_A]);
    });

    test.each([
        ['provider', 'post', '/api/estimate-item-presets'],
        ['provider', 'patch', '/api/estimate-item-presets/7'],
        ['provider', 'delete', '/api/estimate-item-presets/7'],
        ['dispatcher', 'post', '/api/estimate-item-presets'],
        ['dispatcher', 'patch', '/api/estimate-item-presets/7'],
        ['dispatcher', 'delete', '/api/estimate-item-presets/7'],
    ])('R-matrix: %s is denied price-book mutation %s %s', async (roleKey, method, path) => {
        const res = await request(makeApp({
            permissions: ['price_book.view'],
            roleKey,
        }))[method](path).send({ name: 'Changed' });

        expect(res.status).toBe(403);
        expect(mockQuery).not.toHaveBeenCalled();
    });

    test('manager can create, update, and archive with price_book.manage', async () => {
        mockQuery
            .mockResolvedValueOnce({ rows: [] })
            .mockResolvedValueOnce({ rows: [preset(8)] })
            .mockResolvedValueOnce({ rows: [preset(8)] })
            .mockResolvedValueOnce({ rows: [preset(8, COMPANY_A, { name: 'Changed' })] })
            .mockResolvedValueOnce({ rows: [preset(8, COMPANY_A, { archived_at: new Date() })] });
        const app = makeApp({ permissions: ['price_book.manage'], roleKey: 'manager' });

        const created = await request(app).post('/api/estimate-item-presets').send({ name: 'Item 8' });
        const updated = await request(app).patch('/api/estimate-item-presets/8').send({ name: 'Changed' });
        const archived = await request(app).delete('/api/estimate-item-presets/8');

        expect([created.status, updated.status, archived.status]).toEqual([201, 200, 200]);
        const insertCall = mockQuery.mock.calls.find(([sql]) => sql.includes('INSERT INTO estimate_item_presets'));
        expect(insertCall[1][9]).toBe('crm-user-a');
    });

    test.each([
        ['patch', '/api/estimate-item-presets/99'],
        ['delete', '/api/estimate-item-presets/99'],
        ['post', '/api/estimate-item-presets/99/used'],
    ])('T-foreign: %s %s returns 404 and leaves the foreign row unchanged', async (method, path) => {
        const foreignBefore = preset(99, COMPANY_B);
        const foreignAfter = { ...foreignBefore };
        mockQuery.mockResolvedValue({ rows: [] });
        const permission = method === 'post' ? 'price_book.view' : 'price_book.manage';

        const res = await request(makeApp({ permissions: [permission] }))[method](path)
            .send({ name: 'Cross-tenant change' });

        expect(res.status).toBe(404);
        expect(foreignAfter).toStrictEqual(foreignBefore);
        expect(mockQuery.mock.calls.some(([, params]) => (
            Array.isArray(params) && params.includes(99) && params.includes(COMPANY_A)
        ))).toBe(true);
        expect(mockQuery.mock.calls.some(([, params]) => (
            Array.isArray(params) && params.includes(COMPANY_B)
        ))).toBe(false);
    });
});
