/**
 * OUTBOUND-LEAD-CALL-001 (OLC-T7) — TC-OLC-048..054: /api/outbound-lead-caller
 * settings routes. Style precedent: timeOffRoutes.test.js — supertest mini-app
 * with fake-auth middleware injecting req.companyFilter; REAL router + REAL
 * settings service over a mocked db.query. Auth/permission fail-closed asserted
 * by mounting the mini-app WITHOUT the auth stub (401-shape parity is owned by
 * the shared middlewares — here we assert the router never runs без companyFilter).
 */

'use strict';

jest.mock('../backend/src/db/connection', () => ({ query: jest.fn() }));

const express = require('express');
const request = require('supertest');
const db = require('../backend/src/db/connection');
const router = require('../backend/src/routes/outboundLeadCall');

const COMPANY = '00000000-0000-0000-0000-00000000000a';
const OTHER_COMPANY = '00000000-0000-0000-0000-00000000000b';

function appWithAuth(companyId) {
    const app = express();
    app.use(express.json());
    if (companyId !== null) {
        app.use((req, _res, next) => { req.companyFilter = { company_id: companyId }; next(); });
    }
    app.use('/api/outbound-lead-caller', router);
    return app;
}

beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, 'error').mockImplementation(() => {});
    db.query.mockImplementation(async (sql) => {
        if (/FROM outbound_lead_call_settings/.test(sql)) return { rows: [] }; // defaults
        if (/FROM marketplace_installations/.test(sql)) return { rows: [{ status: 'connected' }] };
        if (/SELECT DISTINCT job_source/.test(sql)) return { rows: [{ job_source: 'Pro Referral' }, { job_source: 'Google' }] };
        if (/GROUP BY status/.test(sql)) return { rows: [{ status: 'booked', count: 4 }] };
        if (/INSERT INTO outbound_lead_call_settings/.test(sql)) {
            return { rows: [{ enabled_sources: JSON.parse(arguments[1] ? '[]' : '[]'), max_attempts: 3, backoff_schedule: ['immediate', '+30m', '+2h'] }] };
        }
        return { rows: [], rowCount: 1 };
    });
});
afterEach(() => jest.restoreAllMocks());

describe('TC-OLC-048/049: GET /settings', () => {
    it('returns settings + install state + observed sources + 30d rollup, all company-scoped', async () => {
        const res = await request(appWithAuth(COMPANY)).get('/api/outbound-lead-caller/settings');
        expect(res.status).toBe(200);
        expect(res.body.ok).toBe(true);
        expect(res.body.data.settings.enabled_sources).toEqual(['ProReferral']); // defaults on first connect
        expect(res.body.data.installed).toBe(true);
        expect(res.body.data.install_status).toBe('connected');
        expect(res.body.data.company_sources).toEqual(['Pro Referral', 'Google']);
        expect(res.body.data.recent).toEqual([{ status: 'booked', count: 4 }]);
        // every SQL leg got the tenant param
        for (const [, params] of db.query.mock.calls) {
            expect(params[0]).toBe(COMPANY);
        }
    });

    it('DB failure → 500 INTERNAL shape', async () => {
        db.query.mockRejectedValue(new Error('down'));
        const res = await request(appWithAuth(COMPANY)).get('/api/outbound-lead-caller/settings');
        expect(res.status).toBe(500);
        expect(res.body).toEqual({ ok: false, error: { code: 'INTERNAL', message: 'Failed to load settings' } });
    });
});

