'use strict';
/**
 * SLOT-ENGINE-001 — core pipeline (MVP).
 * Stateless: recommendSlots(request) -> response. Single-technician, fixed
 * candidate windows, haversine travel. See docs/specs/SLOT-ENGINE-001.md.
 */
const { loadConfig } = require('./config');
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

  const techs = (request.technicians || []).filter((t) => t.active !== false);
  const snapshot = buildSnapshot(request.scheduled_jobs, config);

  const shiftStart = hmToMin(config.workday.shift_start);
  const shiftEnd = hmToMin(config.workday.shift_end) + (config.workday.allowed_overtime_minutes || 0);
  const shiftCapacity = shiftEnd - shiftStart;

  const dates = horizonDates(nr.earliest_allowed_date || nowStamp.date, config.planning.horizon_days, config.planning.include_today)
    .filter((d) => (!nr.earliest_allowed_date || d >= nr.earliest_allowed_date) && (!nr.latest_allowed_date || d <= nr.latest_allowed_date));

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

          // ── overlap (max over existing) ───────────────────────────────────
          let maxOverlap = 0;
          for (const j of existing) maxOverlap = Math.max(maxOverlap, overlapMinutes(a, b, j.a, j.b));
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

          for (const e of [ePrevNew, eNewNext]) {
            if (!e) continue;
            if (e.distance_miles > config.travel.max_edge_distance_miles) { reject(candId, 'edge_distance_exceeded', { edge_distance_miles: e.distance_miles }); e.bad = 'd'; }
            if (e.minutes > config.travel.max_edge_travel_minutes) { reject(candId, 'edge_travel_time_exceeded', { edge_travel_minutes: e.minutes }); e.bad = e.bad || 't'; }
          }
          if ((ePrevNew && ePrevNew.bad) || (eNewNext && eNewNext.bad)) continue;

          // ── extra travel ─────────────────────────────────────────────────
          let extraTravel;
          if (ePrevNew && eNewNext && ePrevNext) extraTravel = ePrevNew.minutes + eNewNext.minutes - ePrevNext.minutes;
          else if (ePrevNew && !eNewNext) extraTravel = ePrevNew.minutes;       // after last, no base
          else if (!ePrevNew && eNewNext) extraTravel = eNewNext.minutes;       // before first, no base
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
            day_utilization_after_insert: round2(util),
            geo_confidence: newGeoConf,
            hours_until_slot_start: round2(hoursUntil),
          };
          const score = scoreCandidate(metrics, config);
          const confidence = confidenceClass(score, metrics, newGeoConf, config);
          evaluated.push({
            candidate_id: candId, date, techId: tech.id, techName: tech.name,
            time_frame: { start: win.start, end: win.end },
            feasible_arrival_interval: { start: minToHm(Fstart), end: minToHm(Fend) },
            metrics, score: round1(score), confidence,
            reason_codes: reasonCodes(metrics), explanation: explain(win, date, tech, metrics),
          });
        }
      }
    }
  }

  const ranked = rankAndDiversify(evaluated, config);
  return {
    request_id: request.request_id,
    config_version: config.config_version,
    generated_at: new Date().toISOString(),
    recommendations: ranked.map((r, i) => ({ rank: i + 1, ...r })),
    summary: {
      generated_candidates_count: generated,
      feasible_candidates_count: evaluated.length,
      returned_recommendations_count: ranked.length,
    },
    ...(config.debug.include_rejected_candidates ? { debug: { rejected_candidates_sample: rejected.slice(0, 25) } } : {}),
  };
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
  if (m.nearest_existing_job_distance_miles != null && m.nearest_existing_job_distance_miles <= 5) codes.push('near_existing_jobs');
  if (m.extra_travel_minutes <= 15) codes.push('low_extra_travel');
  if (m.route_slack_minutes >= 30) codes.push('good_schedule_slack');
  if (m.slot_fit_ratio >= 0.6) codes.push('high_slot_fit');
  if (m.max_overlap_minutes === 0) codes.push('no_overlap');
  if (m.extra_travel_minutes > 15 && m.extra_travel_minutes <= 35) codes.push('medium_extra_travel');
  if (m.geo_confidence < 0.7) codes.push('low_geo_confidence');
  return codes;
}

function explain(win, date, tech, m) {
  const bits = [];
  if (m.nearest_existing_job_distance_miles != null && m.nearest_existing_job_distance_miles <= 5) bits.push('технік уже работает рядом');
  if (m.extra_travel_minutes <= 15) bits.push('мало добавочной езды');
  if (m.route_slack_minutes >= 30) bits.push('хороший запас по расписанию');
  const risk = m.geo_confidence < 0.7 ? ' Риск: локация приблизительная (ZIP).' : '';
  return `${date}, ${win.start}-${win.end}, ${tech.name || tech.id}. ${bits.length ? 'Плюсы: ' + bits.join(', ') + '.' : ''}${risk}`.trim();
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

module.exports = { recommendSlots, buildSnapshot, checkFeasibility };
