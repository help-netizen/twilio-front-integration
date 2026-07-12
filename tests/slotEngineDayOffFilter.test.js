/**
 * TECH-DAYOFF-001 (DO-06, section B) — A′ day-off filter inside the single seam
 * slotEngineService.getRecommendations. TC-DO-17…28.
 *
 * Mock scaffold = tests/slotEngineProxy.test.js; the new timeOffQueries module
 * is mocked directly (listOverlappingRange), the engine is global.fetch.
 * Time expectations are built with the REAL exported tzCombine (E-8 canon) so
 * the test derives instants with the same function as production.
 */

jest.mock('../backend/src/db/connection', () => ({ query: jest.fn() }));
jest.mock('../backend/src/db/marketplaceQueries', () => ({
    getPublishedAppByKey: jest.fn(),
    findActiveInstallation: jest.fn(),
}));
jest.mock('../backend/src/services/zenbookerClient', () => ({ getTeamMembers: jest.fn() }));
jest.mock('../backend/src/services/googlePlacesService', () => ({ geocodeAddress: jest.fn() }));
jest.mock('../backend/src/services/jobsService', () => ({ listJobs: jest.fn() }));
jest.mock('../backend/src/services/scheduleService', () => ({
    getDispatchSettings: jest.fn(async () => ({ timezone: 'America/New_York' })),
}));
jest.mock('../backend/src/services/slotEngineSettingsService', () => {
    const actual = jest.requireActual('../backend/src/services/slotEngineSettingsService');
    return {
        DEFAULTS: actual.DEFAULTS,
        buildConfigOverride: actual.buildConfigOverride,
        resolve: jest.fn(),
    };
});
jest.mock('../backend/src/db/timeOffQueries', () => ({ listOverlappingRange: jest.fn() }));

const db = require('../backend/src/db/connection');
const zenbookerClient = require('../backend/src/services/zenbookerClient');
const jobsService = require('../backend/src/services/jobsService');
const settingsService = require('../backend/src/services/slotEngineSettingsService');
const timeOffQueries = require('../backend/src/db/timeOffQueries');
const slotEngineService = require('../backend/src/services/slotEngineService');

const { DEFAULTS } = jest.requireActual('../backend/src/services/slotEngineSettingsService');
const { tzCombine } = slotEngineService;

const COMPANY = '00000000-0000-0000-0000-00000000000a';
const TZ = 'America/New_York';

// Deterministic NY horizon: Saturday + Sunday (explicit window, pre-feature-legal input).
const SAT = '2026-07-18';
const SUN = '2026-07-19';
const HORIZON_END_DATE = '2026-07-20'; // latest + 1 day

const T1 = { id: '1234567', name: 'John Smith' };
const T2 = { id: '7654321', name: 'Jane Doe' };

// Full buildTechnicians output for the fixture roster (byte-exact pin material).
const TECHS_PIN = [
    { id: '1234567', name: 'John Smith', active: true, base: { lat: 42.36, lng: -71.06 } },
    { id: '7654321', name: 'Jane Doe', active: true, base: { lat: 42.3, lng: -71.2 } },
];

// Mirror of slotEngineService.addDaysLocal (pure UTC date-string add), same as
// the slotEngineProxy.test.js precedent — used only to derive horizon expectations.
function addDaysLocal(baseDateStr, n) {
    const base = new Date(`${baseDateStr}T00:00:00Z`);
    base.setUTCDate(base.getUTCDate() + n);
    return base.toISOString().slice(0, 10);
}

/** Day-off DB row on [dateA hhmmA, dateB hhmmB) company-local, stored as UTC ISO. */
function off(techId, dateA, hhmmA, dateB, hhmmB) {
    return {
        id: `off-${techId}-${dateA}-${hhmmA}`,
        technician_id: techId,
        starts_at: tzCombine(dateA, hhmmA, TZ),
        ends_at: tzCombine(dateB, hhmmB, TZ),
    };
}

/** Engine recommendation fixture (NY-local date + HH:MM frame). */
function rec(rank, date, start, end, techs) {
    return { rank, date, time_frame: { start, end }, technicians: techs, score: 0.9, confidence: 'high' };
}

