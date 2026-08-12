jest.mock('../backend/src/db/technicianServiceAreaQueries', () => ({
    listTargets: jest.fn(),
    listValidAssignments: jest.fn(),
    listWildcardTechnicians: jest.fn(),
    setWildcardTechnician: jest.fn(),
    replaceTechnicianDistricts: jest.fn(),
    replaceTechnicianRadii: jest.fn(),
    replaceDistrictTechnicians: jest.fn(),
    replaceRadiusTechnicians: jest.fn(),
}));
jest.mock('../backend/src/db/technicianDirectoryQueries', () => ({
    resolveTechnicianUuid: jest.fn(),
}));
jest.mock('../backend/src/db/territoryRadiusQueries', () => ({
    getSettings: jest.fn(),
}));
jest.mock('../backend/src/services/technicianRosterService', () => ({
    listActive: jest.fn(),
    requireActive: jest.fn(),
}));
jest.mock('../backend/src/services/territoryService', () => ({
    resolveActiveTargets: jest.fn(),
}));

const queries = require('../backend/src/db/technicianServiceAreaQueries');
const directoryQueries = require('../backend/src/db/technicianDirectoryQueries');
const radiusQueries = require('../backend/src/db/territoryRadiusQueries');
const rosterService = require('../backend/src/services/technicianRosterService');
const territoryService = require('../backend/src/services/territoryService');
const service = require('../backend/src/services/technicianServiceAreaService');

const COMPANY = '00000000-0000-0000-0000-00000000000a';
const RADIUS_NORTH = '11111111-1111-4111-8111-111111111111';
const RADIUS_SOUTH = '22222222-2222-4222-8222-222222222222';
const TECHS = [
    { id: 'tech-1', name: 'Alex Rivera' },
    { id: 'tech-2', name: 'Maria Lopez' },
];
const TECH_UUIDS = {
    'tech-1': 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    'tech-2': 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
};

beforeEach(() => {
    jest.clearAllMocks();
    radiusQueries.getSettings.mockResolvedValue({ active_mode: 'list' });
    queries.listTargets.mockResolvedValue({
        districts: [{ id: 'North', name: 'North' }, { id: 'South', name: 'South' }],
        radii: [
            { id: RADIUS_NORTH, zip: '02135', radius_miles: '10.0' },
            { id: RADIUS_SOUTH, zip: '02118', radius_miles: '8.0' },
        ],
    });
    queries.listValidAssignments.mockResolvedValue({ districts: [], radii: [] });
    queries.listWildcardTechnicians.mockResolvedValue([]);
    directoryQueries.resolveTechnicianUuid.mockImplementation(
        async (_companyId, externalId) => TECH_UUIDS[externalId] || null
    );
    rosterService.listActive.mockResolvedValue(TECHS);
    rosterService.requireActive.mockImplementation(async (_companyId, techId) => {
        const technician = TECHS.find(item => item.id === String(techId));
        if (!technician) throw Object.assign(new Error('Technician not found'), { code: 'NOT_FOUND', httpStatus: 404 });
        return technician;
    });
    territoryService.resolveActiveTargets.mockResolvedValue({
        mode: 'list', resolved: true, no_targets: false, target_ids: ['North'],
    });
});

// ZONE-STRICT-001 — these two used to assert the OPPOSITE. An empty assignment
// list was the wildcard, which is exactly how a technician got offered into an
// area he does not work. Serving everywhere is now an explicit mark.
test('TC-SA-STRICT-01 — a technician with nothing assigned is NOT offered', async () => {
    queries.listValidAssignments.mockResolvedValue({
        districts: [{ technician_id: TECH_UUIDS['tech-2'], district_name: 'North' }],
        radii: [],
    });
    territoryService.resolveActiveTargets.mockResolvedValue({
        mode: 'list', resolved: true, no_targets: false, target_ids: ['South'],
    });
    const result = await service.filterEligibleTechnicians(COMPANY, TECHS, { query: '02118' });
    expect(result.matches).toEqual([
        { technician_id: 'tech-1', wildcard: false, unassigned: true, eligible: false },
        { technician_id: 'tech-2', wildcard: false, unassigned: false, eligible: false },
    ]);
    expect(result.technicians).toEqual([]);
});

test('TC-SA-STRICT-02 — the explicit whole-territory mark is eligible for any target', async () => {
    queries.listValidAssignments.mockResolvedValue({
        districts: [{ technician_id: TECH_UUIDS['tech-2'], district_name: 'North' }],
        radii: [],
    });
    queries.listWildcardTechnicians.mockResolvedValue([TECH_UUIDS['tech-1']]);
    territoryService.resolveActiveTargets.mockResolvedValue({
        mode: 'list', resolved: true, no_targets: false, target_ids: ['South'],
    });
    const result = await service.filterEligibleTechnicians(COMPANY, TECHS, { query: '02118' });
    expect(result.matches).toEqual([
        { technician_id: 'tech-1', wildcard: true, unassigned: false, eligible: true },
        { technician_id: 'tech-2', wildcard: false, unassigned: false, eligible: false },
    ]);
    expect(result.technicians.map(technician => technician.id)).toEqual(['tech-1']);
});