describe('TC-OLC-050/051: PUT /settings validation + dedup', () => {
    async function put(body, company = COMPANY) {
        return request(appWithAuth(company)).put('/api/outbound-lead-caller/settings').send(body);
    }

    it.each([
        ['not an array', { enabled_sources: 'ProReferral' }],
        ['too many', { enabled_sources: Array.from({ length: 51 }, (_, i) => `S${i}`) }],
        ['empty string item', { enabled_sources: ['ProReferral', '  '] }],
        ['non-string item', { enabled_sources: [42] }],
        ['81-char item', { enabled_sources: ['x'.repeat(81)] }],
        ['missing body key', {} ],
    ])('%s → 400 VALIDATION, no write', async (_l, body) => {
        const res = await put(body);
        expect(res.status).toBe(400);
        expect(res.body.error.code).toBe('VALIDATION');
        expect(db.query.mock.calls.filter(([sql]) => /INSERT INTO outbound_lead_call_settings/.test(sql))).toHaveLength(0);
    });

    it('normalized dedup keeps the FIRST display label; empty array is valid', async () => {
        db.query.mockImplementation(async (sql, params) => {
            if (/INSERT INTO outbound_lead_call_settings/.test(sql)) {
                return { rows: [{ enabled_sources: JSON.parse(params[1]), max_attempts: 3, backoff_schedule: ['immediate', '+30m', '+2h'] }] };
            }
            return { rows: [], rowCount: 1 };
        });
        const res = await put({ enabled_sources: ['Pro Referral', 'ProReferral', ' pro referral ', 'Google'] });
        expect(res.status).toBe(200);
        expect(res.body.data.settings.enabled_sources).toEqual(['Pro Referral', 'Google']);

        const empty = await put({ enabled_sources: [] });
        expect(empty.status).toBe(200);
        expect(empty.body.data.settings.enabled_sources).toEqual([]); // valid: zero sources = no new chains
    });

    it('upsert params carry the tenant + the deduped JSON', async () => {
        await put({ enabled_sources: ['Pro Referral'] });
        const ins = db.query.mock.calls.find(([sql]) => /INSERT INTO outbound_lead_call_settings/.test(sql));
        expect(ins[1][0]).toBe(COMPANY);
        expect(JSON.parse(ins[1][1])).toEqual(['Pro Referral']);
        expect(ins[0]).toMatch(/ON CONFLICT \(company_id\) DO UPDATE/);
    });
});

describe('TC-OLC-055: PUT /settings — calling-window mode (OLC-WINDOW-001)', () => {
    async function put(body) {
        return request(appWithAuth(COMPANY)).put('/api/outbound-lead-caller/settings').send(body);
    }
    const insParams = () => (db.query.mock.calls.find(([sql]) => /INSERT INTO outbound_lead_call_settings/.test(sql)) || [])[1];
    beforeEach(() => {
        db.query.mockImplementation(async (sql, params) => {
            if (/INSERT INTO outbound_lead_call_settings/.test(sql)) {
                return { rows: [{
                    enabled_sources: JSON.parse(params[1]), calling_window_mode: params[2],
                    custom_start_time: params[3], custom_end_time: params[4],
                    max_attempts: 3, backoff_schedule: ['immediate', '+30m', '+2h'],
                }] };
            }
            return { rows: [], rowCount: 1 };
        });
    });

    it('always mode → 200; persists mode with null custom times', async () => {
        const res = await put({ enabled_sources: ['Pro Referral'], calling_window_mode: 'always' });
        expect(res.status).toBe(200);
        expect(res.body.data.settings.calling_window_mode).toBe('always');
        expect(insParams().slice(2)).toEqual(['always', null, null]);
    });

    it('custom mode with valid HH:MM → 200; persists the window', async () => {
        const res = await put({ enabled_sources: ['Pro Referral'], calling_window_mode: 'custom', custom_start_time: '09:00', custom_end_time: '20:00' });
        expect(res.status).toBe(200);
        expect(insParams().slice(2)).toEqual(['custom', '09:00', '20:00']);
    });

    it('no mode → defaults to office_hours (back-compat with the sources-only client)', async () => {
        const res = await put({ enabled_sources: ['Pro Referral'] });
        expect(res.status).toBe(200);
        expect(insParams().slice(2)).toEqual(['office_hours', null, null]);
    });

    it.each([
        ['unknown mode', { enabled_sources: ['X'], calling_window_mode: 'whenever' }],
        ['custom bad HH:MM', { enabled_sources: ['X'], calling_window_mode: 'custom', custom_start_time: '9am', custom_end_time: '20:00' }],
        ['custom start >= end', { enabled_sources: ['X'], calling_window_mode: 'custom', custom_start_time: '20:00', custom_end_time: '09:00' }],
        ['custom missing times', { enabled_sources: ['X'], calling_window_mode: 'custom' }],
    ])('%s → 400 VALIDATION, no write', async (_l, body) => {
        const res = await put(body);
        expect(res.status).toBe(400);
        expect(res.body.error.code).toBe('VALIDATION');
        expect(db.query.mock.calls.filter(([sql]) => /INSERT INTO outbound_lead_call_settings/.test(sql))).toHaveLength(0);
    });
});

