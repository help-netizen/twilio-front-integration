/**
 * SERVICE-TERR-002 containment seam. Every service-area check goes through
 * this module so list and radius territory modes have one source of truth.
 */

const stQueries = require('../db/serviceTerritoryQueries');
const radiusQueries = require('../db/territoryRadiusQueries');
const territoryGeoService = require('./territoryGeoService');
const { normalizeZip } = require('../utils/zip');
const { haversineMiles } = require('../utils/geo');

function outsideResult(mode, { zip = '', city = '', state = '' } = {}) {
    return {
        inside: false,
        area: '',
        city: city || '',
        state: state || '',
        zip: zip || '',
        mode,
    };
}

function extractRadiusZip(query) {
    const trimmed = String(query ?? '').trim();
    if (/^\d{3,10}$/.test(trimmed)) return normalizeZip(trimmed);
    return trimmed.match(/\b(\d{5})(?:-\d{4})?\b/)?.[1] || '';
}

function isFiniteNumber(value) {
    return typeof value === 'number' && Number.isFinite(value);
}

/**
 * Resolve every Albusto target containing a location in the active mode.
 * `target_ids` are district names in list mode and UUIDs in radius mode.
 */
async function resolveActiveTargets(companyId, location = {}, modeOverride) {
    const settings = modeOverride
        ? { active_mode: modeOverride }
        : await radiusQueries.getSettings(companyId);
    const mode = settings?.active_mode || 'list';

    if (mode === 'list') {
        const districts = await stQueries.getDistrictTargets(companyId);
        if (districts.length === 0) {
            return { mode, resolved: true, no_targets: true, target_ids: [], location: null };
        }
        const query = String(location.query ?? '').trim();
        if (!query) {
            return { mode, resolved: false, no_targets: false, target_ids: [], location: null };
        }
        const row = await stQueries.search(companyId, query);
        if (!row) {
            return { mode, resolved: false, no_targets: false, target_ids: [], location: null };
        }
        return {
            mode,
            resolved: true,
            no_targets: false,
            target_ids: [row.area || ''],
            location: {
                zip: row.zip || '',
                city: row.city || '',
                state: row.state || '',
            },
        };
    }

    let point = null;
    let locationInfo = null;
    if (isFiniteNumber(location.lat) && isFiniteNumber(location.lng)) {
        point = { lat: location.lat, lng: location.lng };
    } else {
        const zip = extractRadiusZip(location.query);
        if (zip) {
            const geo = await territoryGeoService.geocodeZip(zip);
            if (geo) {
                point = { lat: Number(geo.lat), lng: Number(geo.lon) };
                locationInfo = {
                    zip: geo.zip || zip,
                    city: geo.city || '',
                    state: geo.state || '',
                };
            }
        }
    }
    if (!point || !Number.isFinite(point.lat) || !Number.isFinite(point.lng)) {
        return { mode, resolved: false, no_targets: false, target_ids: [], location: locationInfo };
    }

    // Preserve the existing lookup order: resolve a usable point before reading
    // circles. Invalid/city-only input must not touch the radius query, while an
    // empty configured set still returns the resolved ZIP metadata.
    const radii = await radiusQueries.listRadii(companyId);
    if (radii.length === 0) {
        return { mode, resolved: true, no_targets: true, target_ids: [], location: locationInfo };
    }

    const containing = radii
        .map(radius => ({
            radius,
            distance: haversineMiles(radius.lat, radius.lon, point.lat, point.lng),
        }))
        .filter(match => match.distance <= Number(match.radius.radius_miles))
        .sort((a, b) => a.distance - b.distance);
    return {
        mode,
        resolved: containing.length > 0,
        no_targets: false,
        target_ids: containing.map(match => String(match.radius.id)),
        matched_radii: containing,
        location: locationInfo,
    };
}

async function isZipInTerritory(companyId, query) {
    const settings = await radiusQueries.getSettings(companyId);
    const mode = settings?.active_mode || 'list';

    if (mode === 'list') {
        const row = await stQueries.search(companyId, query);
        if (!row) return outsideResult('list');
        return {
            inside: true,
            area: row.area || '',
            city: row.city || '',
            state: row.state || '',
            zip: row.zip || '',
            mode: 'list',
        };
    }

    const resolved = await resolveActiveTargets(companyId, { query }, mode);
    const zip = resolved.location?.zip || extractRadiusZip(query);
    const location = resolved.location || { zip, city: '', state: '' };
    const nearest = resolved.matched_radii?.[0];
    if (!resolved.resolved || !nearest) return outsideResult('radius', location);

    return {
        inside: true,
        area: nearest.radius.zip || 'Radius',
        city: location.city,
        state: location.state,
        zip: location.zip,
        mode: 'radius',
    };
}

module.exports = { isZipInTerritory, resolveActiveTargets };
