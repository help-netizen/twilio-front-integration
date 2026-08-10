const mockJobs = {
    getJobById: jest.fn(async () => ({ id: 5, company_id: 'co' })),
};

jest.mock('../backend/src/services/jobsService', () => mockJobs);
jest.mock('../backend/src/services/eventService', () => ({
    logEvent: jest.fn(),
    actorName: jest.fn(() => 'Tester'),
    describeEvent: jest.fn(),
}));
jest.mock('../backend/src/services/eventBus', () => ({ emit: jest.fn(async () => {}) }));
jest.mock('../backend/src/services/noteAttachmentsService', () => ({
    MAX_FILE_SIZE: 1024,
    MAX_FILES_PER_NOTE: 5,
    getAttachmentsForEntity: jest.fn(async () => []),
}));
jest.mock('../backend/src/services/unitLabelScanService', () => ({}));
jest.mock('../backend/src/services/notesMutationService', () => ({}));
jest.mock('../backend/src/services/conversationsService', () => ({}));
jest.mock('../backend/src/services/routeDistanceService', () => ({}));
jest.mock('../backend/src/services/googlePlacesService', () => ({}));
jest.mock('../backend/src/services/stripePaymentsService', () => ({}));
jest.mock('../backend/src/services/messagingHelper', () => ({}));
jest.mock('../backend/src/services/emailService', () => ({}));
jest.mock('../backend/src/db/companyQueries', () => ({}));
jest.mock('../backend/src/middleware/providerScope', () => ({ getProviderScope: () => null }));

const jobsRouter = require('../backend/src/routes/jobs');

function dispatchPost(path) {
    return new Promise((resolve, reject) => {
        let settled = false;
        const finish = value => {
            if (settled) return;
            settled = true;
            resolve(value);
        };
        const req = {
            method: 'POST',
            url: path,
            originalUrl: `/api/jobs${path}`,
            headers: {},
            body: {},
            user: { sub: 'kc-user', crmUser: { id: 'crm-user' } },
            authz: {
                permissions: ['jobs.view', 'jobs.edit', 'jobs.close', 'jobs.done_pending_approval'],
                scopes: {},
                membership: { role_key: 'tenant_admin' },
            },
            companyFilter: { company_id: 'co' },
        };
        const res = {
            statusCode: 200,
            status(code) {
                this.statusCode = code;
                return this;
            },
            json(body) {
                finish({ status: this.statusCode, body });
                return this;
            },
            send(body) {
                finish({ status: this.statusCode, body });
                return this;
            },
            end() {
                finish({ status: this.statusCode, body: null });
                return this;
            },
            setHeader: jest.fn(),
            getHeader: jest.fn(),
        };

        jobsRouter.handle(req, res, err => {
            if (err) reject(err);
            else finish({ status: 404, body: null });
        });
    });
}

describe('legacy operational jobs routes are unregistered', () => {
    beforeEach(() => jest.clearAllMocks());

    test.each(['enroute', 'start', 'complete'])(
        'POST /api/jobs/:id/%s resolves to 404 without entering a jobs handler',
        async action => {
            const res = await dispatchPost(`/5/${action}`);

            expect(res.status).toBe(404);
            expect(mockJobs.getJobById).not.toHaveBeenCalled();
        }
    );
});
