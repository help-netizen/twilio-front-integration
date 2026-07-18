jest.mock('../backend/src/db/connection', () => ({ query: jest.fn() }));
jest.mock('../backend/src/db/technicianBaseLocationQueries', () => ({
    listByCompany: jest.fn(),
}));
jest.mock('../backend/src/db/serviceTerritoryQueries', () => ({
    getDistrictTargets: jest.fn(),
    search: jest.fn(),
}));
jest.mock('../backend/src/db/territoryRadiusQueries', () => ({
    getSettings: jest.fn(),
    listRadii: jest.fn(),
}));
jest.mock('../backend/src/services/territoryGeoService', () => ({ geocodeZip: jest.fn() }));
jest.mock('../backend/src/services/technicianRosterService', () => ({ listActive: jest.fn() }));
jest.mock('../backend/src/services/googlePlacesService', () => ({ geocodeAddress: jest.fn() }));
jest.mock('../backend/src/services/jobsService', () => ({ listJobs: jest.fn() }));
jest.mock('../backend/src/services/scheduleService', () => ({
    getDispatchSettings: jest.fn(),
}));
jest.mock('../backend/src/services/technicianAvailabilityService', () => ({
    buildUnavailability: jest.fn(),
}));
jest.mock('../backend/src/services/technicianServiceAreaService', () => ({
    filterEligibleTechnicians: jest.fn(),
}));
jest.mock('../backend/src/services/slotEngineSettingsService', () => {
    const actual = jest.requireActual('../backend/src/services/slotEngineSettingsService');
    return {
        DEFAULTS: actual.DEFAULTS,
        buildConfigOverride: actual.buildConfigOverride,
        resolve: jest.fn(),
    };
});

const db = require('../backend/src/db/connection');
const baseQueries = require('../backend/src/db/technicianBaseLocationQueries');
const stQueries = require('../backend/src/db/serviceTerritoryQueries');
const radiusQueries = require('../backend/src/db/territoryRadiusQueries');
const rosterService = require('../backend/src/services/technicianRosterService');
const jobsService = require('../backend/src/services/jobsService');
const scheduleService = require('../backend/src/services/scheduleService');
const availabilityService = require('../backend/src/services/technicianAvailabilityService');
const serviceAreaService = require('../backend/src/services/technicianServiceAreaService');
const settingsService = require('../backend/src/services/slotEngineSettingsService');
const territoryService = require('../backend/src/services/territoryService');
const slotEngineService = require('../backend/src/services/slotEngineService');

const { DEFAULTS } = jest.requireActual('../backend/src/services/slotEngineSettingsService');
const COMPANY = '00000000-0000-0000-0000-00000000000a';
const TECHS = [
    { id: 'tech-1', name: 'Alex Rivera' },
    { id: 'tech-2', name: 'Maria Lopez' },
    { id: 'tech-3', name: 'Sam Perry' },
];

function engineResponse(technicianId = 'tech-1') {
    return {
        ok: true,
        json: jest.fn(async () => ({
            recommendations: [{
                rank: 1,
                date: '2026-07-20',
                time_frame: { start: '10:00', end: '12:00' },
                technicians: [{ id: technicianId, name: technicianId }],
            }],
            summary: {},
        })),
    };
}

beforeEach(() => {
    jest.clearAllMocks();
    db.query.mockResolvedValue({ rows: [] });
    rosterService.listActive.mockResolvedValue(TECHS);
    baseQueries.listByCompany.mockResolvedValue(TECHS.map((tech, index) => ({
        tech_id: tech.id,
        lat: 42.35 + index / 100,
        lng: -71.08 - index / 100,
    })));
    jobsService.listJobs.mockResolvedValue([]);
    scheduleService.getDispatchSettings.mockResolvedValue({
        timezone: 'America/New_York',
        work_start_time: '08:00',
        work_end_time: '18:00',
        work_days: [1, 2, 3, 4, 5],
    });
    availabilityService.buildUnavailability.mockResolvedValue([]);
    settingsService.resolve.mockResolvedValue({ ...DEFAULTS });
    serviceAreaService.filterEligibleTechnicians.mockImplementation(
        async (_companyId, technicians) => ({ target_resolved: true, technicians })
    );
    process.env.SLOT_ENGINE_URL = 'http://engine.test';
    global.fetch = jest.fn().mockResolvedValue(engineResponse());
});

afterEach(() => {
    delete global.fetch;
    delete process.env.SLOT_ENGINE_URL;
});

test('radius target resolution returns every containing Albusto radius, not only nearest', async () => {
    radiusQueries.listRadii.mockResolvedValue([
        { id: 'radius-near', lat: 42.36, lon: -71.06, radius_miles: 5 },
        { id: 'radius-wide', lat: 42.36, lon: -71.06, radius_miles: 25 },
        { id: 'radius-out', lat: 40.71, lon: -74.00, radius_miles: 5 },
    ]);
    const result = await territoryService.resolveActiveTargets(
        COMPANY,
        { lat: 42.36, lng: -71.06 },
        'radius'
    );
    expect(result.resolved).toBe(true);
    expect(result.target_ids).toEqual(['radius-near', 'radius-wide']);
    expect(radiusQueries.listRadii).toHaveBeenCalledWith(COMPANY);
});

test('smart ranking receives only Albusto-eligible technicians before engine dispatch', async () => {
    serviceAreaService.filterEligibleTechnicians.mockImplementation(async (_companyId, technicians, location) => {
        expect(location).toEqual({ query: '12 Main St, Boston, MA 02135', lat: 42.36, lng: -71.06 });
        return { target_resolved: true, technicians: technicians.filter(tech => tech.id !== 'tech-3') };
    });

    await slotEngineService.getRecommendations(COMPANY, {
        new_job: {
            lat: 42.36,
            lng: -71.06,
            address: '12 Main St, Boston, MA 02135',
            earliest_allowed_date: '2026-07-20',
            latest_allowed_date: '2026-07-20',
        },
    });

    const engineBody = JSON.parse(global.fetch.mock.calls[0][1].body);
    expect(engineBody.technicians.map(tech => tech.id)).toEqual(['tech-1', 'tech-2']);
    expect(engineBody.technicians.map(tech => tech.id)).not.toContain('tech-3');
});

test('unresolved target returns no smart suggestions and never calls the engine', async () => {
    serviceAreaService.filterEligibleTechnicians.mockResolvedValue({
        target_resolved: false,
        technicians: [],
    });
    const result = await slotEngineService.getRecommendations(COMPANY, {
        new_job: { lat: 42.36, lng: -71.06 },
    });
    expect(result).toMatchObject({ recommendations: [], engine_status: 'unavailable' });
    expect(global.fetch).not.toHaveBeenCalled();
    expect(availabilityService.buildUnavailability).not.toHaveBeenCalled();
});

test('area-assignment read failure fails smart ranking closed', async () => {
    serviceAreaService.filterEligibleTechnicians.mockRejectedValue(new Error('assignment DB down'));
    const result = await slotEngineService.getRecommendations(COMPANY, {
        new_job: { lat: 42.36, lng: -71.06 },
    });
    expect(result).toMatchObject({ recommendations: [], engine_status: 'unavailable' });
    expect(global.fetch).not.toHaveBeenCalled();
});
