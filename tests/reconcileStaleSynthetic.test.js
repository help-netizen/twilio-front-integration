/**
 * reconcileStaleSynthetic.test.js — OUTBOUND-CALL-TIMELINE-001, CT-02 unit slice.
 *
 * Binding: Docs/specs/OUTBOUND-CALL-TIMELINE-001.md S5 + Docs/tasks.md CT-02.
 *   - The 5-min stale reconciler (`reconcileStale.reconcileStaleCalls`) must NEVER
 *     poll a synthetic `vapi:%` row against Twilio — a 404 there would mark a LIVE
 *     robot call `failed` mid-call. It is guarded out by `AND call_sid LIKE 'CA%'`.
 *   - Real `CA%` rows still reconcile byte-identically.
 *   - A bounded synthetic sweeper finalizes `vapi:%` rows older than 15 min to
 *     `failed`/`is_final=true`, company-scoped, leaving fresh synthetic rows alone.
 *   - Hot-path feed `callsQueries.getNonFinalCalls` carries the same CA guard.
 *
 * The DB is a faithful in-memory mock that HONORS the `LIKE 'CA%'` / `LIKE 'vapi:%'`
 * / age predicates, so removing a guard makes the regression test go red behaviorally
 * (Twilio gets called on a synthetic sid → 404 → the live row is wrongly failed) —
 * not merely a string mismatch.
 */
'use strict';

// ---- in-memory DB state (reset per test) -----------------------------------
let rows;                 // the `calls` table
let fetchedSids;          // every call_sid handed to the Twilio REST client
let sqlLog;               // every SQL string db.query received

const MIN = 60 * 1000;
const minutesAgo = (m) => new Date(Date.now() - m * MIN);

function parseIntervalMinutes(normSql) {
    const m = normSql.match(/INTERVAL '(\d+) minutes'/);
    return m ? parseInt(m[1], 10) : 0;
}
const olderThan = (startedAt, minutes) =>
    startedAt instanceof Date && startedAt.getTime() < Date.now() - minutes * MIN;

// Faithful mini-`calls` DB: interprets the SQL the reconciler actually runs.
function mockDbQuery(sql, params = []) {
    const s = String(sql).replace(/\s+/g, ' ').trim();
    sqlLog.push(s);

    // --- synthetic sweeper UPDATE (marks stale vapi:% rows failed) ---
    if (s.startsWith('UPDATE calls') && s.includes("LIKE 'vapi:%'")) {
        const mins = parseIntervalMinutes(s);
        const hit = rows.filter(
            (r) => r.is_final === false && r.call_sid.startsWith('vapi:') && olderThan(r.started_at, mins),
        );
        for (const r of hit) {
            r.status = 'failed';
            r.is_final = true;
            r.ended_at = r.ended_at || new Date();
        }
        return Promise.resolve({ rows: hit.map((r) => ({ call_sid: r.call_sid, company_id: r.company_id })) });
    }

    // --- Twilio-404 danger path: UPDATE calls SET status = 'failed' WHERE call_sid = $1 ---
    if (s.startsWith('UPDATE calls') && s.includes("status = 'failed'") && s.includes('WHERE call_sid = $1')) {
        const r = rows.find((x) => x.call_sid === params[0]);
        if (r) { r.status = 'failed'; r.is_final = true; r._failedBy404 = true; }
        return Promise.resolve({ rows: [], rowCount: r ? 1 : 0 });
    }

    // --- main success UPDATE from Twilio truth: SET status = $2, is_final = $3, ... ---
    if (s.startsWith('UPDATE calls') && s.includes('status = $2, is_final = $3')) {
        const r = rows.find((x) => x.call_sid === params[0]);
        if (r) {
            r.status = params[1];
            r.is_final = params[2];
            if (params[5] != null) r.duration_sec = params[5];
        }
        return Promise.resolve({ rows: [], rowCount: r ? 1 : 0 });
    }

    // --- children lookup (parent has children?) ---
    if (s.includes('FROM calls WHERE parent_call_sid = $1')) {
        return Promise.resolve({ rows: rows.filter((r) => r.parent_call_sid === params[0]) });
    }

    // --- voicemail_recording recording-existence probe ---
    if (s.includes('FROM recordings WHERE call_sid = $1')) {
        return Promise.resolve({ rows: [] });
    }

    // --- main stale SELECT (feeds the Twilio poll). Honor the CA guard if present. ---
    if (s.includes('SELECT call_sid, parent_call_sid, status, direction, started_at')) {
        const mins = parseIntervalMinutes(s);
        const caGuarded = s.includes("LIKE 'CA%'");
        const out = rows.filter(
            (r) =>
                r.is_final === false &&
                olderThan(r.started_at, mins) &&
                (!caGuarded || r.call_sid.startsWith('CA')),
        );
        return Promise.resolve({
            rows: out.map((r) => ({
                call_sid: r.call_sid,
                parent_call_sid: r.parent_call_sid,
                status: r.status,
                direction: r.direction,
                started_at: r.started_at,
            })),
        });
    }

    return Promise.resolve({ rows: [], rowCount: 0 });
}

