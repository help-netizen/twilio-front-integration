/**
 * MOBILE-TECH-APP-001 / MTECH-T1
 * GET /api/sync/jobs — provider-scoped delta endpoint + syncQueries.
 *
 * DB is mocked (house pattern: jest.mock the pg connection). The mock only proves
 * the SQL STRING + params the handler builds — the REAL migration 150 and the
 * real changed/unassigned/tombstones queries are exercised separately against a
 * live Postgres in a ROLLBACK transaction (LIST-PAGINATION-001 lesson).
 */

jest.mock('../backend/src/db/connection', () => ({ query: jest.fn() }));
jest.mock('../backend/src/services/twilioSync', () => ({
    syncTodayCalls: jest.fn(), syncRecentCalls: jest.fn(),
}));
jest.mock('../backend/src/services/auditService', () => ({ log: jest.fn(async () => {}) }));

const http = require('http');
const express = require('express');
const db = require('../backend/src/db/connection');
const syncQueries = require('../backend/src/db/syncQueries');
const twilioSync = require('../backend/src/services/twilioSync');

const COMPANY_A = '00000000-0000-0000-0000-00000000000a';
const COMPANY_B = '00000000-0000-0000-0000-00000000000b';
const PROVIDER_A = '11111111-1111-1111-1111-11111111111a';

beforeEach(() => {
    db.query.mockReset();
    twilioSync.syncTodayCalls.mockReset();
    twilioSync.syncRecentCalls.mockReset();
});

// ─── helpers ────────────────────────────────────────────────────────────────

function request(app, method, path, extraHeaders = {}) {
    return new Promise((resolve, reject) => {
        const server = app.listen(0, () => {
            const req = http.request({
                hostname: '127.0.0.1',
                port: server.address().port,
                path, method,
                headers: { 'Content-Type': 'application/json', ...extraHeaders },
            }, (res) => {
                let data = '';
                res.on('data', c => (data += c));
                res.on('end', () => { server.close(); resolve({ status: res.statusCode, body: data ? JSON.parse(data) : null }); });
            });
            req.on('error', e => { server.close(); reject(e); });
            req.end();
        });
    });
}

// Build an app mounting the REAL sync router under the same middleware shape as
// src/server.js (authenticate, requireCompanyAccess) — here injected inline so
// we can vary permissions / scope / crm_user / company. Passing `authz:null`
// simulates an unauthenticated request reaching a permission gate.
function appWithAuthz({ permissions = ['jobs.view'], scopes = { job_visibility: 'assigned_only' }, userId = PROVIDER_A, companyId = COMPANY_A, unauth = false } = {}) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
        if (unauth) { req.authz = { permissions: [] }; return next(); }
        req.user = { sub: 'kc-sub', email: 'p@x.com', crmUser: userId ? { id: userId } : undefined };
        req.authz = {
            scope: 'tenant',
            permissions,
            scopes,
            company: { id: companyId },
            membership: { role_key: 'provider' },
        };
        req.companyFilter = { company_id: companyId };
        next();
    });
    app.use('/', require('../backend/src/routes/sync'));
    return app;
}

/** A minimal raw jobs row as the DB would return it (Date objects for timestamps). */
function jobRow(id, updatedAtIso, over = {}) {
    return {
        id,
        company_id: COMPANY_A,
        blanc_status: 'Submitted',
        zb_status: 'scheduled',
        assigned_provider_user_ids: [PROVIDER_A],
        assigned_techs: [],
        notes: [],
        start_date: null,
        end_date: null,
        created_at: new Date('2026-01-01T00:00:00.000Z'),
        updated_at: new Date(updatedAtIso),
        ...over,
    };
}

// ─── syncQueries.parseCursor ─────────────────────────────────────────────────

describe('syncQueries.parseCursor', () => {
    it('returns null for empty/undefined (→ initial full sync)', () => {
        expect(syncQueries.parseCursor(undefined)).toBeNull();
        expect(syncQueries.parseCursor('')).toBeNull();
        expect(syncQueries.parseCursor(null)).toBeNull();
    });
    it('parses "{ISO}|{id}" into normalized ts + id', () => {
        const c = syncQueries.parseCursor('2026-07-02T15:04:05.123Z|4420');
        expect(c).toEqual({ ts: '2026-07-02T15:04:05.123Z', id: '4420' });
    });
    it('throws on a missing separator', () => {
        expect(() => syncQueries.parseCursor('2026-07-02T15:04:05.123Z')).toThrow();
    });
    it('throws on an unparseable timestamp', () => {
        expect(() => syncQueries.parseCursor('not-a-date|5')).toThrow();
    });
    it('throws on a non-integer id', () => {
        expect(() => syncQueries.parseCursor('2026-07-02T15:04:05.123Z|abc')).toThrow();
    });
});