/** Build a rec list with sequential engine ranks 1..n. */
const recs = (...specs) => specs.map(([date, start, end, techs], i) => rec(i + 1, date, start, end, techs));

function engineReturns(recommendations, summary = null) {
    global.fetch.mockResolvedValue({ ok: true, json: async () => ({ recommendations, summary }) });
}

const bodyFromFetch = () => JSON.parse(global.fetch.mock.calls[0][1].body);

function callSeam(extra = {}) {
    return slotEngineService.getRecommendations(COMPANY, {
        new_job: {
            lat: 42.35, lng: -71.09, duration_minutes: 120,
            earliest_allowed_date: SAT, latest_allowed_date: SUN,
            ...extra,
        },
    });
}

/** Expected post-filter output: the kept engine recs, renumbered rank 1..n. */
const rerank = (keptRecs) => keptRecs.map((r, i) => ({ ...r, rank: i + 1 }));

beforeEach(() => {
    jest.clearAllMocks();
    db.query.mockReset().mockImplementation(async (sql) => {
        if (/SELECT tech_id, lat, lng/.test(String(sql))) {
            return {
                rows: [
                    { tech_id: '1234567', lat: 42.36, lng: -71.06, label: null, address: null },
                    { tech_id: '7654321', lat: 42.3, lng: -71.2, label: null, address: null },
                ],
            };
        }
        return { rows: [] };
    });
    zenbookerClient.getTeamMembers.mockReset().mockResolvedValue([
        { id: '1234567', first_name: 'John', last_name: 'Smith', deactivated: false },
        { id: '7654321', first_name: 'Jane', last_name: 'Doe', deactivated: false },
    ]);
    jobsService.listJobs.mockReset().mockResolvedValue([]);
    settingsService.resolve.mockReset().mockResolvedValue({ ...DEFAULTS });
    timeOffQueries.listOverlappingRange.mockReset().mockResolvedValue([]);
    process.env.SLOT_ENGINE_URL = 'http://engine.test';
    global.fetch = jest.fn();
});

afterEach(() => {
    delete global.fetch;
});

// ─── Zero-path pin ───────────────────────────────────────────────────────────

describe('zero day-off path (TC-DO-17, protected pin)', () => {
    it('engine request body and response are byte-identical pre-feature; the only delta is one SELECT', async () => {
        const engineRecs = recs(
            [SAT, '08:00', '10:00', [T1]],
            [SAT, '10:00', '12:00', [T2]],
        );
        engineReturns(engineRecs, { count: 2 });

        const out = await callSeam();

        // 1. Request body pinned to the pre-feature literal.
        expect(bodyFromFetch()).toEqual({
            request_id: expect.stringMatching(/^alb_\d+_[a-z0-9]+$/),
            requested_at: expect.any(String),
            new_request: {
                id: 'new',
                lat: 42.35,
                lng: -71.09,
                job_type: 'unknown',
                duration_minutes: 120,
                required_technician_count: 1,
                earliest_allowed_date: SAT,
                latest_allowed_date: SUN,
            },
            technicians: TECHS_PIN,                                         // full buildTechnicians output
            scheduled_jobs: [],
            config_override: settingsService.buildConfigOverride(DEFAULTS), // ranking.top_n WITHOUT +5
        });
        expect(bodyFromFetch().config_override.ranking).toEqual({ top_n: DEFAULTS.recommendations_shown });

        // 2. Response pinned: engine array untouched, ranks as delivered.
        expect(out).toEqual({
            recommendations: engineRecs,
            summary: { count: 2 },
            engine_status: 'ok',
            coverage: { technicians_total: 2, technicians_with_base: 2 },
        });

        // 3. The single SELECT, horizon bounds derived by the real helpers.
        expect(timeOffQueries.listOverlappingRange).toHaveBeenCalledTimes(1);
        expect(timeOffQueries.listOverlappingRange).toHaveBeenCalledWith(
            COMPANY,
            tzCombine(SAT, '00:00', TZ),
            tzCombine(addDaysLocal(SUN, 1), '00:00', TZ),
        );
    });
});

// ─── Post-filter geometry ────────────────────────────────────────────────────

