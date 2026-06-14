/**
 * Google Places proxy — ALB-101 onboarding.
 *
 * Server-side proxy so the key never reaches the browser. Degrades to empty
 * suggestions when the key is missing — frontend falls back to manual entry.
 */

const KEY = process.env.GOOGLE_PLACES_KEY || process.env.GOOGLE_GEOCODING_KEY || null;
// Geocoding prefers the geocoding key; Places key is the fallback.
const GEOCODE_KEY = () => process.env.GOOGLE_GEOCODING_KEY || process.env.GOOGLE_PLACES_KEY || null;

/**
 * SCHED-ROUTE-001 (C-5): geocode a raw service address (no place_id path).
 * Returns coordinates + normalized address + confidence signals (location_type,
 * partial_match, place_id) so callers can set jobs.geocoding_status. Returns
 * { status:'failed', ... } on no result / missing key — never throws on a bad
 * address. Key is read from env only (never hardcoded, never sent to the browser).
 */
async function geocodeAddress(address) {
    const key = GEOCODE_KEY();
    if (!key) return { status: 'failed', error_code: 'NO_KEY', error_message: 'Geocoding key not configured' };
    if (!address || !String(address).trim()) {
        return { status: 'failed', error_code: 'NO_ADDRESS', error_message: 'Empty address' };
    }
    try {
        const url = new URL('https://maps.googleapis.com/maps/api/geocode/json');
        url.searchParams.set('address', String(address).trim());
        url.searchParams.set('key', key);
        const res = await fetch(url);
        const json = await res.json();
        if (json.status === 'ZERO_RESULTS') {
            return { status: 'failed', error_code: 'ZERO_RESULTS', error_message: 'No geocode result' };
        }
        if (json.status !== 'OK' || !json.results?.length) {
            return { status: 'failed', error_code: json.status || 'ERROR', error_message: json.error_message || 'Geocode failed' };
        }
        const r = json.results[0];
        const lat = r.geometry?.location?.lat ?? null;
        const lng = r.geometry?.location?.lng ?? null;
        if (lat == null || lng == null) {
            return { status: 'failed', error_code: 'NO_COORDS', error_message: 'No coordinates in result' };
        }
        const { mapGeocodeConfidence } = require('./routeGeo');
        const status = mapGeocodeConfidence({
            partial_match: r.partial_match === true,
            location_type: r.geometry?.location_type,
        });
        return {
            status,                                   // 'success' | 'needs_review'
            lat, lng,
            normalized_address: r.formatted_address || null,
            place_id: r.place_id || null,
            location_type: r.geometry?.location_type || null,
            partial_match: r.partial_match === true,
        };
    } catch (err) {
        return { status: 'failed', error_code: 'EXCEPTION', error_message: err.message };
    }
}

async function suggest(q) {
    if (!KEY || !q || q.trim().length < 2) return [];
    const url = new URL('https://maps.googleapis.com/maps/api/place/autocomplete/json');
    url.searchParams.set('input', q.trim());
    url.searchParams.set('types', '(regions)');
    url.searchParams.set('components', 'country:us');
    url.searchParams.set('key', KEY);
    const res = await fetch(url);
    const json = await res.json();
    if (json.status !== 'OK' && json.status !== 'ZERO_RESULTS') {
        console.warn('[Places] autocomplete status:', json.status, json.error_message || '');
        return [];
    }
    return (json.predictions || []).slice(0, 5).map(p => ({
        place_id: p.place_id,
        description: p.description,
    }));
}

async function resolve(placeId) {
    if (!KEY || !placeId) return null;
    const url = new URL('https://maps.googleapis.com/maps/api/place/details/json');
    url.searchParams.set('place_id', placeId);
    url.searchParams.set('fields', 'address_component,geometry');
    url.searchParams.set('key', KEY);
    const res = await fetch(url);
    const json = await res.json();
    if (json.status !== 'OK') return null;

    const comps = json.result.address_components || [];
    const get = (type) => comps.find(c => c.types.includes(type));
    const city = get('locality')?.long_name
        || get('sublocality')?.long_name
        || get('postal_town')?.long_name
        || get('administrative_area_level_3')?.long_name
        || null;
    const state = get('administrative_area_level_1')?.short_name || null;
    const zip = get('postal_code')?.long_name || null;
    const lat = json.result.geometry?.location?.lat ?? null;
    const lng = json.result.geometry?.location?.lng ?? null;

    let timezone = 'America/New_York';
    if (lat != null && lng != null) {
        try {
            const tzUrl = new URL('https://maps.googleapis.com/maps/api/timezone/json');
            tzUrl.searchParams.set('location', `${lat},${lng}`);
            tzUrl.searchParams.set('timestamp', String(Math.floor(Date.now() / 1000)));
            tzUrl.searchParams.set('key', KEY);
            const tzRes = await fetch(tzUrl);
            const tzJson = await tzRes.json();
            if (tzJson.status === 'OK' && tzJson.timeZoneId) timezone = tzJson.timeZoneId;
        } catch (err) {
            console.warn('[Places] timezone lookup failed:', err.message);
        }
    }

    return { city, state, zip, lat, lng, timezone };
}

module.exports = { suggest, resolve, geocodeAddress, _hasKey: () => !!KEY };
