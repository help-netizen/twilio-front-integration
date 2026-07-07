'use strict';
/**
 * SLOT-ENGINE-001 — core pipeline (MVP).
 * Stateless: recommendSlots(request) -> response. Single-technician, fixed
 * candidate windows, haversine travel. See docs/specs/SLOT-ENGINE-001.md.
 */
const { loadConfig, mergeConfig } = require('./config');
const { adjustedTravelMinutes, haversineMiles } = require('./geo');
const { hmToMin, minToHm, overlapMinutes, clamp, horizonDates } = require('./time');

/** Parse the local wall-clock out of an ISO stamp (offset ignored; windows are company-local). */
function parseLocalStamp(iso) {
  const m = String(iso || '').match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/);
  if (!m) return null;
  return { date: `${m[1]}-${m[2]}-${m[3]}`, minutes: Number(m[4]) * 60 + Number(m[5]) };
}

function resolveDuration(jobType, override, isNew, config) {
  if (override != null) return override;
  const byType = config.durations.by_job_type[jobType || 'unknown'];
  if (byType != null) return byType;
  return isNew ? config.durations.default_new_job_duration_minutes
               : config.durations.default_existing_job_duration_minutes;
}

const BLOCKING_STATUSES = new Set(['scheduled', 'confirmed', 'en_route', 'in_progress', 'submitted']);

/** schedule[techId][date] = sorted jobs (by window start). */
function buildSnapshot(jobs, config) {
  const snap = {};
  for (const j of jobs || []) {
    if (j.status && !BLOCKING_STATUSES.has(String(j.status).toLowerCase())) continue;
    const a = hmToMin(j.window_start);
    const b = hmToMin(j.window_end);
    const node = {
      id: j.id, a, b, lat: j.lat, lng: j.lng,
      duration: resolveDuration(j.job_type, j.duration_minutes, false, config),
    };
    for (const techId of j.assigned_technicians || []) {
      (snap[techId] ||= {});
      (snap[techId][j.date] ||= []).push(node);
    }
  }
  for (const t of Object.keys(snap)) for (const d of Object.keys(snap[t])) snap[t][d].sort((x, y) => x.a - y.a);
  return snap;
}