describe('post-filter overlap semantics', () => {
    it('TC-DO-18: partial overlap kills the window; half-open boundary touch does NOT; other techs live; rank 1..n', async () => {
        timeOffQueries.listOverlappingRange.mockResolvedValue([off(T1.id, SAT, '09:00', SAT, '13:00')]);
        const [r1, r2, r3, r4, r5] = recs(
            [SAT, '08:00', '10:00', [T1]], // partial overlap → dropped
            [SAT, '12:00', '14:00', [T1]], // partial overlap → dropped
            [SAT, '13:00', '15:00', [T1]], // touches ends_at exactly → KEPT (half-open)
            [SAT, '14:00', '16:00', [T1]], // clear → kept
            [SAT, '09:00', '11:00', [T2]], // other tech → kept
        );
        engineReturns([r1, r2, r3, r4, r5]);

        const out = await callSeam();
        expect(out.recommendations).toEqual(rerank([r3, r4, r5]));
        expect(out.recommendations.map(r => r.rank)).toEqual([1, 2, 3]);
        // Rec shape untouched (same keys).
        expect(Object.keys(out.recommendations[0]).sort()).toEqual(Object.keys(r3).sort());
    });

    it('TC-DO-19: company-wide all-day day-off empties that day for everyone; other days live from 00:00', async () => {
        // Materialized batch = one row per tech, Saturday 00:00 → Sunday 00:00 NY.
        timeOffQueries.listOverlappingRange.mockResolvedValue([
            off(T1.id, SAT, '00:00', SUN, '00:00'),
            off(T2.id, SAT, '00:00', SUN, '00:00'),
        ]);
        const [r1, r2, r3, r4] = recs(
            [SAT, '08:00', '10:00', [T1]], // dropped
            [SAT, '10:00', '12:00', [T2]], // dropped
            [SUN, '00:00', '02:00', [T1]], // starts exactly at ends_at → kept
            [SUN, '10:00', '12:00', [T2]], // kept
        );
        engineReturns([r1, r2, r3, r4]);

        const out = await callSeam();
        expect(out.recommendations).toEqual(rerank([r3, r4]));
    });

    it('TC-DO-20: cross-midnight multi-day day-off is ONE interval — no per-date slicing', async () => {
        timeOffQueries.listOverlappingRange.mockResolvedValue([off(T1.id, SAT, '09:00', SUN, '21:00')]);
        const [r1, r2, r3, r4, r5, r6] = recs(
            [SAT, '08:00', '10:00', [T1]], // partial (tail into 09:00) → dropped
            [SAT, '10:00', '12:00', [T1]], // inside → dropped
            [SUN, '08:00', '10:00', [T1]], // inside (middle of the multi-day span) → dropped
            [SUN, '19:00', '21:30', [T1]], // head overlaps up to 21:00 → dropped
            [SUN, '21:00', '23:00', [T1]], // starts exactly at ends_at → KEPT
            [SUN, '10:00', '12:00', [T2]], // other tech → kept
        );
        engineReturns([r1, r2, r3, r4, r5, r6]);

        const out = await callSeam();
        expect(out.recommendations).toEqual(rerank([r5, r6]));
    });

    it('TC-DO-24: two OVERLAPPING day-offs of one tech → union semantics, window dropped exactly once, no dupes', async () => {
        timeOffQueries.listOverlappingRange.mockResolvedValue([
            off(T1.id, SAT, '09:00', SAT, '13:00'),
            off(T1.id, SAT, '11:00', SAT, '15:00'),
        ]);
        const [r1, r2] = recs(
            [SAT, '12:00', '14:00', [T1]], // inside both records → dropped once
            [SAT, '16:00', '18:00', [T1]], // outside both → kept
        );
        engineReturns([r1, r2]);

        const out = await callSeam();
        expect(out.recommendations).toEqual(rerank([r2]));
        // No negative double-drop / rank holes or duplicates.
        expect(out.recommendations.map(r => r.rank)).toEqual([1]);
    });
});

// ─── Pre-shaping + headroom ──────────────────────────────────────────────────

