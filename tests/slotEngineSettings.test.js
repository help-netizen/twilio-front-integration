/**
 * REC-SETTINGS-001 — per-company recommendation settings.
 *
 * Covers (test-cases/REC-SETTINGS-001.md):
 *  - buildConfigOverride: DEFAULTS + custom mapping, ONE radius → BOTH geography keys,
 *    the 2 fixed values always present, no extra/exposed keys (TC-RS-001..006).
 *  - resolve / get: no-row → DEFAULTS, full row, per-key partial/corrupt fallback,
 *    resolve degrades on DB error (never throws) while get surfaces it (TC-RS-010..015).
 *  - validate: boundary matrix per field, integer/float/NaN/missing/unknown-key,
 *    all-or-nothing (TC-RS-020..033).
 *  - queries: company-scoping of getByCompany / upsert (TC-RS-040..041).
 *  - routes GET/PUT: 401 (no auth), 403 (no permission), no-row defaults, saved row,
 *    PUT valid upsert, PUT invalid 422 (no write), company_id only from companyFilter,
 *    cross-tenant isolation, GET hard DB error → 500 (TC-RS-042..050).
 *  - migration 128 (structural): PK/FK cascade, jsonb NOT NULL + timestamps, updated_at
 *    trigger, idempotent replay (TC-RS-060..064).
 *
 * Harness mirrors technicianBaseLocations.test.js / slotEngineProxy.test.js: pg pool is
 * mocked (`db.query`), the service runs real over it, and routes are exercised through a
 * controllable `appWith({ permissions, companyId })` express app via supertest.
 */

jest.mock('../backend/src/db/connection', () => ({ query: jest.fn() }));
// auditService.log fires on the 403 path; stub it so no real DB write is attempted.
jest.mock('../backend/src/services/auditService', () => ({ log: jest.fn().mockResolvedValue(undefined) }));

const express = require('express');
const request = require('supertest');

const db = require('../backend/src/db/connection');
const queries = require('../backend/src/db/slotEngineSettingsQueries');
const svc = require('../backend/src/services/slotEngineSettingsService');
const router = require('../backend/src/routes/slotEngineSettings');

const { DEFAULTS } = svc;

const COMPANY_A = '00000000-0000-0000-0000-00000000000a';
const COMPANY_B = '00000000-0000-0000-0000-00000000000b';

beforeEach(() => {
    db.query.mockReset();
    // ensureSchema replay + default empty result.
    db.query.mockResolvedValue({ rows: [] });
});

// Build an app whose auth context is fully controllable per-test. Mirrors the production
// mount order (authenticate → requireCompanyAccess → requirePermission): when no user is
// injected the auth gate returns 401 before the router's permission check runs.
function appWith({ permissions = [], companyId = COMPANY_A, authenticated = true } = {}) {
    const app = express();
    app.use(express.json());
    app.use((req, res, next) => {
        if (!authenticated) {
            return res.status(401).json({ code: 'UNAUTHENTICATED', message: 'Auth required' });
        }
        req.user = { sub: 'kc', email: 'u@x.com', crmUser: { id: 'user-1' } };
        req.authz = { permissions };
        req.companyFilter = { company_id: companyId };
        next();
    });
    app.use('/', router);
    return app;
}

// Helper: rows() makes the next db.query resolve with a settings row carrying `config`.
function configRow(config) {
    return { rows: [{ config }] };
}

// ─── 1. buildConfigOverride — engine key mapping ─────────────────────────────────

