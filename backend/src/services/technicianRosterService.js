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

async function listActive(companyId, { includeZenbookerProfile = false } = {}) {
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

async function requireActive(companyId, technicianId) {
    const id = String(technicianId);
    const technician = (await listActive(companyId)).find(item => item.id === id);
    if (!technician) {
        throw new TechnicianRosterError('NOT_FOUND', 'Technician not found', 404);
    }
    return technician;
}

module.exports = { listActive, requireActive, TechnicianRosterError };