jest.mock('../backend/src/db/connection', () => ({ query: (...a) => mockDbQuery(...a) }));

// queries.getCallByCallSid reads live row state (company-scoped when 2nd arg given).
const mockGetCallByCallSid = jest.fn((sid, companyId = null) => {
    const r = rows.find(
        (x) => x.call_sid === sid && (companyId == null || x.company_id === companyId),
    );
    return Promise.resolve(r ? { ...r } : undefined);
});
jest.mock('../backend/src/db/queries', () => ({
    getCallByCallSid: (...a) => mockGetCallByCallSid(...a),
}));

// Twilio REST client — records every sid fetched; vapi:% sids 404 (Twilio never
// heard of them), CA% sids resolve as completed.
const mockFetch = jest.fn((sid) => {
    fetchedSids.push(sid);
    if (sid.startsWith('vapi:')) {
        const e = new Error('not found'); e.status = 404;
        return Promise.reject(e);
    }
    return Promise.resolve({
        status: 'completed',
        startTime: minutesAgo(6),
        endTime: minutesAgo(4),
        duration: '120',
        price: '-0.02',
        priceUnit: 'USD',
    });
});
jest.mock('../backend/src/services/twilioClient', () => ({
    getTwilioClient: () => ({ calls: (sid) => ({ fetch: () => mockFetch(sid) }) }),
}));

const mockPublish = jest.fn();
jest.mock('../backend/src/services/realtimeService', () => ({
    publishCallUpdate: (...a) => mockPublish(...a),
}));

const { reconcileStaleCalls } = require('../backend/src/services/reconcileStale');
const callsQueries = require('../backend/src/db/callsQueries');

let logSpy;
let errSpy;
beforeEach(() => {
    jest.clearAllMocks();
    rows = [];
    fetchedSids = [];
    sqlLog = [];
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
    logSpy.mockRestore();
    errSpy.mockRestore();
});

const rowOf = (sid) => rows.find((r) => r.call_sid === sid);

// =============================================================================
// (a) REGRESSION GUARD — a live synthetic row is invisible to the Twilio poller
// =============================================================================
describe('CT-02 (a) synthetic row is never polled/failed by the 3-min stale sweep', () => {
    it('a non-final vapi:% row inside the normal window is not fetched from Twilio and stays live', async () => {
        rows.push({
            call_sid: 'vapi:v-live', company_id: 'co-1', status: 'ringing', is_final: false,
            parent_call_sid: null, direction: 'outbound', started_at: minutesAgo(5), ended_at: null,
        });

        const res = await reconcileStaleCalls();

        // never handed to Twilio
        expect(fetchedSids).not.toContain('vapi:v-live');
        expect(mockFetch).not.toHaveBeenCalled();
        // still live — NOT killed by a 404
        expect(rowOf('vapi:v-live').is_final).toBe(false);
        expect(rowOf('vapi:v-live').status).toBe('ringing');
        expect(rowOf('vapi:v-live')._failedBy404).toBeUndefined();
        // 5 min < 15 min synthetic threshold → sweeper leaves it alone too
        expect(res.sweptSynthetic).toBe(0);
    });

    it('the stale SELECT that feeds the Twilio poll carries the CA guard', async () => {
        await reconcileStaleCalls();
        const staleSelect = sqlLog.find((s) =>
            s.includes('SELECT call_sid, parent_call_sid, status, direction, started_at'),
        );
        expect(staleSelect).toBeTruthy();
        expect(staleSelect).toMatch(/is_final = false AND call_sid LIKE 'CA%'/);
    });
});

