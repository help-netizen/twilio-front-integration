'use strict';

/**
 * SERVICE-TERR-002 T1.3 — config/mode/radii endpoints only.
 * Covers TC-TERR2-013…021 and the endpoint half of TC-TERR2-027.
 */

const ORIGINAL_ENV = {
    FEATURE_AUTH_ENABLED: process.env.FEATURE_AUTH_ENABLED,
    KEYCLOAK_REALM_URL: process.env.KEYCLOAK_REALM_URL,
};
process.env.FEATURE_AUTH_ENABLED = 'true';
process.env.KEYCLOAK_REALM_URL = 'http://localhost:8080/realms/crm-prod';

const mockDbQuery = jest.fn();
jest.mock('../backend/src/db/connection', () => ({
    query: mockDbQuery,
    pool: { connect: jest.fn() },
}));
jest.mock('../backend/src/services/userService', () => ({ findOrCreateUser: jest.fn() }));
jest.mock('../backend/src/services/auditService', () => ({
    log: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../backend/src/services/authorizationService', () => ({
    buildDevAuthzContext: jest.fn(() => ({
        scope: 'tenant', company: null, membership: null, permissions: [],
    })),
    resolveAuthzContext: jest.fn(),
}));
jest.mock('jwks-rsa', () => jest.fn().mockReturnValue({ getSigningKey: jest.fn() }));

const express = require('express');
const request = require('supertest');

const db = require('../backend/src/db/connection');
const auditService = require('../backend/src/services/auditService');
const radiusQueries = require('../backend/src/db/territoryRadiusQueries');
const territoryGeoService = require('../backend/src/services/territoryGeoService');
const router = require('../backend/src/routes/service-territories');
const { authenticate, requireCompanyAccess } = require('../backend/src/middleware/keycloakAuth');
const { requirePermission } = require('../backend/src/middleware/authorization');

const COMPANY_A = '11111111-1111-1111-1111-111111111111';
const COMPANY_B = '22222222-2222-2222-2222-222222222222';
const BASE_PATH = '/api/settings/service-territories';

const ENDPOINTS = [
    { method: 'get', path: '/config' },
    { method: 'put', path: '/mode', body: { active_mode: 'radius' } },
    { method: 'post', path: '/radii', body: { zip: '02135', radius_miles: 25 } },
    { method: 'delete', path: '/radii/radius-1' },
];

function restoreEnv(name, value) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
}

function realAuthApp() {
    const app = express();
    app.use(express.json());
    app.use(
        BASE_PATH,
        authenticate,
        requirePermission('tenant.company.manage'),
        requireCompanyAccess,
        router
    );
    return app;
}

function appWith({
    permissions = ['tenant.company.manage'],
    companyId = COMPANY_A,
    poisonedCompanyId = COMPANY_B,
} = {}) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
        req.user = {
            sub: 'kc-user', email: 'admin@example.com', crmUser: { id: 'crm-user-1' },
        };
        req.authz = {
            scope: 'tenant',
            platform_role: 'none',
            company: companyId ? { id: companyId, status: 'active' } : null,
            membership: companyId ? { role_key: 'tenant_admin' } : null,
            permissions,
        };
        req.companyId = poisonedCompanyId;
        next();
    });
    app.use(
        BASE_PATH,
        requirePermission('tenant.company.manage'),
        requireCompanyAccess,
        router
    );
    return app;
}

function invoke(app, { method, path, body }) {
    const pending = request(app)[method](`${BASE_PATH}${path}`);
    return body === undefined ? pending : pending.send(body);
}

function isSql(sql, fragment) {
    return String(sql).includes(fragment);
}

function mockConfigQueries({
    activeMode = 'list',
    radii = [],
    listZipCount = 0,
    companyZip = null,
    listZipGeographies = [],
} = {}) {
    db.query.mockImplementation(async (sql) => {
        if (isSql(sql, 'FROM company_territory_settings')) {
            return { rows: [{ active_mode: activeMode }] };
        }
        if (isSql(sql, 'FROM territory_radii r')) return { rows: radii };
        if (isSql(sql, 'COUNT(*)::int AS count')) {
            return { rows: [{ count: listZipCount }] };
        }
        if (isSql(sql, 'FROM companies')) {
            return { rows: companyZip == null ? [] : [{ zip: companyZip }] };
        }
        if (isSql(sql, 'FROM service_territories st')) {
            return { rows: listZipGeographies };
        }
        throw new Error(`Unexpected SQL: ${sql}`);
    });
}

