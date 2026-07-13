'use strict';

const marketplaceQueries = require('../db/marketplaceQueries');
const territoryRadiusQueries = require('../db/territoryRadiusQueries');
const territoryService = require('./territoryService');
const { normalizeZip } = require('../utils/zip');
const { RELY_UNIT_TYPES, RELY_BRANDS } = require('./relyLeadsCatalog');

function isPlainObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function createVerdict(accepted, reason, extracted, active, error = null) {
    return {
        accepted,
        reason,
        extracted: {
            zip: extracted.zip,
            unit: extracted.unit,
            brand: extracted.brand,
        },
        active: {
            zone: active.zone,
            unit_types: active.unit_types,
            brands: active.brands,
        },
        error,
    };
}

function isRelyLead(payload) {
    return String(payload?.JobSource ?? '').trim().toLowerCase() === 'rely';
}

function parseZipList(input) {
    if (input == null) return { zips: [], invalid: [] };

    const values = Array.isArray(input) ? input : [input];
    const rawTokens = values.flatMap((value) => String(value).split(/[\s,;]+/))
        .map((token) => token.trim())
        .filter(Boolean);
    const zips = [];
    const invalid = [];
    const seen = new Set();

    for (const rawToken of rawTokens) {
        const zip = normalizeZip(rawToken);
        if (!/^\d{5}$/.test(zip)) {
            invalid.push(rawToken);
            continue;
        }
        if (!seen.has(zip)) {
            seen.add(zip);
            zips.push(zip);
        }
    }

    return { zips, invalid };
}

function parseDescription(text) {
    let unitRaw = null;
    let brandRaw = null;

    for (const line of String(text ?? '').split(/\r?\n/)) {
        if (unitRaw === null) {
            const issueMatch = line.match(/^\s*issue\s*:\s*(.+)$/i);
            if (issueMatch) unitRaw = issueMatch[1].trim();
        }
        if (brandRaw === null) {
            const brandMatch = line.match(/^\s*brand\s*:\s*(.+)$/i);
            if (brandMatch) brandRaw = brandMatch[1].trim();
        }
        if (unitRaw !== null && brandRaw !== null) break;
    }

    return { unit_raw: unitRaw, brand_raw: brandRaw };
}

function normalizeCatalogValue(value) {
    return String(value ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function matchCatalogEntry(raw, catalog) {
    if (raw == null || !Array.isArray(catalog)) return null;

    const normalizedRaw = normalizeCatalogValue(raw);
    if (!normalizedRaw) return null;
    const paddedRaw = ` ${normalizedRaw} `;

    for (const entry of catalog) {
        const normalizedEntry = normalizeCatalogValue(entry);
        if (normalizedEntry && paddedRaw.includes(` ${normalizedEntry} `)) return entry;
    }

    return null;
}

function resolveRelySettings(metadata) {
    const settings = isPlainObject(metadata) && isPlainObject(metadata.settings)
        ? metadata.settings
        : {};
    const zone = isPlainObject(settings.zone) ? settings.zone : {};

    return {
        zone: {
            mode: zone.mode === 'custom' ? 'custom' : 'company',
            custom_zips: Array.isArray(zone.custom_zips) ? [...zone.custom_zips] : [],
        },
        unit_types: Array.isArray(settings.unit_types)
            ? settings.unit_types.filter((value) => RELY_UNIT_TYPES.includes(value))
            : [],
        brands: Array.isArray(settings.brands)
            ? settings.brands.filter((value) => RELY_BRANDS.includes(value))
            : [],
    };
}

async function hasCompanyTerritoryData(companyId) {
    const settings = await territoryRadiusQueries.getSettings(companyId);
    const mode = settings?.active_mode || 'list';

    if (mode === 'radius') {
        const radii = await territoryRadiusQueries.listRadii(companyId);
        return Array.isArray(radii) && radii.length > 0;
    }

    return Number(await territoryRadiusQueries.countListZips(companyId)) > 0;
}

async function evaluateRelyLead(payload, companyId) {
    const extracted = { zip: null, unit: null, brand: null };
    const active = { zone: false, unit_types: false, brands: false };

    try {
        extracted.zip = normalizeZip(payload?.PostalCode) || null;

        const row = await marketplaceQueries.getConnectedRelySettings(companyId);
        if (!row) return createVerdict(true, null, extracted, active);

        const settings = resolveRelySettings(row.metadata);
        active.unit_types = settings.unit_types.length > 0;
        active.brands = settings.brands.length > 0;

        if (settings.zone.mode === 'custom') {
            active.zone = settings.zone.custom_zips.length > 0;
            if (active.zone
                && (!extracted.zip || !settings.zone.custom_zips.includes(extracted.zip))) {
                return createVerdict(false, 'out_of_area', extracted, active);
            }
        } else {
            let inside = false;
            if (extracted.zip) {
                const territoryResult = await territoryService.isZipInTerritory(
                    companyId,
                    extracted.zip
                );
                inside = territoryResult?.inside === true;
            }

            if (inside) {
                active.zone = true;
            } else {
                active.zone = await hasCompanyTerritoryData(companyId);
                if (active.zone) {
                    return createVerdict(false, 'out_of_area', extracted, active);
                }
            }
        }

        let parsed = null;
        if (active.unit_types || active.brands) parsed = parseDescription(payload?.Description);

        if (active.unit_types) {
            extracted.unit = matchCatalogEntry(parsed.unit_raw, RELY_UNIT_TYPES);
            if (extracted.unit && !settings.unit_types.includes(extracted.unit)) {
                return createVerdict(false, 'unit_not_serviced', extracted, active);
            }
        }

        if (active.brands) {
            extracted.brand = matchCatalogEntry(parsed.brand_raw, RELY_BRANDS);
            if (extracted.brand && !settings.brands.includes(extracted.brand)) {
                return createVerdict(false, 'brand_not_serviced', extracted, active);
            }
        }

        return createVerdict(true, null, extracted, active);
    } catch (err) {
        console.error('[RelyLeadFilter] fail-open', err);
        const message = err && typeof err.message === 'string' ? err.message : String(err);
        return createVerdict(true, null, extracted, active, message);
    }
}

function buildMarker(verdict) {
    return {
        rejected: true,
        reason: verdict?.reason ?? null,
        evaluated_at: new Date().toISOString(),
        zip: verdict?.extracted?.zip ?? null,
        unit: verdict?.extracted?.unit ?? null,
        brand: verdict?.extracted?.brand ?? null,
    };
}

module.exports = {
    isRelyLead,
    parseZipList,
    parseDescription,
    matchCatalogEntry,
    evaluateRelyLead,
    buildMarker,
    resolveRelySettings,
};
