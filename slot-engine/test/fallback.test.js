'use strict';
/**
 * SLOT-ENGINE-NEAREST-FALLBACK-001 — Tier-2 "nearest-tech" distance fallback.
 *
 * Verifies the two-pass control in engine.js: Tier-1 (normal radius) runs first and is
 * byte-identical to legacy; Tier-2 fires ONLY when Tier-1 yields zero feasible candidates,
 * relaxing the distance gate to a wider ceiling (fallback_max_distance_miles, default 25)
 * while preserving overlap=0 and physical feasibility. See docs/specs + docs/test-cases
 * for SLOT-ENGINE-NEAREST-FALLBACK-001.
 *
 * Harness: `node --test` from slot-engine/ (same as engine.test.js / scenarios.test.js).
 *
 * NOTE ON COORDINATES: the test-case doc sketched WESTON at ~11.9 mi, but the literal
 * Weston centroid (42.3668,-71.3020) is only ~9.54 mi from Brookline — INSIDE the 10 mi
 * Tier-1 gate, so it would NOT trigger the fallback. We therefore use synthetic Boston-area
 * points on the 42.3318 parallel with measured distances, and FB_SANITY asserts every band
 * up front so a coordinate drift fails loudly instead of silently mis-tiering a case.
 */
const test = require('node:test');
const assert = require('node:assert');
const { recommendSlots } = require('../src/engine');
const { haversineMiles } = require('../src/geo');
const { overlapMinutes, hmToMin } = require('../src/time');

// ── Coordinate fixture (measured; see FB_SANITY) ────────────────────────────
const BROOKLINE   = { lat: 42.3318, lng: -71.1212 }; // tech base / existing jobs
const NEWTON      = { lat: 42.3370, lng: -71.2092 }; // ~4.5 mi  → covered (Tier-1)
const WESTON_11_8 = { lat: 42.3318, lng: -71.3512 }; // ~11.75 mi → Tier-1 miss, Tier-2 hit
const MID_15      = { lat: 42.3318, lng: -71.4212 }; // ~15.3 mi  → Tier-2 band
const MID_18      = { lat: 42.3318, lng: -71.4712 }; // ~17.9 mi  → Tier-2 band
const FAR_30      = { lat: 42.3318, lng: -71.7212 }; // ~30.6 mi  → beyond 25, Tier-2 miss

const NOW = '2026-06-25T07:30:00-04:00'; // early → all of today's windows are future
const T = '2026-06-25', T1 = '2026-06-26', T2 = '2026-06-27';

const job = (id, tech, date, ws, we, loc, dur = 60) =>
  ({ id, date, status: 'scheduled', job_type: 'service_call', window_start: ws, window_end: we,
     lat: loc.lat, lng: loc.lng, duration_minutes: dur, assigned_technicians: [tech] });
const newReq = (loc, extra = {}) =>
  ({ id: 'n', lat: loc.lat, lng: loc.lng, geo_confidence: 0.9, job_type: 'service_call',
     earliest_allowed_date: T, latest_allowed_date: T, ...extra });
const tech = (id, name, base) => ({ id, name, active: true, base });

/** true iff [a,b) window (min) overlaps any of the tech's existing jobs. */
function overlapsExisting(startHm, endHm, jobs) {
  const a = hmToMin(startHm), b = hmToMin(endHm);
  return jobs.some((j) => overlapMinutes(a, b, hmToMin(j.window_start), hmToMin(j.window_end)) > 0);
}

