/**
 * technicianBaseLocationsService.js — manage technician base (home) locations for the
 * slot engine (SLOT-ENGINE-001 Phase 2). Lists the Zenbooker service-provider roster
 * merged with stored base coordinates, and upserts a base either from explicit lat/lng
 * or by geocoding an address.
 */
const queries = require('../db/technicianBaseLocationQueries');
const zenbookerClient = require('./zenbookerClient');
const googlePlacesService = require('./googlePlacesService');

function isFiniteNum(n) {
    return typeof n === 'number' && Number.isFinite(n);
}

function trimOrNull(v) {
    if (v === null || v === undefined) return null;
    const s = String(v).trim();
    return s === '' ? null : s;
}

// Project the structured-address columns off a stored row (or all-null when absent),
// so every list() branch returns the same shape for the editor to pre-fill.
function structuredOf(row) {
    return {
        street: row ? (row.street || null) : null,
        apt: row ? (row.apt || null) : null,
        city: row ? (row.city || null) : null,
        state: row ? (row.state || null) : null,
        zip: row ? (row.zip || null) : null,
    };
}

// Compose a single-line address from structured fields (used to geocode when the
// caller typed parts but no composed `address` string).
function composeAddress({ street, apt, city, state, zip }) {
    const line1 = [trimOrNull(street), trimOrNull(apt)].filter(Boolean).join(' ');
    const tail = [trimOrNull(city), [trimOrNull(state), trimOrNull(zip)].filter(Boolean).join(' ')]
        .filter(Boolean)
        .join(', ');
    return [line1, tail].filter(Boolean).join(', ').trim() || null;
}

/**
 * Roster of service-provider technicians (from Zenbooker), LEFT-merged with stored
 * base locations. If Zenbooker is unavailable, degrade to just the stored rows.
 * Shape: [{ tech_id, name, lat, lng, label, address, has_base }]
 */
async function list(companyId) {
    const stored = await queries.listByCompany(companyId);
    const byId = new Map(stored.map(r => [String(r.tech_id), r]));

    let members = null;
    try {
        members = await zenbookerClient.getTeamMembers(
            { service_provider: true, deactivated: false },
            companyId
        );
    } catch (err) {
        console.warn('[TechBaseLocations] Zenbooker roster unavailable:', err.message);
        members = null;
    }

    if (!Array.isArray(members)) {
        // Degrade: surface only the stored base rows.
        return stored.map(r => ({
            tech_id: String(r.tech_id),
            name: null,
            lat: r.lat,
            lng: r.lng,
            label: r.label || null,
            address: r.address || null,
            ...structuredOf(r),
            has_base: true,
        }));
    }

    const seen = new Set();
    const out = members.map(m => {
        const techId = String(m.id);
        seen.add(techId);
        const base = byId.get(techId);
        const name = [m.first_name, m.last_name].filter(Boolean).join(' ').trim() || m.name || null;
        return {
            tech_id: techId,
            name,
            lat: base ? base.lat : null,
            lng: base ? base.lng : null,
            label: base ? (base.label || null) : null,
            address: base ? (base.address || null) : null,
            ...structuredOf(base),
            has_base: Boolean(base),
        };
    });

    // Include stored bases for techs no longer in the active roster.
    for (const r of stored) {
        if (seen.has(String(r.tech_id))) continue;
        out.push({
            tech_id: String(r.tech_id),
            name: null,
            lat: r.lat,
            lng: r.lng,
            label: r.label || null,
            address: r.address || null,
            ...structuredOf(r),
            has_base: true,
        });
    }

    return out;
}

/**
 * Upsert a technician base. If lat & lng are provided, store them directly.
 * Otherwise, if an address is provided, geocode it. Errors carry httpStatus/code.
 */
async function upsert(companyId, techId, payload = {}) {
    const { lat, lng, label, address } = payload;
    // Structured address fields (ADDR-UX-001) — stored as-is so the editor can pre-fill.
    const structured = {
        street: trimOrNull(payload.street),
        apt: trimOrNull(payload.apt),
        city: trimOrNull(payload.city),
        state: trimOrNull(payload.state),
        zip: trimOrNull(payload.zip),
    };

    if (isFiniteNum(lat) && isFiniteNum(lng)) {
        return queries.upsert(companyId, techId, {
            lat, lng, label, address: address ?? null, ...structured,
        });
    }

    // No explicit coords: geocode the composed string (or build one from the parts).
    const toGeocode = (address && String(address).trim()) ? String(address) : composeAddress(structured);
    if (toGeocode) {
        const g = await googlePlacesService.geocodeAddress(toGeocode);
        if (g.status === 'failed' || !isFiniteNum(g.lat) || !isFiniteNum(g.lng)) {
            const err = new Error(g.error_message || 'Could not find coordinates for this address.');
            err.httpStatus = 422;
            err.code = 'GEOCODE_FAILED';
            throw err;
        }
        return queries.upsert(companyId, techId, {
            lat: g.lat,
            lng: g.lng,
            label,
            address: g.normalized_address || toGeocode,
            ...structured,
        });
    }

    const err = new Error('Provide either lat & lng or an address.');
    err.httpStatus = 400;
    err.code = 'COORDS_OR_ADDRESS_REQUIRED';
    throw err;
}

async function remove(companyId, techId) {
    return queries.remove(companyId, techId);
}

module.exports = { list, upsert, remove };