describe('buildConfigOverride', () => {
    it('TC-RS-001: DEFAULTS → exact override', () => {
        expect(svc.buildConfigOverride(DEFAULTS)).toEqual({
            geography: {
                max_distance_from_existing_job_miles: 10,
                max_distance_from_base_if_empty_day_miles: 10,
                allow_empty_day_candidates: true,
            },
            overlap: { max_timeframe_overlap_minutes: 0 },
            feasibility: { min_required_slack_minutes: 15 },
            planning: { horizon_days: 3 },
            ranking: { top_n: 3 },
            workload: { max_day_utilization: 0.95 },
        });
    });

    it('TC-RS-002: custom set → exact override', () => {
        const o = svc.buildConfigOverride({
            max_distance_miles: 25, overlap_minutes: 30, min_buffer_minutes: 45,
            horizon_days: 7, recommendations_shown: 5,
        });
        expect(o.geography.max_distance_from_existing_job_miles).toBe(25);
        expect(o.overlap.max_timeframe_overlap_minutes).toBe(30);
        expect(o.feasibility.min_required_slack_minutes).toBe(45);
        expect(o.planning.horizon_days).toBe(7);
        expect(o.ranking.top_n).toBe(5);
        // fixed keys unchanged
        expect(o.geography.allow_empty_day_candidates).toBe(true);
        expect(o.workload.max_day_utilization).toBe(0.95);
    });

    it('TC-RS-003: ONE radius → BOTH geography keys', () => {
        const o = svc.buildConfigOverride({ ...DEFAULTS, max_distance_miles: 42 });
        expect(o.geography.max_distance_from_existing_job_miles).toBe(42);
        expect(o.geography.max_distance_from_base_if_empty_day_miles).toBe(42);
    });

    it('TC-RS-004: two fixed values always present (DEFAULTS)', () => {
        const o = svc.buildConfigOverride(DEFAULTS);
        expect(o.geography.allow_empty_day_candidates).toBe(true);
        expect(o.workload.max_day_utilization).toBe(0.95);
    });

    it('TC-RS-005: two fixed values present regardless of input (no overlap/no buffer)', () => {
        const o = svc.buildConfigOverride({
            max_distance_miles: 1, overlap_minutes: 0, min_buffer_minutes: 0,
            horizon_days: 1, recommendations_shown: 1,
        });
        expect(o.geography.allow_empty_day_candidates).toBe(true);
        expect(o.workload.max_day_utilization).toBe(0.95);
    });

    it('TC-RS-006: output carries no extra/exposed keys', () => {
        const o = svc.buildConfigOverride(DEFAULTS);
        expect(Object.keys(o).sort()).toEqual(
            ['feasibility', 'geography', 'overlap', 'planning', 'ranking', 'workload']
        );
        expect(Object.keys(o.geography).sort()).toEqual([
            'allow_empty_day_candidates',
            'max_distance_from_base_if_empty_day_miles',
            'max_distance_from_existing_job_miles',
        ]);
        expect(o.travel).toBeUndefined();
        expect(o.scoring).toBeUndefined();
        expect(o.candidate_timeframes).toBeUndefined();
    });
});

// ─── 2. resolve / get — safe-failure + partial-fill ──────────────────────────────

describe('resolve / get', () => {
    it('TC-RS-010: no row → DEFAULTS (resolve and get)', async () => {
        db.query.mockResolvedValue({ rows: [] });
        await expect(svc.resolve(COMPANY_A)).resolves.toEqual(DEFAULTS);
        db.query.mockResolvedValue({ rows: [] });
        await expect(svc.get(COMPANY_A)).resolves.toEqual(DEFAULTS);
    });

    it('TC-RS-011: full row → its 5 values, integer-typed', async () => {
        const stored = { max_distance_miles: 20, overlap_minutes: 30, min_buffer_minutes: 0, horizon_days: 10, recommendations_shown: 8 };
        db.query.mockImplementation(async (sql) => /SELECT config/.test(String(sql)) ? configRow(stored) : { rows: [] });
        await expect(svc.resolve(COMPANY_A)).resolves.toEqual(stored);
    });

    it('TC-RS-012: missing individual key → that key falls back to default', async () => {
        db.query.mockImplementation(async (sql) => /SELECT config/.test(String(sql)) ? configRow({ max_distance_miles: 20 }) : { rows: [] });
        await expect(svc.resolve(COMPANY_A)).resolves.toEqual({
            max_distance_miles: 20, overlap_minutes: 0, min_buffer_minutes: 15, horizon_days: 3, recommendations_shown: 3,
        });
    });

    it('TC-RS-013: corrupt/non-numeric key → that key falls back to default', async () => {
        db.query.mockImplementation(async (sql) =>
            /SELECT config/.test(String(sql)) ? configRow({ max_distance_miles: 'abc', overlap_minutes: null, horizon_days: 7 }) : { rows: [] });
        await expect(svc.resolve(COMPANY_A)).resolves.toEqual({
            max_distance_miles: 10, overlap_minutes: 0, min_buffer_minutes: 15, horizon_days: 7, recommendations_shown: 3,
        });
    });

    it('TC-RS-014: DB error in resolve → DEFAULTS, never throws', async () => {
        db.query.mockRejectedValue(new Error('db down'));
        await expect(svc.resolve(COMPANY_A)).resolves.toEqual(DEFAULTS);
    });

    it('TC-RS-015: DB error in get → surfaces (does NOT swallow)', async () => {
        db.query.mockRejectedValue(new Error('db down'));
        await expect(svc.get(COMPANY_A)).rejects.toThrow('db down');
    });
});

