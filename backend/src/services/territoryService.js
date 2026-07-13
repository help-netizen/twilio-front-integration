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

    const zip = extractRadiusZip(query);
    if (!zip) return outsideResult('radius');

    const geo = await territoryGeoService.geocodeZip(zip);
    if (!geo) return outsideResult('radius', { zip });

    const radii = await radiusQueries.listRadii(companyId);
    let nearest = null;
    for (const radius of radii) {
        const distance = haversineMiles(radius.lat, radius.lon, geo.lat, geo.lon);
        if (distance <= Number(radius.radius_miles)
            && (nearest == null || distance < nearest.distance)) {
            nearest = { radius, distance };
        }
    }

    const location = {
        zip: geo.zip || zip,
        city: geo.city || '',
        state: geo.state || '',
    };
    if (!nearest) return outsideResult('radius', location);

    return {
        inside: true,
        area: nearest.radius.zip || 'Radius',
        city: location.city,
        state: location.state,
        zip: location.zip,
        mode: 'radius',
    };
}

module.exports = { isZipInTerritory };
