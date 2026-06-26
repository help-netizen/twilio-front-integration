'use strict';
/** Haversine distance + MVP travel-time model (SLOT-ENGINE-001 §15, haversine variant). */

const EARTH_RADIUS_MILES = 3958.7613;
const toRad = (d) => (d * Math.PI) / 180;

/** Great-circle distance in miles between two {lat,lng} points. */
function haversineMiles(a, b) {
  if (!a || !b || a.lat == null || b.lat == null) return Infinity;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_MILES * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Adjusted travel time (minutes) between two points, MVP/haversine:
 *   raw = distance / speed
 *   T   = raw * multiplier + operational_buffer + geo_uncertainty_buffer
 * geo_uncertainty_buffer grows when either endpoint is a low-confidence
 * location (e.g. a ZIP centroid). a/b may carry `uncertainty_radius_meters`.
 */
function adjustedTravelMinutes(a, b, config) {
  const t = config.travel;
  const distance = haversineMiles(a, b);
  if (!isFinite(distance)) return { distance_miles: Infinity, minutes: Infinity, driveMinutes: Infinity };
  const speed = t.average_city_speed_mph || 25;
  const rawMinutes = (distance / speed) * 60;
  const uncA = metersToMiles(a && a.uncertainty_radius_meters) || 0;
  const uncB = metersToMiles(b && b.uncertainty_radius_meters) || 0;
  const geoBufferMinutes = ((t.geo_uncertainty_beta ?? 0.5) * (uncA + uncB) / speed) * 60;
  // driveMinutes = actual drive estimate (raw * multiplier + per-stop operational buffer).
  // Use this for edge / extra-travel LIMITS — a detour is a detour regardless of how precisely
  // the address was geocoded.
  const driveMinutes = rawMinutes * (t.travel_time_multiplier ?? 1) + (t.operational_buffer_minutes ?? 0);
  // minutes = driveMinutes + geo-uncertainty risk margin. Use this for FEASIBILITY (conservative
  // arrival time) only — never for the detour limits (the margin is added asymmetrically to the
  // edges touching the uncertain point and would otherwise reject ZIP-level locations entirely).
  const minutes = driveMinutes + geoBufferMinutes;
  return { distance_miles: distance, minutes, driveMinutes };
}

function metersToMiles(m) { return m == null ? 0 : m / 1609.344; }

module.exports = { haversineMiles, adjustedTravelMinutes };