// ── Tier-1 baseline snapshot (captured from the CURRENT engine on engine.test's
//    baseRequest()). FB_COVERED_BYTE_IDENTICAL deep-equals live output to this. Any
//    Tier-1 drift (a stray shared-config mutation, a scoring change) fails immediately. ──
const EXISTING = { lat: 42.34, lng: -71.10 };
const NEARBY   = { lat: 42.35, lng: -71.09 };
const BASE     = { lat: 42.36, lng: -71.06 };
function baseRequest(overrides = {}) {
  return {
    request_id: 'req_test',
    requested_at: '2026-06-25T08:00:00-04:00',
    new_request: {
      id: 'new_1', lat: NEARBY.lat, lng: NEARBY.lng, geo_confidence: 0.9,
      job_type: 'service_call', required_technician_count: 1,
      earliest_allowed_date: '2026-06-25', latest_allowed_date: '2026-06-25',
    },
    technicians: [tech('tech_001', 'Robert', BASE)],
    scheduled_jobs: [job('job_1001', 'tech_001', '2026-06-25', '10:00', '12:00', EXISTING, 60)],
    ...overrides,
  };
}
// Projection that drops the volatile generated_at but keeps everything ordering/scoring-load-bearing.
const project = (res) => res.recommendations.map((r) => ({
  rank: r.rank, candidate_id: r.candidate_id, date: r.date, time_frame: r.time_frame,
  techId: r.technicians[0].id, score: r.score, confidence: r.confidence,
  has_fallback_tier: 'fallback_tier' in r,
}));
const BASELINE = [
  { rank: 1, candidate_id: 'tech_001_2026-06-25_12:00_1', date: '2026-06-25',
    time_frame: { start: '12:00', end: '14:00' }, techId: 'tech_001', score: 90.5,
    confidence: 'high', has_fallback_tier: false },
  { rank: 2, candidate_id: 'tech_001_2026-06-25_14:00_1', date: '2026-06-25',
    time_frame: { start: '14:00', end: '16:00' }, techId: 'tech_001', score: 90.1,
    confidence: 'high', has_fallback_tier: false },
];

// ────────────────────────────────────────────────────────────────────────────
// FB-P0-00 — fixture distances land in the expected bands (fail loudly on drift)
// ────────────────────────────────────────────────────────────────────────────
test('FB_SANITY: fixture distances are in the expected bands', () => {
  const d = (p) => haversineMiles(BROOKLINE, p);
  assert.ok(d(NEWTON) < 10, `NEWTON should be < 10 mi (got ${d(NEWTON).toFixed(2)})`);
  assert.ok(d(WESTON_11_8) > 10 && d(WESTON_11_8) < 25,
    `WESTON_11_8 should be in (10,25) (got ${d(WESTON_11_8).toFixed(2)})`);
  assert.ok(d(MID_15) > 10 && d(MID_15) < 25, `MID_15 in (10,25) (got ${d(MID_15).toFixed(2)})`);
  assert.ok(d(MID_18) > 10 && d(MID_18) < 25, `MID_18 in (10,25) (got ${d(MID_18).toFixed(2)})`);
  assert.ok(d(FAR_30) > 25, `FAR_30 should be > 25 mi (got ${d(FAR_30).toFixed(2)})`);
});

// ────────────────────────────────────────────────────────────────────────────
// FB-1 (B1 repro) — Tier-1 empty → Tier-2 returns nearest-tech slots, tagged
// ────────────────────────────────────────────────────────────────────────────
test('FB-1: nearest tech ~11.8 mi (beyond 10) → Tier-1 empty → Tier-2 rescues, tagged', () => {
  const jobs = [job('j1', 'rob', T, '10:00', '12:00', BROOKLINE)];
  const res = recommendSlots({
    requested_at: NOW, new_request: newReq(WESTON_11_8),
    technicians: [tech('rob', 'Robert', BROOKLINE)], scheduled_jobs: jobs,
    config_override: { geography: { fallback_max_distance_miles: 25 } },
  });
  assert.ok(res.recommendations.length >= 1, 'Tier-2 must return >= 1 rec');
  assert.strictEqual(res.summary.used_nearest_fallback, true);
  for (const r of res.recommendations) {
    assert.strictEqual(r.technicians[0].id, 'rob', 'every rec is the nearest tech');
    assert.strictEqual(r.fallback_tier, 2, 'every Tier-2 rec tagged fallback_tier:2');
    assert.ok(r.reason_codes.includes('nearest_tech_fallback'), 'reason code nearest_tech_fallback');
  }
});

