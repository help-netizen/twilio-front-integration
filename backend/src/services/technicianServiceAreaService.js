/**
 * Single TECH-SCHEDULE-001 seam for technician service-area assignments,
 * wildcard eligibility, both edit directions, and active-mode matching.
 */
const queries = require('../db/technicianServiceAreaQueries');
const directoryQueries = require('../db/technicianDirectoryQueries');
const radiusQueries = require('../db/territoryRadiusQueries');
const rosterService = require('./technicianRosterService');
const territoryService = require('./territoryService');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

class TechnicianServiceAreaError extends Error {
    constructor(code, message, httpStatus = 500) {
        super(message);
        this.name = 'TechnicianServiceAreaError';
        this.code = code;
        this.httpStatus = httpStatus;
    }
}

function normalizeMode(mode) {
    if (mode === 'list' || mode === 'district' || mode === 'districts') return 'list';
    if (mode === 'radius' || mode === 'radii') return 'radius';
    throw new TechnicianServiceAreaError(
        'VALIDATION',
        'mode must be districts or radii',
        400
    );
}

function normalizeAssignments(mode, values) {
    if (!Array.isArray(values)) {
        throw new TechnicianServiceAreaError('VALIDATION', 'assignments must be an array', 400);
    }
    const normalized = Array.from(new Set(values.map(value => String(value))));
    if (mode === 'radius' && normalized.some(value => !UUID_RE.test(value))) {
        throw new TechnicianServiceAreaError('VALIDATION', 'Every radius assignment must be a UUID', 400);
    }
    return normalized;
}

function assignmentMap(rows, key) {
    const map = new Map();
    for (const row of rows || []) {
        const technicianId = normalizeUuid(row.technician_id);
        if (!technicianId) continue;
        if (!map.has(technicianId)) map.set(technicianId, []);
        const assignment = String(row[key]);
        if (!map.get(technicianId).includes(assignment)) {
            map.get(technicianId).push(assignment);
        }
    }
    return map;
}

function normalizeUuid(value) {
    const id = value == null ? '' : String(value);
    return UUID_RE.test(id) ? id.toLowerCase() : null;
}

async function normalizeRoster(companyId, roster) {
    return Promise.all((roster || []).map(async technician => {
        const publicId = String(technician.id);
        const technicianUuid = normalizeUuid(publicId)
            || normalizeUuid(await directoryQueries.resolveExternalToUuid(
                companyId,
                'zenbooker',
                publicId
            ));
        return {
            public_id: publicId,
            technician_uuid: technicianUuid,
            name: technician.name || publicId,
        };
    }));
}

async function getAssignmentState(companyId, rosterOverride) {
    const [settings, targets, assignments, roster, wildcardIds] = await Promise.all([
        radiusQueries.getSettings(companyId),
        queries.listTargets(companyId),
        queries.listValidAssignments(companyId),
        rosterOverride ? Promise.resolve(rosterOverride) : rosterService.listActive(companyId),
        queries.listWildcardTechnicians(companyId),
    ]);
    const servesAll = new Set((wildcardIds || []).map(normalizeUuid).filter(Boolean));
    const activeMode = settings?.active_mode === 'radius' ? 'radius' : 'list';
    const normalizedRoster = await normalizeRoster(companyId, roster);
    const technicians = normalizedRoster.map(technician => ({
        id: technician.public_id,
        name: technician.name,
    }));
    const activeIds = new Set(
        normalizedRoster.map(technician => technician.technician_uuid).filter(Boolean)
    );
    const validDistricts = new Set(targets.districts.map(district => String(district.id)));
    const validRadii = new Set(targets.radii.map(radius => String(radius.id)));
    const districtsByTech = assignmentMap(
        assignments.districts.filter(row => activeIds.has(normalizeUuid(row.technician_id))
            && validDistricts.has(String(row.district_name))),
        'district_name'
    );
    const radiiByTech = assignmentMap(
        assignments.radii.filter(row => activeIds.has(normalizeUuid(row.technician_id))
            && validRadii.has(String(row.radius_id))),
        'radius_id'
    );
    const technicianAssignments = normalizedRoster.map(technician => {
        const districtNames = districtsByTech.get(technician.technician_uuid) || [];
        const radiusIds = radiiByTech.get(technician.technician_uuid) || [];
        const activeAssignments = activeMode === 'radius' ? radiusIds : districtNames;
        const servesAllTerritory = technician.technician_uuid
            ? servesAll.has(technician.technician_uuid)
            : false;
        return {
            technician_id: technician.public_id,
            technician_name: technician.name,
            district_names: districtNames,
            radius_ids: radiusIds,
            // ZONE-STRICT-001: two different facts that used to be one. "No
            // assignments" is now merely a state (and means NOT offered);
            // "serves the whole territory" is an explicit, deliberate mark.
            unassigned_in_active_mode: activeAssignments.length === 0,
            serves_all_territory: servesAllTerritory,
            wildcard_in_active_mode: servesAllTerritory,
        };
    });
    const assignmentByTech = new Map(
        technicianAssignments.map(item => [item.technician_id, item])
    );

    return {
        active_mode: activeMode,
        technicians,
        districts: targets.districts.map(district => ({
            ...district,
            technician_ids: technicianAssignments
                .filter(item => item.district_names.includes(String(district.id)))
                .map(item => item.technician_id),
        })),
        radii: targets.radii.map(radius => ({
            ...radius,
            technician_ids: technicianAssignments
                .filter(item => item.radius_ids.includes(String(radius.id)))
                .map(item => item.technician_id),
        })),
        technician_assignments: technicianAssignments,
        wildcard_technicians: technicianAssignments
            .filter(item => item.serves_all_territory)
            .map(item => ({
                id: item.technician_id,
                name: item.technician_name,
            })),
        // Technicians the scheduler will NOT offer at all — nothing assigned and
        // not marked company-wide. Surfaced so the settings screen can say so out
        // loud instead of leaving a silently invisible technician.
        unassigned_technicians: technicianAssignments
            .filter(item => item.unassigned_in_active_mode && !item.serves_all_territory)
            .map(item => ({
                id: item.technician_id,
                name: item.technician_name,
            })),
        _assignment_by_tech: assignmentByTech,
    };
}

