/**
 * SCHED-ROUTE-VIS-001 — local direct-job route recalculation hooks after
 * external job sync was decommissioned.
 */

'use strict';

jest.mock('../backend/src/db/connection', () => ({ query: jest.fn() }));
jest.mock('../backend/src/db/membershipQueries', () => ({
    resolveProviderUserIds: jest.fn(async () => []),
}));
jest.mock('../backend/src/services/routeSegmentService', () => ({
    recalcForJob: jest.fn(),
    enqueueGeocode: jest.fn(),
}));
jest.mock('../backend/src/services/contactDedupeService', () => ({
    resolveContact: jest.fn(),
}));
jest.mock('../backend/src/services/contactPropagationService', () => ({
    propagateContactDetails: jest.fn(async () => {}),
}));
jest.mock('../backend/src/services/eventBus', () => ({ emit: jest.fn(async () => {}) }));
jest.mock('../backend/src/services/eventService', () => ({}));

const db = require('../backend/src/db/connection');
const routeSegmentService = require('../backend/src/services/routeSegmentService');
const contactDedupeService = require('../backend/src/services/contactDedupeService');
const jobsService = require('../backend/src/services/jobsService');

const COMPANY = '00000000-0000-4000-8000-000000000001';
const INPUT = {
    contact: { name: 'Jane Doe', phone: '+16175551234' },
    address: { line1: '1 Main St', city: 'Boston', postal_code: '02134' },
    slot: { start: '2026-07-15T10:00:00Z', end: '2026-07-15T12:00:00Z' },
    job_type: 'Fridge repair',
};

function jobRow(overrides = {}) {
    return {
        id: 42,
        company_id: COMPANY,
        contact_id: 5,
        blanc_status: 'Submitted',
        customer_name: 'Jane Doe',
        address: '1 Main St, Boston, 02134',
        city: 'Boston',
        lat: 42.1,
        lng: -71.2,
        assigned_techs: [],
        assigned_provider_user_ids: [],
        notes: [],
        ...overrides,
    };
}

function primeCreate(row) {
    db.query.mockImplementation(async sql => (
        /INSERT INTO jobs/.test(sql)
            ? { rows: [row] }
            : { rows: [], rowCount: 0 }
    ));
}

beforeEach(() => {
    jest.clearAllMocks();
    contactDedupeService.resolveContact.mockResolvedValue({ contact_id: 5, status: 'created' });
    routeSegmentService.recalcForJob.mockResolvedValue({ techDays: 0, results: [] });
    routeSegmentService.enqueueGeocode.mockResolvedValue();
});

describe('createDirectJob local route hooks', () => {
    test('a locally created job triggers one route recalculation', async () => {
        primeCreate(jobRow());

        const result = await jobsService.createDirectJob(COMPANY, INPUT);

        expect(result).toEqual({ job_id: 42, zenbooker_job_id: null, zb_warning: null });
        expect(routeSegmentService.recalcForJob).toHaveBeenCalledTimes(1);
        expect(routeSegmentService.recalcForJob).toHaveBeenCalledWith(
            COMPANY,
            42,
            { coordsChanged: true }
        );
    });

    test('an address without coordinates also enqueues local geocoding', async () => {
        primeCreate(jobRow({ lat: null, lng: null }));

        await jobsService.createDirectJob(COMPANY, INPUT);

        expect(routeSegmentService.recalcForJob).toHaveBeenCalledWith(
            COMPANY,
            42,
            { coordsChanged: true }
        );
        expect(routeSegmentService.enqueueGeocode).toHaveBeenCalledWith(COMPANY, 42);
    });

    test('stored coordinates avoid a redundant geocode', async () => {
        primeCreate(jobRow());

        await jobsService.createDirectJob(COMPANY, INPUT);

        expect(routeSegmentService.enqueueGeocode).not.toHaveBeenCalled();
    });

    test('a route recalculation failure never rolls back the local job', async () => {
        primeCreate(jobRow());
        routeSegmentService.recalcForJob.mockRejectedValue(new Error('route unavailable'));
        const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

        const result = await jobsService.createDirectJob(COMPANY, INPUT);
        await new Promise(resolve => setImmediate(resolve));

        expect(result.job_id).toBe(42);
        expect(errorSpy).toHaveBeenCalledWith(
            '[CreateDirectJob] route recalc failed (non-fatal):',
            'route unavailable'
        );
        errorSpy.mockRestore();
    });
});