// ────────────────────────────────────────────────────────────────────────────
// FB-2 (B6/B2) — Tier-1 non-empty ⇒ Tier-2 never runs; recs carry no fallback fields
// ────────────────────────────────────────────────────────────────────────────
test('FB-2: covered job (within 10 mi) → no fallback_tier, used_nearest_fallback false', () => {
  const res = recommendSlots({
    requested_at: NOW, new_request: newReq(NEWTON),
    technicians: [tech('rob', 'Robert', BROOKLINE)],
    scheduled_jobs: [job('j1', 'rob', T, '10:00', '12:00', BROOKLINE)],
  });
  assert.ok(res.recommendations.length >= 1, 'covered location still recommends (Tier-1)');
  assert.strictEqual(res.summary.used_nearest_fallback, false);
  assert.ok(!res.recommendations.some((r) => 'fallback_tier' in r), 'no rec has fallback_tier');
  assert.ok(!res.recommendations.some((r) => r.reason_codes.includes('nearest_tech_fallback')));
});

// ────────────────────────────────────────────────────────────────────────────
// FB-3 (B3) — 25 mi cap: a ~30 mi job is NOT rescued by Tier-2
// ────────────────────────────────────────────────────────────────────────────
test('FB-3: nearest tech ~30 mi (beyond 25 cap) → Tier-2 does NOT rescue → 0 recs', () => {
  const res = recommendSlots({
    requested_at: NOW, new_request: newReq(FAR_30),
    technicians: [tech('rob', 'Robert', BROOKLINE)],
    scheduled_jobs: [job('j1', 'rob', T, '10:00', '12:00', BROOKLINE)],
    config_override: { geography: { fallback_max_distance_miles: 25 } },
  });
  assert.strictEqual(res.recommendations.length, 0, 'beyond the 25 mi cap → truly out of area');
  assert.strictEqual(res.summary.used_nearest_fallback, false);
});

// ────────────────────────────────────────────────────────────────────────────
// FB-4 (B4) — non-overlap preserved in Tier-2: never offer a window over an existing job
// ────────────────────────────────────────────────────────────────────────────
test('FB-4: Tier-2 preserves overlap=0 — no offered window overlaps the existing 10:00–12:00', () => {
  const jobs = [job('j1', 'rob', T, '10:00', '12:00', BROOKLINE)];
  const res = recommendSlots({
    requested_at: NOW, new_request: newReq(MID_15),
    technicians: [tech('rob', 'Robert', BROOKLINE)], scheduled_jobs: jobs,
    config_override: { geography: { fallback_max_distance_miles: 25 } },
  });
  assert.ok(res.recommendations.length >= 1, 'Tier-2 should surface at least the back-to-back window');
  assert.ok(!res.recommendations.some((r) => r.time_frame.start === '10:00'),
    '10:00 overlaps the existing job and must NOT be offered');
  for (const r of res.recommendations) {
    assert.ok(!overlapsExisting(r.time_frame.start, r.time_frame.end, jobs),
      `offered window ${r.time_frame.start}-${r.time_frame.end} must not overlap an existing job`);
  }
  // back-to-back 12:00–14:00 (touching, not overlapping) IS allowed.
  assert.ok(res.recommendations.some((r) => r.time_frame.start === '12:00'),
    'the back-to-back 12:00 window is allowed and should appear');
});