async function flushLazySeed() {
    await new Promise(resolve => setImmediate(resolve));
    await new Promise(resolve => setImmediate(resolve));
}

beforeEach(() => {
    jest.restoreAllMocks();
    db.query.mockReset();
    auditService.log.mockClear();
    jest.spyOn(console, 'warn').mockImplementation(() => {});
});

afterAll(() => {
    jest.restoreAllMocks();
    restoreEnv('FEATURE_AUTH_ENABLED', ORIGINAL_ENV.FEATURE_AUTH_ENABLED);
    restoreEnv('KEYCLOAK_REALM_URL', ORIGINAL_ENV.KEYCLOAK_REALM_URL);
});

describe('GET /config', () => {
    test('TC-TERR2-013: returns the exact full config shape with tenant-scoped reads', async () => {
        const radii = [
            {
                id: 'radius-1', zip: '02135', radius_miles: '25.0',
                lat: '42.346700', lon: '-71.162700', position: 0,
                city: 'Brighton', state: 'MA',
            },
            {
                id: 'radius-2', zip: '02461', radius_miles: '10.0',
                lat: '42.316800', lon: '-71.209500', position: 1,
                city: 'Newton', state: 'MA',
            },
        ];
        mockConfigQueries({
            activeMode: 'radius',
            radii,
            listZipCount: 3,
            companyZip: '02135',
            listZipGeographies: [
                { zip: '02135', lat: '42.346700', lon: '-71.162700' },
                { zip: '02461', lat: '42.316800', lon: '-71.209500' },
            ],
        });

        const res = await request(appWith()).get(`${BASE_PATH}/config`);

        expect(res.status).toBe(200);
        expect(res.body).toEqual({
            config: {
                active_mode: 'radius',
                radii,
                counts: { list_zips: 3, radii: 2 },
                company_zip: '02135',
                list_centroids: [
                    { zip: '02135', lat: '42.346700', lon: '-71.162700' },
                    { zip: '02461', lat: '42.316800', lon: '-71.209500' },
                ],
            },
        });
        expect(db.query).toHaveBeenCalledTimes(5);
        for (const [, params] of db.query.mock.calls) {
            expect(params).toContain(COMPANY_A);
        }
    });

    test('TC-TERR2-014: lazy seed deduplicates missing ZIPs, caps at 10, and safe-fails', async () => {
        const listZipGeographies = Array.from({ length: 15 }, (_, index) => ({
            zip: String(10000 + index), lat: null, lon: null,
        }));
        listZipGeographies.push({ zip: '10000', lat: null, lon: null });
        mockConfigQueries({ listZipCount: 15, listZipGeographies });
        const geocode = jest.spyOn(territoryGeoService, 'geocodeZip')
            .mockImplementation(async zip => {
                if (zip === '10004') throw new Error('transient geocoder failure');
                return null;
            });

        const res = await request(appWith()).get(`${BASE_PATH}/config`);
        expect(res.status).toBe(200);
        expect(res.body.config.list_centroids).toEqual([]);

        await flushLazySeed();
        expect(geocode).toHaveBeenCalledTimes(10);
        expect(new Set(geocode.mock.calls.map(([zip]) => zip)).size).toBe(10);
        expect(geocode.mock.calls.map(([zip]) => zip)).toEqual(
            Array.from({ length: 10 }, (_, index) => String(10000 + index))
        );
    });
});

