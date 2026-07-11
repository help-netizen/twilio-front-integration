/**
 * SCHED-ROUTE-VIS-001 RV-04b — FR-2 lazy-on-read seed + city mapper
 * (TC-RV-18..31, TC-RV-40).
 *
 * Covers:
 *   - routeQueries.getMissingTechDaysInRange SQL shape (parameterized,
 *     company-scoped, participation rules, COUNT>=2, OR-pending, ORDER/LIMIT,
 *     optional technicianId, jobs-only detection)
 *   - routeSegmentService.enqueueRouteCalcDeduped (queued-only NOT EXISTS guard)
 *   - routeSegmentService.seedMissingForRange (from/to guard, cap, stuck-pending
 *     self-heal via deduped path, non-fatal errors)
 *   - scheduleService.getRouteSegments (response never waits for the seed,
 *     techFilter forwarded, `{ segments }` contract pinned)
 *   - rowToScheduleItem city mapping via getScheduleItems (subtitle untouched)
 *
 * Style: mocked db.query (routeQueries/routeSegmentService/scheduleService are
 * REAL; higher layers observed via jest.spyOn on the shared module objects).
 * global.fetch is asserted untouched in EVERY case (TC-RV-34 runtime guard, INV-1).
 */

jest.mock('../backend/src/db/connection', () => ({ query: jest.fn(), pool: { end: jest.fn() } }));
jest.mock('../backend/src/db/scheduleQueries');

const db = require('../backend/src/db/connection');
const routeQueries = require('../backend/src/db/routeQueries');           // REAL
const routeSeg = require('../backend/src/services/routeSegmentService');  // REAL
const scheduleQueries = require('../backend/src/db/scheduleQueries');     // mocked
const scheduleService = require('../backend/src/services/scheduleService'); // REAL

const CO = 'co-1';
const TZ = 'America/New_York';
const RANGE = { from: '2026-07-01', to: '2026-07-07' };

const norm = (sql) => String(sql).replace(/\s+/g, ' ').trim();
const microFlush = () => new Promise(r => setImmediate(r));
const dbCalls = (re) => db.query.mock.calls.filter(c => re.test(c[0]));

beforeEach(() => {
    jest.clearAllMocks();
    global.fetch = jest.fn();
    db.query.mockResolvedValue({ rows: [], rowCount: 1 });
});

afterEach(() => {
    // TC-RV-34 (runtime half, INV-1): no seed/read path ever touches Google/fetch.
    expect(global.fetch).not.toHaveBeenCalled();
    jest.restoreAllMocks();
});

// =============================================================================
// getMissingTechDaysInRange — TC-RV-18, 19, 40
// =============================================================================

