'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { recommendSlots } = require('../src/engine');
const { overlapMinutes } = require('../src/time');

// Boston-area fixture. Existing job ~1 mile from the new request.
const EXISTING = { lat: 42.34, lng: -71.10 };
const NEARBY = { lat: 42.35, lng: -71.09 };
const FAR = { lat: 41.50, lng: -70.00 }; // ~80 mi away
const BASE = { lat: 42.36, lng: -71.06 };

function baseRequest(overrides = {}) {
  return {
    request_id: 'req_test',
    requested_at: '2026-06-25T08:00:00-04:00', // today, 08:00 → 08:00-10:00 window is "too soon"
    new_request: {
      id: 'new_1', lat: NEARBY.lat, lng: NEARBY.lng, geo_confidence: 0.9,
      job_type: 'service_call', required_technician_count: 1,
      earliest_allowed_date: '2026-06-25', latest_allowed_date: '2026-06-25',
    },
    technicians: [{ id: 'tech_001', name: 'Robert', active: true, base: BASE }],
    scheduled_jobs: [{
      id: 'job_1001', date: '2026-06-25', status: 'scheduled', job_type: 'service_call',
      window_start: '10:00', window_end: '12:00', lat: EXISTING.lat, lng: EXISTING.lng,
      duration_minutes: 60, assigned_technicians: ['tech_001'],
    }],
    ...overrides,
  };
}

test('returns ranked recommendations with valid structure', () => {
  const res = recommendSlots(baseRequest());
  assert.ok(Array.isArray(res.recommendations));
  assert.ok(res.recommendations.length >= 1, 'expected at least one recommendation');
  res.recommendations.forEach((r, i) => {
    assert.equal(r.rank, i + 1);
    assert.ok(r.score >= 0 && r.score <= 100, 'score in [0,100]');
    assert.ok(r.technicians[0].id === 'tech_001');
    assert.ok(['high', 'medium', 'low'].includes(r.confidence));
    assert.ok(r.time_frame.start && r.feasible_arrival_interval.start);
  });
  // nearby (~1 mile) → near_existing_jobs reason on the top rec
  assert.ok(res.recommendations[0].reason_codes.includes('near_existing_jobs'));
});

test('overlap hard-limit (0) rejects the window overlapping an existing job', () => {
  const res = recommendSlots(baseRequest());
  const sameDay10 = res.recommendations.filter((r) => r.date === '2026-06-25' && r.time_frame.start === '10:00');
  assert.equal(sameDay10.length, 0, '10:00-12:00 overlaps existing 10:00-12:00 and must be rejected');
});

test('past-timeframe filter: 08:00 window excluded when requested at 08:00 today', () => {
  const res = recommendSlots(baseRequest());
  const early = res.recommendations.filter((r) => r.date === '2026-06-25' && r.time_frame.start === '08:00');
  assert.equal(early.length, 0, '08:00 start is within minimum_minutes_before_slot_start_today');
});

test('far-away request with no empty-day candidates yields no recommendations', () => {
  const req = baseRequest();
  req.new_request.lat = FAR.lat; req.new_request.lng = FAR.lng;
  const res = recommendSlots(req);
  assert.equal(res.recommendations.length, 0, 'nearest distance exceeded → all rejected');
});

test('overlap allowed when max_timeframe_overlap_minutes is raised (custom windows)', () => {
  // existing 10:00-12:00, candidate 11:00-13:00 → 60 min overlap
  const req = baseRequest({
    config_override: { candidate_timeframes: [{ start: '11:00', end: '13:00' }] },
  });
  const rejected = recommendSlots(req).recommendations.filter((r) => r.time_frame.start === '11:00');
  assert.equal(rejected.length, 0, 'with overlap=0 the 60-min overlap must be rejected');

  req.config_override.overlap = { max_timeframe_overlap_minutes: 60 };
  const allowed = recommendSlots(req);
  // not rejected *by overlap* — it should at least be generated/feasible (single nearby job, big slack)
  assert.ok(allowed.recommendations.some((r) => r.time_frame.start === '11:00'), 'overlap=60 lets the candidate through');
});

test('multi-job day: new job feasibly inserted between two existing jobs', () => {
  const req = baseRequest();
  req.scheduled_jobs.push({
    id: 'job_1002', date: '2026-06-25', status: 'scheduled', job_type: 'repair',
    window_start: '14:00', window_end: '16:00', lat: EXISTING.lat, lng: EXISTING.lng,
    duration_minutes: 90, assigned_technicians: ['tech_001'],
  });
  const res = recommendSlots(req);
  // the 12:00-14:00 window sits between the two jobs and should be offered
  assert.ok(res.recommendations.some((r) => r.time_frame.start === '12:00'), 'mid-day slot between jobs is feasible');
});

test('overlapMinutes helper matches the spec example (10-12 vs 11-13 = 60)', () => {
  assert.equal(overlapMinutes(10 * 60, 12 * 60, 11 * 60, 13 * 60), 60);
  assert.equal(overlapMinutes(10 * 60, 12 * 60, 12 * 60, 14 * 60), 0); // touching, not overlapping
});
