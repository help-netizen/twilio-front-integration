/**
 * TECH-DAYOFF-001 (DO-06, section A) — CRUD /api/schedule/time-off + RBAC +
 * provider scope. TC-DO-01…16.
 *
 * Style precedent: tests/slotEngineProxy.test.js — service + route in ONE suite
 * over a supertest mini-app with fake-auth middleware; REAL timeOffService +
 * timeOffQueries on top of a mocked db.query; the native roster and directory
 * seams are mocked.
 */

jest.mock('../backend/src/db/connection', () => ({ query: jest.fn() }));
jest.mock('../backend/src/db/marketplaceQueries', () => ({
    getPublishedAppByKey: jest.fn(),
    findActiveInstallation: jest.fn(),
}));
jest.mock('../backend/src/services/technicianRosterService', () => ({ listActive: jest.fn() }));
jest.mock('../backend/src/services/googlePlacesService', () => ({ geocodeAddress: jest.fn() }));
jest.mock('../backend/src/services/jobsService', () => ({ listJobs: jest.fn() }));
jest.mock('../backend/src/services/scheduleService', () => ({
    getDispatchSettings: jest.fn(async () => ({
        timezone: 'America/New_York',
        work_start_time: '08:00:00',
        work_end_time: '18:00:00',
        work_days: [1, 2, 3, 4, 5],
    })),
}));
jest.mock('../backend/src/db/technicianDirectoryQueries', () => ({
    resolveTechnicianUuid: jest.fn(),
    findActiveTechnicianByCrmUserId: jest.fn(),
}));

const express = require('express');
const request = require('supertest');

const db = require('../backend/src/db/connection');
const technicianRosterService = require('../backend/src/services/technicianRosterService');
const directoryQueries = require('../backend/src/db/technicianDirectoryQueries');
const scheduleRouter = require('../backend/src/routes/schedule');

const COMPANY = '00000000-0000-0000-0000-00000000000a';
const PROVIDER_USER = 'provider-user-9';
const ROW_ID = '11111111-1111-4111-8111-111111111111';
const TECH_UUID = '22222222-2222-4222-8222-222222222222';

const DAY_MS = 24 * 60 * 60 * 1000;
const future = (days) => new Date(Date.now() + days * DAY_MS).toISOString();
const past = (days) => new Date(Date.now() - days * DAY_MS).toISOString();

// Per-test knobs consumed by the db.query implementation below.
let selectRows;
let deleteRowCount;

/** Rebuild the RETURNING rows of an INSERT from its parameter list ($1 = company). */
function rowsFromInsertParams(params) {
    const [companyId, ...rest] = params;
    const rows = [];
    for (let i = 0; i < rest.length; i += 8) {
        const [technician_id, technician_name, starts_at, ends_at, note, source, batch_id, created_by] = rest.slice(i, i + 8);
        rows.push({
            id: `row-${rows.length + 1}`,
            company_id: companyId,
            technician_id, technician_name, starts_at, ends_at, note, source, batch_id, created_by,
            created_at: '2026-07-11T00:00:00.000Z',
        });
    }
    return rows;
}

const timeOffQueryCalls = (re) => db.query.mock.calls.filter(([sql]) => re.test(String(sql)));
const insertCalls = () => timeOffQueryCalls(/INSERT INTO technician_time_off/i);
const deleteCalls = () => timeOffQueryCalls(/DELETE FROM technician_time_off/i);
const selectCalls = () => timeOffQueryCalls(/FROM technician_time_off/i)
    .filter(([sql]) => !/^\s*(?:INSERT|DELETE)/i.test(String(sql)));
const anyTimeOffTableCalls = () => timeOffQueryCalls(/technician_time_off/i);

function appWith({
    permissions = [],
    scopes = { job_visibility: 'all' },
    crmUser = { id: 'user-1' },
} = {}) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
        req.user = { sub: 'kc', email: 'u@x.com' };
        if (crmUser) req.user.crmUser = crmUser;
        req.authz = { permissions };
        if (scopes) req.authz.scopes = scopes;
        req.companyFilter = { company_id: COMPANY };
        next();
    });
    app.use('/api/schedule', scheduleRouter);
    return app;
}