function recommendSlots(request) {
  const config = loadConfig(request.config_override || request.config);
  const nowStamp = parseLocalStamp(request.requested_at) || { date: null, minutes: 0 };
  const nr = request.new_request || {};
  const newPoint = { lat: nr.lat, lng: nr.lng, uncertainty_radius_meters: nr.uncertainty_radius_meters };
  const newGeoConf = nr.geo_confidence == null ? 1 : nr.geo_confidence;
  const newDuration = resolveDuration(nr.job_type, nr.duration_minutes, true, config);

  // MVP is single-technician (vendor-spec Phase 1). A new request needing a team
  // is out of scope here (Phase 2 = team feasible-interval intersection).
  if ((nr.required_technician_count || 1) > 1) {
    return {
      request_id: request.request_id, config_version: config.config_version,
      generated_at: new Date().toISOString(), recommendations: [],
      summary: { generated_candidates_count: 0, feasible_candidates_count: 0, returned_recommendations_count: 0,
        note: 'multi_technician_requests_not_supported_in_mvp' },
    };
  }

  const techs = (request.technicians || []).filter((t) => t.active !== false);
  const snapshot = buildSnapshot(request.scheduled_jobs, config);
  const lowGeo = newGeoConf < config.geography.min_geo_confidence_for_auto_recommendation;

  const shiftStart = hmToMin(config.workday.shift_start);
  const shiftEnd = hmToMin(config.workday.shift_end) + (config.workday.allowed_overtime_minutes || 0);
  const shiftCapacity = shiftEnd - shiftStart;

  const dates = horizonDates(nr.earliest_allowed_date || nowStamp.date, config.planning.horizon_days, config.planning.include_today)
    .filter((d) => (!nr.earliest_allowed_date || d >= nr.earliest_allowed_date)
      && (!nr.latest_allowed_date || d <= nr.latest_allowed_date)
      // never propose a date earlier than today
      && (!nowStamp.date || !config.planning.exclude_past_timeframes || d >= nowStamp.date));

  // Per-request constants shared by both candidate-generation passes.
  const ctx = { nowStamp, nr, newPoint, newGeoConf, newDuration, lowGeo, shiftStart, shiftEnd, shiftCapacity };

  // ── PASS 1: Tier-1 (config as-is) ───────────────────────────────────────────
  // MUST stay byte-identical to legacy output for any currently-covered location.
  const p1 = generateCandidates(dates, techs, snapshot, config, ctx);
  let deduped = dedupeBestPerSlot(p1.evaluated);
  let generated = p1.generated;
  let rejected = p1.rejected;
  let usedFallback = false;

  // ── PASS 2: Tier-2 (nearest-tech distance fallback) ─────────────────────────
  // Fires ONLY when Tier-1 produced nothing AND a wider ceiling is configured.
  const fbCap = config.geography.fallback_max_distance_miles;
  const canFallback = fbCap != null && fbCap > config.geography.max_distance_from_existing_job_miles;
  if (deduped.length === 0 && canFallback) {
    const fbConfig = deriveFallbackConfig(config, fbCap);
    const p2 = generateCandidates(dates, techs, snapshot, fbConfig, ctx);
    const dedupedFb = dedupeBestPerSlot(p2.evaluated).map((c) => {
      const codes = c.reason_codes.includes('nearest_tech_fallback') ? c.reason_codes : c.reason_codes.concat('nearest_tech_fallback');
      return { ...c, fallback_tier: 2, reason_codes: codes };
    });
    deduped = dedupedFb;
    generated += p2.generated;
    rejected = config.debug.include_rejected_candidates ? rejected.concat(p2.rejected) : rejected;
    usedFallback = dedupedFb.length > 0;
  }

  const ranked = rankAndDiversify(deduped, config);
  return {
    request_id: request.request_id,
    config_version: config.config_version,
    generated_at: new Date().toISOString(),
    recommendations: ranked.map((r, i) => ({ rank: i + 1, ...r })),
    summary: {
      generated_candidates_count: generated,
      feasible_candidates_count: deduped.length,
      returned_recommendations_count: ranked.length,
      used_nearest_fallback: usedFallback,
    },
    ...(config.debug.include_rejected_candidates ? { debug: { rejected_candidates_sample: rejected.slice(0, 25) } } : {}),
  };
}

/**
 * Candidate generation (SLOT-ENGINE-001 core loop). Pure over (dates, techs, snapshot,
 * config, ctx) — no side effects on inputs — so it can be run twice (Tier-1, then Tier-2
 * with a widened config). `ctx` carries the already-computed per-request constants.
 * Returns { evaluated, generated, rejected }.
 */