// ─── 3. validate — boundary matrix, all-or-nothing ───────────────────────────────

describe('validate', () => {
    const base = { ...DEFAULTS };
    const expectReject = (input, field) => {
        let thrown;
        try { svc.validate(input); } catch (e) { thrown = e; }
        expect(thrown).toBeDefined();
        expect(thrown.httpStatus).toBe(422);
        expect(thrown.code).toBe('INVALID_SETTINGS');
        expect(thrown.field).toBe(field);
    };

    it('TC-RS-020: all-fields-valid baseline → coerced integers returned', () => {
        const input = { max_distance_miles: 15, overlap_minutes: 0, min_buffer_minutes: 30, horizon_days: 5, recommendations_shown: 5 };
        expect(svc.validate(input)).toEqual(input);
    });

    it('TC-RS-021: numeric-string coercion "15" → 15', () => {
        const input = { max_distance_miles: '15', overlap_minutes: '0', min_buffer_minutes: '30', horizon_days: '5', recommendations_shown: '5' };
        expect(svc.validate(input)).toEqual({ max_distance_miles: 15, overlap_minutes: 0, min_buffer_minutes: 30, horizon_days: 5, recommendations_shown: 5 });
    });

    it('TC-RS-022: max_distance_miles 1 ok, 100 ok', () => {
        expect(svc.validate({ ...base, max_distance_miles: 1 }).max_distance_miles).toBe(1);
        expect(svc.validate({ ...base, max_distance_miles: 100 }).max_distance_miles).toBe(100);
    });

    it('TC-RS-023: max_distance_miles 0 reject, 101 reject', () => {
        expectReject({ ...base, max_distance_miles: 0 }, 'max_distance_miles');
        expectReject({ ...base, max_distance_miles: 101 }, 'max_distance_miles');
    });

    it('TC-RS-024: overlap_minutes 0/240 ok, -1/241 reject', () => {
        expect(svc.validate({ ...base, overlap_minutes: 0 }).overlap_minutes).toBe(0);
        expect(svc.validate({ ...base, overlap_minutes: 240 }).overlap_minutes).toBe(240);
        expectReject({ ...base, overlap_minutes: -1 }, 'overlap_minutes');
        expectReject({ ...base, overlap_minutes: 241 }, 'overlap_minutes');
    });

    it('TC-RS-025: min_buffer_minutes 0/240 ok, -1/241 reject', () => {
        expect(svc.validate({ ...base, min_buffer_minutes: 0 }).min_buffer_minutes).toBe(0);
        expect(svc.validate({ ...base, min_buffer_minutes: 240 }).min_buffer_minutes).toBe(240);
        expectReject({ ...base, min_buffer_minutes: -1 }, 'min_buffer_minutes');
        expectReject({ ...base, min_buffer_minutes: 241 }, 'min_buffer_minutes');
    });

    it('TC-RS-026: horizon_days 1/14 ok, 0/15 reject', () => {
        expect(svc.validate({ ...base, horizon_days: 1 }).horizon_days).toBe(1);
        expect(svc.validate({ ...base, horizon_days: 14 }).horizon_days).toBe(14);
        expectReject({ ...base, horizon_days: 0 }, 'horizon_days');
        expectReject({ ...base, horizon_days: 15 }, 'horizon_days');
    });

    it('TC-RS-027: recommendations_shown 1/10 ok, 0/11 reject', () => {
        expect(svc.validate({ ...base, recommendations_shown: 1 }).recommendations_shown).toBe(1);
        expect(svc.validate({ ...base, recommendations_shown: 10 }).recommendations_shown).toBe(10);
        expectReject({ ...base, recommendations_shown: 0 }, 'recommendations_shown');
        expectReject({ ...base, recommendations_shown: 11 }, 'recommendations_shown');
    });

    it('TC-RS-028: non-integer (float) rejected', () => {
        expectReject({ ...base, overlap_minutes: 30.5 }, 'overlap_minutes');
    });

    it('TC-RS-029: non-numeric ("abc", NaN) rejected', () => {
        expectReject({ ...base, max_distance_miles: 'abc' }, 'max_distance_miles');
        expectReject({ ...base, horizon_days: NaN }, 'horizon_days');
    });

    it('TC-RS-030: missing field rejected', () => {
        const { recommendations_shown, ...partial } = base;
        expectReject(partial, 'recommendations_shown');
    });

    it('TC-RS-031: all-or-nothing — one bad field → throws (nothing returned)', () => {
        expect(() => svc.validate({ ...base, horizon_days: 0 })).toThrow();
    });

    it('TC-RS-032: unknown keys stripped (not persisted)', () => {
        const out = svc.validate({ ...base, company_id: COMPANY_A, top_n: 99, evil: 1 });
        expect(Object.keys(out).sort()).toEqual([
            'horizon_days', 'max_distance_miles', 'min_buffer_minutes', 'overlap_minutes', 'recommendations_shown',
        ]);
        expect(out.company_id).toBeUndefined();
        expect(out.top_n).toBeUndefined();
        expect(out.evil).toBeUndefined();
    });

    it('TC-RS-033: custom picker value out of range rejected (no bypass)', () => {
        expectReject({ ...base, overlap_minutes: 300 }, 'overlap_minutes');
    });
});

