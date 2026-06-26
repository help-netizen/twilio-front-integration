'use strict';
/* Realistic dispatching scenarios — permanent regression tests for recommendation
   correctness (real Boston-area coords so haversine distances are realistic). */
const test = require('node:test');
const assert = require('node:assert');
const { recommendSlots } = require('../src/engine');

const BROOKLINE = { lat: 42.3318, lng: -71.1212 };
const NEWTON    = { lat: 42.3370, lng: -71.2092 }; // ~5 mi W of Brookline
const CAMBRIDGE = { lat: 42.3736, lng: -71.1097 }; // north
const QUINCY    = { lat: 42.2529, lng: -71.0023 }; // ~10 mi SE
const WORCESTER = { lat: 42.2626, lng: -71.8023 }; // ~40 mi W (far)

const NOW = '2026-06-25T07:30:00-04:00'; // early → all of today's windows are future
const T = '2026-06-25', T1 = '2026-06-26', T2 = '2026-06-27';

const job = (id, tech, date, ws, we, loc, dur = 60) =>
  ({ id, date, status: 'scheduled', job_type: 'service_call', window_start: ws, window_end: we, lat: loc.lat, lng: loc.lng, duration_minutes: dur, assigned_technicians: [tech] });
const newReq = (loc, extra = {}) =>
  ({ id: 'n', lat: loc.lat, lng: loc.lng, geo_confidence: 0.9, job_type: 'service_call', earliest_allowed_date: T, latest_allowed_date: T, ...extra });

function run(name, req) {
  const res = recommendSlots(req);
  console.log(`\n■ ${name}  (gen=${res.summary.generated_candidates_count} feasible=${res.summary.feasible_candidates_count} returned=${res.recommendations.length})`);
  for (const r of res.recommendations)
    console.log(`   #${r.rank} ${r.date} ${r.time_frame.start}-${r.time_frame.end} ${r.technicians[0].name} score=${r.score} ${r.confidence}${r.requires_dispatch_confirmation ? ' [confirm]' : ''} ${(r.reason_codes || []).slice(0, 3).join(',')}`);
  return res;
}

test('S1 nearby same-day → offers gap windows for the on-site tech', () => {
  const r = run('S1', { requested_at: NOW, new_request: newReq(NEWTON), technicians: [{ id: 'rob', name: 'Robert', active: true, base: BROOKLINE }], scheduled_jobs: [job('j1', 'rob', T, '10:00', '12:00', BROOKLINE)] });
  assert.ok(r.recommendations.length > 0 && r.recommendations.every(x => x.technicians[0].id === 'rob'));
  assert.ok(!r.recommendations.some(x => x.date === T && x.time_frame.start === '10:00'), 'no window overlapping the existing job');
  assert.ok(r.recommendations[0].reason_codes.includes('near_existing_jobs'));
});

test('S2 geographic tech-selection → picks the closer technician', () => {
  const r = run('S2', { requested_at: NOW, new_request: newReq(QUINCY),
    technicians: [{ id: 'rob', name: 'Robert', active: true, base: CAMBRIDGE }, { id: 'mur', name: 'Murad', active: true, base: QUINCY }],
    scheduled_jobs: [job('j1', 'rob', T, '10:00', '12:00', CAMBRIDGE), job('j2', 'mur', T, '10:00', '12:00', QUINCY)] });
  assert.equal(r.recommendations[0].technicians[0].id, 'mur');
});

test('S3 far request → no recommendations (nearest distance exceeded)', () => {
  const r = run('S3', { requested_at: NOW, new_request: newReq(WORCESTER), technicians: [{ id: 'rob', name: 'Robert', active: true, base: BROOKLINE }], scheduled_jobs: [job('j1', 'rob', T, '10:00', '12:00', BROOKLINE)] });
  assert.equal(r.recommendations.length, 0);
});

test('S4 fully-packed tech is outranked by a freer one', () => {
  const r = run('S4', { requested_at: NOW, new_request: newReq(BROOKLINE),
    technicians: [{ id: 'rob', name: 'Robert', active: true, base: BROOKLINE }, { id: 'mur', name: 'Murad', active: true, base: BROOKLINE }],
    scheduled_jobs: [
      job('a', 'rob', T, '08:00', '10:00', BROOKLINE, 110), job('b', 'rob', T, '10:00', '12:00', BROOKLINE, 110),
      job('c', 'rob', T, '12:00', '14:00', BROOKLINE, 110), job('d', 'rob', T, '14:00', '16:00', BROOKLINE, 110),
      job('e', 'rob', T, '16:00', '18:00', BROOKLINE, 110), job('m1', 'mur', T, '10:00', '12:00', BROOKLINE, 60)] });
  assert.ok(r.recommendations.length > 0 && r.recommendations[0].technicians[0].id === 'mur');
});

test('S5 empty future day anchored on the technician base', () => {
  const r = run('S5', { requested_at: NOW, config_override: { geography: { allow_empty_day_candidates: true } },
    new_request: newReq(BROOKLINE, { earliest_allowed_date: T2, latest_allowed_date: T2 }),
    technicians: [{ id: 'rob', name: 'Robert', active: true, base: BROOKLINE }], scheduled_jobs: [] });
  assert.ok(r.recommendations.length > 0 && r.recommendations.every(x => x.date === T2));
});

test('S6 overlap hard-limit → the overlapping window is never offered', () => {
  const r = run('S6', { requested_at: NOW, new_request: newReq(BROOKLINE), technicians: [{ id: 'rob', name: 'Robert', active: true, base: BROOKLINE }], scheduled_jobs: [job('j1', 'rob', T, '10:00', '12:00', BROOKLINE)] });
  assert.ok(!r.recommendations.some(x => x.time_frame.start === '10:00'));
});

test('S7 multi-day → prefers tomorrow-near over today-far', () => {
  const r = run('S7', { requested_at: NOW, new_request: newReq(BROOKLINE, { latest_allowed_date: T2 }),
    technicians: [{ id: 'rob', name: 'Robert', active: true, base: BROOKLINE }],
    scheduled_jobs: [job('today', 'rob', T, '10:00', '12:00', WORCESTER), job('tom', 'rob', T1, '10:00', '12:00', BROOKLINE)] });
  assert.ok(r.recommendations.length > 0 && r.recommendations.every(x => x.date === T1));
});

test('S8 low geo confidence (ZIP centroid) → still recommends, flagged low + confirm', () => {
  const r = run('S8', { requested_at: NOW, new_request: newReq(NEWTON, { geo_confidence: 0.4, uncertainty_radius_meters: 2500 }),
    technicians: [{ id: 'rob', name: 'Robert', active: true, base: BROOKLINE }], scheduled_jobs: [job('j1', 'rob', T, '10:00', '12:00', BROOKLINE)] });
  assert.ok(r.recommendations.length > 0, 'ZIP-level location must still get suggestions (not zero)');
  assert.ok(r.recommendations.every(x => x.confidence === 'low' && x.requires_dispatch_confirmation));
});