function generateCandidates(dates, techs, snapshot, config, ctx) {
  const { nowStamp, nr, newPoint, newGeoConf, newDuration, lowGeo, shiftStart, shiftEnd, shiftCapacity } = ctx;
  const evaluated = [];
  let generated = 0;
  const rejected = [];
  const reject = (cand, reason, details) => { if (config.debug.include_rejected_candidates) rejected.push({ candidate_id: cand, reason_code: reason, details }); };

  for (const date of dates) {
    for (const win of config.candidate_timeframes) {
      const a = hmToMin(win.start), b = hmToMin(win.end);
      // past-timeframe filter (today only)
      if (date === nowStamp.date && a < nowStamp.minutes + config.planning.minimum_minutes_before_slot_start_today) continue;

      for (const tech of techs) {
        const existing = (snapshot[tech.id] && snapshot[tech.id][date]) || [];
        const base = tech.base && tech.base.lat != null ? tech.base : null;
        const positions = existing.length ? existing.length + 1 : 1;

        for (let idx = 0; idx < positions; idx++) {
          generated++;
          const candId = `${tech.id}_${date}_${win.start}_${idx}`;
          const newNode = { id: nr.id || 'new', a, b, lat: nr.lat, lng: nr.lng, duration: newDuration, isNew: true, point: newPoint };

          // ── empty-day handling ────────────────────────────────────────────
          if (!existing.length) {
            if (!config.geography.allow_empty_day_candidates) { reject(candId, 'nearest_distance_exceeded', { empty_day: true }); continue; }
            if (!base) { reject(candId, 'nearest_distance_exceeded', { empty_day: true, base: 'unknown' }); continue; }
            const dBase = haversineMiles(base, newPoint);
            if (dBase > config.geography.max_distance_from_base_if_empty_day_miles) { reject(candId, 'nearest_distance_exceeded', { base_distance_miles: dBase }); continue; }
          }

          // route = existing with new spliced at idx
          const route = existing.slice(0, idx).concat([newNode], existing.slice(idx));

          // ── overlap (max + sum over existing) ─────────────────────────────
          let maxOverlap = 0, sumOverlap = 0;
          for (const j of existing) { const ov = overlapMinutes(a, b, j.a, j.b); maxOverlap = Math.max(maxOverlap, ov); sumOverlap += ov; }
          if (maxOverlap > config.overlap.max_timeframe_overlap_minutes) { reject(candId, 'timeframe_overlap_exceeded', { max_overlap_minutes: maxOverlap }); continue; }

          // ── nearest distance to existing ─────────────────────────────────
          let nearest = Infinity;
          for (const j of existing) nearest = Math.min(nearest, haversineMiles(newPoint, j));
          if (existing.length && nearest > config.geography.max_distance_from_existing_job_miles) { reject(candId, 'nearest_distance_exceeded', { nearest_distance_miles: nearest }); continue; }
          if (!existing.length && base) nearest = haversineMiles(base, newPoint);

          // ── edges around the new job ─────────────────────────────────────
          const prev = idx > 0 ? existing[idx - 1] : base;
          const next = idx < existing.length ? existing[idx] : base;
          const T = (x, y) => (x && y ? adjustedTravelMinutes(x.point || x, y.point || y, config) : null);
          const ePrevNew = prev ? T(prev, newNode) : null;
          const eNewNext = next ? T(newNode, next) : null;
          const ePrevNext = prev && next ? T(prev, next) : null;

          // Edge / extra-travel limits use driveMinutes (raw drive) — NOT the geo-uncertainty
          // margin, which would otherwise reject ZIP-level locations entirely.
          for (const e of [ePrevNew, eNewNext]) {
            if (!e) continue;
            if (e.distance_miles > config.travel.max_edge_distance_miles) { reject(candId, 'edge_distance_exceeded', { edge_distance_miles: e.distance_miles }); e.bad = 'd'; }
            if (e.driveMinutes > config.travel.max_edge_travel_minutes) { reject(candId, 'edge_travel_time_exceeded', { edge_travel_minutes: e.driveMinutes }); e.bad = e.bad || 't'; }
          }
          if ((ePrevNew && ePrevNew.bad) || (eNewNext && eNewNext.bad)) continue;

          // ── extra travel (marginal detour; raw drive, no uncertainty margin) ─
          let extraTravel;
          if (ePrevNew && eNewNext && ePrevNext) extraTravel = ePrevNew.driveMinutes + eNewNext.driveMinutes - ePrevNext.driveMinutes;
          else if (ePrevNew && !eNewNext) extraTravel = ePrevNew.driveMinutes;   // after last, no base
          else if (!ePrevNew && eNewNext) extraTravel = eNewNext.driveMinutes;   // before first, no base
          else extraTravel = 0;
          if (extraTravel > config.travel.max_extra_travel_minutes) { reject(candId, 'extra_travel_exceeded', { extra_travel_minutes: extraTravel }); continue; }

          // ── physical feasibility (earliest/latest propagation) ───────────
          const feas = checkFeasibility(route, base, shiftStart, shiftEnd, config);
          if (feas.rejected) { reject(candId, feas.reason, feas.details); continue; }

          // new job feasible interval & slot fit
          const qi = idx; // new job index in route
          const Fstart = feas.E[qi], Fend = feas.L[qi];
          const fitLen = Math.max(0, Fend - Fstart);
          const winLen = b - a;
          const slotFit = winLen > 0 ? fitLen / winLen : 0;
          if (fitLen <= 0) { reject(candId, 'route_infeasible', { feasible_interval_empty: true }); continue; }
          if (slotFit < config.feasibility.min_slot_fit_ratio) { reject(candId, 'low_slot_fit_ratio', { slot_fit_ratio: slotFit }); continue; }

          // ── day utilization ──────────────────────────────────────────────
          const util = feas.workload / shiftCapacity;
          if (util > config.workload.max_day_utilization) { reject(candId, 'utilization_exceeded', { utilization: util }); continue; }

          const hoursUntil = nowStamp.date ? hoursBetween(nowStamp, date, a) : 0;
          const metrics = {
            nearest_existing_job_distance_miles: round1(nearest === Infinity ? null : nearest),
            extra_travel_minutes: round1(extraTravel),
            route_slack_minutes: round1(feas.routeSlack),
            slot_fit_ratio: round2(slotFit),
            max_overlap_minutes: maxOverlap,
            sum_overlap_minutes: sumOverlap,
            day_utilization_after_insert: round2(util),
            geo_confidence: newGeoConf,
            hours_until_slot_start: round2(hoursUntil),
          };
          const score = scoreCandidate(metrics, config);
          // Low location confidence (e.g. ZIP centroid below the floor): never an
          // "auto" recommendation — force low + flag for dispatcher confirmation.
          const confidence = lowGeo ? 'low' : confidenceClass(score, metrics, newGeoConf, config);
          const codes = reasonCodes(metrics);
          if (lowGeo && !codes.includes('low_location_confidence')) codes.push('low_location_confidence');
          evaluated.push({
            candidate_id: candId, date, techId: tech.id, techName: tech.name,
            time_frame: { start: win.start, end: win.end },
            feasible_arrival_interval: { start: minToHm(Fstart), end: minToHm(Fend) },
            metrics, score: round1(score), confidence,
            requires_dispatch_confirmation: lowGeo || undefined,
            reason_codes: codes, explanation: explain(metrics),
          });
        }
      }
    }
  }
  return { evaluated, generated, rejected };
}

