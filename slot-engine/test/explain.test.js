'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { explain, recommendSlots } = require('../src/engine');

// SLOT-ENGINE-001 — UX polish. Unit contract for explain(m).
// Test cases: docs/test-cases/SLOT-ENGINE-001-UX-POLISH.md (EXP-01..12).
// explain reads only: nearest_existing_job_distance_miles, extra_travel_minutes,
// route_slack_minutes (geo_confidence is deliberately NOT read — EXP-07/08).

const NEAR = 'tech already working nearby';
const EXTRA = 'little extra driving';
const SLACK = 'comfortable schedule gap';
const FALLBACK = 'Good fit for this route';

// Build a metrics object with explicit fields. Defaults make every positive
// FALSE so each case can flip exactly the dimensions it exercises.
function m(over = {}) {
  return {
    nearest_existing_job_distance_miles: 99,
    extra_travel_minutes: 99,
    route_slack_minutes: 0,
    geo_confidence: 0.9,
    ...over,
  };
}

// Forbidden-content guard, reused across EXP-06.
function assertCleanEnglish(s) {
  assert.equal(typeof s, 'string');
  assert.ok(s.length > 0, 'non-empty');
  assert.ok(!/[Ѐ-ӿԀ-ԯ]/.test(s), 'no Cyrillic'); // /[Ѐ-ӿ]/
  assert.ok(!/[a-z]+_[a-z]/.test(s), 'no snake_case token');
  assert.ok(!/\d{4}-\d{2}-\d{2}/.test(s), 'no YYYY-MM-DD date');
  assert.ok(!/\d{1,2}:\d{2}/.test(s), 'no HH:MM time');
  for (const bad of ['технік', 'Риск', 'Плюсы']) {
    assert.ok(!s.includes(bad), `no literal "${bad}"`);
  }
  // ASCII-only except the middot · (U+00B7) used as the join separator.
  for (const ch of s) {
    const code = ch.codePointAt(0);
    assert.ok(code < 128 || code === 0x00b7, `char "${ch}" (U+${code.toString(16)}) is ASCII or middot`);
  }
}

// EXP-01: all three positives → joined with " · " in spec order.
test('EXP-01 all three positives → joined in spec order', () => {
  const out = explain(m({ nearest_existing_job_distance_miles: 1.2, extra_travel_minutes: 8, route_slack_minutes: 45 }));
  assert.strictEqual(out, `${NEAR} · ${EXTRA} · ${SLACK}`);
  assert.strictEqual(out, 'tech already working nearby · little extra driving · comfortable schedule gap');
});

// EXP-02: no positives → exact fallback constant.
test('EXP-02 no positives → exact fallback constant', () => {
  const out = explain(m({ nearest_existing_job_distance_miles: 12, extra_travel_minutes: 40, route_slack_minutes: 10 }));
  assert.strictEqual(out, FALLBACK);
  assert.notStrictEqual(out, '');
  assert.notStrictEqual(out, null);
  assert.notStrictEqual(out, undefined);
});

// EXP-03: only "near" positive → single phrase.
test('EXP-03 only near positive → single phrase', () => {
  const out = explain(m({ nearest_existing_job_distance_miles: 3, extra_travel_minutes: 40, route_slack_minutes: 10 }));
  assert.strictEqual(out, NEAR);
});

// EXP-04: only "extra travel" positive → single phrase.
test('EXP-04 only extra-travel positive → single phrase', () => {
  const out = explain(m({ nearest_existing_job_distance_miles: 20, extra_travel_minutes: 5, route_slack_minutes: 10 }));
  assert.strictEqual(out, EXTRA);
});

// EXP-05: only "slack" positive → single phrase.
test('EXP-05 only slack positive → single phrase', () => {
  const out = explain(m({ nearest_existing_job_distance_miles: 20, extra_travel_minutes: 40, route_slack_minutes: 50 }));
  assert.strictEqual(out, SLACK);
});

// EXP-06: English-only / no-leak content guard (table-driven over EXP-01/02/08 inputs).
test('EXP-06 content guard — no Cyrillic / snake_case / date / time, ASCII+middot only', () => {
  const inputs = [
    m({ nearest_existing_job_distance_miles: 1.2, extra_travel_minutes: 8, route_slack_minutes: 45 }), // EXP-01
    m({ nearest_existing_job_distance_miles: 12, extra_travel_minutes: 40, route_slack_minutes: 10 }), // EXP-02
    m({ nearest_existing_job_distance_miles: 30, extra_travel_minutes: 40, route_slack_minutes: 10, geo_confidence: 0.3 }), // EXP-08
  ];
  for (const input of inputs) {
    const out = explain(input);
    assertCleanEnglish(out);
    // No legacy technician/date prefix: must not start with "<word>, " and no ". " segment joins.
    assert.ok(!/^[A-Za-z0-9]+,\s/.test(out), 'no leading "<word>, " prefix');
    assert.ok(!out.includes('. '), 'no ". " segment join');
  }
});

