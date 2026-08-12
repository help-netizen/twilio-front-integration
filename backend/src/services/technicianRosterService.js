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

async function listNative(companyId, runner) {
    const technicians = runner
        ? await technicianDirectoryQueries.listActiveTechnicians(companyId, runner)
        : await technicianDirectoryQueries.listActiveTechnicians(companyId);
    return (Array.isArray(technicians) ? technicians : []).map(technician => ({
        id: String(technician.id),
        name: String(technician.display_name),
        active: true,
        technician_uuid: String(technician.id),
    }));
}

async function listActive(companyId, { runner } = {}) {
    if (typeof companyId !== 'string' || !COMPANY_UUID_RE.test(companyId.trim())) {
        throw new TechnicianRosterError('INVALID_COMPANY', 'A company UUID is required', 400);
    }
    return listNative(companyId, runner);
}

async function requireActive(companyId, technicianId, { runner } = {}) {
    const id = runner
        ? await technicianDirectoryQueries.resolveTechnicianUuid(
            companyId, technicianId, 'zenbooker', runner
        )
        : await technicianDirectoryQueries.resolveTechnicianUuid(
            companyId, technicianId, 'zenbooker'
        );
    if (!id) {
        throw new TechnicianRosterError('NOT_FOUND', 'Technician not found', 404);
    }
    const roster = await listActive(companyId, { runner });
    const technician = roster.find(item => item.id === String(id));
    if (!technician) {
        throw new TechnicianRosterError('NOT_FOUND', 'Technician not found', 404);
    }
    return technician;
}

/**
 * Canonicalize client/provider assignment objects while preserving their
 * display payload. Every persisted id is technicians.id, even when an older
 * client supplied a Zenbooker external id.
 */
async function canonicalizeAssignments(companyId, assignments, { runner } = {}) {
    const canonical = [];
    const seen = new Set();
    for (const assignment of Array.isArray(assignments) ? assignments : []) {
        if (!assignment || assignment.id == null || String(assignment.id).trim() === '') {
            throw new TechnicianRosterError(
                'INVALID_TECHNICIAN',
                'Technician assignments require an id',
                400
            );
        }
        const technician = await requireActive(companyId, assignment.id, { runner });
        if (seen.has(technician.id)) continue;
        seen.add(technician.id);
        canonical.push({
            ...assignment,
            id: technician.id,
            name: assignment.name || technician.name,
        });
    }
    return canonical;
}

module.exports = {
    listActive,
    requireActive,
    canonicalizeAssignments,
    TechnicianRosterError,
};