describe('PUT /mode', () => {
    test('TC-TERR2-015: validates active_mode and upserts without deleting either dataset', async () => {
        db.query.mockImplementation(async (sql, params) => {
            if (isSql(sql, 'INSERT INTO company_territory_settings')) {
                return { rows: [{ active_mode: params[1] }] };
            }
            throw new Error(`Unexpected SQL: ${sql}`);
        });
        const app = appWith();

        const valid = await request(app).put(`${BASE_PATH}/mode`)
            .send({ active_mode: 'radius' });
        expect(valid.status).toBe(200);
        expect(valid.body).toEqual({ config: { active_mode: 'radius' } });
        expect(db.query.mock.calls[0][1]).toEqual([COMPANY_A, 'radius']);

        const callsAfterValid = db.query.mock.calls.length;
        const invalid = await request(app).put(`${BASE_PATH}/mode`)
            .send({ active_mode: 'both' });
        expect(invalid.status).toBe(400);
        expect(invalid.body).toEqual({ error: 'active_mode must be list or radius' });

        const missing = await request(app).put(`${BASE_PATH}/mode`).send({});
        expect(missing.status).toBe(400);
        expect(db.query).toHaveBeenCalledTimes(callsAfterValid);
        expect(db.query.mock.calls.some(([sql]) => /\bDELETE\b/.test(String(sql)))).toBe(false);
    });

    test('TC-SA-MODE-01 — list→radius→list preserves both assignment maps', async () => {
        let activeMode = 'list';
        const districtAssignments = [{ technician_id: 'tech-1', district_name: 'North' }];
        const radiusAssignments = [{
            technician_id: 'tech-1',
            radius_id: '11111111-1111-4111-8111-111111111111',
        }];
        const before = JSON.stringify({ districtAssignments, radiusAssignments });
        db.query.mockImplementation(async (sql, params) => {
            if (isSql(sql, 'INSERT INTO company_territory_settings')) {
                activeMode = params[1];
                return { rows: [{ active_mode: activeMode }] };
            }
            if (/DELETE FROM technician_district_assignments/.test(String(sql))) {
                districtAssignments.length = 0;
                return { rows: [] };
            }
            if (/DELETE FROM technician_radius_assignments/.test(String(sql))) {
                radiusAssignments.length = 0;
                return { rows: [] };
            }
            throw new Error(`Unexpected SQL: ${sql}`);
        });
        const app = appWith();

        expect((await request(app).put(`${BASE_PATH}/mode`).send({ active_mode: 'radius' })).status).toBe(200);
        expect((await request(app).put(`${BASE_PATH}/mode`).send({ active_mode: 'list' })).status).toBe(200);

        expect(activeMode).toBe('list');
        expect(JSON.stringify({ districtAssignments, radiusAssignments })).toBe(before);
        expect(db.query).toHaveBeenCalledTimes(2);
    });
});