/**
 * deriveFallbackConfig(config, fbCap) — clone of `config` with ONLY the distance ceilings
 * widened to the Tier-2 fallback distance (SLOT-ENGINE-NEAREST-FALLBACK-001 §3.3). Never
 * mutates `config`. Overlap (=0), feasibility, scoring and ranking are inherited untouched;
 * we only stop rejecting on raw distance so the same loop admits nearest-tech candidates.
 * Edge/extra-travel caps are lifted with the SAME formula buildConfigOverride uses
 * (K=2.64 min/mi, BUF=10, ×1.10 headroom), floored at the current caps so Tier-2 is never
 * MORE permissive on travel than a correctly-sized Tier-1.
 */
function deriveFallbackConfig(config, fbCap) {
  const K = 2.64, BUF = 10;
  const edge = Math.max(config.travel.max_edge_travel_minutes, Math.ceil((K * fbCap + BUF) * 1.10));
  const extra = Math.max(config.travel.max_extra_travel_minutes, Math.ceil((2 * K * fbCap + BUF) * 1.10));
  return mergeConfig(config, {
    geography: {
      max_distance_from_existing_job_miles: fbCap,
      max_distance_from_base_if_empty_day_miles: fbCap,
      allow_empty_day_candidates: true,
    },
    travel: {
      max_edge_distance_miles: Math.max(config.travel.max_edge_distance_miles, fbCap),
      max_edge_travel_minutes: edge,
      max_extra_travel_minutes: extra,
    },
  });
}