/** Mini-app variant where the auth middleware rejects (real authenticate contract). */
function unauthenticatedApp() {
    const app = express();
    app.use(express.json());
    app.use('/api/schedule', (_req, res) =>
        res.status(401).json({ ok: false, error: { code: 'UNAUTHORIZED', message: 'Missing Authorization header' } }));
    return app;
}

const dispatcher = () => appWith({ permissions: ['schedule.view', 'schedule.dispatch'] });
const viewer = () => appWith({ permissions: ['schedule.view'] });

beforeEach(() => {
    jest.clearAllMocks();
    selectRows = [];
    deleteRowCount = 1;
    technicianRosterService.listActive.mockReset().mockResolvedValue([]);
    directoryQueries.resolveTechnicianUuid.mockReset().mockImplementation(async (_companyId, id) => {
        const value = String(id).toLowerCase();
        return /^[0-9a-f-]{36}$/.test(value) ? value : TECH_UUID;
    });
    directoryQueries.findActiveTechnicianByCrmUserId.mockReset().mockResolvedValue(null);
    db.query.mockReset().mockImplementation(async (sql, params) => {
        const s = String(sql);
        if (/INSERT INTO technician_time_off/i.test(s)) return { rows: rowsFromInsertParams(params) };
        if (/DELETE FROM technician_time_off/i.test(s)) return { rowCount: deleteRowCount };
        if (/FROM technician_time_off/i.test(s)) return { rows: selectRows };
        return { rows: [], rowCount: 0 };
    });
});

// ─── POST /time-off — individual ─────────────────────────────────────────────

describe('POST /api/schedule/time-off (individual)', () => {
    it('TC-DO-01: 201, one row, name snapshot, source=individual, batch_id=null, created_by=crmUser.id', async () => {
        const starts_at = future(7);
        const ends_at = future(9);
        const res = await request(dispatcher()).post('/api/schedule/time-off').send({
            target: 'technician',
            technician_id: TECH_UUID,
            technician_name: 'John Smith',
            starts_at, ends_at,
            note: 'vacation',
        });

        expect(res.status).toBe(201);
        expect(res.body.ok).toBe(true);
        expect(res.body.data.created).toHaveLength(1);
        expect(res.body.data.created[0]).toMatchObject({
            technician_id: TECH_UUID,
            technician_name: 'John Smith',
            source: 'individual',
            batch_id: null,
        });

        expect(insertCalls()).toHaveLength(1);
        const [, params] = insertCalls()[0];
        expect(params).toEqual([
            COMPANY,            // req.companyFilter.company_id
            TECH_UUID,          // canonical native technician UUID
            'John Smith',       // client snapshot — ZB never called
            starts_at, ends_at,
            'vacation',
            'individual',
            null,               // batch_id
            'user-1',           // created_by = crmUser.id, NOT sub 'kc'
        ]);
        expect(params).not.toContain('kc');
        expect(technicianRosterService.listActive).not.toHaveBeenCalled();
    });

    it('TC-DO-02: no crmUser → created_by strictly null, still 201', async () => {
        const app = appWith({ permissions: ['schedule.dispatch'], crmUser: null });
        const res = await request(app).post('/api/schedule/time-off').send({
            target: 'technician', technician_id: '1234567', technician_name: 'John Smith',
            starts_at: future(1), ends_at: future(2),
        });
        expect(res.status).toBe(201);
        expect(insertCalls()).toHaveLength(1);
        const [, params] = insertCalls()[0];
        expect(params[8]).toBeNull();      // created_by
        expect(params).not.toContain('kc');
    });

    it('TC-DO-08: mapped technician identity is accepted without a roster call', async () => {
        const res = await request(dispatcher()).post('/api/schedule/time-off').send({
            target: 'technician', technician_id: 'no-such-tech-999',
            starts_at: future(1), ends_at: future(2),
        });
        expect(res.status).toBe(201);
        expect(res.body.data.created[0].technician_id).toBe(TECH_UUID);
        expect(technicianRosterService.listActive).not.toHaveBeenCalled();
    });
});

