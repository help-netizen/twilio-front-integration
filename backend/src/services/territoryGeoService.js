/**
 * SERVICE-TERR-002 ZIP geocoding. Successful public ZIP geography is cached
 * globally; failures are intentionally not cached so transient errors can heal.
 */

const db = require('../db/connection');
const { normalizeZip } = require('../utils/zip');

const PLACE_ID_MAX_AGE_MS = 365 * 24 * 60 * 60 * 1000;

function getGeocodingKey() {
    return process.env.GOOGLE_GEOCODING_KEY || process.env.GOOGLE_PLACES_KEY || null;
}

function findAddressComponent(components, type) {
    return components.find(component => component.types?.includes(type));
}

function isPlaceIdFresh(resolvedAt, now = Date.now()) {
    if (!resolvedAt) return false;
    const resolvedAtMs = new Date(resolvedAt).getTime();
    return Number.isFinite(resolvedAtMs)
        && now - resolvedAtMs < PLACE_ID_MAX_AGE_MS;
}

function publicGeography(zip, row) {
    return {
        zip,
        lat: row.lat,
        lon: row.lon,
        city: row.city ?? null,
        state: row.state ?? null,
    };
}

function exactPostalCodePlaceId(result, zip) {
    const components = result.address_components || [];
    const resultZip = normalizeZip(
        findAddressComponent(components, 'postal_code')?.long_name
    );
    if (resultZip !== zip) return null;

    const placeId = typeof result.place_id === 'string' ? result.place_id.trim() : '';
    return placeId || null;
}

async function requestGoogleZip(zip) {
    const key = getGeocodingKey();
    if (!key) {
        console.warn('[TerritoryGeo] ZIP geocoding key is not configured');
        return null;
    }

    const url = new URL('https://maps.googleapis.com/maps/api/geocode/json');
    url.searchParams.set('components', `postal_code:${zip}|country:US`);
    url.searchParams.set('key', key);

    const response = await fetch(url);
    const payload = await response.json();
    if (payload.status !== 'OK' || !payload.results?.length) {
        console.warn(
            '[TerritoryGeo] ZIP geocoding failed:',
            payload.status || 'ERROR',
            payload.error_message || ''
        );
        return null;
    }

    const result = payload.results[0];
    const lat = result.geometry?.location?.lat ?? null;
    const lon = result.geometry?.location?.lng ?? null;
    if (lat == null || lon == null) {
        console.warn('[TerritoryGeo] ZIP geocoding returned no coordinates');
        return null;
    }

    const components = result.address_components || [];
    const city = findAddressComponent(components, 'locality')?.long_name
        || findAddressComponent(components, 'sublocality')?.long_name
        || findAddressComponent(components, 'postal_town')?.long_name
        || null;
    const state = findAddressComponent(components, 'administrative_area_level_1')?.short_name
        || null;

    return {
        zip,
        lat,
        lon,
        city,
        state,
        googlePlaceId: exactPostalCodePlaceId(result, zip),
    };
}

async function cacheGoogleZip(geography) {
    await db.query(
        `INSERT INTO zip_geocache (
            zip, lat, lon, city, state, google_place_id, place_id_resolved_at
         )
         VALUES ($1, $2, $3, $4, $5, $6, CASE WHEN $6::text IS NULL THEN NULL ELSE NOW() END)
         ON CONFLICT (zip) DO UPDATE SET
            lat = COALESCE(zip_geocache.lat, EXCLUDED.lat),
            lon = COALESCE(zip_geocache.lon, EXCLUDED.lon),
            city = COALESCE(zip_geocache.city, EXCLUDED.city),
            state = COALESCE(zip_geocache.state, EXCLUDED.state),
            google_place_id = COALESCE(EXCLUDED.google_place_id, zip_geocache.google_place_id),
            place_id_resolved_at = CASE
                WHEN EXCLUDED.google_place_id IS NOT NULL THEN EXCLUDED.place_id_resolved_at
                ELSE zip_geocache.place_id_resolved_at
            END`,
        [
            geography.zip,
            geography.lat,
            geography.lon,
            geography.city,
            geography.state,
            geography.googlePlaceId,
        ]
    );
}

async function geocodeZip(input) {
    const zip = normalizeZip(input);
    if (!zip) return null;

    try {
        const cachedResult = await db.query(
            `SELECT lat, lon, city, state
             FROM zip_geocache
             WHERE zip = $1`,
            [zip]
        );
        const cached = cachedResult.rows[0];
        if (cached?.lat != null && cached?.lon != null) {
            return publicGeography(zip, cached);
        }

        const geography = await requestGoogleZip(zip);
        if (!geography) return null;

        await cacheGoogleZip(geography);
        return publicGeography(zip, geography);
    } catch (err) {
        console.warn('[TerritoryGeo] ZIP geocoding exception:', err?.message || String(err));
        return null;
    }
}

async function resolveZipPlaceId(input) {
    const zip = normalizeZip(input);
    if (!zip) return null;

    let cachedPlaceId = null;
    try {
        const cachedResult = await db.query(
            `SELECT google_place_id, place_id_resolved_at
             FROM zip_geocache
             WHERE zip = $1`,
            [zip]
        );
        const cached = cachedResult.rows[0];
        cachedPlaceId = typeof cached?.google_place_id === 'string'
            ? cached.google_place_id.trim() || null
            : null;
        if (cachedPlaceId && isPlaceIdFresh(cached.place_id_resolved_at)) {
            return cachedPlaceId;
        }

        const geography = await requestGoogleZip(zip);
        if (!geography?.googlePlaceId) return cachedPlaceId;

        await cacheGoogleZip(geography);
        return geography.googlePlaceId;
    } catch (err) {
        console.warn(
            '[TerritoryGeo] ZIP place ID resolution exception:',
            err?.message || String(err)
        );
        return cachedPlaceId;
    }
}

module.exports = { geocodeZip, resolveZipPlaceId, isPlaceIdFresh };