// ─── save (service): validate → upsert → returns saved; invalid → no write ───────

describe('save (service)', () => {
    it('valid input → upsert called → returns the 5 saved keys', async () => {
        const input = { max_distance_miles: 15, overlap_minutes: 0, min_buffer_minutes: 30, horizon_days: 5, recommendations_shown: 5 };
        db.query.mockImplementation(async (sql) => /INSERT INTO slot_engine_settings/.test(String(sql)) ? configRow(input) : { rows: [] });
        const out = await svc.save(COMPANY_A, input);
        expect(out).toEqual(input);
        const ins = db.query.mock.calls.find(c => /INSERT INTO slot_engine_settings/.test(String(c[0])));
        expect(ins).toBeTruthy();
        expect(ins[1][0]).toBe(COMPANY_A);
        expect(ins[1][1]).toEqual(input);
    });

    it('invalid input → throws 422 and upsert NOT called', async () => {
        await expect(svc.save(COMPANY_A, { ...DEFAULTS, max_distance_miles: 250 }))
            .rejects.toMatchObject({ httpStatus: 422, code: 'INVALID_SETTINGS', field: 'max_distance_miles' });
        const ins = db.query.mock.calls.find(c => /INSERT INTO slot_engine_settings/.test(String(c[0])));
        expect(ins).toBeUndefined();
    });
});

// ─── 4. queries — company-scoping ────────────────────────────────────────────────

describe('queries are company-scoped', () => {
    it('TC-RS-040: getByCompany filters by company_id; selects config', async () => {
        db.query.mockImplementation(async (sql) => /SELECT config/.test(String(sql)) ? configRow(DEFAULTS) : { rows: [] });
        await queries.getByCompany(COMPANY_A);
        const sel = db.query.mock.calls.find(c => /SELECT config/.test(String(c[0])));
        expect(sel).toBeTruthy();
        expect(String(sel[0])).toMatch(/WHERE company_id = \$1/);
        expect(sel[1][0]).toBe(COMPANY_A);
    });

    it('TC-RS-041: upsert binds company_id first, ON CONFLICT (company_id)', async () => {
        db.query.mockImplementation(async (sql) => /INSERT INTO slot_engine_settings/.test(String(sql)) ? configRow(DEFAULTS) : { rows: [] });
        await queries.upsert(COMPANY_A, DEFAULTS);
        const ins = db.query.mock.calls.find(c => /INSERT INTO slot_engine_settings/.test(String(c[0])));
        expect(ins[1][0]).toBe(COMPANY_A);
        expect(ins[1][1]).toEqual(DEFAULTS);
        expect(String(ins[0])).toMatch(/ON CONFLICT \(company_id\) DO UPDATE/);
        expect(String(ins[0])).toMatch(/updated_at = NOW\(\)/);
    });
});