describe('pre-shaping and top_n headroom', () => {
    it('TC-DO-21: a single record covering the whole horizon drops the tech from technicians[]; coverage over the pre-shaped roster', async () => {
        timeOffQueries.listOverlappingRange.mockResolvedValue([
            off(T1.id, SAT, '00:00', HORIZON_END_DATE, '00:00'), // covers [horizonStart, horizonEnd)
            off(T2.id, SAT, '09:00', SAT, '11:00'),              // partial → stays
        ]);
        engineReturns([]);

        const out = await callSeam();
        const body = bodyFromFetch();
        expect(body.technicians.map(t => t.id)).toEqual(['7654321']);
        // The surviving tech object is byte-exact buildTechnicians output (INV-4 — input-shaping only).
        expect(body.technicians).toEqual([TECHS_PIN[1]]);
        expect(out.coverage).toEqual({ technicians_total: 1, technicians_with_base: 1 });
    });

    it('TC-DO-22: ranking.top_n = original + 5 in the request; result sliced to the original top_n, rank 1..n; per-tech caps untouched', async () => {
        timeOffQueries.listOverlappingRange.mockResolvedValue([off(T1.id, SAT, '09:00', SAT, '13:00')]);
        const N = DEFAULTS.recommendations_shown; // 3
        // Engine returns N+5 recs; 2 of them overlap T1's day-off.
        const engineRecs = recs(
            [SAT, '09:00', '11:00', [T1]], // dropped
            [SAT, '11:00', '13:00', [T1]], // dropped
            [SAT, '13:00', '15:00', [T1]],
            [SAT, '15:00', '17:00', [T1]],
            [SAT, '08:00', '10:00', [T2]],
            [SAT, '10:00', '12:00', [T2]],
            [SUN, '08:00', '10:00', [T2]],
            [SUN, '10:00', '12:00', [T1]],
        );
        expect(engineRecs).toHaveLength(N + 5);
        engineReturns(engineRecs);

        const out = await callSeam();
        const body = bodyFromFetch();
        // Headroom composed into ranking.top_n only; other override keys byte-equal DEFAULTS mapping.
        expect(body.config_override).toEqual({
            ...settingsService.buildConfigOverride(DEFAULTS),
            ranking: { top_n: N + 5 },
        });
        expect(body.config_override.ranking.max_recommendations_per_technician).toBeUndefined();
        expect(body.config_override.ranking.max_recommendations_per_same_timeframe).toBeUndefined();

        expect(out.recommendations.length).toBeLessThanOrEqual(N);
        expect(out.recommendations).toEqual(rerank([engineRecs[2], engineRecs[3], engineRecs[4]]));
        expect(out.recommendations.map(r => r.rank)).toEqual([1, 2, 3]);
    });

    it('TC-DO-23: two ABUTTING records jointly covering the horizon → tech NOT pre-shaped (v1, no merging), but killed by the post-filter', async () => {
        timeOffQueries.listOverlappingRange.mockResolvedValue([
            off(T1.id, SAT, '00:00', SUN, '00:00'),               // [horizonStart, mid)
            off(T1.id, SUN, '00:00', HORIZON_END_DATE, '00:00'),  // [mid, horizonEnd)
        ]);
        const [r1, r2, r3] = recs(
            [SAT, '10:00', '12:00', [T1]], // first half → dropped
            [SUN, '10:00', '12:00', [T1]], // second half → dropped
            [SAT, '10:00', '12:00', [T2]], // kept
        );
        engineReturns([r1, r2, r3]);

        const out = await callSeam();
        // Multi-records are NOT merged: T1 stays in the engine roster…
        expect(bodyFromFetch().technicians.map(t => t.id)).toContain('1234567');
        // …but every T1 rec is dead after the post-filter.
        expect(out.recommendations).toEqual(rerank([r3]));
        expect(out.engine_status).toBe('ok');
    });
});

// ─── TECHSLOT one-tech ───────────────────────────────────────────────────────

