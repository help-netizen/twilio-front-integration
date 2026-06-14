/**
 * routeGeo.js — SCHED-ROUTE-001 pure helpers (no I/O, fully unit-tested).
 *
 * Holds the correctness-critical, side-effect-free logic for route scheduling:
 * coordinate rounding + global cache key (C-4), geocode confidence mapping (C-5),
 * company-local schedule day (C-3), the generated Google Maps URL (C-6), and the
 * affected-segment diff for insert/remove/reassign/address-change (Affected
 * segment logic). Keeping this pure makes the route engine deterministic.
 */

const CACHE_PRECISION = 5; // ~1.1 m; same for cache write and lookup (C-4)

/** Round a coordinate to the agreed cache precision. Returns a Number. */
function roundCoord(n) {
    if (n == null || Number.isNaN(Number(n))) return null;
    return Number(Number(n).toFixed(CACHE_PRECISION));
}

/**
 * Deterministic GLOBAL cache key for a directed coordinate pair + mode.
 * Never serialize raw floats — always round first (C-4).
 */
function buildCacheKey(oLat, oLng, dLat, dLng, travelMode = 'driving') {
    const r = (x) => roundCoord(x)?.toFixed(CACHE_PRECISION);
    return `${travelMode}:${r(oLat)},${r(oLng)}:${r(dLat)},${r(dLng)}`;
}

/**
 * Map a Google geocode result to a job geocoding_status (C-5).
 *  success      — precise, trustworthy.
 *  needs_review — ambiguous/low precision (still routable if coords present).
 */
function mapGeocodeConfidence({ partial_match, location_type } = {}) {
    const precise = location_type === 'ROOFTOP' || location_type === 'RANGE_INTERPOLATED';
    if (!partial_match && precise) return 'success';
    return 'needs_review';
}

/** Build the Google Maps link on read — never persisted (C-6). */
function googleMapsUrl({ lat, lng, address } = {}) {
    if (lat != null && lng != null) {
        return `https://www.google.com/maps/search/?api=1&query=${lat},${lng}`;
    }
    if (address) {
        return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(address)}`;
    }
    return null;
}

/**
 * Company-local schedule day (C-3) for a UTC timestamp + IANA tz.
 * Returns 'YYYY-MM-DD' in the company timezone (NOT the UTC date).
 */
function companyDay(startUtc, timeZone = 'America/New_York') {
    if (!startUtc) return null;
    const d = startUtc instanceof Date ? startUtc : new Date(startUtc);
    if (Number.isNaN(d.getTime())) return null;
    // en-CA gives ISO-style YYYY-MM-DD; formatToParts avoids locale surprises.
    const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    }).formatToParts(d);
    const get = (t) => parts.find((p) => p.type === t)?.value;
    return `${get('year')}-${get('month')}-${get('day')}`;
}

/** Adjacent directed pairs of an ordered job-id sequence: [[a,b],[b,c],…]. */
function adjacentPairs(seq) {
    const out = [];
    for (let i = 0; i + 1 < seq.length; i++) out.push([seq[i], seq[i + 1]]);
    return out;
}

const pairKey = (p) => `${p[0]}->${p[1]}`;

/**
 * Affected-segment diff for ONE technician/day sequence (Affected segment logic).
 *
 * @param {Array} oldSeq  ordered job ids before the change
 * @param {Array} newSeq  ordered job ids after the change
 * @param {Set|Array} changedJobIds jobs whose address/coords changed (force recalc
 *        of any surviving pair that touches them)
 * @returns {{ stale: Array<[from,to]>, toCalc: Array<[from,to]> }}
 *   stale  — currently-active pairs to mark stale
 *   toCalc — pairs to (re)calculate or reuse from cache
 */
function computeAffectedPairs(oldSeq = [], newSeq = [], changedJobIds = []) {
    const changed = new Set((changedJobIds || []).map(String));
    const oldPairs = adjacentPairs(oldSeq);
    const newPairs = adjacentPairs(newSeq);
    const oldByKey = new Map(oldPairs.map((p) => [pairKey(p), p]));
    const newByKey = new Map(newPairs.map((p) => [pairKey(p), p]));

    const stale = [];
    const toCalc = [];

    // Pairs that disappeared, or that survived but touch a coord-changed job.
    for (const [k, p] of oldByKey) {
        const survived = newByKey.has(k);
        const touchesChanged = changed.has(String(p[0])) || changed.has(String(p[1]));
        if (!survived || touchesChanged) stale.push(p);
    }
    // Pairs that are new, or that survived but touch a coord-changed job (recalc).
    for (const [k, p] of newByKey) {
        const existed = oldByKey.has(k);
        const touchesChanged = changed.has(String(p[0])) || changed.has(String(p[1]));
        if (!existed || touchesChanged) toCalc.push(p);
    }
    return { stale, toCalc };
}

module.exports = {
    CACHE_PRECISION,
    roundCoord,
    buildCacheKey,
    mapGeocodeConfidence,
    googleMapsUrl,
    companyDay,
    adjacentPairs,
    computeAffectedPairs,
};
