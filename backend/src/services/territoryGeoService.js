/**
 * SERVICE-TERR-002 ZIP geocoding. Successful public ZIP geography is cached
 * globally; failures are intentionally not cached so transient errors can heal.
 */

const db = require('../db/connection');
const { normalizeZip } = require('../utils/zip');

function getGeocodingKey() {
    return process.env.GOOGLE_GEOCODING_KEY || process.env.GOOGLE_PLACES_KEY || null;
}

function findAddressComponent(components, type) {
    return components.find(component => component.types?.includes(type));
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
            return {
                zip,
                lat: cached.lat,
                lon: cached.lon,
                city: cached.city ?? null,
                state: cached.state ?? null,
            };
        }

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

        await db.query(
            `INSERT INTO zip_geocache (zip, lat, lon, city, state)
             VALUES ($1, $2, $3, $4, $5)
             ON CONFLICT (zip) DO NOTHING`,
            [zip, lat, lon, city, state]
        );

        return { zip, lat, lon, city, state };
    } catch (err) {
        console.warn('[TerritoryGeo] ZIP geocoding exception:', err?.message || String(err));
        return null;
    }
}

module.exports = { geocodeZip };