describe('POST /radii', () => {
    test('TC-TERR2-016: geocodes and creates the first pair at position zero', async () => {
        jest.spyOn(territoryGeoService, 'geocodeZip').mockResolvedValue({
            zip: '02135', lat: 42.3467, lon: -71.1627, city: 'Brighton', state: 'MA',
        });
        db.query.mockImplementation(async (sql, params) => {
            if (isSql(sql, 'FROM territory_radii r')) return { rows: [] };
            if (isSql(sql, 'INSERT INTO territory_radii')) {
                return {
                    rows: [{
                        id: 'radius-1', zip: params[1], radius_miles: params[4],
                        lat: params[2], lon: params[3], position: params[5],
                    }],
                };
            }
            throw new Error(`Unexpected SQL: ${sql}`);
        });

        const res = await request(appWith()).post(`${BASE_PATH}/radii`)
            .send({ zip: '02135', radius_miles: 25 });

        expect(res.status).toBe(201);
        expect(res.body).toEqual({
            radius: {
                id: 'radius-1', zip: '02135', radius_miles: 25,
                lat: 42.3467, lon: -71.1627, position: 0,
                city: 'Brighton', state: 'MA',
            },
        });
        const insert = db.query.mock.calls.find(([sql]) => isSql(sql, 'INSERT INTO territory_radii'));
        expect(insert[1]).toEqual([COMPANY_A, '02135', 42.3467, -71.1627, 25, 0]);
    });

    test('TC-TERR2-017: returns 422 ZIP_NOT_FOUND without inserting', async () => {
        jest.spyOn(territoryGeoService, 'geocodeZip').mockResolvedValue(null);

        const res = await request(appWith()).post(`${BASE_PATH}/radii`)
            .send({ zip: '00000', radius_miles: 25 });

        expect(res.status).toBe(422);
        expect(res.body).toEqual({ error: 'ZIP_NOT_FOUND' });
        expect(db.query).not.toHaveBeenCalled();
    });

    test('TC-TERR2-018: rejects invalid ZIP/radius values and accepts 1721 at radius 200', async () => {
        const geocode = jest.spyOn(territoryGeoService, 'geocodeZip').mockResolvedValue({
            zip: '01721', lat: 42.259, lon: -71.458, city: 'Ashland', state: 'MA',
        });
        db.query.mockImplementation(async (sql, params) => {
            if (isSql(sql, 'FROM territory_radii r')) return { rows: [] };
            if (isSql(sql, 'INSERT INTO territory_radii')) {
                return {
                    rows: [{
                        id: 'radius-max', zip: params[1], radius_miles: params[4],
                        lat: params[2], lon: params[3], position: params[5],
                    }],
                };
            }
            throw new Error(`Unexpected SQL: ${sql}`);
        });
        const app = appWith();
        const invalidBodies = [
            { zip: '123', radius_miles: 25 },
            { zip: 'abc', radius_miles: 25 },
            { zip: '02135', radius_miles: 0 },
            { zip: '02135', radius_miles: 200.1 },
            { zip: '02135', radius_miles: 'abc' },
        ];

        for (const body of invalidBodies) {
            const invalid = await request(app).post(`${BASE_PATH}/radii`).send(body);
            expect(invalid.status).toBe(400);
        }
        expect(geocode).not.toHaveBeenCalled();
        expect(db.query).not.toHaveBeenCalled();

        const valid = await request(app).post(`${BASE_PATH}/radii`)
            .send({ zip: '1721', radius_miles: 200 });
        expect(valid.status).toBe(201);
        expect(valid.body.radius).toEqual(expect.objectContaining({
            zip: '01721', radius_miles: 200, position: 0,
        }));
        expect(geocode).toHaveBeenCalledWith('01721');
    });

    test('TC-TERR2-027: a second pair with the same ZIP is accepted', async () => {
        jest.spyOn(territoryGeoService, 'geocodeZip').mockResolvedValue({
            zip: '02135', lat: 42.3467, lon: -71.1627, city: 'Brighton', state: 'MA',
        });
        db.query.mockImplementation(async (sql, params) => {
            if (isSql(sql, 'FROM territory_radii r')) {
                return { rows: [{ id: 'radius-1', zip: '02135', position: 0 }] };
            }
            if (isSql(sql, 'INSERT INTO territory_radii')) {
                return {
                    rows: [{
                        id: 'radius-2', zip: params[1], radius_miles: params[4],
                        lat: params[2], lon: params[3], position: params[5],
                    }],
                };
            }
            throw new Error(`Unexpected SQL: ${sql}`);
        });

        const res = await request(appWith()).post(`${BASE_PATH}/radii`)
            .send({ zip: '02135', radius_miles: 40 });

        expect(res.status).toBe(201);
        expect(res.body.radius).toEqual(expect.objectContaining({
            id: 'radius-2', zip: '02135', radius_miles: 40, position: 1,
        }));
    });
});

describe('DELETE /radii/:id', () => {
    test('TC-TERR2-019: own id returns 200; foreign or missing id returns the same 404', async () => {
        db.query.mockImplementation(async (sql, params) => {
            if (!isSql(sql, 'DELETE FROM territory_radii')) {
                throw new Error(`Unexpected SQL: ${sql}`);
            }
            return { rows: params[0] === 'owned-radius' ? [{ id: params[0] }] : [] };
        });
        const app = appWith();

        const owned = await request(app).delete(`${BASE_PATH}/radii/owned-radius`);
        expect(owned.status).toBe(200);
        expect(owned.body).toEqual({ success: true });

        const foreign = await request(app).delete(`${BASE_PATH}/radii/company-b-radius`);
        expect(foreign.status).toBe(404);
        expect(foreign.body).toEqual({ error: 'Radius not found' });

        const missing = await request(app).delete(`${BASE_PATH}/radii/missing-radius`);
        expect(missing.status).toBe(404);
        for (const [sql, params] of db.query.mock.calls) {
            expect(String(sql)).toContain('WHERE id = $1 AND company_id = $2');
            expect(params[1]).toBe(COMPANY_A);
        }
    });
});