// ────────────────────────────────────────────────────────────────────────────
// FB-5 (B5) — empty-day-from-base: Tier-2 anchors windows at the tech base
// ────────────────────────────────────────────────────────────────────────────
test('FB-5: nearest tech has an EMPTY day → Tier-2 offers base-anchored windows', () => {
  // Base ~15 mi west of Brookline; new request ~2.6 mi past the base (so >10 from any
  // Brookline anchor and Tier-1 misses). Empty future day → empty-day path.
  const res = recommendSlots({
    requested_at: NOW,
    new_request: newReq(MID_18, { earliest_allowed_date: T2, latest_allowed_date: T2 }),
    technicians: [tech('rob', 'Robert', MID_15)], scheduled_jobs: [],
    config_override: { geography: { fallback_max_distance_miles: 25 } },
  });
  assert.ok(res.recommendations.length >= 1, 'empty-day tech within 25 mi yields Tier-2 recs');
  assert.strictEqual(res.summary.used_nearest_fallback, true);
  assert.ok(res.recommendations.every((r) => r.date === T2), 'all recs on the requested future day');
  for (const r of res.recommendations) {
    assert.strictEqual(r.fallback_tier, 2);
    // empty-day "nearest" = base→new distance (~2.6 mi), never null.
    assert.notStrictEqual(r.metrics.nearest_existing_job_distance_miles, null,
      'empty-day metric is the base distance, not null');
    assert.ok(r.metrics.nearest_existing_job_distance_miles > 0
      && r.metrics.nearest_existing_job_distance_miles < 10,
      'base distance ~2.6 mi (base→new), not the 15+ mi to Brookline');
  }
});

// ────────────────────────────────────────────────────────────────────────────
// FB-6 (B7) — nearest-first ranking: the closer fallback tech ranks #1
// ────────────────────────────────────────────────────────────────────────────
test('FB-6: two techs within 25 mi at different distances → nearer tech ranks first', () => {
  // New request between two empty-day tech bases. Tech A base ~1 mi away, tech B base ~4 mi.
  // Both far (> 10 mi) from Brookline anchors so Tier-1 is empty; Tier-2 ranks by distance.
  const NEWP = { lat: 42.3318, lng: -71.4500 }; // ~16.8 mi from Brookline
  const A_BASE = { lat: 42.3318, lng: -71.4300 }; // ~1.0 mi from NEWP
  const B_BASE = { lat: 42.3318, lng: -71.5300 }; // ~4.1 mi from NEWP
  const res = recommendSlots({
    requested_at: NOW,
    new_request: newReq(NEWP, { earliest_allowed_date: T2, latest_allowed_date: T2 }),
    technicians: [tech('A', 'Ann', A_BASE), tech('B', 'Bob', B_BASE)], scheduled_jobs: [],
    config_override: { geography: { fallback_max_distance_miles: 25 } },
  });
  assert.ok(res.recommendations.length >= 1);
  assert.strictEqual(res.recommendations[0].technicians[0].id, 'A',
    'the nearer tech (A) must rank #1 in a Tier-2 set');
  assert.strictEqual(res.recommendations[0].fallback_tier, 2);
});

// ────────────────────────────────────────────────────────────────────────────
// FB-7 (B8) — off-switch: fallback_max_distance_miles <= normal radius ⇒ Tier-2 never fires
// ────────────────────────────────────────────────────────────────────────────
test('FB-7: fallback disabled (fallback_max_distance_miles:0) → 11.8 mi job → 0 recs', () => {
  const res = recommendSlots({
    requested_at: NOW, new_request: newReq(WESTON_11_8),
    technicians: [tech('rob', 'Robert', BROOKLINE)],
    scheduled_jobs: [job('j1', 'rob', T, '10:00', '12:00', BROOKLINE)],
    config_override: { geography: { fallback_max_distance_miles: 0 } },
  });
  assert.strictEqual(res.recommendations.length, 0, 'off-switch → legacy behavior (empty)');
  assert.strictEqual(res.summary.used_nearest_fallback, false);
});

test('FB-7b: fallback ceiling == normal radius (not >) ⇒ canFallback false ⇒ 0 recs', () => {
  // 10 mi fallback is NOT > the 10 mi normal radius → Tier-2 must not double-run.
  const res = recommendSlots({
    requested_at: NOW, new_request: newReq(WESTON_11_8),
    technicians: [tech('rob', 'Robert', BROOKLINE)],
    scheduled_jobs: [job('j1', 'rob', T, '10:00', '12:00', BROOKLINE)],
    config_override: { geography: { fallback_max_distance_miles: 10 } },
  });
  assert.strictEqual(res.recommendations.length, 0);
  assert.strictEqual(res.summary.used_nearest_fallback, false);
});