// =============================================================================
// (b) A real CA% row still reconciles exactly as before
// =============================================================================
describe('CT-02 (b) real CA% rows reconcile byte-identically', () => {
    it('a non-final CA row older than 3 min is fetched from Twilio and finalized + SSE', async () => {
        rows.push({
            call_sid: 'CA100', company_id: 'co-1', status: 'ringing', is_final: false,
            parent_call_sid: null, direction: 'inbound', started_at: minutesAgo(5), ended_at: null,
        });

        const res = await reconcileStaleCalls();

        expect(fetchedSids).toContain('CA100');
        expect(rowOf('CA100').is_final).toBe(true);
        expect(rowOf('CA100').status).toBe('completed');
        expect(mockPublish).toHaveBeenCalledWith(
            expect.objectContaining({ eventType: 'call.updated', call_sid: 'CA100' }),
        );
        expect(res.reconciled).toBe(1);
    });
});

// =============================================================================
// (c) Synthetic sweeper — finalize >15-min vapi rows, leave fresh ones, scoped
// =============================================================================
describe('CT-02 (c) bounded synthetic sweeper (S5.2)', () => {
    it('finalizes a >15-min vapi:% row to failed (company-scoped) and leaves a fresh one alone', async () => {
        rows.push({
            call_sid: 'vapi:old', company_id: 'co-9', status: 'ringing', is_final: false,
            parent_call_sid: null, direction: 'outbound', started_at: minutesAgo(20), ended_at: null,
        });
        rows.push({
            call_sid: 'vapi:fresh', company_id: 'co-9', status: 'ringing', is_final: false,
            parent_call_sid: null, direction: 'outbound', started_at: minutesAgo(2), ended_at: null,
        });

        const res = await reconcileStaleCalls();

        // old one finalized with the spec's terminal status
        expect(rowOf('vapi:old').is_final).toBe(true);
        expect(rowOf('vapi:old').status).toBe('failed');
        expect(rowOf('vapi:old').ended_at).toBeInstanceOf(Date);
        // fresh one untouched
        expect(rowOf('vapi:fresh').is_final).toBe(false);
        expect(rowOf('vapi:fresh').status).toBe('ringing');
        // company-scoped SSE re-read (call_sid + its own company_id)
        expect(mockGetCallByCallSid).toHaveBeenCalledWith('vapi:old', 'co-9');
        expect(mockPublish).toHaveBeenCalledWith(
            expect.objectContaining({ eventType: 'call.updated', call_sid: 'vapi:old' }),
        );
        // never polled Twilio for either synthetic sid
        expect(fetchedSids).toHaveLength(0);
        expect(res.sweptSynthetic).toBe(1);
    });

    it('a synthetic sweep failure never crashes the reconciler (non-fatal)', async () => {
        // Force the sweeper UPDATE to throw; the CA sweep must still complete.
        rows.push({
            call_sid: 'CA200', company_id: 'co-1', status: 'ringing', is_final: false,
            parent_call_sid: null, direction: 'inbound', started_at: minutesAgo(5), ended_at: null,
        });
        const conn = require('../backend/src/db/connection');
        const orig = conn.query;
        const spy = jest.spyOn(conn, 'query').mockImplementation((sql, params) => {
            if (String(sql).replace(/\s+/g, ' ').includes("LIKE 'vapi:%'")) {
                return Promise.reject(new Error('sweeper DB down'));
            }
            return orig(sql, params);
        });

        const res = await reconcileStaleCalls();

        expect(res.reconciled).toBe(1);        // CA path unaffected
        expect(rowOf('CA200').status).toBe('completed');
        spy.mockRestore();
    });
});

// =============================================================================
// getNonFinalCalls (hot-path feed) — CA guard present
// =============================================================================
describe('CT-02 getNonFinalCalls hot-path feed carries the CA guard', () => {
    it('emits AND call_sid LIKE \'CA%\' in the SQL', async () => {
        await callsQueries.getNonFinalCalls(6);
        const feedSelect = sqlLog.find((s) => s.includes('SELECT * FROM calls'));
        expect(feedSelect).toBeTruthy();
        expect(feedSelect).toMatch(/is_final = false AND call_sid LIKE 'CA%'/);
    });
});