function publicState(state) {
    const { _assignment_by_tech, ...result } = state;
    return result;
}

function technicianAreaSettings(state, technicianId) {
    const id = String(technicianId);
    const assigned = state._assignment_by_tech.get(id) || {
        technician_id: id,
        district_names: [],
        radius_ids: [],
        // A technician we know nothing about is NOT company-wide (ZONE-STRICT-001).
        unassigned_in_active_mode: true,
        serves_all_territory: false,
        wildcard_in_active_mode: false,
    };
    return {
        active_mode: state.active_mode,
        districts: state.districts.map(district => ({ id: district.id, name: district.name })),
        radii: state.radii.map(radius => ({
            id: String(radius.id),
            zip: radius.zip,
            radius_miles: Number(radius.radius_miles),
        })),
        district_assignments: assigned.district_names,
        radius_assignments: assigned.radius_ids,
        serves_all_territory: Boolean(assigned.serves_all_territory),
        unassigned_in_active_mode: Boolean(assigned.unassigned_in_active_mode),
        wildcard_in_active_mode: Boolean(assigned.serves_all_territory),
    };
}

async function getTechnicianSettings(companyId, technician, stateOverride) {
    const state = stateOverride || await getAssignmentState(companyId, [technician]);
    return technicianAreaSettings(state, technician.id);
}

function activeSummary(state, technicianId) {
    const settings = technicianAreaSettings(state, technicianId);
    const ids = state.active_mode === 'radius'
        ? settings.radius_assignments
        : settings.district_assignments;
    if (settings.serves_all_territory) {
        return state.active_mode === 'radius'
            ? 'Whole territory (all radii)'
            : 'Whole territory (all districts)';
    }
    if (ids.length === 0) {
        // Says what actually happens now, instead of the old "wildcard".
        return state.active_mode === 'radius'
            ? 'No radii — not offered'
            : 'No districts — not offered';
    }
    const names = state.active_mode === 'radius'
        ? ids.map(id => {
            const radius = state.radii.find(item => String(item.id) === id);
            return radius ? `${radius.zip} · ${Number(radius.radius_miles)} mi` : id;
        })
        : ids.map(id => id || 'Uncategorized ZIPs');
    return names.length === 1 ? names[0] : `${names[0]} +${names.length - 1}`;
}

async function replaceTechnicianAssignments(companyId, technicianId, modeInput, values, createdBy) {
    const technician = await rosterService.requireActive(companyId, technicianId);
    const mode = normalizeMode(modeInput);
    const assignments = normalizeAssignments(mode, values);
    if (mode === 'list') {
        await queries.replaceTechnicianDistricts(companyId, technician.id, assignments, createdBy);
    } else {
        await queries.replaceTechnicianRadii(companyId, technician.id, assignments, createdBy);
    }
    return getTechnicianSettings(companyId, technician);
}

/**
 * ZONE-STRICT-001 — mark (or unmark) a technician as serving the whole territory.
 * This is the only way back to the old "offered everywhere" behaviour, and it now
 * takes a deliberate act rather than an empty assignment list.
 */
async function setTechnicianServesAllTerritory(companyId, technicianId, servesAll, createdBy) {
    if (typeof servesAll !== 'boolean') {
        throw new TechnicianServiceAreaError('VALIDATION', 'serves_all_territory must be a boolean', 400);
    }
    const technician = await rosterService.requireActive(companyId, technicianId);
    await queries.setWildcardTechnician(companyId, technician.id, servesAll, createdBy);
    return getTechnicianSettings(companyId, technician);
}

