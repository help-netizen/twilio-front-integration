/** Canonical active technician roster backed by the native directory. */
const technicianDirectoryQueries = require('../db/technicianDirectoryQueries');
const COMPANY_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

class TechnicianRosterError extends Error {
    constructor(code, message, httpStatus) {
        super(message);
        this.name = 'TechnicianRosterError';
        this.code = code;
        this.httpStatus = httpStatus;
    }
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

async function listActive(companyId) {
    if (typeof companyId !== 'string' || !COMPANY_UUID_RE.test(companyId.trim())) {
        throw new TechnicianRosterError('INVALID_COMPANY', 'A company UUID is required', 400);
    }
    return listNative(companyId);
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
