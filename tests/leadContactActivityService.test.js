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
    clientActor,
    integrationActor,
    logLeadContactActivity,
    userActor,
} = require('../backend/src/services/leadContactActivityService');

const COMPANY = '00000000-0000-4000-8000-000000000001';
const CRM_USER = '10000000-0000-4000-8000-000000000001';

beforeEach(() => {
    jest.clearAllMocks();
    mockLogActivity.mockResolvedValue({ ok: true, id: 1 });
});

test.each([
    ['lead', 'lead.updated', 42],
    ['contact', 'contact.updated', 84],
])('%s human activity uses a real target id, the CRM actor, and no parent', async (
    entityType,
    action,
    entityId
) => {
    const client = { query: jest.fn() };
    await logLeadContactActivity({
        companyId: COMPANY,
        entityType,
        action,
        entityId,
        actor: userActor(CRM_USER),
    }, { client });

    expect(mockLogActivity).toHaveBeenCalledWith({
        action,
        target_type: entityType,
        target_id: String(entityId),
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
    expect(mockLogActivity.mock.calls[0][0].target_id).not.toBe('undefined');
});

test.each([
    [aiActor('AI Phone', 'agent'), 'ai', 'AI Phone', 'agent'],
    [aiActor('Avatar'), 'ai', 'Avatar', 'mcp'],
    [integrationActor('Yelp', 'webhook'), 'integration', 'Yelp', 'webhook'],
    [clientActor(), 'client', 'Client', 'portal'],
])('non-human activity leaves actor_id null and labels the actor', async (
    actor,
    actorType,
    actorLabel,
    source
) => {
    const client = { query: jest.fn() };
    await logLeadContactActivity({
        companyId: COMPANY,
        entityType: 'lead',
        action: 'lead.created',
        entityId: 42,
        actor,
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

test('rejects an unresolved target instead of recording "undefined"', async () => {
    await expect(logLeadContactActivity({
        companyId: COMPANY,
        entityType: 'lead',
        action: 'lead.lost',
        entityId: undefined,
        actor: userActor(CRM_USER),
    }, { client: { query: jest.fn() } })).rejects.toThrow('lead target id is required');
    expect(mockLogActivity).not.toHaveBeenCalled();
});
