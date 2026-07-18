/**
 * Canonical active Zenbooker service-provider roster.
 * Operational failures are explicit; callers must not substitute job history.
 */
const zenbookerClient = require('./zenbookerClient');

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

async function listActive(companyId) {
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
        .map(member => ({
            id: String(member.id),
            name: displayName(member),
            active: true,
        }));
}

async function requireActive(companyId, technicianId) {
    const id = String(technicianId);
    const technician = (await listActive(companyId)).find(item => item.id === id);
    if (!technician) {
        throw new TechnicianRosterError('NOT_FOUND', 'Technician not found', 404);
    }
    return technician;
}

module.exports = { listActive, requireActive, TechnicianRosterError };
