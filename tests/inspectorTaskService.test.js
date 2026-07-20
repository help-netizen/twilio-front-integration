'use strict';

const mockClient = { query: jest.fn(), release: jest.fn() };
jest.mock('../backend/src/db/connection', () => ({
    pool: { connect: jest.fn().mockResolvedValue(mockClient) },
}));
jest.mock('../backend/src/db/inspectorQueries', () => ({
    assertEntityType: jest.fn(),
    getReview: jest.fn(),
    reloadEligibleEntity: jest.fn(),
    getEntityRecord: jest.fn(),
    getOpenInspectorTask: jest.fn(),
    insertReview: jest.fn(),
    findExistingTimeline: jest.fn(),
    linkTaskToTimeline: jest.fn(),
}));
jest.mock('../backend/src/db/tasksQueries', () => ({
    createTask: jest.fn(),
    getTaskById: jest.fn(),
}));
jest.mock('../backend/src/services/tasksService', () => ({ emitTaskChange: jest.fn() }));

const inspectorQueries = require('../backend/src/db/inspectorQueries');
const tasksQueries = require('../backend/src/db/tasksQueries');
const tasksService = require('../backend/src/services/tasksService');
const service = require('../backend/src/services/inspectorTaskService');

const COMPANY = '11111111-1111-1111-1111-111111111111';
const INPUT = {
    companyId: COMPANY,
    runId: 41,
    companyLocalDate: '2026-07-20',
    entityType: 'job',
    entityId: 1345,
    boundary: new Date('2026-07-20T04:00:00.000Z'),
    ignoredStatuses: ['Canceled'],
    verdict: {
        needs_attention: true,
        confidence: 0.91,
        reason: 'No payment progress is recorded.',
        task_title: 'Verify payment progress for Job 1345',
        task_description: 'Check whether the invoice or payment is missing and update the record.',
    },
    modelResult: {
        provider: 'gemini', model: 'gemini-test', latency_ms: 10, token_usage: { total: 20 },
    },
};

describe('Inspector transactional task service', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        mockClient.query.mockResolvedValue({ rows: [], rowCount: 0 });
        inspectorQueries.getReview.mockResolvedValue(null);
        inspectorQueries.reloadEligibleEntity.mockResolvedValue({ id: 1345, contact_id: 9 });
        inspectorQueries.getOpenInspectorTask.mockResolvedValue(null);
        inspectorQueries.findExistingTimeline.mockResolvedValue(null);
        inspectorQueries.insertReview.mockImplementation(async (_company, review) => ({ id: 1, ...review }));
        tasksQueries.createTask.mockResolvedValue({ id: 77, job_id: 1345, thread_id: null });
        tasksQueries.getTaskById.mockResolvedValue({ id: 77, job_id: 1345, thread_id: 88 });
    });

    test('SAB-INSP-TASK-SHAPE: action creates exact unassigned agent provenance on the direct parent', async () => {
        const result = await service.createInspectorTask(INPUT);
        expect(result.status).toBe('created');
        expect(tasksQueries.createTask).toHaveBeenCalledWith(COMPANY, {
            parentType: 'job',
            parentId: 1345,
            parentIdIsNumeric: true,
            title: INPUT.verdict.task_title,
            description: INPUT.verdict.task_description,
            created_by: 'agent',
            kind: 'agent',
            agent_type: 'inspector',
            agent_input: {
                entity_type: 'job', entity_id: 1345, company_local_date: '2026-07-20', run_id: 41,
            },
            agent_output: expect.objectContaining({
                needs_attention: true, provider: 'gemini', model: 'gemini-test',
            }),
            agent_status: 'succeeded',
        }, mockClient);
        const payload = tasksQueries.createTask.mock.calls[0][1];
        expect(payload.owner_user_id).toBeUndefined();
        expect(payload.author_user_id).toBeUndefined();
        expect(tasksService.emitTaskChange).toHaveBeenCalledWith(COMPANY);
        expect(mockClient.query.mock.calls.map(call => call[0])).toEqual([
            'BEGIN', 'SAVEPOINT inspector_task_create', 'RELEASE SAVEPOINT inspector_task_create', 'COMMIT',
        ]);
    });

    test('SAB-INSP-DEDUP-OPEN: an open/snoozed Inspector task suppresses a second insert', async () => {
        inspectorQueries.getOpenInspectorTask.mockResolvedValue({
            id: 55, status: 'open', due_at: '2026-08-01T12:00:00.000Z',
        });
        const result = await service.createInspectorTask(INPUT);
        expect(result.status).toBe('deduped');
        expect(tasksQueries.createTask).not.toHaveBeenCalled();
        expect(inspectorQueries.insertReview).toHaveBeenCalledWith(
            COMPANY,
            expect.objectContaining({ verdict: 'deduped_open_task', task_id: 55 }),
            mockClient
        );
        expect(tasksService.emitTaskChange).not.toHaveBeenCalled();
    });

    test('partial-index race rolls back to savepoint and records the winning open task', async () => {
        tasksQueries.createTask.mockRejectedValue(Object.assign(new Error('duplicate'), { code: '23505' }));
        inspectorQueries.getOpenInspectorTask
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce({ id: 99, status: 'open' });
        const result = await service.createInspectorTask(INPUT);
        expect(result).toMatchObject({ status: 'deduped', task: { id: 99 } });
        expect(mockClient.query.mock.calls.map(call => call[0])).toContain(
            'ROLLBACK TO SAVEPOINT inspector_task_create'
        );
        expect(tasksService.emitTaskChange).not.toHaveBeenCalled();
    });

    test('SAB-INSP-NO-TIMELINE-FABRICATION: no existing timeline leaves the direct task timeline-less', async () => {
        inspectorQueries.findExistingTimeline.mockResolvedValue(null);
        const result = await service.createInspectorTask(INPUT);
        expect(result.task.thread_id).toBeNull();
        expect(inspectorQueries.linkTaskToTimeline).not.toHaveBeenCalled();
        expect(JSON.stringify(inspectorQueries.mock?.calls || '')).not.toContain('findOrCreate');
    });

    test('existing company/contact timeline is linked after direct-parent creation', async () => {
        inspectorQueries.findExistingTimeline.mockResolvedValue({ id: 88, contact_id: 9 });
        inspectorQueries.linkTaskToTimeline.mockResolvedValue({ id: 77 });
        const result = await service.createInspectorTask(INPUT);
        expect(inspectorQueries.linkTaskToTimeline).toHaveBeenCalledWith(
            COMPANY, 77, 88, 9, mockClient
        );
        expect(result.task.thread_id).toBe(88);
    });

    test('foreign/missing entity returns not_found without task or review write', async () => {
        inspectorQueries.reloadEligibleEntity.mockResolvedValue(null);
        inspectorQueries.getEntityRecord.mockResolvedValue(null);
        const result = await service.createInspectorTask(INPUT);
        expect(result.status).toBe('not_found');
        expect(tasksQueries.createTask).not.toHaveBeenCalled();
        expect(inspectorQueries.insertReview).not.toHaveBeenCalled();
    });

    test('SAB-INSP-SSE-SCOPE: event payload is the existing company-only coarse ping', async () => {
        await service.createInspectorTask(INPUT);
        expect(tasksService.emitTaskChange).toHaveBeenCalledTimes(1);
        expect(tasksService.emitTaskChange).toHaveBeenCalledWith(COMPANY);
    });
});