// ─── syncQueries.getChangedJobs — cursor / tiebreak / has_more ───────────────

describe('syncQueries.getChangedJobs', () => {
    it('incremental builds a forward (updated_at,id) > cursor predicate, ASC order, LIMIT+1', async () => {
        db.query
            .mockResolvedValueOnce({ rows: [] })   // changed page
            .mockResolvedValueOnce({ rows: [] });  // attachments (jobIds empty → still guarded, but called only if ids)
        await syncQueries.getChangedJobs({
            companyId: COMPANY_A, crmUserId: PROVIDER_A,
            cursor: { ts: '2026-07-02T00:00:00.000Z', id: '100' }, limit: 200, windowDays: 30,
        });
        const [sql, params] = db.query.mock.calls[0];
        expect(sql).toContain('j.company_id = $1');
        expect(sql).toContain('j.assigned_provider_user_ids @> $2::jsonb');
        expect(sql).toContain('(j.updated_at, j.id) > ($3, $4)');
        expect(sql).toContain('ORDER BY j.updated_at ASC, j.id ASC');
        // has_more detection → LIMIT is limit+1
        expect(sql).toMatch(/LIMIT \$5/);
        expect(params[0]).toBe(COMPANY_A);
        expect(params[1]).toBe(JSON.stringify([PROVIDER_A]));
        expect(params[2]).toBe('2026-07-02T00:00:00.000Z');
        expect(params[3]).toBe('100');
        expect(params[4]).toBe(201);
    });

    it('initial full sync uses the window + open-status arm instead of a cursor', async () => {
        db.query.mockResolvedValueOnce({ rows: [] });
        await syncQueries.getChangedJobs({
            companyId: COMPANY_A, crmUserId: PROVIDER_A, cursor: null, limit: 200, windowDays: 30,
        });
        const [sql, params] = db.query.mock.calls[0];
        expect(sql).not.toContain('(j.updated_at, j.id) >');
        expect(sql).toContain('start_date >= now()');
        expect(sql).toContain('blanc_status <> ALL');
        expect(params).toContain('30');            // windowDays
        expect(params).toContainEqual(syncQueries.TERMINAL_BLANC_STATUSES);
    });

    it('detects has_more via the extra row and drops it; nextCursor = last kept row', async () => {
        // limit 2 → fetch 3; return 3 rows so hasMore true and the 3rd is popped.
        db.query
            .mockResolvedValueOnce({ rows: [
                jobRow(10, '2026-07-01T00:00:00.000Z'),
                jobRow(11, '2026-07-01T00:00:00.000Z'),
                jobRow(12, '2026-07-02T00:00:00.000Z'),
            ] })
            .mockResolvedValueOnce({ rows: [] }); // attachments
        const out = await syncQueries.getChangedJobs({
            companyId: COMPANY_A, crmUserId: PROVIDER_A, cursor: null, limit: 2, windowDays: 30,
        });
        expect(out.hasMore).toBe(true);
        expect(out.jobs.map(j => j.id)).toEqual([10, 11]);   // 12 popped
        // cursor from the LAST KEPT row (id 11 @ its updated_at), not the popped one
        expect(out.nextCursor).toBe('2026-07-01T00:00:00.000Z|11');
    });

    it('tiebreak: same updated_at across a page boundary keeps id ordering (no loss/dup)', async () => {
        // Three rows share updated_at; page size 2 → next cursor is "...|11", so the
        // next call's (updated_at,id) > (ts,11) yields exactly id 12 — no overlap.
        db.query
            .mockResolvedValueOnce({ rows: [
                jobRow(10, '2026-07-01T00:00:00.000Z'),
                jobRow(11, '2026-07-01T00:00:00.000Z'),
                jobRow(12, '2026-07-01T00:00:00.000Z'),
            ] })
            .mockResolvedValueOnce({ rows: [] });
        const page1 = await syncQueries.getChangedJobs({
            companyId: COMPANY_A, crmUserId: PROVIDER_A, cursor: null, limit: 2, windowDays: 30,
        });
        expect(page1.nextCursor).toBe('2026-07-01T00:00:00.000Z|11');

        db.query.mockReset();
        db.query
            .mockResolvedValueOnce({ rows: [jobRow(12, '2026-07-01T00:00:00.000Z')] })
            .mockResolvedValueOnce({ rows: [] });
        const page2 = await syncQueries.getChangedJobs({
            companyId: COMPANY_A, crmUserId: PROVIDER_A,
            cursor: { ts: '2026-07-01T00:00:00.000Z', id: '11' }, limit: 2, windowDays: 30,
        });
        expect(page2.jobs.map(j => j.id)).toEqual([12]);
        // id 11 (the page-1 boundary) is neither repeated nor skipped.
        const [sql, params] = db.query.mock.calls[0];
        expect(sql).toContain('(j.updated_at, j.id) > ($3, $4)');
        expect(params[3]).toBe('11');
    });

    it('enriches notes[] with attachments as {id,fileName,contentType,fileSize} — NO url', async () => {
        db.query
            .mockResolvedValueOnce({ rows: [jobRow(20, '2026-07-01T00:00:00.000Z', {
                notes: [{ id: 'n1', text: 'hello' }],
            })] })
            .mockResolvedValueOnce({ rows: [
                { job_id: 20, id: 555, note_index: 0, note_id: 'n1', file_name: 'p.jpg', content_type: 'image/jpeg', file_size: 1234 },
            ] });
        const out = await syncQueries.getChangedJobs({
            companyId: COMPANY_A, crmUserId: PROVIDER_A, cursor: null, limit: 200, windowDays: 30,
        });
        const note = out.jobs[0].notes[0];
        expect(note.attachments).toEqual([{ id: 555, fileName: 'p.jpg', contentType: 'image/jpeg', fileSize: 1234 }]);
        expect(note.attachments[0]).not.toHaveProperty('url');
    });

    it('does not run the attachments query when the page is empty', async () => {
        db.query.mockResolvedValueOnce({ rows: [] });
        await syncQueries.getChangedJobs({
            companyId: COMPANY_A, crmUserId: PROVIDER_A, cursor: null, limit: 200, windowDays: 30,
        });
        expect(db.query).toHaveBeenCalledTimes(1); // only the changed query
    });
});