test('TC-SA-STRICT-03 — a stale district row NARROWS the offer instead of widening it', async () => {
    // Renaming a district invalidates its rows. That used to promote the
    // technician to company-wide; now it takes him out of the offer entirely,
    // so a configuration mistake can never send someone to the wrong area.
    queries.listValidAssignments.mockResolvedValue({
        districts: [{ technician_id: TECH_UUIDS['tech-1'], district_name: 'Deleted district' }],
        radii: [],
    });
    const result = await service.filterEligibleTechnicians(COMPANY, [TECHS[0]], { query: '02135' });
    expect(result.matches).toEqual([
        { technician_id: 'tech-1', wildcard: false, unassigned: true, eligible: false },
    ]);
    expect(result.technicians).toEqual([]);
});

test('TC-SA-STRICT-04 — the whole-territory mark is written and cleared deliberately', async () => {
    queries.setWildcardTechnician.mockResolvedValue();
    await service.setTechnicianServesAllTerritory(COMPANY, 'tech-1', true, 'crm-user-1');
    expect(queries.setWildcardTechnician).toHaveBeenCalledWith(COMPANY, 'tech-1', true, 'crm-user-1');

    await service.setTechnicianServesAllTerritory(COMPANY, 'tech-1', false, 'crm-user-1');
    expect(queries.setWildcardTechnician).toHaveBeenLastCalledWith(COMPANY, 'tech-1', false, 'crm-user-1');

    await expect(service.setTechnicianServesAllTerritory(COMPANY, 'tech-1', 'yes', 'crm-user-1'))
        .rejects.toMatchObject({ code: 'VALIDATION' });
});

test('TC-SA-STRICT-05 — unassigned technicians are reported so they are not silently invisible', async () => {
    queries.listValidAssignments.mockResolvedValue({
        districts: [{ technician_id: TECH_UUIDS['tech-2'], district_name: 'North' }],
        radii: [],
    });
    const state = await service.getAssignmentState(COMPANY, TECHS);
    expect(state.unassigned_technicians).toEqual([{ id: 'tech-1', name: 'Alex Rivera' }]);
    expect(state.wildcard_technicians).toEqual([]);
});

test('district and radius assignments coexist while active-mode wildcard is mode-specific', async () => {
    queries.listValidAssignments.mockResolvedValue({
        districts: [{ technician_id: TECH_UUIDS['tech-1'], district_name: 'North' }],
        radii: [{ technician_id: TECH_UUIDS['tech-1'], radius_id: RADIUS_SOUTH }],
    });
    const listState = await service.getAssignmentState(COMPANY, TECHS);
    expect(listState.technician_assignments[0]).toMatchObject({
        district_names: ['North'],
        radius_ids: [RADIUS_SOUTH],
        wildcard_in_active_mode: false,
    });

    radiusQueries.getSettings.mockResolvedValue({ active_mode: 'radius' });
    const radiusState = await service.getAssignmentState(COMPANY, TECHS);
    expect(radiusState.technician_assignments[0]).toMatchObject({
        district_names: ['North'],
        radius_ids: [RADIUS_SOUTH],
        wildcard_in_active_mode: false,
    });
});

test('technician-side replacement writes only the selected map and accepts empty wildcard', async () => {
    queries.replaceTechnicianDistricts.mockResolvedValue();
    await service.replaceTechnicianAssignments(COMPANY, 'tech-1', 'districts', [], 'crm-user-1');
    expect(queries.replaceTechnicianDistricts).toHaveBeenCalledWith(
        COMPANY, 'tech-1', [], 'crm-user-1'
    );
    expect(queries.replaceTechnicianRadii).not.toHaveBeenCalled();
});

test('companies with no active-mode targets keep every technician wildcard and eligible', async () => {
    queries.listTargets.mockResolvedValue({ districts: [], radii: [] });
    const result = await service.filterEligibleTechnicians(COMPANY, TECHS, {});
    expect(result.no_targets).toBe(true);
    expect(result.technicians).toEqual(TECHS);
    expect(territoryService.resolveActiveTargets).not.toHaveBeenCalled();
});

test('an unresolved active target fails closed instead of inventing matches', async () => {
    territoryService.resolveActiveTargets.mockResolvedValue({
        mode: 'list', resolved: false, no_targets: false, target_ids: [],
    });
    const result = await service.filterEligibleTechnicians(COMPANY, TECHS, { query: 'outside' });
    expect(result.target_resolved).toBe(false);
    expect(result.technicians).toEqual([]);
    expect(result.matches.every(match => match.eligible === false)).toBe(true);
});
