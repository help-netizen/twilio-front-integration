/** Canonical active technician roster with a per-company ZB/native cutover. */
const zenbookerClient = require('./zenbookerClient');
const technicianDirectoryQueries = require('../db/technicianDirectoryQueries');
const { getTechnicianDirectoryMode } = require('../config/featureFlags');
const COMPANY_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

class TechnicianRosterError extends Error {
    constructor(code, message, httpStatus) {
        super(message);
        this.name = 'TechnicianRosterError';
        this.code = code;
        this.httpStatus = httpStatus;
    }
}

function displayName(member) {
    return [member.first_name, member.last_name].filter(Boolean).join(' ').trim()
        || member.name
        || String(member.id);
}

function zenbookerProfile(member, name) {
    const refs = value => (Array.isArray(value) ? value : [])
        .filter(item => item?.id != null && item?.name != null)
        .map(item => ({ id: String(item.id), name: String(item.name) }));
    const nullableString = value => value == null || value === '' ? null : String(value);

    return {
        name,
        phone: nullableString(member.phone),
        email: nullableString(member.email),
        user_status: nullableString(member.user_status),
        assigned_territories: refs(member.assigned_territories),
        skill_tags: refs(member.skill_tags),
        calendar_color: nullableString(member.calendar_color),
        avatar: nullableString(member.avatar),
    };
}

async function listLegacy(companyId, { includeZenbookerProfile = false } = {}) {
    let members;
    try {
        members = await zenbookerClient.getTeamMembers(
            { service_provider: true, deactivated: false },
            companyId
        );
    } catch (err) {
        console.error('[TechnicianRoster] Zenbooker roster unavailable:', err.message);
        throw new TechnicianRosterError(
            'ZENBOOKER_UNAVAILABLE',
            'The active Zenbooker technician roster is unavailable',
            502
        );
    }

    return (Array.isArray(members) ? members : [])
        .filter(member => member?.id != null && member.deactivated !== true && member.service_provider !== false)
        .map(member => {
            const name = displayName(member);
            return {
                id: String(member.id),
                name,
                active: true,
                ...(includeZenbookerProfile ? { zenbooker: zenbookerProfile(member, name) } : {}),
            };
        });
}

async function listNative(companyId) {
    const technicians = await technicianDirectoryQueries.listActiveTechnicians(companyId);
    return (Array.isArray(technicians) ? technicians : []).map(technician => {
        const technicianUuid = String(technician.id);
        return {
            id: technician.zenbooker_external_id == null
                ? technicianUuid
                : String(technician.zenbooker_external_id),
            name: String(technician.display_name),
            active: true,
            technician_uuid: technicianUuid,
        };
    });
}

function rosterDifference(legacy, native) {
    const legacyById = new Map(legacy.map(item => [String(item.id), String(item.name)]));
    const nativeById = new Map(native.map(item => [String(item.id), String(item.name)]));
    const missingInNative = [...legacyById.keys()].filter(id => !nativeById.has(id));
    const missingInLegacy = [...nativeById.keys()].filter(id => !legacyById.has(id));
    const nameMismatches = [...legacyById.entries()]
        .filter(([id, name]) => nativeById.has(id) && nativeById.get(id) !== name)
        .map(([id, legacyName]) => ({
            id,
            legacy_name: legacyName,
            native_name: nativeById.get(id),
        }));
    if (missingInNative.length === 0 && missingInLegacy.length === 0 && nameMismatches.length === 0) {
        return null;
    }
    return {
        missing_in_native: missingInNative,
        missing_in_legacy: missingInLegacy,
        name_mismatches: nameMismatches,
    };
}

async function listActive(companyId, options = {}) {
    if (typeof companyId !== 'string' || !COMPANY_UUID_RE.test(companyId.trim())) {
        throw new TechnicianRosterError('INVALID_COMPANY', 'A company UUID is required', 400);
    }
    const mode = getTechnicianDirectoryMode(companyId);
    if (mode === 'native') return listNative(companyId);

    const legacy = await listLegacy(companyId, options);
    if (mode === 'compare') {
        try {
            const native = await listNative(companyId);
            const difference = rosterDifference(legacy, native);
            if (difference) {
                console.warn('[TechnicianRoster] Native roster mismatch:', {
                    company_id: companyId,
                    ...difference,
                });
            }
        } catch (err) {
            console.warn('[TechnicianRoster] Native roster comparison unavailable:', {
                company_id: companyId,
                error: err.message,
            });
        }
    }
    return legacy;
}

async function requireActive(companyId, technicianId) {
    const rawId = String(technicianId);
    const id = COMPANY_UUID_RE.test(rawId) ? rawId.toLowerCase() : rawId;
    const roster = await listActive(companyId);
    let technician = roster.find(item => item.id === id || item.technician_uuid === id);
    if (!technician && COMPANY_UUID_RE.test(id)) {
        const externalId = await technicianDirectoryQueries.resolveUuidToExternal(
            companyId,
            'zenbooker',
            id
        );
        if (externalId) {
            technician = roster.find(item => item.id === String(externalId));
        }
    }
    if (!technician) {
        throw new TechnicianRosterError('NOT_FOUND', 'Technician not found', 404);
    }
    return technician;
}

module.exports = { listActive, requireActive, TechnicianRosterError };
