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

    if (isFiniteNum(lat) && isFiniteNum(lng)) {
        return queries.upsert(companyId, techId, { lat, lng, label, address: address ?? null });
    }

    if (address && String(address).trim()) {
        const g = await googlePlacesService.geocodeAddress(address);
        if (g.status === 'failed' || !isFiniteNum(g.lat) || !isFiniteNum(g.lng)) {
            const err = new Error(g.error_message || 'Could not geocode that address.');
            err.httpStatus = 422;
            err.code = 'GEOCODE_FAILED';
            throw err;
        }
        return queries.upsert(companyId, techId, {
            lat: g.lat,
            lng: g.lng,
            label,
            address: g.normalized_address || address,
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
