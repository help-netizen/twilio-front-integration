'use strict';

jest.mock('../backend/src/db/connection', () => ({ query: jest.fn() }));
jest.mock('../backend/src/db/routeQueries', () => ({
    getCompanyTimezone: jest.fn(),
    getTechDaysForJob: jest.fn(),
}));
jest.mock('../backend/src/services/routeSegmentService', () => ({
    recalcForJob: jest.fn(),
    enqueueGeocode: jest.fn(),
}));
jest.mock('../backend/src/db/membershipQueries', () => ({ resolveProviderUserIds: jest.fn() }));
jest.mock('../backend/src/services/contactResolverService', () => ({
    resolveOrCreateContact: jest.fn(),
}));
jest.mock('../backend/src/services/contactPropagationService', () => ({
    propagateContactDetails: jest.fn(),
}));
jest.mock('../backend/src/services/eventBus', () => ({ emit: jest.fn() }));
jest.mock('../backend/src/services/eventService', () => ({}));
jest.mock('../backend/src/services/zenbookerClient', () => ({ getJob: jest.fn() }));

const db = require('../backend/src/db/connection');
const routeQueries = require('../backend/src/db/routeQueries');
const routeSegmentService = require('../backend/src/services/routeSegmentService');
const membershipQueries = require('../backend/src/db/membershipQueries');
const { resolveOrCreateContact } = require('../backend/src/services/contactResolverService');
const { propagateContactDetails } = require('../backend/src/services/contactPropagationService');
const jobsService = require('../backend/src/services/jobsService');

const COMPANY = '00000000-0000-0000-0000-0000000000aa';

describe('Zenbooker job customer contact resolution', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        resolveOrCreateContact.mockResolvedValue({
            contact_id: 77,
            created: false,
            matched_by: 'phone',
        });
        propagateContactDetails.mockResolvedValue({ phone: 'already', email: 'already' });
        membershipQueries.resolveProviderUserIds.mockResolvedValue([]);
        routeQueries.getCompanyTimezone.mockResolvedValue('America/New_York');
        routeQueries.getTechDaysForJob.mockResolvedValue([]);
        routeSegmentService.recalcForJob.mockResolvedValue({ techDays: 0, results: [] });
        db.query.mockImplementation(async (sql) => {
            if (/FROM jobs j[\s\S]*j\.zenbooker_job_id = \$1/.test(sql)) {
                return {
                    rows: [{
                        id: 9,
                        company_id: COMPANY,
                        zenbooker_job_id: 'zb-job-9',
                        blanc_status: 'Submitted',
                        zb_status: 'scheduled',
                        zb_canceled: false,
                        zb_rescheduled: false,
                        assigned_techs: [],
                        assigned_provider_user_ids: [],
                        notes: [],
                        created_at: new Date('2026-01-01T00:00:00.000Z'),
                        updated_at: new Date('2026-01-01T00:00:00.000Z'),
                    }],
                };
            }
            return { rows: [], rowCount: 1 };
        });
    });

    test('job→contact lookup uses the shared resolver and writes its contact id', async () => {
        await jobsService.syncFromZenbooker('zb-job-9', {
            status: 'scheduled',
            customer: {
                id: 'zb-customer-9',
                name: 'Jane Resolver',
                phone: '+1 617 555 0199',
                email: 'jane@example.test',
            },
            assigned_providers: [],
            unable_to_auto_assign: true,
        }, COMPANY);

        expect(resolveOrCreateContact).toHaveBeenCalledWith({
            companyId: COMPANY,
            externalId: 'zb-customer-9',
            contact: expect.objectContaining({
                full_name: 'Jane Resolver',
                phone: '+1 617 555 0199',
                email: 'jane@example.test',
            }),
        });
        const update = db.query.mock.calls.find(call => /UPDATE jobs SET\s+zb_status/.test(call[0]));
        expect(update).toBeTruthy();
        expect(update[1][19]).toBe(77);
    });
});