/** Earliest/latest propagation over an ordered route. Returns {E,L,routeSlack,workload} or {rejected}. */
function checkFeasibility(route, base, shiftStart, shiftEnd, config) {
  const n = route.length;
  const E = new Array(n), L = new Array(n);
  const dur = route.map((j) => j.duration);
  const Tmin = (x, y) => adjustedTravelMinutes(x.point || x, y.point || y, config).minutes;

  for (let k = 0; k < n; k++) {
    if (k === 0) E[k] = Math.max(route[k].a, base ? shiftStart + Tmin(base, route[k]) : shiftStart);
    else E[k] = Math.max(route[k].a, E[k - 1] + dur[k - 1] + Tmin(route[k - 1], route[k]));
    if (E[k] > route[k].b) return { rejected: true, reason: 'route_infeasible', details: { at: route[k].id } };
  }
  for (let k = n - 1; k >= 0; k--) {
    if (k === n - 1) L[k] = Math.min(route[k].b, shiftEnd - dur[k] - (base ? Tmin(route[k], base) : 0));
    else L[k] = Math.min(route[k].b, L[k + 1] - dur[k] - Tmin(route[k], route[k + 1]));
    if (E[k] > L[k]) return { rejected: true, reason: 'route_infeasible', details: { at: route[k].id } };
  }
  let routeSlack = Infinity;
  for (let k = 0; k < n; k++) routeSlack = Math.min(routeSlack, L[k] - E[k]);
  if (routeSlack < config.feasibility.min_required_slack_minutes) return { rejected: true, reason: 'insufficient_slack', details: { route_slack_minutes: routeSlack } };

  let workload = dur.reduce((s, d) => s + d, 0);
  for (let k = 1; k < n; k++) workload += Tmin(route[k - 1], route[k]);
  if (base) workload += Tmin(base, route[0]) + Tmin(route[n - 1], base);
  return { E, L, routeSlack, workload };
}

function scoreCandidate(m, config) {
  const w = config.scoring.weights, th = config.scoring.theta;
  const S_extra = Math.exp(-Math.max(0, m.extra_travel_minutes) / th.extra_travel_minutes);
  const S_slack = clamp((m.route_slack_minutes - config.feasibility.min_required_slack_minutes) /
    (config.feasibility.target_good_slack_minutes - config.feasibility.min_required_slack_minutes), 0, 1);
  const S_dist = m.nearest_existing_job_distance_miles == null ? 0.5 : Math.exp(-m.nearest_existing_job_distance_miles / th.distance_miles);
  const S_fit = m.slot_fit_ratio;
  const S_soon = Math.exp(-m.hours_until_slot_start / th.soon_hours);
  const S_work = 1 - clamp((m.day_utilization_after_insert - config.workload.target_day_utilization) /
    (config.workload.max_day_utilization - config.workload.target_day_utilization), 0, 1);
  const S_over = Math.exp(-m.max_overlap_minutes / config.overlap.overlap_penalty_theta_minutes);
  const S_geo = m.geo_confidence;
  return config.scoring.score_scale * (
    w.extra_travel * S_extra + w.slack * S_slack + w.distance * S_dist + w.slot_fit * S_fit +
    w.soon * S_soon + w.workload * S_work + w.overlap * S_over + w.geo_confidence * S_geo);
}

function confidenceClass(score, m, geoConf, config) {
  if (score >= 85 && m.route_slack_minutes >= 30 && m.extra_travel_minutes <= 20 && m.slot_fit_ratio >= 0.5 && geoConf >= 0.7) return 'high';
  if (score >= 70 && m.route_slack_minutes >= 15 && m.extra_travel_minutes <= 35 && m.slot_fit_ratio >= 0.25) return 'medium';
  return 'low';
}

