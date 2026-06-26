/**
 * SLOT-ENGINE-001 Phase 2 — technician base locations.
 *
 * Covers:
 *  - Route auth: 403 without tenant.company.manage, 200 with it.
 *  - Company isolation: every query is scoped by company_id; B can't see/delete A's.
 *  - Geocode-on-upsert: address→success stored, failed→422, neither coords nor address→400.
 */

jest.mock('../backend/src/db/connection', () => ({ query: jest.fn() }));
jest.mock('../backend/src/services/zenbookerClient', () => ({ getTeamMembers: jest.fn() }));
jest.mock('../backend/src/services/googlePlacesService', () => ({ geocodeAddress: jest.fn() }));

const express = require('express');
const request = require('supertest');

const db = require('../backend/src/db/connection');
const zenbookerClient = require('../backend/src/services/zenbookerClient');
const googlePlacesService = require('../backend/src/services/googlePlacesService');
const queries = require('../backend/src/db/technicianBaseLocationQueries');
const svc = require('../backend/src/services/technicianBaseLocationsService');
const router = require('../backend/src/routes/technicianBaseLocations');

const COMPANY_A = '00000000-0000-0000-0000-00000000000a';
const COMPANY_B = '00000000-0000-0000-0000-00000000000b';

// Build an app whose auth context is fully controllable per-test.
function appWith({ permissions = [], companyId = COMPANY_A } = {}) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
        req.user = { sub: 'kc', email: 'u@x.com', crmUser: { id: 'user-1' } };
        req.authz = { permissions };
        req.companyFilter = { company_id: companyId };
        next();
    });
    app.use('/', router);
    return app;
}

beforeEach(() => {
    db.query.mockReset();
    zenbookerClient.getTeamMembers.mockReset();
    googlePlacesService.geocodeAddress.mockReset();
    // schema bootstrap + default empty result
    db.query.mockResolvedValue({ rows: [] });
    zenbookerClient.getTeamMembers.mockResolvedValue([]);
});

describe('route auth', () => {
    it('403 GET without tenant.company.manage', async () => {
        const res = await request(appWith({ permissions: [] })).get('/');
        expect(res.status).toBe(403);
    });

    it('200 GET with tenant.company.manage', async () => {
        const res = await request(appWith({ permissions: ['tenant.company.manage'] })).get('/');
        expect(res.status).toBe(200);
        expect(res.body.ok).toBe(true);
        expect(Array.isArray(res.body.data)).toBe(true);
    });

    it('403 PUT without permission', async () => {
        const res = await request(appWith({ permissions: [] }))
            .put('/tech_1').send({ lat: 1, lng: 2 });
        expect(res.status).toBe(403);
    });

    it('403 DELETE without permission', async () => {
        const res = await request(appWith({ permissions: [] })).delete('/tech_1');
        expect(res.status).toBe(403);
    });
});

describe('company isolation', () => {
    it('GET scopes the list query by the caller company', async () => {
        await request(appWith({ permissions: ['tenant.company.manage'], companyId: COMPANY_B })).get('/');
        const listCall = db.query.mock.calls.find(c => /FROM technician_base_locations/.test(String(c[0])) && /SELECT/.test(String(c[0])));
        expect(listCall).toBeTruthy();
        expect(listCall[1][0]).toBe(COMPANY_B);
    });

    it("B's DELETE only targets B's rows (404 when B has no such row)", async () => {
        // schema query returns [], DELETE returns no rows → 404.
        db.query.mockResolvedValue({ rows: [] });
        const res = await request(appWith({ permissions: ['tenant.company.manage'], companyId: COMPANY_B }))
            .delete('/tech_owned_by_A');
        expect(res.status).toBe(404);
        const delCall = db.query.mock.calls.find(c => /DELETE FROM technician_base_locations/.test(String(c[0])));
        expect(delCall[1]).toEqual([COMPANY_B, 'tech_owned_by_A']);
    });

    it('DELETE returns ok:true when a row is removed', async () => {
        db.query.mockImplementation(async (sql) => {
            if (/DELETE FROM technician_base_locations/.test(String(sql))) return { rows: [{ tech_id: 'tech_1' }] };
            return { rows: [] };
        });
        const res = await request(appWith({ permissions: ['tenant.company.manage'] })).delete('/tech_1');
        expect(res.status).toBe(200);
        expect(res.body).toEqual({ ok: true });
    });
});