describe('mount middleware and tenant isolation', () => {
    test('TC-TERR2-020: all four endpoints return 401 unauthenticated and 403 without permission/company', async () => {
        const noAuthApp = realAuthApp();
        const noPermissionApp = appWith({ permissions: [] });
        const noCompanyApp = appWith({ companyId: null });

        for (const endpoint of ENDPOINTS) {
            const noAuth = await invoke(noAuthApp, endpoint);
            expect(noAuth.status).toBe(401);
            expect(noAuth.body).toEqual(expect.objectContaining({ code: 'AUTH_REQUIRED' }));

            const noPermission = await invoke(noPermissionApp, endpoint);
            expect(noPermission.status).toBe(403);
            expect(noPermission.body).toEqual(expect.objectContaining({ code: 'ACCESS_DENIED' }));

            const noCompany = await invoke(noCompanyApp, endpoint);
            expect(noCompany.status).toBe(403);
            expect(noCompany.body).toEqual(expect.objectContaining({
                code: 'TENANT_CONTEXT_REQUIRED',
            }));
        }
        expect(db.query).not.toHaveBeenCalled();
    });

    test('TC-TERR2-021: all four endpoints use company B and ignore poisoned company ids', async () => {
        const geocode = jest.spyOn(territoryGeoService, 'geocodeZip').mockResolvedValue({
            zip: '02135', lat: 42.3467, lon: -71.1627, city: 'Brighton', state: 'MA',
        });
        db.query.mockImplementation(async (sql, params) => {
            if (isSql(sql, 'FROM company_territory_settings')) {
                return { rows: [{ active_mode: 'list' }] };
            }
            if (isSql(sql, 'FROM territory_radii r')) return { rows: [] };
            if (isSql(sql, 'COUNT(*)::int AS count')) return { rows: [{ count: 0 }] };
            if (isSql(sql, 'FROM companies')) return { rows: [{ zip: '90210' }] };
            if (isSql(sql, 'FROM service_territories st')) return { rows: [] };
            if (isSql(sql, 'INSERT INTO company_territory_settings')) {
                return { rows: [{ active_mode: params[1] }] };
            }
            if (isSql(sql, 'INSERT INTO territory_radii')) {
                return {
                    rows: [{
                        id: 'b-radius', zip: params[1], radius_miles: params[4],
                        lat: params[2], lon: params[3], position: params[5],
                    }],
                };
            }
            if (isSql(sql, 'DELETE FROM territory_radii')) {
                return { rows: [{ id: params[0] }] };
            }
            throw new Error(`Unexpected SQL: ${sql}`);
        });
        const app = appWith({ companyId: COMPANY_B, poisonedCompanyId: COMPANY_A });

        const config = await request(app).get(`${BASE_PATH}/config`);
        const mode = await request(app).put(`${BASE_PATH}/mode`)
            .send({ active_mode: 'radius', company_id: COMPANY_A });
        const create = await request(app).post(`${BASE_PATH}/radii`)
            .send({ zip: '02135', radius_miles: 25, company_id: COMPANY_A });
        const remove = await request(app).delete(`${BASE_PATH}/radii/b-radius`);

        expect(config.status).toBe(200);
        expect(config.body.config.radii).toEqual([]);
        expect(mode.status).toBe(200);
        expect(create.status).toBe(201);
        expect(remove.status).toBe(200);
        expect(geocode).toHaveBeenCalledWith('02135');
        for (const [, params] of db.query.mock.calls) {
            expect(params).toContain(COMPANY_B);
            expect(params).not.toContain(COMPANY_A);
        }
    });
});
