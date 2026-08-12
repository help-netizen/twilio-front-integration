'use strict';

const mockDbQuery = jest.fn();
const mockTxQuery = jest.fn();
const mockLogJobActivity = jest.fn();
const mockWithTransaction = jest.fn();
const mockResolveTransition = jest.fn();
const mockRecalcForJob = jest.fn();
const mockEventBusEmit = jest.fn();

jest.mock('../backend/src/db/connection', () => ({
    query: (...args) => mockDbQuery(...args),
    pool: {
        query: (...args) => mockDbQuery(...args),
        connect: jest.fn(),
    },
}));
jest.mock('../backend/src/services/activityLogService', () => ({
    logActivity: jest.fn(),
}));
jest.mock('../backend/src/services/jobActivityService', () => ({
    logJobActivity: (...args) => mockLogJobActivity(...args),
}));
jest.mock('../backend/src/services/transactionService', () => ({
    withTransaction: (...args) => mockWithTransaction(...args),
}));
jest.mock('../backend/src/services/fsmService', () => ({
    resolveTransition: (...args) => mockResolveTransition(...args),
}));
jest.mock('../backend/src/db/routeQueries', () => ({
    getCompanyTimezone: jest.fn(async () => 'America/New_York'),
    getTechDaysForJob: jest.fn(async () => []),
}));
jest.mock('../backend/src/services/routeSegmentService', () => ({
    enqueueGeocode: jest.fn(async () => null),
    recalcForJob: (...args) => mockRecalcForJob(...args),
}));
jest.mock('../backend/src/db/membershipQueries', () => ({
    resolveProviderUserIds: jest.fn(async () => []),
}));
jest.mock('../backend/src/services/eventBus', () => ({
    emit: (...args) => mockEventBusEmit(...args),
}));
jest.mock('../backend/src/services/technicianRosterService', () => ({
    canonicalizeAssignments: jest.fn(async (_companyId, assignments) =>
        assignments.map(assignment => ({
            ...assignment,
            id: assignment.id === 'zb-tech-1'
                ? 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
                : assignment.id,
        }))
    ),
}));

const jobsService = require('../backend/src/services/jobsService');
const scheduleService = require('../backend/src/services/scheduleService');

const COMPANY_A = '00000000-0000-4000-8000-000000000001';
const COMPANY_B = '00000000-0000-4000-8000-000000000002';
const ACTOR = {
    id: '10000000-0000-4000-8000-000000000001',
    type: 'user',
    label: null,
    source: 'crm',
};

let job;

function clone(value) {
    return JSON.parse(JSON.stringify(value));
}

function jobIdAndCompany(sql, params) {
    if (/zb_canceled = true/.test(sql)) return [params[1], params[2]];
    if (/blanc_status = \$1/.test(sql)) return [params[2], params[3]];
    if (/SET start_date = \$3/.test(sql)) return [params[0], params[1]];
    if (/address\s+= COALESCE/.test(sql)) return [params[0], params[1]];
    if (/SET description = \$1/.test(sql)) return [params[1], params[2]];
    if (/assigned_techs = \$3::jsonb/.test(sql)) return [params[0], params[1]];
    return [null, null];
}

function applyJobUpdate(sql, params) {
    const [id, companyId] = jobIdAndCompany(sql, params);
    const hasCompanyScope = /company_id/.test(sql);
    const matches = Number(id) === job.id && (!hasCompanyScope || companyId === job.company_id);
    if (!matches) return { rows: [], rowCount: 0 };

    if (/blanc_status = \$1/.test(sql)) {
        job.blanc_status = params[0];
        if (params[1]) job.zb_canceled = true;
    } else if (/zb_canceled = true/.test(sql)) {
        job.blanc_status = 'Canceled';
        job.zb_canceled = true;
    } else if (/SET start_date = \$3/.test(sql)) {
        job.start_date = params[2];
        job.end_date = params[3];
    } else if (/address\s+= COALESCE/.test(sql)) {
        job.address = params[2];
        job.lat = params[3];
        job.lng = params[4];
    } else if (/SET description = \$1/.test(sql)) {
        job.description = params[0];
    } else if (/assigned_techs = \$3::jsonb/.test(sql)) {
        job.assigned_techs = JSON.parse(params[2]);
    }
    return { rows: [clone(job)], rowCount: 1 };
}