describe('TC-OLC-052: tenant isolation', () => {
    it('company A and B never share params; scoping comes ONLY from companyFilter', async () => {
        await request(appWithAuth(COMPANY)).get('/api/outbound-lead-caller/settings');
        const aCalls = db.query.mock.calls.length;
        await request(appWithAuth(OTHER_COMPANY)).get('/api/outbound-lead-caller/settings');
        const bParams = db.query.mock.calls.slice(aCalls).map(([, p]) => p[0]);
        expect(bParams.every(p => p === OTHER_COMPANY)).toBe(true);
    });

    it('body-supplied companyId is ignored (anti-spoof)', async () => {
        await request(appWithAuth(COMPANY))
            .put('/api/outbound-lead-caller/settings')
            .send({ enabled_sources: ['Pro Referral'], companyId: OTHER_COMPANY, company_id: OTHER_COMPANY });
        const ins = db.query.mock.calls.find(([sql]) => /INSERT INTO outbound_lead_call_settings/.test(sql));
        expect(ins[1][0]).toBe(COMPANY);
    });
});

describe('TC-OLC-053: no auth context → no tenant reads', () => {
    it('without companyFilter the handlers 500 without leaking data (middleware owns 401/403 upstream)', async () => {
        // In prod the shared authenticate/requirePermission/requireCompanyAccess
        // chain rejects before the router. Here: absent companyFilter must not
        // produce a tenant-less query that returns data.
        db.query.mockImplementation(async (sql, params) => {
            if (params && params[0] === undefined) throw new Error('tenant param missing');
            return { rows: [] };
        });
        const res = await request(appWithAuth(null)).get('/api/outbound-lead-caller/settings');
        expect(res.status).toBe(500);
        expect(res.body.ok).toBe(false);
    });

    it('server.js mounts the router behind the marketplace gate (source assert)', () => {
        const src = require('fs').readFileSync(require.resolve('../src/server.js'), 'utf8');
        expect(src).toMatch(/app\.use\('\/api\/outbound-lead-caller', authenticate, requirePermission\('tenant\.integrations\.manage'\), requireCompanyAccess,/);
    });
});

describe('TC-OLC-054: sabotage — the validation detector can go red', () => {
    it('a hypothetical impl that skips validation WOULD write the bad payload (detector power)', async () => {
        // Drive the service layer directly with an invalid payload — proving the
        // 400-asserts above depend on the ROUTE's validation, not on the service
        // silently refusing.
        const svc = require('../backend/src/services/outboundLeadCallSettingsService');
        db.query.mockImplementation(async (sql, params) => {
            if (/INSERT INTO outbound_lead_call_settings/.test(sql)) {
                return { rows: [{ enabled_sources: JSON.parse(params[1]), max_attempts: 3, backoff_schedule: ['x'] }] };
            }
            return { rows: [] };
        });
        const out = await svc.saveSources(COMPANY, ['']); // empty string — route would 400
        expect(db.query.mock.calls.some(([sql]) => /INSERT INTO outbound_lead_call_settings/.test(sql))).toBe(true);
        expect(out.enabled_sources).toEqual([]); // coerceStored drops empties on read — belt, not the gate
    });
});