describe('routeQueries.getMissingTechDaysInRange — SQL shape (S-9/S-12/S-14/E-1)', () => {
    // TC-RV-18: one parameterized company-scoped query with the participation
    // rules of getParticipatingJobsForTechDay, COUNT>=2, OR-pending, ORDER/LIMIT.
    test('TC-RV-18: parameterized, company-scoped, COUNT>=2, no-active OR pending, ORDER BY + LIMIT cap', async () => {
        db.query.mockResolvedValueOnce({ rows: [{ technician_id: 'tech-A', schedule_date: '2026-07-03' }] });
        const out = await routeQueries.getMissingTechDaysInRange(CO, RANGE, TZ, 10);

        expect(db.query).toHaveBeenCalledTimes(1);
        const [sql, params] = db.query.mock.calls[0];
        const s = norm(sql);
        // Company scope + fan-out over the internal assignee mirror.
        expect(s).toContain('company_id = $1');
        expect(s).toContain('jsonb_array_elements_text(assigned_provider_user_ids)');
        // Participation rules (same as getParticipatingJobsForTechDay).
        expect(s).toContain('start_date IS NOT NULL');
        expect(s).toContain('blanc_status <> ALL($5)');
        expect(s).toContain('AT TIME ZONE $2');                    // company-local day
        expect(s).toContain('COUNT(*) >= 2');                      // S-12: pairs need ≥2 jobs
        // Predicate: (no active segment at all) OR (an active pending exists).
        expect(s).toMatch(/NOT EXISTS \( SELECT 1 FROM schedule_route_segments/);
        expect(s).toContain("s.status <> 'stale'");
        expect(s).toMatch(/OR EXISTS \( SELECT 1 FROM schedule_route_segments/);
        expect(s).toContain("s.status = 'pending'");               // S-14: stuck-pending self-heal
        expect(s).toContain('ORDER BY schedule_date');
        expect(s).toContain('LIMIT $6');
        // Fully parameterized — no value interpolation ($n only).
        expect(s).not.toContain(CO);
        expect(s).not.toContain(RANGE.from);
        expect(s).not.toContain(RANGE.to);
        expect(s).not.toContain(TZ);
        expect(params).toEqual([CO, TZ, RANGE.from, RANGE.to, routeQueries.EXCLUDED_STATUSES, 10]);

        expect(out).toEqual([{ technicianId: 'tech-A', scheduleDate: '2026-07-03' }]);
    });

    // TC-RV-19 (S-10/INV-3): optional technicianId adds exactly one predicate + param.
    test('TC-RV-19: optional technicianId — predicate present only when passed, rest identical', async () => {
        await routeQueries.getMissingTechDaysInRange(CO, { ...RANGE, technicianId: 'tech-A' }, TZ, 10);
        await routeQueries.getMissingTechDaysInRange(CO, RANGE, TZ, 10);

        const [sqlWith, paramsWith] = db.query.mock.calls[0];
        const [sqlWithout, paramsWithout] = db.query.mock.calls[1];

        expect(norm(sqlWith)).toContain('td.technician_id = $7');
        expect(paramsWith).toEqual([CO, TZ, RANGE.from, RANGE.to, routeQueries.EXCLUDED_STATUSES, 10, 'tech-A']);
        expect(norm(sqlWithout)).not.toContain('technician_id = $7');
        expect(paramsWithout).toHaveLength(6);
        // Removing the tech predicate yields the exact filter-less SQL.
        expect(norm(sqlWith).replace(' AND td.technician_id = $7', '')).toBe(norm(sqlWithout));
    });

    // TC-RV-40 (E-2): candidate rows come from jobs ONLY — a lead/task between two
    // jobs neither feeds COUNT(*)>=2 nor breaks an A→B pair.
    test('TC-RV-40: detection reads only jobs (+ segment table in predicates) — no leads/tasks', async () => {
        await routeQueries.getMissingTechDaysInRange(CO, RANGE, TZ, 10);
        const s = norm(db.query.mock.calls[0][0]);
        expect(s).toMatch(/FROM jobs,/);                          // the single row source
        expect(s).not.toMatch(/\bleads\b/i);
        expect(s).not.toMatch(/\btasks\b/i);                      // deduped enqueue is a DIFFERENT function
        // Every FROM references either jobs or schedule_route_segments.
        for (const m of s.match(/FROM ([a-z_]+)/g) || []) {
            expect(['FROM jobs', 'FROM schedule_route_segments']).toContain(m);
        }
    });
});

// =============================================================================
// enqueueRouteCalcDeduped — TC-RV-20, 21
// =============================================================================

describe('routeSegmentService.enqueueRouteCalcDeduped (S-11/E-7)', () => {
    // TC-RV-20: INSERT..SELECT..WHERE NOT EXISTS guarded ONLY by agent_status='queued'.
    test("TC-RV-20: dedup INSERT guarded by queued-only NOT EXISTS ('running' NOT guarded)", async () => {
        await routeSeg.enqueueRouteCalcDeduped(CO, 'tech-A', '2026-07-03');

        expect(db.query).toHaveBeenCalledTimes(1);
        const [sql, params] = db.query.mock.calls[0];
        const s = norm(sql);
        expect(s).toMatch(/INSERT INTO tasks .* SELECT .* WHERE NOT EXISTS/);
        expect(s).toMatch(/NOT EXISTS \( SELECT 1 FROM tasks WHERE company_id = \$1/);
        expect(s).toContain("kind = 'agent'");
        expect(s).toContain("agent_type = 'route_calc'");
        expect(s).toContain("agent_status = 'queued'");
        expect(s).not.toContain("'running'");                     // E-7: deliberately NOT guarded
        expect(s).toContain("agent_input->>'technician_id' = $2");
        expect(s).toContain("agent_input->>'schedule_date' = $3");
        expect(params.slice(0, 3)).toEqual([CO, 'tech-A', '2026-07-03']);
        expect(JSON.parse(params[3])).toEqual({ technician_id: 'tech-A', schedule_date: '2026-07-03' });

        // Plain enqueueRouteCalc is untouched beside it (TC-RV-33): no dedup guard.
        db.query.mockClear();
        await routeSeg.enqueueRouteCalc(CO, 'tech-A', '2026-07-03');
        expect(norm(db.query.mock.calls[0][0])).not.toContain('NOT EXISTS');
    });

    // TC-RV-21: rowCount 0 (queued exists → no-op) and 1 (inserted) both resolve.
    // NB: a duplicate task beside a RUNNING one is allowed BY DESIGN (guard is
    // queued-only, E-7) — the extra task is a no-op for the worker; we do NOT
    // assert the opposite.
    test('TC-RV-21: no-throw on both dedup outcomes (0 = queued dup skipped, 1 = inserted)', async () => {
        db.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });   // queued already there
        await expect(routeSeg.enqueueRouteCalcDeduped(CO, 'tech-A', '2026-07-03')).resolves.toBeUndefined();
        db.query.mockResolvedValueOnce({ rows: [], rowCount: 1 });   // nothing queued → inserted
        await expect(routeSeg.enqueueRouteCalcDeduped(CO, 'tech-A', '2026-07-03')).resolves.toBeUndefined();
    });
});

// =============================================================================
// seedMissingForRange — TC-RV-22..26
// =============================================================================

// reconcileTechDay / enqueueRouteCalcDeduped are called by direct reference
// inside the real service, so their behaviour is steered through routeQueries
// spies and observed via db.query (INSERT INTO tasks with/without NOT EXISTS).
function spySeedDeps({ candidates = [], jobs = [], active = [], calculable = [] } = {}) {
    return {
        tz: jest.spyOn(routeQueries, 'getCompanyTimezone').mockResolvedValue(TZ),
        detect: jest.spyOn(routeQueries, 'getMissingTechDaysInRange').mockResolvedValue(candidates),
        participating: jest.spyOn(routeQueries, 'getParticipatingJobsForTechDay').mockResolvedValue(jobs),
        active: jest.spyOn(routeQueries, 'getActiveSegments').mockResolvedValue(active),
        stale: jest.spyOn(routeQueries, 'markSegmentsStale').mockResolvedValue(0),
        insert: jest.spyOn(routeQueries, 'insertSegment').mockResolvedValue({ id: 1 }),
        calculable: jest.spyOn(routeQueries, 'getCalculableSegments').mockResolvedValue(calculable),
    };
}

const TWO_JOBS = [{ id: 1, lat: 1, lng: 1, address: 'a' }, { id: 2, lat: 2, lng: 2, address: 'b' }];
const CAND = { technicianId: 'tech-A', scheduleDate: '2026-07-03' };

describe('routeSegmentService.seedMissingForRange (S-13/S-14/E-6)', () => {
    // TC-RV-22 (E-6, negative): missing from/to → immediate return, zero work.
    test('TC-RV-22: empty from/to guard — no db, no tz, no detection, no reconcile', async () => {
        const spies = spySeedDeps();
        await routeSeg.seedMissingForRange(CO, { from: null, to: '2026-07-07' });
        await routeSeg.seedMissingForRange(CO, { from: '2026-07-01', to: undefined });
        await routeSeg.seedMissingForRange(CO, {});
        expect(db.query).not.toHaveBeenCalled();
        expect(spies.tz).not.toHaveBeenCalled();
        expect(spies.detect).not.toHaveBeenCalled();
        expect(spies.participating).not.toHaveBeenCalled();
    });

    // TC-RV-23 (S-13): cap forwarded to detection; one reconcile per candidate
    // (observed via getParticipatingJobsForTechDay(co, tech, day, tz)).
    test('TC-RV-23: ≤cap reconciles — cap passed to detection, one reconcile per candidate with tz', async () => {
        const candidates = Array.from({ length: 10 }, (_, i) => ({
            technicianId: `tech-${i}`, scheduleDate: `2026-07-0${(i % 7) + 1}`,
        }));
        const spies = spySeedDeps({ candidates, jobs: TWO_JOBS });

        await routeSeg.seedMissingForRange(CO, RANGE);

        expect(spies.detect).toHaveBeenCalledTimes(1);
        expect(spies.detect).toHaveBeenCalledWith(CO, { from: RANGE.from, to: RANGE.to, technicianId: undefined }, TZ, 10);
        expect(spies.participating).toHaveBeenCalledTimes(10);
        candidates.forEach((c, i) => {
            expect(spies.participating.mock.calls[i]).toEqual([CO, c.technicianId, c.scheduleDate, TZ]);
        });

        // Custom cap is forwarded into detection.
        spies.detect.mockClear();
        await routeSeg.seedMissingForRange(CO, RANGE, { cap: 3 });
        expect(spies.detect).toHaveBeenCalledWith(CO, expect.any(Object), TZ, 3);
    });

    // TC-RV-24 (S-14): reconcile enqueued nothing (desired == active) but pending
    // calculable segments exist → stuck pending goes out via the DEDUPED path.
    test('TC-RV-24: stuck pending self-heals through enqueueRouteCalcDeduped exactly once', async () => {
        spySeedDeps({
            candidates: [CAND],
            jobs: TWO_JOBS,
            active: [{ from_job_id: 1, to_job_id: 2 }],   // desired == active → enqueuedCalc:false
            calculable: [{ id: 7 }],
        });

        await routeSeg.seedMissingForRange(CO, RANGE);

        const deduped = dbCalls(/NOT EXISTS/);
        expect(deduped).toHaveLength(1);
        expect(deduped[0][1].slice(0, 3)).toEqual([CO, 'tech-A', '2026-07-03']);
    });

    // TC-RV-25 (negative branches): deduped NOT used when reconcile already
    // enqueued, or when there is nothing calculable (e.g. coord-less pair, E-1).
    test('TC-RV-25a: reconcile enqueued its own route_calc → deduped path not used', async () => {
        // No active segments + 2 calculable jobs → reconcile inserts + plain-enqueues.
        const spies = spySeedDeps({ candidates: [CAND], jobs: TWO_JOBS });
        await routeSeg.seedMissingForRange(CO, RANGE);
        expect(dbCalls(/NOT EXISTS/)).toHaveLength(0);         // no deduped call
        expect(dbCalls(/INSERT INTO tasks/)).toHaveLength(1);  // the single plain enqueue
        expect(spies.calculable).not.toHaveBeenCalled();
    });

    test('TC-RV-25b: nothing to calculate → no enqueue at all', async () => {
        spySeedDeps({
            candidates: [CAND],
            jobs: TWO_JOBS,
            active: [{ from_job_id: 1, to_job_id: 2 }],   // enqueuedCalc:false
            calculable: [],                                // and nothing calculable
        });
        await routeSeg.seedMissingForRange(CO, RANGE);
        expect(dbCalls(/INSERT INTO tasks/)).toHaveLength(0);
    });

    // TC-RV-26 (non-fatal): failures inside the seed never propagate.
    test('TC-RV-26a: detection failure → resolves, logs non-fatal', async () => {
        const spies = spySeedDeps();
        spies.detect.mockRejectedValue(new Error('detect boom'));
        const ce = jest.spyOn(console, 'error').mockImplementation(() => {});
        await expect(routeSeg.seedMissingForRange(CO, RANGE)).resolves.toBeUndefined();
        expect(ce).toHaveBeenCalledWith('[Schedule] lazy route seed failed (non-fatal):', 'detect boom');
    });

    test('TC-RV-26b: reconcile failure on a candidate → resolves, logs non-fatal', async () => {
        const spies = spySeedDeps({
            candidates: [CAND,
                { technicianId: 'tech-B', scheduleDate: '2026-07-04' },
                { technicianId: 'tech-C', scheduleDate: '2026-07-05' }],
            jobs: TWO_JOBS,
        });
        spies.participating.mockRejectedValueOnce(new Error('reconcile boom'));
        const ce = jest.spyOn(console, 'error').mockImplementation(() => {});
        await expect(routeSeg.seedMissingForRange(CO, RANGE)).resolves.toBeUndefined();
        expect(ce).toHaveBeenCalledWith('[Schedule] lazy route seed failed (non-fatal):', 'reconcile boom');
    });
});

// =============================================================================
// scheduleService.getRouteSegments — TC-RV-27..30
// =============================================================================

const SEGMENT_ROW = {
    id: 1, technician_id: 't', schedule_date: '2026-07-03', from_job_id: 1, to_job_id: 2,
    distance_meters: 5000, duration_minutes: 12, travel_mode: 'driving',
    status: 'success', calculated_at: null,
};

describe('scheduleService.getRouteSegments — lazy seed wiring (S-9/S-10)', () => {
    // TC-RV-27 (S-9): the response resolves BEFORE the seed even starts (setImmediate);
    // a never-resolving seed proves the HTTP path does not await it.
    test('TC-RV-27: response never waits for the seed; seed gets the range params once', async () => {
        jest.spyOn(routeQueries, 'getSegmentsForRange').mockResolvedValue([SEGMENT_ROW]);
        const seedSpy = jest.spyOn(routeSeg, 'seedMissingForRange')
            .mockImplementation(() => new Promise(() => {}));   // never resolves

        const res = await scheduleService.getRouteSegments(CO, { ...RANGE }, null);

        expect(res).toEqual({ segments: [SEGMENT_ROW] });       // already answered
        expect(seedSpy).not.toHaveBeenCalled();                 // no synchronous part
        await microFlush();
        expect(seedSpy).toHaveBeenCalledTimes(1);
        expect(seedSpy).toHaveBeenCalledWith(CO, { from: RANGE.from, to: RANGE.to, technicianId: null });
    });

    // TC-RV-28 (S-10/INV-3, security): assigned_only provider seeds ONLY their own
    // tech-day pairs — techFilter forces the own crm_users.id, ignoring the query param.
    test('TC-RV-28: provider assigned_only → seed receives own technicianId, not the requested one', async () => {
        const rangeSpy = jest.spyOn(routeQueries, 'getSegmentsForRange').mockResolvedValue([]);
        const seedSpy = jest.spyOn(routeSeg, 'seedMissingForRange').mockResolvedValue();

        await scheduleService.getRouteSegments(CO,
            { ...RANGE, technicianId: 'someone-else' },
            { assignedOnly: true, userId: 'tech-P' });
        await microFlush();

        expect(rangeSpy).toHaveBeenCalledWith(CO, { from: RANGE.from, to: RANGE.to, technicianId: 'tech-P' });
        expect(seedSpy).toHaveBeenCalledWith(CO, { from: RANGE.from, to: RANGE.to, technicianId: 'tech-P' });
    });

    // TC-RV-29 (negative): a rejecting seed is caught after the response was sent.
    test('TC-RV-29: seed rejection → response unaffected, error caught + logged', async () => {
        jest.spyOn(routeQueries, 'getSegmentsForRange').mockResolvedValue([SEGMENT_ROW]);
        jest.spyOn(routeSeg, 'seedMissingForRange').mockRejectedValue(new Error('seed boom'));
        const ce = jest.spyOn(console, 'error').mockImplementation(() => {});

        const res = await scheduleService.getRouteSegments(CO, { ...RANGE }, null);
        expect(res).toEqual({ segments: [SEGMENT_ROW] });       // resolved BEFORE the failure

        await microFlush();
        await microFlush();
        expect(ce).toHaveBeenCalledWith('[Schedule] lazy route seed failed (non-fatal):', 'seed boom');
    });

    // TC-RV-30 (drift-guard): the `{ segments }` contract is byte-identical to the
    // SCHED-ROUTE-001 shape — no new fields, no wrappers, seed invisible in the body.
    test('TC-RV-30: response contract pinned — deep-equal { segments: [...] }', async () => {
        jest.spyOn(routeQueries, 'getSegmentsForRange').mockResolvedValue([SEGMENT_ROW]);
        jest.spyOn(routeSeg, 'seedMissingForRange').mockResolvedValue();

        const res = await scheduleService.getRouteSegments(CO,
            { from: '2026-07-03', to: '2026-07-03', technicianId: 't' }, { assignedOnly: false });

        expect(res).toEqual({
            segments: [{
                id: 1, technician_id: 't', schedule_date: '2026-07-03', from_job_id: 1, to_job_id: 2,
                distance_meters: 5000, duration_minutes: 12, travel_mode: 'driving',
                status: 'success', calculated_at: null,
            }],
        });
        expect(Object.keys(res)).toEqual(['segments']);
        await microFlush();   // drain the setImmediate before spies restore
    });
});

// =============================================================================
// rowToScheduleItem — TC-RV-31 (city mapper, via getScheduleItems)
// =============================================================================

describe('rowToScheduleItem — city field (S-15/INV-10)', () => {
    // TC-RV-31: job/lead take city from the row, task (SQL selects NULL) → null;
    // ''/undefined normalize to null; subtitle is NEVER composed on the backend.
    test('TC-RV-31: city mapped per entity, normalized to null, subtitle untouched', async () => {
        scheduleQueries.getDispatchSettings.mockResolvedValue(null);
        scheduleQueries.getScheduleItems.mockResolvedValue({
            rows: [
                { entity_type: 'job', entity_id: 1, title: 'Fridge', subtitle: 'Ann', status: 'Submitted', start_at: null, end_at: null, address_summary: '', city: 'Boston', customer_name: 'Ann', company_id: CO },
                { entity_type: 'lead', entity_id: 2, title: 'Lead', subtitle: 'Kim', status: 'New', start_at: null, end_at: null, address_summary: '', city: 'Newton', customer_name: 'Kim', company_id: CO },
                { entity_type: 'task', entity_id: 3, title: 'Call back', subtitle: '', status: 'open', start_at: null, end_at: null, address_summary: '', city: null, customer_name: '', company_id: CO },
                { entity_type: 'job', entity_id: 4, title: 'No-city job', subtitle: 'Bob', status: 'Submitted', start_at: null, end_at: null, address_summary: '', city: '', customer_name: 'Bob', company_id: CO },
            ],
            total: 4,
        });

        const { items } = await scheduleService.getScheduleItems(CO, {});

        expect(items.map(i => i.city)).toEqual(['Boston', 'Newton', null, null]);
        // subtitle stays EXACTLY the raw value — no "Customer, City" composition here (INV-10).
        expect(items.map(i => i.subtitle)).toEqual(['Ann', 'Kim', '', 'Bob']);
        expect(items[0].customer_name).toBe('Ann');
    });
});