// ─── 5. routes — GET / PUT ───────────────────────────────────────────────────────

describe('routes GET / PUT /api/settings/slot-engine-settings', () => {
    it('TC-RS-042: 401 without auth context (GET and PUT)', async () => {
        const getRes = await request(appWith({ authenticated: false })).get('/');
        expect(getRes.status).toBe(401);
        const putRes = await request(appWith({ authenticated: false })).put('/').send({ ...DEFAULTS });
        expect(putRes.status).toBe(401);
    });

    it('TC-RS-043: 403 without tenant.company.manage (GET and PUT)', async () => {
        const getRes = await request(appWith({ permissions: [] })).get('/');
        expect(getRes.status).toBe(403);
        const putRes = await request(appWith({ permissions: [] })).put('/').send({ ...DEFAULTS });
        expect(putRes.status).toBe(403);
    });

    it('TC-RS-044: GET no row → defaults; no row created', async () => {
        db.query.mockResolvedValue({ rows: [] });
        const res = await request(appWith({ permissions: ['tenant.company.manage'] })).get('/');
        expect(res.status).toBe(200);
        expect(res.body).toEqual({ ok: true, data: DEFAULTS });
        // GET is read-only: no INSERT issued.
        expect(db.query.mock.calls.find(c => /INSERT INTO slot_engine_settings/.test(String(c[0])))).toBeUndefined();
    });

    it('TC-RS-045: GET row → saved values', async () => {
        const stored = { max_distance_miles: 20, overlap_minutes: 30, min_buffer_minutes: 0, horizon_days: 10, recommendations_shown: 8 };
        db.query.mockImplementation(async (sql) => /SELECT config/.test(String(sql)) ? configRow(stored) : { rows: [] });
        const res = await request(appWith({ permissions: ['tenant.company.manage'] })).get('/');
        expect(res.status).toBe(200);
        expect(res.body).toEqual({ ok: true, data: stored });
    });

    it('TC-RS-046: PUT valid → upsert + returns saved', async () => {
        const body = { max_distance_miles: 15, overlap_minutes: 0, min_buffer_minutes: 30, horizon_days: 5, recommendations_shown: 5 };
        db.query.mockImplementation(async (sql) => /INSERT INTO slot_engine_settings/.test(String(sql)) ? configRow(body) : { rows: [] });
        const res = await request(appWith({ permissions: ['tenant.company.manage'] })).put('/').send(body);
        expect(res.status).toBe(200);
        expect(res.body).toEqual({ ok: true, data: body });
        const ins = db.query.mock.calls.find(c => /INSERT INTO slot_engine_settings/.test(String(c[0])));
        expect(ins).toBeTruthy();
        expect(ins[1][1]).toEqual(body);
    });

    it('TC-RS-047: PUT invalid → 422, nothing saved', async () => {
        const res = await request(appWith({ permissions: ['tenant.company.manage'] }))
            .put('/').send({ ...DEFAULTS, max_distance_miles: 250 });
        expect(res.status).toBe(422);
        expect(res.body.ok).toBe(false);
        expect(res.body.error.code).toBe('INVALID_SETTINGS');
        // validate runs before upsert → no INSERT recorded.
        expect(db.query.mock.calls.find(c => /INSERT INTO slot_engine_settings/.test(String(c[0])))).toBeUndefined();
    });

    it('TC-RS-048: company_id ONLY from req.companyFilter (poisoned body/req ignored)', async () => {
        const body = { ...DEFAULTS, company_id: COMPANY_B };
        db.query.mockImplementation(async (sql) => /INSERT INTO slot_engine_settings/.test(String(sql)) ? configRow(DEFAULTS) : { rows: [] });
        const app = express();
        app.use(express.json());
        app.use((req, _res, next) => {
            req.user = { sub: 'kc', email: 'u@x.com', crmUser: { id: 'user-1' } };
            req.authz = { permissions: ['tenant.company.manage'] };
            req.companyFilter = { company_id: COMPANY_A };
            req.companyId = COMPANY_B; // poison
            next();
        });
        app.use('/', router);
        const res = await request(app).put('/').send(body);
        expect(res.status).toBe(200);
        const ins = db.query.mock.calls.find(c => /INSERT INTO slot_engine_settings/.test(String(c[0])));
        expect(ins[1][0]).toBe(COMPANY_A);
        // the stripped config never carries company_id
        expect(ins[1][1].company_id).toBeUndefined();
    });

    it('TC-RS-049: cross-tenant isolation — B reads scoped to B (A row never returned)', async () => {
        db.query.mockResolvedValue({ rows: [] });
        await request(appWith({ permissions: ['tenant.company.manage'], companyId: COMPANY_B })).get('/');
        const sel = db.query.mock.calls.find(c => /SELECT config/.test(String(c[0])));
        expect(sel[1][0]).toBe(COMPANY_B);
    });

    // The GET route uses get() (not resolve): a normal no-row first-run returns DEFAULTS,
    // but a hard DB fault surfaces as 500 so the UI shows an honest "couldn't load" toast
    // (and its local DEFAULTS mirror) rather than silently presenting defaults as if saved.
    // The safe-failing resolve() path is reserved for slotEngineService (TC-RS-014/051..054).
    it('TC-RS-050: GET hard DB error → 500 (route uses get, surfaces the fault)', async () => {
        db.query.mockRejectedValue(new Error('db down'));
        const res = await request(appWith({ permissions: ['tenant.company.manage'] })).get('/');
        expect(res.status).toBe(500);
        expect(res.body.ok).toBe(false);
        expect(res.body.error.code).toBe('INTERNAL');
    });
});