function reasonCodes(m) {
  const codes = [];
  // positive
  if (m.nearest_existing_job_distance_miles != null && m.nearest_existing_job_distance_miles <= 5) codes.push('near_existing_jobs');
  if (m.extra_travel_minutes <= 15) codes.push('low_extra_travel');
  if (m.route_slack_minutes >= 30) codes.push('good_schedule_slack');
  if (m.slot_fit_ratio >= 0.6) codes.push('high_slot_fit');
  if (m.max_overlap_minutes === 0) codes.push('no_overlap');
  // negative / risk
  if (m.extra_travel_minutes > 15 && m.extra_travel_minutes <= 35) codes.push('medium_extra_travel');
  if (m.route_slack_minutes < 30) codes.push('tight_schedule');
  if (m.max_overlap_minutes > 0) codes.push('overlap_allowed');
  if (m.geo_confidence < 0.7) codes.push('low_geo_confidence');
  return codes;
}

/** Keep the highest-scoring candidate per (techId, date, window start). */
function dedupeBestPerSlot(cands) {
  const best = new Map();
  for (const c of cands) {
    const key = `${c.techId}|${c.date}|${c.time_frame.start}`;
    const prev = best.get(key);
    if (!prev || c.score > prev.score) best.set(key, c);
  }
  return [...best.values()];
}

function explain(m) {
  const bits = [];
  if (m.nearest_existing_job_distance_miles != null && m.nearest_existing_job_distance_miles <= 5) bits.push('tech already working nearby');
  if (m.extra_travel_minutes <= 15) bits.push('little extra driving');
  if (m.route_slack_minutes >= 30) bits.push('comfortable schedule gap');
  return bits.length ? bits.join(' · ') : 'Good fit for this route';
}

function rankAndDiversify(cands, config) {
  const sorted = cands.slice().sort((a, b) => b.score - a.score);
  const out = [];
  const perTech = {}, perTf = {};
  for (const c of sorted) {
    if (out.length >= config.ranking.top_n) break;
    const tfKey = `${c.date}_${c.time_frame.start}`;
    if ((perTech[c.techId] || 0) >= config.ranking.max_recommendations_per_technician) continue;
    if ((perTf[tfKey] || 0) >= config.ranking.max_recommendations_per_same_timeframe) continue;
    perTech[c.techId] = (perTech[c.techId] || 0) + 1;
    perTf[tfKey] = (perTf[tfKey] || 0) + 1;
    out.push({
      candidate_id: c.candidate_id, date: c.date, time_frame: c.time_frame,
      technicians: [{ id: c.techId, name: c.techName }],
      score: c.score, confidence: c.confidence,
      ...(c.requires_dispatch_confirmation ? { requires_dispatch_confirmation: true } : {}),
      ...(c.fallback_tier ? { fallback_tier: c.fallback_tier } : {}),
      feasible_arrival_interval: c.feasible_arrival_interval,
      metrics: c.metrics, reason_codes: c.reason_codes, explanation: c.explanation,
    });
  }
  return out;
}

function hoursBetween(nowStamp, date, winStartMin) {
  const [y, m, d] = date.split('-').map(Number);
  const target = new Date(y, m - 1, d, 0, 0, 0).getTime() + winStartMin * 60000;
  const [ny, nm, nd] = nowStamp.date.split('-').map(Number);
  const now = new Date(ny, nm - 1, nd, 0, 0, 0).getTime() + nowStamp.minutes * 60000;
  return Math.max(0, (target - now) / 3600000);
}

const round1 = (x) => (x == null ? null : Math.round(x * 10) / 10);
const round2 = (x) => (x == null ? null : Math.round(x * 100) / 100);

module.exports = { recommendSlots, buildSnapshot, checkFeasibility, explain };