// ─── syncQueries.getUnassignedJobIds / getTombstoneJobIds ────────────────────

describe('syncQueries.getUnassignedJobIds', () => {
    it('incremental returns ids of company jobs NOT visible under scope, changed since', async () => {
        db.query.mockResolvedValueOnce({ rows: [{ id: 4412 }, { id: 4417 }] });
        const ids = await syncQueries.getUnassignedJobIds({
            companyId: COMPANY_A, crmUserId: PROVIDER_A, cursor: { ts: '2026-07-01T00:00:00.000Z', id: '1' },
        });
        expect(ids).toEqual([4412, 4417]);
        const [sql, params] = db.query.mock.calls[0];
        expect(sql).toContain('j.company_id = $1');
        expect(sql).toContain('j.updated_at > $2');
        expect(sql).toContain('NOT (j.assigned_provider_user_ids @> $3::jsonb)');
        expect(params).toEqual([COMPANY_A, '2026-07-01T00:00:00.000Z', JSON.stringify([PROVIDER_A])]);
    });
    it('returns [] on initial full sync (cursor null) without querying', async () => {
        const ids = await syncQueries.getUnassignedJobIds({ companyId: COMPANY_A, crmUserId: PROVIDER_A, cursor: null });
        expect(ids).toEqual([]);
        expect(db.query).not.toHaveBeenCalled();
    });
});