describe('queries are company-scoped', () => {
    it('upsert binds company_id first', async () => {
        db.query.mockResolvedValue({ rows: [{ company_id: COMPANY_A, tech_id: 't', lat: 1, lng: 2 }] });
        await queries.upsert(COMPANY_A, 't', { lat: 1, lng: 2, label: 'Home', address: null });
        const call = db.query.mock.calls.find(c => /INSERT INTO technician_base_locations/.test(String(c[0])));
        expect(call[1][0]).toBe(COMPANY_A);
        expect(call[1][1]).toBe('t');
        expect(String(call[0])).toMatch(/ON CONFLICT \(company_id, tech_id\)/);
    });

    it('remove filters by company_id AND tech_id', async () => {
        db.query.mockResolvedValue({ rows: [{ tech_id: 't' }] });
        await queries.remove(COMPANY_A, 't');
        const call = db.query.mock.calls.find(c => /DELETE FROM technician_base_locations/.test(String(c[0])));
        expect(String(call[0])).toMatch(/WHERE company_id = \$1 AND tech_id = \$2/);
        expect(call[1]).toEqual([COMPANY_A, 't']);
    });
});

describe('geocode-on-upsert (service)', () => {
    it('stores lat/lng directly when both are provided (no geocode call)', async () => {
        db.query.mockResolvedValue({ rows: [{ tech_id: 't', lat: 42.1, lng: -71.2 }] });
        await svc.upsert(COMPANY_A, 't', { lat: 42.1, lng: -71.2, label: 'Home' });
        expect(googlePlacesService.geocodeAddress).not.toHaveBeenCalled();
        const ins = db.query.mock.calls.find(c => /INSERT INTO technician_base_locations/.test(String(c[0])));
        expect(ins[1].slice(0, 5)).toEqual([COMPANY_A, 't', 42.1, -71.2, 'Home']);
    });

    it('address → success: geocodes and stores normalized address', async () => {
        googlePlacesService.geocodeAddress.mockResolvedValue({
            status: 'success', lat: 42.36, lng: -71.06, normalized_address: '1 Main St, Boston, MA',
        });
        db.query.mockResolvedValue({ rows: [{ tech_id: 't', lat: 42.36, lng: -71.06 }] });
        await svc.upsert(COMPANY_A, 't', { address: '1 main st' });
        expect(googlePlacesService.geocodeAddress).toHaveBeenCalledWith('1 main st');
        const ins = db.query.mock.calls.find(c => /INSERT INTO technician_base_locations/.test(String(c[0])));
        expect(ins[1][2]).toBe(42.36);
        expect(ins[1][3]).toBe(-71.06);
        expect(ins[1][5]).toBe('1 Main St, Boston, MA');
    });

    it('address → failed: throws 422 GEOCODE_FAILED, no write', async () => {
        googlePlacesService.geocodeAddress.mockResolvedValue({ status: 'failed', error_message: 'No geocode result' });
        await expect(svc.upsert(COMPANY_A, 't', { address: 'nowhere' })).rejects.toMatchObject({
            httpStatus: 422, code: 'GEOCODE_FAILED',
        });
        const ins = db.query.mock.calls.find(c => /INSERT INTO technician_base_locations/.test(String(c[0])));
        expect(ins).toBeUndefined();
    });

    it('neither coords nor address: throws 400 COORDS_OR_ADDRESS_REQUIRED', async () => {
        await expect(svc.upsert(COMPANY_A, 't', { label: 'Home' })).rejects.toMatchObject({
            httpStatus: 400, code: 'COORDS_OR_ADDRESS_REQUIRED',
        });
        expect(googlePlacesService.geocodeAddress).not.toHaveBeenCalled();
    });
});

describe('PUT route surfaces service error codes', () => {
    it('422 when geocode fails', async () => {
        googlePlacesService.geocodeAddress.mockResolvedValue({ status: 'failed', error_message: 'No geocode result' });
        const res = await request(appWith({ permissions: ['tenant.company.manage'] }))
            .put('/tech_1').send({ address: 'nowhere' });
        expect(res.status).toBe(422);
        expect(res.body.error.code).toBe('GEOCODE_FAILED');
    });

    it('400 when neither coords nor address provided', async () => {
        const res = await request(appWith({ permissions: ['tenant.company.manage'] }))
            .put('/tech_1').send({ label: 'Home' });
        expect(res.status).toBe(400);
        expect(res.body.error.code).toBe('COORDS_OR_ADDRESS_REQUIRED');
    });
});