// ─── POST /time-off — company-wide materialization ───────────────────────────

describe('POST /api/schedule/time-off (company)', () => {
    it('TC-DO-03: K active techs → exactly K rows via ONE INSERT statement, shared batch_id, source=company', async () => {
        technicianRosterService.listActive.mockResolvedValue([
            { id: TECH_UUID, name: 'John Smith' },
            { id: '33333333-3333-4333-8333-333333333333', name: 'Jane Doe' },
            { id: '44444444-4444-4444-8444-444444444444', name: 'Bob' },
        ]);
        const starts_at = future(8);
        const ends_at = future(9);
        const res = await request(dispatcher()).post('/api/schedule/time-off').send({
            target: 'company', starts_at, ends_at, note: 'storm day',
        });

        expect(res.status).toBe(201);
        expect(res.body.data.created).toHaveLength(3);

        expect(technicianRosterService.listActive).toHaveBeenCalledTimes(1);
        expect(technicianRosterService.listActive).toHaveBeenCalledWith(COMPANY);

        // Atomicity: exactly ONE multi-row INSERT statement.
        expect(insertCalls()).toHaveLength(1);
        const [, params] = insertCalls()[0];
        const rows = rowsFromInsertParams(params);
        expect(rows).toHaveLength(3);
        expect(rows.map(r => r.technician_id)).toEqual([
            TECH_UUID,
            '33333333-3333-4333-8333-333333333333',
            '44444444-4444-4444-8444-444444444444',
        ]);
        expect(rows.map(r => r.technician_name)).toEqual(['John Smith', 'Jane Doe', 'Bob']);

        const batchIds = new Set(rows.map(r => r.batch_id));
        expect(batchIds.size).toBe(1);
        expect([...batchIds][0]).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
        for (const r of rows) {
            expect(r.source).toBe('company');
            expect(r.starts_at).toBe(starts_at);
            expect(r.ends_at).toBe(ends_at);
            expect(r.note).toBe('storm day');
            expect(r.created_by).toBe('user-1');
        }
    });

    it('TC-DO-04: empty roster → 400 NO_ACTIVE_TECHNICIANS, zero inserts', async () => {
        technicianRosterService.listActive.mockResolvedValue([]);
        const res = await request(dispatcher()).post('/api/schedule/time-off').send({
            target: 'company', starts_at: future(1), ends_at: future(2),
        });
        expect(res.status).toBe(400);
        expect(res.body.ok).toBe(false);
        expect(res.body.error.code).toBe('NO_ACTIVE_TECHNICIANS');
        expect(insertCalls()).toHaveLength(0);
    });

    it('TC-DO-05: native roster failure → 500 INTERNAL, zero inserts (atomicity)', async () => {
        technicianRosterService.listActive.mockRejectedValue(new Error('Roster unavailable'));
        const res = await request(dispatcher()).post('/api/schedule/time-off').send({
            target: 'company', starts_at: future(1), ends_at: future(2),
        });
        expect(res.status).toBe(500);
        expect(res.body.error.code).toBe('INTERNAL');
        expect(insertCalls()).toHaveLength(0);
    });
});

// ─── POST validation matrix ──────────────────────────────────────────────────

