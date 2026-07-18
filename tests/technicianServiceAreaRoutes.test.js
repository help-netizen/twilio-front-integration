jest.mock('../backend/src/services/technicianServiceAreaService', () => ({
    getAssignmentState: jest.fn(),
    publicState: jest.fn(value => value),
    replaceDistrictTechnicians: jest.fn(),
    replaceRadiusTechnicians: jest.fn(),
}));
jest.mock('../backend/src/db/connection', () => ({
    query: jest.fn(),
    pool: { connect: jest.fn() },
}));
jest.mock('../backend/src/services/auditService', () => ({ log: jest.fn().mockResolvedValue(undefined) }));

const fs = require('fs');
const path = require('path');
const express = require('express');
const request = require('supertest');
const service = require('../backend/src/services/technicianServiceAreaService');
const router = require('../backend/src/routes/service-territories');
const { requirePermission } = require('../backend/src/middleware/authorization');
const { requireCompanyAccess } = require('../backend/src/middleware/keycloakAuth');

const COMPANY_A = '00000000-0000-0000-0000-00000000000a';
const COMPANY_B = '00000000-0000-0000-0000-00000000000b';
const RADIUS = '11111111-1111-4111-8111-111111111111';
const BASE = '/api/settings/service-territories';

function appWith({ companyId = COMPANY_A, permissions = ['tenant.company.manage'] } = {}) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
        req.user = { sub: 'keycloak-sub', crmUser: { id: 'crm-user-17' } };
        req.authz = {
            scope: 'tenant',
            company: companyId ? { id: companyId, status: 'active' } : null,
            membership: companyId ? { role_key: 'tenant_admin' } : null,
            permissions,
        };
        req.companyId = COMPANY_B;
        next();
    });
    app.use(BASE, requirePermission('tenant.company.manage'), requireCompanyAccess, router);
    return app;
}

beforeEach(() => {
    jest.clearAllMocks();
    const state = {
        active_mode: 'list',
        technicians: [{ id: 'tech-1', name: 'Alex Rivera' }],
        districts: [{ id: 'North', name: 'North', technician_ids: [] }],
        radii: [{ id: RADIUS, technician_ids: [] }],
        technician_assignments: [],
        wildcard_technicians: [{ id: 'tech-1', name: 'Alex Rivera' }],
    };
    service.getAssignmentState.mockResolvedValue(state);
    service.replaceDistrictTechnicians.mockResolvedValue(state);
    service.replaceRadiusTechnicians.mockResolvedValue(state);
});

test('production mount keeps authentication, permission, and company access', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'server.js'), 'utf8');
    expect(source).toMatch(/app\.use\('\/api\/settings\/service-territories', authenticate, requirePermission\('tenant\.company\.manage'\), requireCompanyAccess, serviceTerritoryRouter\)/);
});

test('assignment aggregate uses only req.companyFilter company and preserves roster errors', async () => {
    const ok = await request(appWith()).get(`${BASE}/assignments`);
    expect(ok.status).toBe(200);
    expect(service.getAssignmentState).toHaveBeenCalledWith(COMPANY_A);
    expect(service.getAssignmentState).not.toHaveBeenCalledWith(COMPANY_B);

    service.getAssignmentState.mockRejectedValue(Object.assign(new Error('roster down'), {
        code: 'ZENBOOKER_UNAVAILABLE', httpStatus: 502,
    }));
    const failed = await request(appWith()).get(`${BASE}/assignments`);
    expect(failed.status).toBe(502);
    expect(failed.body.error.code).toBe('ZENBOOKER_UNAVAILABLE');
});

test('both reverse edit directions accept empty arrays and use crmUser.id', async () => {
    const app = appWith();
    const district = await request(app).put(`${BASE}/district-assignments`)
        .send({ district_name: 'North', technician_ids: [] });
    expect(district.status).toBe(200);
    expect(service.replaceDistrictTechnicians).toHaveBeenCalledWith(
        COMPANY_A, 'North', [], 'crm-user-17'
    );

    const radius = await request(app).put(`${BASE}/radii/${RADIUS}/technicians`)
        .send({ technician_ids: [] });
    expect(radius.status).toBe(200);
    expect(service.replaceRadiusTechnicians).toHaveBeenCalledWith(
        COMPANY_A, RADIUS, [], 'crm-user-17'
    );
    expect(service.replaceDistrictTechnicians.mock.calls[0]).not.toContain('keycloak-sub');
    expect(service.replaceRadiusTechnicians.mock.calls[0]).not.toContain('keycloak-sub');
});

test('new assignment routes reject missing company or permission before service calls', async () => {
    const noPermission = appWith({ permissions: [] });
    const noCompany = appWith({ companyId: null });
    for (const [method, endpoint, body] of [
        ['get', '/assignments', undefined],
        ['put', '/district-assignments', { district_name: 'North', technician_ids: [] }],
        ['put', `/radii/${RADIUS}/technicians`, { technician_ids: [] }],
    ]) {
        const permissionRequest = request(noPermission)[method](`${BASE}${endpoint}`);
        const permissionResponse = body ? await permissionRequest.send(body) : await permissionRequest;
        expect(permissionResponse.status).toBe(403);

        const companyRequest = request(noCompany)[method](`${BASE}${endpoint}`);
        const companyResponse = body ? await companyRequest.send(body) : await companyRequest;
        expect(companyResponse.status).toBe(403);
    }
    expect(service.getAssignmentState).not.toHaveBeenCalled();
    expect(service.replaceDistrictTechnicians).not.toHaveBeenCalled();
    expect(service.replaceRadiusTechnicians).not.toHaveBeenCalled();
});
