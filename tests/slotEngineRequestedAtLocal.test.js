/**
 * OB-66 — `requested_at` must be the COMPANY-LOCAL wall clock.
 *
 * The engine reads this field with `parseLocalStamp` (slot-engine/src/engine.js),
 * which pulls the digits out and IGNORES any offset: whatever we send is taken as
 * local time. We were sending `new Date().toISOString()`, i.e. UTC, so in New York
 * the engine believed it was four hours later than it was — it over-filtered the
 * windows still left in the day and, after 20:00 local, its idea of "today" had
 * already rolled into tomorrow.
 *
 * Mock scaffold mirrors tests/slotEngineDayOffFilter.test.js.
 */

jest.mock('../backend/src/db/connection', () => ({ query: jest.fn() }));
jest.mock('../backend/src/db/marketplaceQueries', () => ({
    getPublishedAppByKey: jest.fn(),
    findActiveInstallation: jest.fn(),
}));
jest.mock('../backend/src/services/technicianRosterService', () => ({ listActive: jest.fn() }));
jest.mock('../backend/src/services/googlePlacesService', () => ({ geocodeAddress: jest.fn() }));
jest.mock('../backend/src/services/jobsService', () => ({ listJobs: jest.fn() }));
jest.mock('../backend/src/services/scheduleService', () => ({
    getDispatchSettings: jest.fn(async () => ({ timezone: 'America/New_York' })),
}));
jest.mock('../backend/src/services/slotEngineSettingsService', () => {
    const actual = jest.requireActual('../backend/src/services/slotEngineSettingsService');
    return {
        DEFAULTS: actual.DEFAULTS,
        buildConfigOverride: actual.buildConfigOverride,
        resolve: jest.fn(),
    };
});
jest.mock('../backend/src/services/technicianAvailabilityService', () => ({ buildUnavailability: jest.fn() }));
jest.mock('../backend/src/services/technicianServiceAreaService', () => ({
    filterEligibleTechnicians: jest.fn(),
}));

const db = require('../backend/src/db/connection');
const technicianRosterService = require('../backend/src/services/technicianRosterService');
const jobsService = require('../backend/src/services/jobsService');
const scheduleService = require('../backend/src/services/scheduleService');
const settingsService = require('../backend/src/services/slotEngineSettingsService');
const availabilityService = require('../backend/src/services/technicianAvailabilityService');
const serviceAreaService = require('../backend/src/services/technicianServiceAreaService');
const slotEngineService = require('../backend/src/services/slotEngineService');

const { DEFAULTS } = jest.requireActual('../backend/src/services/slotEngineSettingsService');

const COMPANY = '00000000-0000-0000-0000-00000000000a';

// The owner's call that exposed this: 6:40pm Wednesday in New York.
const INSTANT = new Date('2026-08-19T22:40:00.000Z');

const bodyFromFetch = () => JSON.parse(global.fetch.mock.calls[0][1].body);

function callSeam() {
    return slotEngineService.getRecommendations(COMPANY, {
        new_job: {
            lat: 42.35, lng: -71.09, duration_minutes: 120,
            earliest_allowed_date: '2026-08-19', latest_allowed_date: '2026-08-21',
        },
    });
}

beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] }).setSystemTime(INSTANT);
    db.query.mockReset().mockImplementation(async (sql) => (
        /SELECT tech_id, lat, lng/.test(String(sql))
            ? { rows: [{ tech_id: '1234567', lat: 42.36, lng: -71.06, label: null, address: null }] }
            : { rows: [] }
    ));
    technicianRosterService.listActive.mockReset().mockResolvedValue([
        { id: '1234567', name: 'John Smith', active: true },
    ]);
    jobsService.listJobs.mockReset().mockResolvedValue([]);
    settingsService.resolve.mockReset().mockResolvedValue({ ...DEFAULTS });
    availabilityService.buildUnavailability.mockReset().mockResolvedValue([]);
    serviceAreaService.filterEligibleTechnicians.mockReset().mockImplementation(
        async (_companyId, technicians) => ({ target_resolved: true, technicians })
    );
    process.env.SLOT_ENGINE_URL = 'http://engine.test';
    global.fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ recommendations: [], summary: null }) });
});

afterEach(() => {
    jest.useRealTimers();
    delete global.fetch;
});

describe('requested_at is the company-local wall clock', () => {
    test('New York gets 18:40, not the 22:40 that UTC would have sent', async () => {
        scheduleService.getDispatchSettings.mockResolvedValue({ timezone: 'America/New_York' });
        await callSeam();
        expect(bodyFromFetch().requested_at).toBe('2026-08-19T18:40');
    });

    test('the stamp carries no offset — the engine would ignore one anyway', async () => {
        scheduleService.getDispatchSettings.mockResolvedValue({ timezone: 'America/New_York' });
        await callSeam();
        const stamp = bodyFromFetch().requested_at;
        expect(stamp.endsWith('Z')).toBe(false);
        expect(stamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
    });

    test('a different company timezone moves the stamp with it', async () => {
        scheduleService.getDispatchSettings.mockResolvedValue({ timezone: 'America/Los_Angeles' });
        await callSeam();
        expect(bodyFromFetch().requested_at).toBe('2026-08-19T15:40');
    });

    test('late evening local does NOT roll the engine into tomorrow', async () => {
        // 21:30 in New York = 01:30 UTC on the 20th. Sending UTC made the engine
        // think the horizon had already lost a whole day.
        jest.setSystemTime(new Date('2026-08-20T01:30:00.000Z'));
        scheduleService.getDispatchSettings.mockResolvedValue({ timezone: 'America/New_York' });
        await callSeam();
        expect(bodyFromFetch().requested_at).toBe('2026-08-19T21:30');
    });
});