describe('POST /api/schedule/time-off validation (TC-DO-06 / TC-DO-07)', () => {
    const valid = () => ({
        target: 'technician', technician_id: '1234567',
        starts_at: future(1), ends_at: future(2),
    });

    it.each([
        ['ends_at == starts_at', () => { const t = future(1); return { ...valid(), starts_at: t, ends_at: t }; }],
        ['ends_at < starts_at (inversion)', () => ({ ...valid(), starts_at: future(2), ends_at: future(1) })],
        ['period entirely in the past', () => ({ ...valid(), starts_at: past(3), ends_at: past(1) })],
        ['missing starts_at', () => { const b = valid(); delete b.starts_at; return b; }],
        ['missing ends_at', () => { const b = valid(); delete b.ends_at; return b; }],
        ['invalid ISO', () => ({ ...valid(), starts_at: 'garbage' })],
        ["target 'weekend'", () => ({ ...valid(), target: 'weekend' })],
        ["target technician without technician_id", () => { const b = valid(); delete b.technician_id; return b; }],
        ["target technician with empty technician_id", () => ({ ...valid(), technician_id: '   ' })],
        ['note of 501 chars', () => ({ ...valid(), note: 'x'.repeat(501) })],
    ])('TC-DO-06: %s → 400, zero inserts', async (_label, buildBody) => {
        const res = await request(dispatcher()).post('/api/schedule/time-off').send(buildBody());
        expect(res.status).toBe(400);
        expect(res.body.ok).toBe(false);
        expect(['VALIDATION', 'MISSING_FIELD']).toContain(res.body.error.code);
        expect(insertCalls()).toHaveLength(0);
    });

    it('TC-DO-07: starts_at in the past + ends_at in the future → 201 (already-running absence)', async () => {
        const res = await request(dispatcher()).post('/api/schedule/time-off').send({
            ...valid(), starts_at: past(2), ends_at: future(2),
        });
        expect(res.status).toBe(201);
        expect(res.body.data.created).toHaveLength(1);
    });
});

// ─── DELETE /time-off/:id ────────────────────────────────────────────────────

describe('DELETE /api/schedule/time-off/:id', () => {
    it('TC-DO-09: own row → 200 {deleted:true}; SQL strictly WHERE id AND company_id; no batch cascade', async () => {
        deleteRowCount = 1;
        const res = await request(dispatcher()).delete(`/api/schedule/time-off/${ROW_ID}`);
        expect(res.status).toBe(200);
        expect(res.body).toEqual({ ok: true, data: { deleted: true } });

        expect(deleteCalls()).toHaveLength(1); // exactly one per-row DELETE — batch siblings untouched
        const [sql, params] = deleteCalls()[0];
        expect(String(sql)).toMatch(/WHERE id = \$1 AND company_id = \$2/);
        expect(String(sql)).not.toMatch(/batch_id/); // INV-6: no cascade path exists
        expect(params).toEqual([ROW_ID, COMPANY]);
    });

    it('TC-DO-10: missing id / foreign tenant row → identical 404 NOT_FOUND', async () => {
        deleteRowCount = 0; // what WHERE id AND company_id yields for a foreign tenant
        const res = await request(dispatcher()).delete(`/api/schedule/time-off/${ROW_ID}`);
        expect(res.status).toBe(404);
        expect(res.body).toEqual({ ok: false, error: { code: 'NOT_FOUND', message: expect.any(String) } });
    });
});

// ─── GET /time-off ───────────────────────────────────────────────────────────