describe('TECHSLOT one-tech + day-off (TC-DO-25)', () => {
    it('(a) day-off covers the whole horizon → pre-shaping yields technicians=[], safe-fail 0 recs, no throw', async () => {
        timeOffQueries.listOverlappingRange.mockResolvedValue([
            off(T1.id, SAT, '00:00', HORIZON_END_DATE, '00:00'),
        ]);
        engineReturns([]);

        const out = await callSeam({ technician_id: '1234567' });
        if (global.fetch.mock.calls.length > 0) {
            expect(bodyFromFetch().technicians).toEqual([]);
        }
        expect(out).toEqual({
            recommendations: [],
            summary: null,
            engine_status: 'ok',
            coverage: { technicians_total: 0, technicians_with_base: 0 },
        });
    });

    it('(b) day-off only on the targetDay → post-filter drops every rec, same safe-fail shape', async () => {
        timeOffQueries.listOverlappingRange.mockResolvedValue([off(T1.id, SAT, '00:00', SUN, '00:00')]);
        engineReturns(recs(
            [SAT, '08:00', '10:00', [T1]],
            [SAT, '10:00', '12:00', [T1]],
        ));

        const out = await callSeam({ technician_id: '1234567' });
        expect(bodyFromFetch().technicians.map(t => t.id)).toEqual(['1234567']);
        expect(out.recommendations).toEqual([]);
        expect(out.engine_status).toBe('ok');
    });
});

// ─── DST ─────────────────────────────────────────────────────────────────────

describe('DST fall-back day, America/New_York (TC-DO-26)', () => {
    const DST_DAY = '2026-11-01'; // clocks fall back 02:00 → 01:00
    const DST_NEXT = '2026-11-02';

    it('exactly the tzCombine instants are silenced — no ±1h drift', async () => {
        // Sanity: the shared helper IS DST-aware (EDT day = UTC−4, EST 08:00 on the switch day = UTC−5).
        expect(tzCombine('2026-10-31', '08:00', TZ)).toBe('2026-10-31T12:00:00.000Z');
        expect(tzCombine(DST_DAY, '08:00', TZ)).toBe('2026-11-01T13:00:00.000Z');

        // Day-off entered company-local 08:00→12:00 of the switch day, converted by the SAME tzCombine.
        timeOffQueries.listOverlappingRange.mockResolvedValue([off(T1.id, DST_DAY, '08:00', DST_DAY, '12:00')]);
        const [r1, r2] = recs(
            [DST_DAY, '07:00', '09:00', [T1]], // instant-overlap → dropped
            [DST_DAY, '12:00', '14:00', [T1]], // boundary touch → kept
        );
        engineReturns([r1, r2]);

        const out = await callSeam({
            earliest_allowed_date: DST_DAY, latest_allowed_date: DST_DAY,
        });
        expect(out.recommendations).toEqual(rerank([r2]));
        // Horizon end built through the same DST-aware combine (next local midnight).
        expect(timeOffQueries.listOverlappingRange).toHaveBeenCalledWith(
            COMPANY, tzCombine(DST_DAY, '00:00', TZ), tzCombine(DST_NEXT, '00:00', TZ));
    });
});

// ─── Failure semantics ───────────────────────────────────────────────────────

describe('failure paths', () => {
    it('TC-DO-27: day-off SELECT error PROPAGATES (reject) — never swallowed into "0 rows"', async () => {
        timeOffQueries.listOverlappingRange.mockRejectedValue(new Error('db down'));
        engineReturns(recs([SAT, '08:00', '10:00', [T1]])); // must not turn into a success

        await expect(callSeam()).rejects.toThrow('db down');
    });

    it('TC-DO-28a: SLOT_ENGINE_URL missing + non-empty day-off → existing unavailable shape, fetch not called', async () => {
        delete process.env.SLOT_ENGINE_URL;
        timeOffQueries.listOverlappingRange.mockResolvedValue([off(T1.id, SAT, '09:00', SAT, '13:00')]);

        const out = await callSeam();
        expect(out).toEqual({
            recommendations: [],
            summary: null,
            engine_status: 'unavailable',
            coverage: { technicians_total: 2, technicians_with_base: 2 },
        });
        expect(global.fetch).not.toHaveBeenCalled();
    });

    it('TC-DO-28b: engine down (fetch rejects) + non-empty day-off → same byte-exact unavailable shape', async () => {
        timeOffQueries.listOverlappingRange.mockResolvedValue([off(T1.id, SAT, '09:00', SAT, '13:00')]);
        global.fetch.mockRejectedValue(new Error('aborted'));

        const out = await callSeam();
        expect(out).toEqual({
            recommendations: [],
            summary: null,
            engine_status: 'unavailable',
            coverage: { technicians_total: 2, technicians_with_base: 2 },
        });
        expect(global.fetch).toHaveBeenCalledTimes(1);
    });
});