describe('syncQueries.getTombstoneJobIds', () => {
    it('incremental selects job_id from job_tombstones since the cursor', async () => {
        db.query.mockResolvedValueOnce({ rows: [{ job_id: 4390 }] });
        const ids = await syncQueries.getTombstoneJobIds({ companyId: COMPANY_A, cursor: { ts: '2026-07-01T00:00:00.000Z', id: '1' } });
        expect(ids).toEqual([4390]);
        const [sql, params] = db.query.mock.calls[0];
        expect(sql).toContain('FROM job_tombstones');
        expect(sql).toContain('company_id = $1');
        expect(sql).toContain('deleted_at > $2');
        expect(params).toEqual([COMPANY_A, '2026-07-01T00:00:00.000Z']);
    });
    it('returns [] on initial full sync without querying', async () => {
        const ids = await syncQueries.getTombstoneJobIds({ companyId: COMPANY_A, cursor: null });
        expect(ids).toEqual([]);
        expect(db.query).not.toHaveBeenCalled();
    });
});

// ─── Route contract ──────────────────────────────────────────────────────────

describe('GET /api/sync/jobs route', () => {
    it('403 without jobs.view', async () => {
        const res = await request(appWithAuthz({ permissions: [] }), 'GET', '/jobs');
        expect(res.status).toBe(403);
    });

    it('401/403 for an unauthenticated request (no authz.permissions)', async () => {
        // requirePermission denies (403 ACCESS_DENIED) — the mount-level authenticate
        // (401) is upstream in server.js; the gate here is the permission check.
        const res = await request(appWithAuthz({ unauth: true }), 'GET', '/jobs');
        expect(res.status).toBe(403);
    });

    it('400 on a malformed since cursor', async () => {
        const res = await request(appWithAuthz(), 'GET', '/jobs?since=garbage-no-pipe');
        expect(res.status).toBe(400);
        expect(res.body.ok).toBe(false);
    });

    it('deny-by-default (assigned_only, no crm_user) → 200 scope_empty, not 404, echoes since', async () => {
        const res = await request(
            appWithAuthz({ userId: null, scopes: { job_visibility: 'assigned_only' } }),
            'GET', '/jobs?since=2026-07-01T00:00:00.000Z|5'
        );
        expect(res.status).toBe(200);
        expect(res.body.data.scope_empty).toBe(true);
        expect(res.body.data.changed).toEqual([]);
        expect(res.body.data.unassigned).toEqual([]);
        expect(res.body.data.tombstones).toEqual([]);
        expect(res.body.data.has_more).toBe(false);
        expect(res.body.data.next_cursor).toBe('2026-07-01T00:00:00.000Z|5'); // echo input, don't advance
        expect(db.query).not.toHaveBeenCalled();
    });

    it('empty initial page → next_cursor null (no input since to echo)', async () => {
        db.query.mockResolvedValueOnce({ rows: [] }); // changed empty (no attachments call)
        const res = await request(appWithAuthz(), 'GET', '/jobs');
        expect(res.status).toBe(200);
        expect(res.body.data.scope_empty).toBe(false);
        expect(res.body.data.next_cursor).toBeNull();
        expect(res.body.data.has_more).toBe(false);
    });

    it('last page (has_more:false) returns unassigned + tombstones; incremental', async () => {
        db.query
            .mockResolvedValueOnce({ rows: [
                { id: 30, company_id: COMPANY_A, blanc_status: 'Submitted', zb_status: 'scheduled',
                  assigned_provider_user_ids: [PROVIDER_A], assigned_techs: [], notes: [],
                  start_date: null, end_date: null, created_at: new Date('2026-01-01T00:00:00Z'),
                  updated_at: new Date('2026-07-02T10:00:00.000Z') },
            ] })                                   // changed (1 row, < limit → last page)
            .mockResolvedValueOnce({ rows: [] })   // attachments
            .mockResolvedValueOnce({ rows: [{ id: 4412 }] })   // unassigned
            .mockResolvedValueOnce({ rows: [{ job_id: 4390 }] }); // tombstones
        const res = await request(appWithAuthz(), 'GET', '/jobs?since=2026-07-01T00:00:00.000Z|1');
        expect(res.status).toBe(200);
        expect(res.body.data.has_more).toBe(false);
        expect(res.body.data.changed.map(j => j.id)).toEqual([30]);
        expect(res.body.data.unassigned).toEqual([4412]);
        expect(res.body.data.tombstones).toEqual([4390]);
        expect(res.body.data.next_cursor).toBe('2026-07-02T10:00:00.000Z|30');
    });

    it('NON-last page (has_more:true) withholds unassigned + tombstones', async () => {
        // limit=1 → fetch 2; return 2 → hasMore true → deletions must be [].
        const mk = (id, ts) => ({ id, company_id: COMPANY_A, blanc_status: 'Submitted', zb_status: 'scheduled',
            assigned_provider_user_ids: [PROVIDER_A], assigned_techs: [], notes: [], start_date: null, end_date: null,
            created_at: new Date('2026-01-01T00:00:00Z'), updated_at: new Date(ts) });
        db.query
            .mockResolvedValueOnce({ rows: [mk(40, '2026-07-02T09:00:00.000Z'), mk(41, '2026-07-02T09:30:00.000Z')] })
            .mockResolvedValueOnce({ rows: [] }); // attachments only; NO unassigned/tombstones queries
        const res = await request(appWithAuthz(), 'GET', '/jobs?since=2026-07-01T00:00:00.000Z|1&limit=1');
        expect(res.status).toBe(200);
        expect(res.body.data.has_more).toBe(true);
        expect(res.body.data.changed.map(j => j.id)).toEqual([40]);
        expect(res.body.data.unassigned).toEqual([]);
        expect(res.body.data.tombstones).toEqual([]);
        // Only changed + attachments ran (2 db calls) — deletions withheld until last page.
        expect(db.query).toHaveBeenCalledTimes(2);
    });

    it('reassign-away surfaces in unassigned (last page)', async () => {
        db.query
            .mockResolvedValueOnce({ rows: [] })                 // changed empty
            .mockResolvedValueOnce({ rows: [{ id: 4412 }] })     // unassigned (no attachments call — page empty)
            .mockResolvedValueOnce({ rows: [] });                // tombstones
        const res = await request(appWithAuthz(), 'GET', '/jobs?since=2026-07-01T00:00:00.000Z|1');
        expect(res.status).toBe(200);
        expect(res.body.data.unassigned).toEqual([4412]);
    });

    it('cross-tenant isolation: company_id comes from authz, scoped in every query', async () => {
        db.query.mockResolvedValueOnce({ rows: [] }); // changed empty
        await request(appWithAuthz({ companyId: COMPANY_B }), 'GET', '/jobs');
        const [, params] = db.query.mock.calls[0];
        // First param of the changed query is the caller's own company (B), never A.
        expect(params[0]).toBe(COMPANY_B);
        expect(params[0]).not.toBe(COMPANY_A);
    });

    it('respects limit clamp (max 500) in the changed query', async () => {
        db.query.mockResolvedValueOnce({ rows: [] });
        await request(appWithAuthz(), 'GET', '/jobs?limit=99999');
        const [sql, params] = db.query.mock.calls[0];
        // limit clamped to 500 → LIMIT param is 501.
        const limitParam = params[params.length - 1];
        expect(limitParam).toBe(501);
        expect(sql).toMatch(/LIMIT \$\d+/);
    });
});

