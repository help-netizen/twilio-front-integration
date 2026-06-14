/**
 * routeDistanceService.js — SCHED-ROUTE-001 route estimate (FR-007/008).
 *
 * driving, NO live traffic (departure_time is never sent). GLOBAL cache-first
 * (C-4): a successful cache entry means Google is NOT called. Per-pair 1×1
 * Distance Matrix requests (1 billed element each) — cheaper than a cross-product
 * matrix for path-shaped routes; cache-miss pairs are fired concurrently for
 * latency. Key from env only (never hardcoded, never sent to the browser).
 *
 * Correction to spec C-8: do NOT batch consecutive pairs into one N×N matrix —
 * that bills N² elements while a path needs only N. "Batch" here = concurrency.
 */

const { buildCacheKey } = require('./routeGeo');
const routeQueries = require('../db/routeQueries');

const KEY = () => process.env.GOOGLE_GEOCODING_KEY || process.env.GOOGLE_PLACES_KEY || null;

/** Low-level 1×1 Distance Matrix call. Returns {distanceMeters, durationMinutes} or throws. */
async function callDistanceMatrix(origin, dest, travelMode = 'driving') {
    const key = KEY();
    if (!key) { const e = new Error('Route key not configured'); e.code = 'NO_KEY'; throw e; }
    const url = new URL('https://maps.googleapis.com/maps/api/distancematrix/json');
    url.searchParams.set('origins', `${origin.lat},${origin.lng}`);
    url.searchParams.set('destinations', `${dest.lat},${dest.lng}`);
    url.searchParams.set('mode', travelMode);          // driving; NO departure_time = no traffic
    url.searchParams.set('units', 'metric');
    url.searchParams.set('key', key);
    const res = await fetch(url);
    const json = await res.json();
    if (json.status !== 'OK') { const e = new Error(json.error_message || json.status); e.code = json.status || 'ERROR'; throw e; }
    const el = json.rows?.[0]?.elements?.[0];
    if (!el || el.status !== 'OK') { const e = new Error(el?.status || 'NO_ELEMENT'); e.code = el?.status || 'NO_RESULT'; throw e; }
    return {
        distanceMeters: el.distance?.value ?? null,
        durationMinutes: el.duration?.value != null ? Math.round(el.duration.value / 60) : null,
    };
}

/**
 * Resolve one origin→dest estimate. Cache-first; on miss, calls Google and
 * stores the result in the GLOBAL cache. Returns:
 *   { status:'success', distanceMeters, durationMinutes, cacheKey, fromCache }
 *   { status:'failed', errorCode, errorMessage, cacheKey }
 */
async function computePair(origin, dest, travelMode = 'driving') {
    const cacheKey = buildCacheKey(origin.lat, origin.lng, dest.lat, dest.lng, travelMode);

    const cached = await routeQueries.getCache(cacheKey);
    if (cached) {
        return {
            status: 'success', fromCache: true, cacheKey,
            distanceMeters: cached.distance_meters, durationMinutes: cached.duration_minutes,
        };
    }

    try {
        const r = await callDistanceMatrix(origin, dest, travelMode);
        await routeQueries.putCache({
            originLat: origin.lat, originLng: origin.lng, destLat: dest.lat, destLng: dest.lng,
            travelMode, cacheKey, distanceMeters: r.distanceMeters, durationMinutes: r.durationMinutes,
            status: 'success',
        });
        return { status: 'success', fromCache: false, cacheKey, ...r };
    } catch (err) {
        // Do NOT cache failures as success; surface for the segment status.
        return { status: 'failed', cacheKey, errorCode: err.code || 'ERROR', errorMessage: err.message };
    }
}

module.exports = { computePair, callDistanceMatrix };