describe('GET /api/schedule/time-off', () => {
    const FROM = '2026-07-18T00:00:00.000Z';
    const TO = '2026-07-25T00:00:00.000Z';

    it.each([
        ['missing from', `to=${TO}`],
        ['missing to', `from=${FROM}`],
        ['from > to', `from=${TO}&to=${FROM}`],
        ['invalid ISO', `from=garbage&to=${TO}`],
    ])('TC-DO-11: %s → 400 VALIDATION', async (_label, qs) => {
        const res = await request(viewer()).get(`/api/schedule/time-off?${qs}`);
        expect(res.status).toBe(400);
        expect(res.body.error.code).toBe('VALIDATION');
    });

    it('TC-DO-12a: overlap semantics (starts_at < to AND ends_at > from), company-scoped, past not trimmed', async () => {
        selectRows = [{
            id: ROW_ID, company_id: COMPANY, technician_id: '1234567', technician_name: 'John Smith',
            starts_at: '2026-07-18T13:00:00.000Z', ends_at: '2026-07-20T01:00:00.000Z',
            note: 'vacation', source: 'individual', batch_id: null,
            created_by: 'user-1', created_at: '2026-07-11T20:00:00.000Z',
        }];
        const res = await request(viewer()).get(`/api/schedule/time-off?from=${FROM}&to=${TO}`);
        expect(res.status).toBe(200);
        expect(res.body.data.time_off).toEqual(selectRows);

        expect(selectCalls()).toHaveLength(1);
        const [sql, params] = selectCalls()[0];
        expect(String(sql)).toMatch(/company_id = \$1/);
        expect(String(sql)).toMatch(/starts_at < \$3/); // strict overlap, NOT "entirely inside"
        expect(String(sql)).toMatch(/ends_at > \$2/);
        expect(params).toEqual([COMPANY, FROM, TO]);
    });

    it('TC-DO-12b: optional technician_id filter adds technician_id = $4', async () => {
        const res = await request(viewer()).get(`/api/schedule/time-off?from=${FROM}&to=${TO}&technician_id=1234567`);
        expect(res.status).toBe(200);
        const [sql, params] = selectCalls()[0];
        expect(String(sql)).toMatch(/technician_uuid = \$4::uuid/);
        expect(params).toEqual([COMPANY, FROM, TO, TECH_UUID]);
    });

    it('TC-DO-13: provider (assigned_only) → forced onto OWN native technician, foreign param ignored', async () => {
        directoryQueries.findActiveTechnicianByCrmUserId.mockResolvedValue({ id: TECH_UUID });
        const app = appWith({
            permissions: ['schedule.view'],
            scopes: { job_visibility: 'assigned_only' },
            crmUser: { id: PROVIDER_USER },
        });
        selectRows = [{ id: ROW_ID, technician_id: '1234567', technician_name: 'John Smith' }];

        const res = await request(app)
            .get(`/api/schedule/time-off?from=${FROM}&to=${TO}&technician_id=7654321`); // brazenly asks for a FOREIGN id
        expect(res.status).toBe(200);
        expect(res.body.data.time_off).toEqual(selectRows);

        expect(directoryQueries.findActiveTechnicianByCrmUserId).toHaveBeenCalledWith(COMPANY, PROVIDER_USER);
        const [sql, params] = selectCalls()[0];
        expect(String(sql)).toMatch(/technician_uuid = \$4::uuid/);
        expect(params[3]).toBe(TECH_UUID); // own canonical id wins
        const allParams = db.query.mock.calls.flatMap(([, p]) => p || []);
        expect(allParams).not.toContain('7654321'); // foreign id never reaches SQL
    });

    it('TC-DO-14: provider without an active technician → 200 [] (deny-by-default), no table read, not 500', async () => {
        directoryQueries.findActiveTechnicianByCrmUserId.mockResolvedValue(null);
        const app = appWith({
            permissions: ['schedule.view'],
            scopes: { job_visibility: 'assigned_only' },
            crmUser: { id: PROVIDER_USER },
        });
        const res = await request(app).get(`/api/schedule/time-off?from=${FROM}&to=${TO}`);
        expect(res.status).toBe(200);
        expect(res.body.data.time_off).toEqual([]);
        expect(anyTimeOffTableCalls()).toHaveLength(0); // not a single record handed out
    });

    it('TC-DO-16: GET serves a deactivated technician row as-is from the DB snapshot', async () => {
        selectRows = [{
            id: ROW_ID, technician_id: 'deactivated-42', technician_name: 'Old Name Snapshot',
            starts_at: '2026-07-18T13:00:00.000Z', ends_at: '2026-07-19T13:00:00.000Z',
            note: null, source: 'individual', batch_id: null, created_at: '2026-07-11T00:00:00.000Z',
        }];
        const res = await request(viewer()).get(`/api/schedule/time-off?from=${FROM}&to=${TO}`);
        expect(res.status).toBe(200);
        expect(res.body.data.time_off[0].technician_name).toBe('Old Name Snapshot');
        expect(technicianRosterService.listActive).not.toHaveBeenCalled();
    });
});

// ─── GET /unavailability — composite read, explicit CRUD remains separate ───

