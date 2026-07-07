'use strict';
/**
 * Default engine config (SLOT-ENGINE-001 §8/§37). MVP values.
 * A request may pass `config_override` which is deep-merged over this.
 */
const DEFAULT_CONFIG = {
  config_version: 'slot_engine_v1_mvp',
  timezone: 'America/New_York',

  planning: {
    horizon_days: 3,
    include_today: true,
    exclude_past_timeframes: true,
    minimum_minutes_before_slot_start_today: 60,
  },

  // Fixed arrival windows (the candidate time frames offered to the client).
  candidate_timeframes: [
    { start: '08:00', end: '10:00' },
    { start: '10:00', end: '12:00' },
    { start: '12:00', end: '14:00' },
    { start: '14:00', end: '16:00' },
    { start: '16:00', end: '18:00' },
  ],

  workday: {
    shift_start: '08:00',
    shift_end: '18:00',
    allowed_overtime_minutes: 0,
  },

  durations: {
    default_new_job_duration_minutes: 75,
    default_existing_job_duration_minutes: 75,
    by_job_type: { service_call: 60, repair: 90, maintenance: 75, unknown: 75 },
  },

  // Haversine MVP travel model (no Google Routes in MVP).
  travel: {
    model: 'haversine',
    average_city_speed_mph: 25,
    travel_time_multiplier: 1.10,
    operational_buffer_minutes: 10,
    geo_uncertainty_beta: 0.5,
    max_edge_distance_miles: 25,
    max_edge_travel_minutes: 45,
    max_extra_travel_minutes: 35,
  },

  geography: {
    max_distance_from_existing_job_miles: 10,
    allow_empty_day_candidates: false,
    max_distance_from_base_if_empty_day_miles: 20,
    min_geo_confidence_for_auto_recommendation: 0.50,
    // Tier-2 "nearest-tech" fallback ceiling (SLOT-ENGINE-NEAREST-FALLBACK-001).
    // Fires only when Tier-1 yields ZERO recs AND this > max_distance_from_existing_job_miles.
    // Set to 0/null/<= normal radius to DISABLE the fallback (Tier-1-only legacy behavior).
    fallback_max_distance_miles: 25,
  },

  overlap: {
    max_timeframe_overlap_minutes: 0,
    overlap_penalty_theta_minutes: 60,
  },

  feasibility: {
    min_required_slack_minutes: 15,
    target_good_slack_minutes: 60,
    min_slot_fit_ratio: 0.15,
  },

  workload: {
    target_day_utilization: 0.85,
    max_day_utilization: 0.95,
  },

  scoring: {
    score_scale: 100,
    weights: {
      extra_travel: 0.25,
      slack: 0.20,
      distance: 0.15,
      slot_fit: 0.15,
      soon: 0.10,
      workload: 0.10,
      overlap: 0.03,
      geo_confidence: 0.02,
    },
    theta: { extra_travel_minutes: 30, distance_miles: 10, soon_hours: 48 },
  },

  ranking: {
    top_n: 3,
    max_recommendations_per_technician: 2,
    max_recommendations_per_same_timeframe: 2,
  },

  debug: { include_rejected_candidates: false },
};

function isObject(v) { return v && typeof v === 'object' && !Array.isArray(v); }

/** Deep-merge override onto a clone of base (arrays replaced wholesale). */
function mergeConfig(base, override) {
  const out = Array.isArray(base) ? base.slice() : { ...base };
  if (!isObject(override)) return out;
  for (const k of Object.keys(override)) {
    if (isObject(out[k]) && isObject(override[k])) out[k] = mergeConfig(out[k], override[k]);
    else out[k] = override[k];
  }
  return out;
}

function loadConfig(override) {
  return mergeConfig(DEFAULT_CONFIG, override || {});
}

module.exports = { DEFAULT_CONFIG, loadConfig, mergeConfig };
