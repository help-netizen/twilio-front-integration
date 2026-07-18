jest.mock('../backend/src/db/technicianServiceAreaQueries', () => ({
    listTargets: jest.fn(),
    listValidAssignments: jest.fn(),
    replaceTechnicianDistricts: jest.fn(),
    replaceTechnicianRadii: jest.fn(),
    replaceDistrictTechnicians: jest.fn(),
    replaceRadiusTechnicians: jest.fn(),
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

test('TC-SA-WILDCARD-01 — empty active set is wildcard for every target', async () => {
    queries.listValidAssignments.mockResolvedValue({
        districts: [{ technician_id: 'tech-2', district_name: 'North' }],
        radii: [],
    });
    territoryService.resolveActiveTargets.mockResolvedValue({
        mode: 'list', resolved: true, no_targets: false, target_ids: ['South'],
    });
    const result = await service.filterEligibleTechnicians(COMPANY, TECHS, { query: '02118' });
    expect(result.matches).toEqual([
        { technician_id: 'tech-1', wildcard: true, eligible: true },
        { technician_id: 'tech-2', wildcard: false, eligible: false },
    ]);
    expect(result.technicians.map(technician => technician.id)).toEqual(['tech-1']);
});

test('TC-SA-WILDCARD-STALE-01 — a stale district row does not suppress wildcard', async () => {
    queries.listValidAssignments.mockResolvedValue({
        districts: [{ technician_id: 'tech-1', district_name: 'Deleted district' }],
        radii: [],
    });
    const result = await service.filterEligibleTechnicians(COMPANY, [TECHS[0]], { query: '02135' });
    expect(result.matches).toEqual([
        { technician_id: 'tech-1', wildcard: true, eligible: true },
    ]);
});

test('district and radius assignments coexist while active-mode wildcard is mode-specific', async () => {
    queries.listValidAssignments.mockResolvedValue({
        districts: [{ technician_id: 'tech-1', district_name: 'North' }],
        radii: [{ technician_id: 'tech-1', radius_id: RADIUS_SOUTH }],
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
