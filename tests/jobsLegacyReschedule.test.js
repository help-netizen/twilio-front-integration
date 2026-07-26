'use strict';

const mockGetJobById = jest.fn();
const mockResolveAssignedProviderUserIds = jest.fn();
jest.mock('../backend/src/services/jobsService', () => ({
    getJobById: (...args) => mockGetJobById(...args),
    resolveAssignedProviderUserIds: (...args) => mockResolveAssignedProviderUserIds(...args),
}));

const mockDbQuery = jest.fn();
const mockTxQuery = jest.fn();
jest.mock('../backend/src/db/connection', () => ({
    query: (...args) => mockDbQuery(...args),
}));

const mockWithTransaction = jest.fn();
jest.mock('../backend/src/services/transactionService', () => ({
    withTransaction: (...args) => mockWithTransaction(...args),
}));

const mockLogJobActivity = jest.fn();
jest.mock('../backend/src/services/jobActivityService', () => ({
    userActor: (id) => ({ id, type: 'user', label: null, source: 'crm' }),
    logJobActivity: (...args) => mockLogJobActivity(...args),
}));

jest.mock('../backend/src/services/zenbookerClient', () => ({}));
jest.mock('../backend/src/services/realtimeService', () => ({
    publishJobUpdate: jest.fn(),
}));
jest.mock('../backend/src/services/routeSegmentService', () => ({
    recalcForJob: jest.fn(async () => null),
}));
jest.mock('../backend/src/db/routeQueries', () => ({
    getCompanyTimezone: jest.fn(async () => 'America/New_York'),
    getTechDaysForJob: jest.fn(async () => []),
}));
jest.mock('../backend/src/services/noteAttachmentsService', () => ({
    MAX_FILE_SIZE: 1,
    MAX_FILES_PER_NOTE: 1,
}));
jest.mock('../backend/src/services/notesMutationService', () => ({}));
jest.mock('../backend/src/services/eventService', () => ({
    logEvent: jest.fn(),
    actorName: jest.fn(),
    getEntityHistory: jest.fn(),
}));
jest.mock('../backend/src/services/stripePaymentsService', () => ({
    StripePaymentsError: class extends Error {},
}));
jest.mock('../backend/src/services/emailService', () => ({
    sendEmail: jest.fn(),
}));

const jobsRouter = require('../backend/src/routes/jobs');

const COMPANY = '00000000-0000-4000-8000-000000000001';

const rescheduleLayer = jobsRouter.stack.find(
    layer => layer.route?.path === '/:id/reschedule'
);
const rescheduleHandler = rescheduleLayer.route.stack.at(-1).handle;

async function invokeReschedule(body) {
    const req = {
        params: { id: '50' },
        body,
        user: { crmUser: { id: '10000000-0000-4000-8000-000000000001' } },
        authz: { scope: 'tenant', permissions: ['jobs.edit'], scopes: {} },
        companyFilter: { company_id: COMPANY },
    };
    const response = { statusCode: 200, body: null };
    const res = {
        status(code) {
            response.statusCode = code;
            return this;
        },
        json(payload) {
            response.body = payload;
            return this;
        },
    };
    await rescheduleHandler(req, res);
    return response;
}

beforeEach(() => {
    jest.clearAllMocks();
    mockGetJobById.mockResolvedValue({
        id: 50,
        company_id: COMPANY,
        zenbooker_job_id: null,
        assigned_techs: [],
    });
    mockDbQuery.mockResolvedValue({
        rows: [{ zenbooker_job_id: null, assigned_techs: [] }],
    });
    mockTxQuery.mockResolvedValue({ rows: [], rowCount: 1 });
    mockWithTransaction.mockImplementation(work => work({ query: mockTxQuery }));
    mockLogJobActivity.mockResolvedValue({ ok: true, id: 1 });
});

test('legacy reschedule scopes every local SQL statement and logs atomically', async () => {
    const res = await invokeReschedule({
        start_date: '2026-08-01T14:00:00.000Z',
        arrival_window_minutes: 120,
    });

    expect(res.statusCode).toBe(200);
    for (const [sql, params] of [...mockDbQuery.mock.calls, ...mockTxQuery.mock.calls]) {
        if (!/\b(?:SELECT|UPDATE)\b[\s\S]*\bjobs\b/i.test(String(sql))) continue;
        expect(String(sql)).toContain('company_id');
        expect(params).toContain(COMPANY);
    }
    expect(mockLogJobActivity).toHaveBeenCalledWith({
        companyId: COMPANY,
        action: 'job.rescheduled',
        jobId: 50,
        actor: {
            id: '10000000-0000-4000-8000-000000000001',
            type: 'user',
            label: null,
            source: 'crm',
        },
    }, expect.objectContaining({ client: expect.any(Object) }));
});

test('legacy reschedule returns 404 for a foreign Job before any raw write', async () => {
    mockGetJobById.mockResolvedValueOnce(null);

    const res = await invokeReschedule({
        start_date: '2026-08-01T14:00:00.000Z',
    });

    expect(res.statusCode).toBe(404);
    expect(mockDbQuery).not.toHaveBeenCalled();
    expect(mockTxQuery).not.toHaveBeenCalled();
    expect(mockLogJobActivity).not.toHaveBeenCalled();
});