beforeEach(() => {
    jest.clearAllMocks();
    job = {
        id: 50,
        company_id: COMPANY_A,
        blanc_status: 'Submitted',
        zb_status: 'scheduled',
        zb_canceled: false,
        zb_rescheduled: false,
        zenbooker_job_id: null,
        assigned_techs: [],
        assigned_provider_user_ids: [],
        notes: [],
        tags: [],
        start_date: null,
        end_date: null,
        created_at: null,
        updated_at: null,
    };

    mockResolveTransition.mockResolvedValue({ valid: true });
    mockLogJobActivity.mockResolvedValue({ ok: true, id: 1 });
    mockRecalcForJob.mockResolvedValue(null);
    mockEventBusEmit.mockResolvedValue({ id: 1 });

    mockDbQuery.mockImplementation(async (sql, params = []) => {
        const text = String(sql);
        if (/FROM jobs j/i.test(text)) {
            const companyId = params[1];
            const companyMatches = companyId === undefined || companyId === job.company_id;
            const row = clone(job);
            if (row.start_date) row.start_date = new Date(row.start_date);
            if (row.end_date) row.end_date = new Date(row.end_date);
            return Number(params[0]) === job.id && companyMatches
                ? { rows: [row] }
                : { rows: [] };
        }
        if (/FROM job_tag_assignments/i.test(text)) return { rows: [] };
        return { rows: [] };
    });

    mockTxQuery.mockImplementation(async (sql, params = []) => {
        const text = String(sql);
        if (/INSERT INTO jobs/i.test(text)) return { rows: [clone(job)], rowCount: 1 };
        if (/FROM job_tag_assignments/i.test(text)) return { rows: [] };
        if (/DELETE FROM job_tag_assignments/i.test(text)) return { rows: [], rowCount: 0 };
        if (/UPDATE jobs/i.test(text)) return applyJobUpdate(text, params);
        return { rows: [], rowCount: 0 };
    });

    mockWithTransaction.mockImplementation(async (work) => {
        const before = clone(job);
        try {
            return await work({ query: mockTxQuery });
        } catch (error) {
            job = before;
            throw error;
        }
    });
});

describe('cancelJob tenant isolation', () => {
    test('a foreign-company call returns 404 and leaves the owned row byte-unchanged', async () => {
        const before = clone(job);

        await expect(jobsService.cancelJob(50, COMPANY_B, ACTOR)).rejects.toMatchObject({
            statusCode: 404,
        });

        expect(job).toEqual(before);
        expect(mockWithTransaction).not.toHaveBeenCalled();
        expect(mockLogJobActivity).not.toHaveBeenCalled();
    });

    test('the committed UPDATE independently carries company_id', async () => {
        await jobsService.cancelJob(50, COMPANY_A, ACTOR);

        const update = mockTxQuery.mock.calls.find(([sql]) => /UPDATE jobs/i.test(String(sql)));
        expect(update).toBeDefined();
        expect(String(update[0])).toContain('company_id');
        expect(update[1]).toContain(COMPANY_A);
        expect(mockLogJobActivity).toHaveBeenCalledWith({
            companyId: COMPANY_A,
            action: 'job.status_changed',
            jobId: 50,
            actor: ACTOR,
            summary: { status: 'Canceled' },
        }, expect.objectContaining({ client: expect.any(Object) }));
    });
});

