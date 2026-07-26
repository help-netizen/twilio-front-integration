'use strict';

const mockLogActivity = jest.fn();

jest.mock('../backend/src/services/activityLogService', () => ({
    logActivity: (...args) => mockLogActivity(...args),
}));
jest.mock('../backend/src/services/transactionService', () => ({
    withTransaction: jest.fn(),
}));

const {
    aiActor,
    logJobActivity,
    systemActor,
    userActor,
} = require('../backend/src/services/jobActivityService');

const COMPANY = '00000000-0000-4000-8000-000000000001';
const CRM_USER = '10000000-0000-4000-8000-000000000001';

beforeEach(() => {
    jest.clearAllMocks();
    mockLogActivity.mockResolvedValue({ ok: true, id: 1 });
});

test('human Job activity uses the CRM user and no parent snapshot', async () => {
    const client = { query: jest.fn() };
    await logJobActivity({
        companyId: COMPANY,
        action: 'job.updated',
        jobId: 42,
        actor: userActor(CRM_USER),
    }, { client });

    expect(mockLogActivity).toHaveBeenCalledWith({
        action: 'job.updated',
        target_type: 'job',
        target_id: '42',
        company_id: COMPANY,
        actor_id: CRM_USER,
        details: {
            actor_type: 'user',
            actor_label: null,
            source: 'crm',
            parent_type: null,
            parent_id: null,
        },
    }, { client });
});

test.each([
    [aiActor('AI Phone'), 'ai', 'AI Phone', 'agent'],
    [aiActor('Sara', 'mcp'), 'ai', 'Sara', 'mcp'],
    [systemActor('Automation'), 'system', 'Automation', 'crm'],
])('non-human Job activity never puts its identity in actor_id', async (
    actor,
    actorType,
    actorLabel,
    source
) => {
    const client = { query: jest.fn() };
    await logJobActivity({
        companyId: COMPANY,
        action: 'job.status_changed',
        jobId: 42,
        actor,
        summary: { status: 'Canceled' },
    }, { client });

    expect(mockLogActivity).toHaveBeenCalledWith(
        expect.objectContaining({
            actor_id: null,
            details: expect.objectContaining({
                actor_type: actorType,
                actor_label: actorLabel,
                source,
                parent_type: null,
                parent_id: null,
            }),
        }),
        { client }
    );
});