describe('GET /api/schedule/unavailability (TECH-SCHEDULE-001)', () => {
    const FROM = '2026-07-20T04:00:00.000Z';
    const TO = '2026-07-21T04:00:00.000Z';

    it('returns explicit time off and derived schedule gaps with distinct kinds', async () => {
        technicianRosterService.listActive.mockResolvedValue([
            { id: TECH_UUID, name: 'John Smith', active: true, technician_uuid: TECH_UUID },
        ]);
        selectRows = [{
            id: ROW_ID,
            company_id: COMPANY,
            technician_id: TECH_UUID,
            technician_name: 'John Smith',
            starts_at: '2026-07-20T15:00:00.000Z',
            ends_at: '2026-07-20T16:00:00.000Z',
            note: 'Appointment',
            source: 'individual',
            batch_id: null,
        }];

        const res = await request(viewer()).get(
            `/api/schedule/unavailability?from=${FROM}&to=${TO}`
        );
        expect(res.status).toBe(200);
        expect(res.body.data.unavailability.map(item => item.kind)).toEqual([
            'schedule_gap', 'time_off', 'schedule_gap',
        ]);
        expect(res.body.data.unavailability.find(item => item.kind === 'schedule_gap')).toMatchObject({
            mutable: false,
            source: 'company',
        });
        expect(res.body.data.unavailability.find(item => item.kind === 'time_off')).toMatchObject({
            mutable: true,
            note: 'Appointment',
        });
    });

    it('retains schedule.view RBAC and provider-own scoping', async () => {
        technicianRosterService.listActive.mockResolvedValue([
            { id: TECH_UUID, name: 'John Smith', active: true, technician_uuid: TECH_UUID },
            { id: '33333333-3333-4333-8333-333333333333', name: 'Jane Doe', active: true, technician_uuid: '33333333-3333-4333-8333-333333333333' },
        ]);
        directoryQueries.findActiveTechnicianByCrmUserId.mockResolvedValue({ id: TECH_UUID });
        const provider = appWith({
            permissions: ['schedule.view'],
            scopes: { job_visibility: 'assigned_only' },
            crmUser: { id: PROVIDER_USER },
        });
        const res = await request(provider).get(
            `/api/schedule/unavailability?from=${FROM}&to=${TO}&technician_id=7654321`
        );
        expect(res.status).toBe(200);
        expect(new Set(res.body.data.unavailability.map(item => item.technician_id))).toEqual(new Set([TECH_UUID]));
        expect(new Set(res.body.data.unavailability.map(item => item.technician_name))).toEqual(new Set(['John Smith']));
        expect(JSON.stringify(res.body.data.unavailability)).not.toContain('Jane Doe');
    });

    it('rejects callers without schedule.view before reading availability', async () => {
        const res = await request(appWith({ permissions: [] })).get(
            `/api/schedule/unavailability?from=${FROM}&to=${TO}`
        );
        expect(res.status).toBe(403);
        expect(technicianRosterService.listActive).not.toHaveBeenCalled();
    });
});

// ─── RBAC matrix ─────────────────────────────────────────────────────────────

describe('RBAC (TC-DO-15)', () => {
    it("POST with only schedule.view (provider) → 403, no table access", async () => {
        const res = await request(viewer()).post('/api/schedule/time-off').send({
            target: 'technician', technician_id: '1234567',
            starts_at: future(1), ends_at: future(2),
        });
        expect(res.status).toBe(403);
        expect(anyTimeOffTableCalls()).toHaveLength(0);
    });

    it("DELETE with only schedule.view → 403, no table access", async () => {
        const res = await request(viewer()).delete(`/api/schedule/time-off/${ROW_ID}`);
        expect(res.status).toBe(403);
        expect(anyTimeOffTableCalls()).toHaveLength(0);
    });

    it('GET with no permissions → 403, no table access', async () => {
        const res = await request(appWith({ permissions: [] }))
            .get('/api/schedule/time-off?from=2026-07-18T00:00:00.000Z&to=2026-07-25T00:00:00.000Z');
        expect(res.status).toBe(403);
        expect(anyTimeOffTableCalls()).toHaveLength(0);
    });

    it('unauthenticated chain (no req.user) → 401, no table access', async () => {
        const app = unauthenticatedApp();
        for (const call of [
            () => request(app).get('/api/schedule/time-off?from=a&to=b'),
            () => request(app).post('/api/schedule/time-off').send({}),
            () => request(app).delete(`/api/schedule/time-off/${ROW_ID}`),
        ]) {
            const res = await call();
            expect(res.status).toBe(401);
        }
        expect(anyTimeOffTableCalls()).toHaveLength(0);
    });
});