async function requireActiveIds(companyId, technicianIds) {
    if (!Array.isArray(technicianIds)) {
        throw new TechnicianServiceAreaError('VALIDATION', 'technician_ids must be an array', 400);
    }
    const ids = Array.from(new Set(technicianIds.map(value => String(value))));
    const roster = await rosterService.listActive(companyId);
    const activeIds = new Set(roster.map(technician => String(technician.id)));
    if (ids.some(id => !activeIds.has(id))) {
        throw new TechnicianServiceAreaError('NOT_FOUND', 'Technician not found', 404);
    }
    return { ids, roster };
}

async function replaceDistrictTechnicians(companyId, districtName, technicianIds, createdBy) {
    if (typeof districtName !== 'string') {
        throw new TechnicianServiceAreaError('VALIDATION', 'district_name is required', 400);
    }
    const { ids, roster } = await requireActiveIds(companyId, technicianIds);
    await queries.replaceDistrictTechnicians(companyId, districtName, ids, createdBy);
    return publicState(await getAssignmentState(companyId, roster));
}

async function replaceRadiusTechnicians(companyId, radiusId, technicianIds, createdBy) {
    if (!UUID_RE.test(String(radiusId))) {
        throw new TechnicianServiceAreaError('NOT_FOUND', 'Radius not found', 404);
    }
    const { ids, roster } = await requireActiveIds(companyId, technicianIds);
    await queries.replaceRadiusTechnicians(companyId, radiusId, ids, createdBy);
    return publicState(await getAssignmentState(companyId, roster));
}

function isEligible({ servesAllTerritory, validAssignments }, targetIds) {
    // ZONE-STRICT-001 — this empty branch USED to return true, and that is the
    // bug the owner reported: a technician nobody had assigned anywhere was
    // offered for every ZIP the company covers. Worse, the failure direction was
    // wrong — renaming a district invalidated its rows, and a properly zoned
    // technician silently became a company-wide one.
    //
    // Serving the whole territory is now something you SAY, not something that
    // happens by omission. Absence of assignments means the technician is simply
    // not offered; a missing configuration narrows the offer instead of widening it.
    if (servesAllTerritory) return true;
    if (validAssignments.size === 0) return false;
    return targetIds.some(targetId => validAssignments.has(String(targetId)));
}

async function filterEligibleTechnicians(companyId, technicians, location) {
    const roster = (technicians || []).map(technician => ({
        id: String(technician.id),
        name: technician.name || String(technician.id),
    }));
    const state = await getAssignmentState(companyId, roster);
    const targetCount = state.active_mode === 'radius' ? state.radii.length : state.districts.length;
    const resolved = targetCount === 0
        ? { mode: state.active_mode, resolved: true, no_targets: true, target_ids: [] }
        : await territoryService.resolveActiveTargets(companyId, location, state.active_mode);

    const matches = (technicians || []).map(technician => {
        const assigned = state._assignment_by_tech.get(String(technician.id));
        const values = state.active_mode === 'radius'
            ? assigned?.radius_ids || []
            : assigned?.district_names || [];
        const servesAllTerritory = Boolean(assigned?.serves_all_territory);
        return {
            technician_id: String(technician.id),
            // The company-wide mark, and separately the plain fact of having
            // nothing assigned — which now excludes rather than includes.
            wildcard: servesAllTerritory,
            unassigned: values.length === 0 && !servesAllTerritory,
            eligible: resolved.resolved && (
                // A company that has configured no districts/radii at all is not
                // making a statement about anybody — everyone stays eligible, or a
                // fresh tenant would get zero slots forever.
                resolved.no_targets
                || isEligible({ servesAllTerritory, validAssignments: new Set(values) }, resolved.target_ids)
            ),
        };
    });
    const eligibleIds = new Set(matches.filter(match => match.eligible).map(match => match.technician_id));
    return {
        active_mode: state.active_mode,
        target_resolved: resolved.resolved,
        no_targets: Boolean(resolved.no_targets),
        target_ids: resolved.target_ids,
        matches,
        technicians: (technicians || []).filter(technician => eligibleIds.has(String(technician.id))),
    };
}

async function getTechnicianMatches(companyId, location) {
    const roster = await rosterService.listActive(companyId);
    const result = await filterEligibleTechnicians(companyId, roster, location);
    return {
        active_mode: result.active_mode,
        target_resolved: result.target_resolved,
        no_targets: result.no_targets,
        target_ids: result.target_ids,
        matches: result.matches,
    };
}

module.exports = {
    getAssignmentState,
    publicState,
    getTechnicianSettings,
    activeSummary,
    replaceTechnicianAssignments,
    setTechnicianServesAllTerritory,
    replaceDistrictTechnicians,
    replaceRadiusTechnicians,
    filterEligibleTechnicians,
    getTechnicianMatches,
    TechnicianServiceAreaError,
    _isEligible: isEligible,
};