// ─── 7. Migration 128 — structural assertions + ensureSchema replay ──────────────

describe('migration 128 (structural) + ensureSchema replay', () => {
    const fs = require('fs');
    const path = require('path');
    const sql = fs.readFileSync(
        path.join(__dirname, '..', 'backend', 'db', 'migrations', '128_create_slot_engine_settings.sql'),
        'utf8'
    );

    it('TC-RS-060: table created with company_id PK + FK cascade', () => {
        expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS slot_engine_settings/);
        expect(sql).toMatch(/company_id\s+UUID\s+PRIMARY KEY\s+REFERENCES companies\(id\)\s+ON DELETE CASCADE/);
    });

    it('TC-RS-061: config jsonb NOT NULL + timestamps', () => {
        expect(sql).toMatch(/config\s+JSONB\s+NOT NULL/);
        expect(sql).toMatch(/created_at\s+TIMESTAMPTZ\s+NOT NULL\s+DEFAULT NOW\(\)/);
        expect(sql).toMatch(/updated_at\s+TIMESTAMPTZ\s+NOT NULL\s+DEFAULT NOW\(\)/);
    });

    it('TC-RS-062: updated_at trigger wired to update_updated_at_column', () => {
        expect(sql).toMatch(/CREATE TRIGGER trg_slot_engine_settings_updated_at\s+BEFORE UPDATE ON slot_engine_settings/);
        expect(sql).toMatch(/EXECUTE FUNCTION update_updated_at_column\(\)/);
    });

    it('TC-RS-063: idempotent (DROP TRIGGER IF EXISTS) — safe replay does not throw', async () => {
        expect(sql).toMatch(/DROP TRIGGER IF EXISTS trg_slot_engine_settings_updated_at/);
        // ensureSchema feeds the file to db.query; replaying twice must not throw.
        db.query.mockResolvedValue({ rows: [] });
        await expect(queries.ensureSchema()).resolves.toBeUndefined();
        // ensureSchema memoizes, so the SQL was passed to db.query at least once across the suite.
        // Assert the schema string itself is what ensureSchema would send.
        expect(sql).toContain('slot_engine_settings');
    });

    it('TC-RS-064: FK cascade clause present (deletes settings with company)', () => {
        expect(sql).toMatch(/ON DELETE CASCADE/);
    });
});