test('same-company FSM status transition keeps its behavior and logs the CRM actor atomically', async () => {
    await jobsService.updateBlancStatus(50, 'On the way', COMPANY_A, ACTOR);

    expect(mockEventBusEmit).toHaveBeenCalledWith(
        COMPANY_A,
        'job.status_changed',
        expect.objectContaining({
            job_id: 50,
            record_refs: [{ type: 'job', id: 50 }],
            from: 'Submitted',
            to: 'On the way',
        }),
        expect.objectContaining({
            actorType: 'user',
            actorId: ACTOR.id,
            aggregateType: 'job',
            aggregateId: 50,
        })
    );

    expect(job.blanc_status).toBe('On the way');
    expect(mockLogJobActivity).toHaveBeenCalledWith({
        companyId: COMPANY_A,
        action: 'job.status_changed',
        jobId: 50,
        actor: ACTOR,
        summary: { status: 'On the way' },
    }, { client: { query: mockTxQuery } });
});

test('a status activity failure rolls back the status mutation', async () => {
    mockLogJobActivity.mockRejectedValueOnce(new Error('audit insert failed'));

    await expect(
        jobsService.updateBlancStatus(50, 'On the way', COMPANY_A, ACTOR)
    ).rejects.toThrow('audit insert failed');

    expect(job.blanc_status).toBe('Submitted');
});

test('foreign-company schedule reschedule cannot mutate or log the Job', async () => {
    const before = clone(job);

    await expect(
        scheduleService.rescheduleItem(
            COMPANY_B,
            'job',
            50,
            '2026-08-01T14:00:00.000Z',
            '2026-08-01T16:00:00.000Z',
            ACTOR
        )
    ).rejects.toMatchObject({ code: 'NOT_FOUND', httpStatus: 404 });

    expect(job).toEqual(before);
    expect(mockLogJobActivity).not.toHaveBeenCalled();
});

test('same-company schedule reschedule writes and logs in one transaction', async () => {
    await scheduleService.rescheduleItem(
        COMPANY_A,
        'job',
        50,
        '2026-08-01T14:00:00.000Z',
        '2026-08-01T16:00:00.000Z',
        ACTOR
    );

    expect(job.start_date).toBe('2026-08-01T14:00:00.000Z');
    expect(mockLogJobActivity).toHaveBeenCalledWith({
        companyId: COMPANY_A,
        action: 'job.rescheduled',
        jobId: 50,
        actor: ACTOR,
    }, expect.objectContaining({ client: expect.any(Object) }));
});

test.each([
    [
        'coordinates',
        () => jobsService.updateJobLocation(
            COMPANY_A,
            50,
            { address: '123 Main', lat: 40.7, lng: -74 },
            ACTOR
        ),
    ],
    [
        'description',
        () => jobsService.updateJobDescription(50, 'Updated description', COMPANY_A, ACTOR),
    ],
    [
        'tags',
        () => jobsService.updateJobTags(50, [], COMPANY_A, ACTOR),
    ],
])('%s inline save emits exactly one coarse job.updated', async (_field, save) => {
    await save();

    expect(mockLogJobActivity).toHaveBeenCalledTimes(1);
    expect(mockLogJobActivity).toHaveBeenCalledWith({
        companyId: COMPANY_A,
        action: 'job.updated',
        jobId: 50,
        actor: ACTOR,
    }, expect.objectContaining({ client: expect.any(Object) }));
});

test('schedule-slot Job creation logs job.created with the supplied human actor', async () => {
    await jobsService.createManualJob(
        COMPANY_A,
        { service_name: 'Repair' },
        ACTOR
    );

    expect(mockLogJobActivity).toHaveBeenCalledWith({
        companyId: COMPANY_A,
        action: 'job.created',
        jobId: 50,
        actor: ACTOR,
        summary: { status: 'Submitted' },
    }, expect.objectContaining({ client: expect.any(Object) }));
});

test.each([
    [[{ id: 'zb-tech-1', name: 'Sara' }], 'job.assigned', 1],
    [[], 'job.unassigned', 0],
])('schedule reassign emits %s providers as %s', async (assignees, action, count) => {
    await scheduleService.reassignItem(
        COMPANY_A,
        'job',
        50,
        assignees,
        ACTOR
    );

    expect(mockLogJobActivity).toHaveBeenCalledWith({
        companyId: COMPANY_A,
        action,
        jobId: 50,
        actor: ACTOR,
        summary: { count },
    }, expect.objectContaining({ client: expect.any(Object) }));
});