describe('POST /api/sync manual call refresh RBAC', () => {
    it.each([
        ['provider', '/today'],
        ['provider', '/recent'],
    ])('R-matrix: %s without reports.calls.view is denied %s', async (_role, path) => {
        const res = await request(
            appWithAuthz({ permissions: ['pulse.view'] }),
            'POST', path
        );

        expect(res.status).toBe(403);
        expect(twilioSync.syncTodayCalls).not.toHaveBeenCalled();
        expect(twilioSync.syncRecentCalls).not.toHaveBeenCalled();
    });

    it('dispatcher can run the company-scoped today refresh', async () => {
        twilioSync.syncTodayCalls.mockResolvedValue({ synced: 2, skipped: 0, total: 2 });

        const res = await request(
            appWithAuthz({ permissions: ['reports.calls.view'], companyId: COMPANY_B }),
            'POST', '/today'
        );

        expect(res.status).toBe(200);
        expect(twilioSync.syncTodayCalls).toHaveBeenCalledWith(COMPANY_B);
    });

    it('dispatcher can run the company-scoped recent refresh', async () => {
        twilioSync.syncRecentCalls.mockResolvedValue(3);

        const res = await request(
            appWithAuthz({ permissions: ['reports.calls.view'], companyId: COMPANY_B }),
            'POST', '/recent'
        );

        expect(res.status).toBe(200);
        expect(twilioSync.syncRecentCalls).toHaveBeenCalledWith(COMPANY_B);
    });
});