// ────────────────────────────────────────────────────────────────────────────
// FB-P0-08 (B11) — multi-tech short-circuits BEFORE the two-pass block
// ────────────────────────────────────────────────────────────────────────────
test('FB-8: multi-technician request short-circuits before fallback', () => {
  const res = recommendSlots({
    requested_at: NOW,
    new_request: newReq(WESTON_11_8, { required_technician_count: 2 }),
    technicians: [tech('rob', 'Robert', BROOKLINE)],
    scheduled_jobs: [job('j1', 'rob', T, '10:00', '12:00', BROOKLINE)],
  });
  assert.strictEqual(res.recommendations.length, 0);
  assert.strictEqual(res.summary.note, 'multi_technician_requests_not_supported_in_mvp');
  assert.ok(!('used_nearest_fallback' in res.summary), 'no fallback fields on the early return');
});

// ────────────────────────────────────────────────────────────────────────────
// MANDATORY Tier-1-unchanged regression guard (FB-P0-02 snapshot / byte-identity)
// ────────────────────────────────────────────────────────────────────────────
test('FB_COVERED_BYTE_IDENTICAL: Tier-1 output for a covered input equals the captured baseline', () => {
  const res = recommendSlots(baseRequest());
  assert.deepStrictEqual(project(res), BASELINE,
    'covered-location Tier-1 recs must be byte-identical to the pre-fallback baseline');
  assert.strictEqual(res.summary.used_nearest_fallback, false);
  assert.strictEqual(res.summary.feasible_candidates_count, 3);
});

// ────────────────────────────────────────────────────────────────────────────
// FB-P1-02 (B12) — low-geo flagging survives into Tier-2
// ────────────────────────────────────────────────────────────────────────────
test('FB-P1-low-geo: Tier-2 recs still flagged low + requires_dispatch_confirmation', () => {
  const res = recommendSlots({
    requested_at: NOW, new_request: newReq(WESTON_11_8, { geo_confidence: 0.4 }),
    technicians: [tech('rob', 'Robert', BROOKLINE)],
    scheduled_jobs: [job('j1', 'rob', T, '10:00', '12:00', BROOKLINE)],
    config_override: { geography: { fallback_max_distance_miles: 25 } },
  });
  assert.ok(res.recommendations.length >= 1);
  for (const r of res.recommendations) {
    assert.strictEqual(r.confidence, 'low');
    assert.strictEqual(r.requires_dispatch_confirmation, true);
    assert.ok(r.reason_codes.includes('low_location_confidence'));
    assert.ok(r.reason_codes.includes('nearest_tech_fallback'), 'still tagged as a fallback');
  }
});

// ────────────────────────────────────────────────────────────────────────────
// FB-P1-04 — summary math sums both passes when Tier-2 runs
// ────────────────────────────────────────────────────────────────────────────
test('FB-P1-summary-math: generated_candidates_count sums Pass1 + Pass2 when Tier-2 fires', () => {
  const res = recommendSlots({
    requested_at: NOW, new_request: newReq(WESTON_11_8),
    technicians: [tech('rob', 'Robert', BROOKLINE)],
    scheduled_jobs: [job('j1', 'rob', T, '10:00', '12:00', BROOKLINE)],
    config_override: { geography: { fallback_max_distance_miles: 25 } },
  });
  assert.strictEqual(res.summary.used_nearest_fallback, true);
  // Pass1 generated some candidates (all rejected by distance) AND Pass2 generated more.
  // A single-pass count would be half; the sum proves both passes were counted.
  assert.ok(res.summary.generated_candidates_count > res.recommendations.length,
    'generated count includes the rejected Pass-1 candidates + Pass-2');
  assert.strictEqual(res.summary.feasible_candidates_count >= res.recommendations.length, true);
});