// EXP-07: low geo confidence carries ONLY positives — identical to high-geo, no risk text.
test('EXP-07 low geo + positives → identical to high-geo, no risk text', () => {
  const lowGeo = explain(m({ nearest_existing_job_distance_miles: 1, extra_travel_minutes: 5, route_slack_minutes: 50, geo_confidence: 0.4 }));
  const highGeo = explain(m({ nearest_existing_job_distance_miles: 1, extra_travel_minutes: 5, route_slack_minutes: 50, geo_confidence: 0.9 }));
  assert.strictEqual(lowGeo, `${NEAR} · ${EXTRA} · ${SLACK}`);
  assert.strictEqual(lowGeo, highGeo);
  for (const risk of ['approx', 'Approx', 'ZIP', 'address', 'Risk', 'Риск', 'приблизительная']) {
    assert.ok(!lowGeo.includes(risk), `no risk/uncertainty wording "${risk}"`);
  }
});

// EXP-08: low geo + no positives → still the clean fallback (no risk appended).
test('EXP-08 low geo + no positives → clean fallback, no risk suffix', () => {
  const out = explain(m({ nearest_existing_job_distance_miles: 30, extra_travel_minutes: 40, route_slack_minutes: 10, geo_confidence: 0.3 }));
  assert.strictEqual(out, FALLBACK);
});

// EXP-09: distance edge — 5 inclusive (IN), 5.1 (OUT).
test('EXP-09 distance edge: 5 IN, 5.1 OUT', () => {
  const inEdge = explain(m({ nearest_existing_job_distance_miles: 5, extra_travel_minutes: 40, route_slack_minutes: 10 }));
  assert.strictEqual(inEdge, NEAR);
  const outEdge = explain(m({ nearest_existing_job_distance_miles: 5.1, extra_travel_minutes: 40, route_slack_minutes: 10 }));
  assert.strictEqual(outEdge, FALLBACK);
});

// EXP-10: extra edge (15 IN / 15.1 OUT) and slack edge (30 IN / 29.9 OUT).
test('EXP-10 extra edge 15/15.1 and slack edge 30/29.9', () => {
  const extraIn = explain(m({ nearest_existing_job_distance_miles: 20, extra_travel_minutes: 15, route_slack_minutes: 10 }));
  assert.strictEqual(extraIn, EXTRA);
  const extraOut = explain(m({ nearest_existing_job_distance_miles: 20, extra_travel_minutes: 15.1, route_slack_minutes: 10 }));
  assert.strictEqual(extraOut, FALLBACK);
  const slackIn = explain(m({ nearest_existing_job_distance_miles: 20, extra_travel_minutes: 40, route_slack_minutes: 30 }));
  assert.strictEqual(slackIn, SLACK);
  const slackOut = explain(m({ nearest_existing_job_distance_miles: 20, extra_travel_minutes: 40, route_slack_minutes: 29.9 }));
  assert.strictEqual(slackOut, FALLBACK);
});

// EXP-11: nearest_existing_job_distance_miles == null → near-phrase skipped, no throw.
test('EXP-11 null distance → near phrase skipped, no throw', () => {
  let outA;
  assert.doesNotThrow(() => {
    outA = explain(m({ nearest_existing_job_distance_miles: null, extra_travel_minutes: 5, route_slack_minutes: 50 }));
  });
  assert.strictEqual(outA, `${EXTRA} · ${SLACK}`);
  assert.ok(!outA.includes(NEAR), 'near phrase excluded for null distance');
  const outB = explain(m({ nearest_existing_job_distance_miles: null, extra_travel_minutes: 40, route_slack_minutes: 10 }));
  assert.strictEqual(outB, FALLBACK);
});

// EXP-12: shape — typeof string && length > 0, plus pipeline guard on every rec.explanation.
test('EXP-12 shape: string & length>0 for a representative metrics object', () => {
  const out = explain(m({ nearest_existing_job_distance_miles: 1.2, extra_travel_minutes: 8, route_slack_minutes: 45 }));
  assert.strictEqual(typeof out, 'string');
  assert.ok(out.length > 0);
});

test('EXP-12 pipeline guard: every recommendation.explanation is a non-empty string', () => {
  const res = recommendSlots({
    request_id: 'req_exp12',
    requested_at: '2026-06-25T08:00:00-04:00',
    new_request: {
      id: 'new_1', lat: 42.35, lng: -71.09, geo_confidence: 0.9,
      job_type: 'service_call', required_technician_count: 1,
      earliest_allowed_date: '2026-06-25', latest_allowed_date: '2026-06-25',
    },
    technicians: [{ id: 'tech_001', name: 'Robert', active: true, base: { lat: 42.36, lng: -71.06 } }],
    scheduled_jobs: [{
      id: 'job_1001', date: '2026-06-25', status: 'scheduled', job_type: 'service_call',
      window_start: '10:00', window_end: '12:00', lat: 42.34, lng: -71.10,
      duration_minutes: 60, assigned_technicians: ['tech_001'],
    }],
  });
  assert.ok(res.recommendations.length >= 1, 'expected at least one recommendation');
  for (const rec of res.recommendations) {
    assert.strictEqual(typeof rec.explanation, 'string');
    assert.ok(rec.explanation.length > 0, 'explanation non-empty');
  }
});
