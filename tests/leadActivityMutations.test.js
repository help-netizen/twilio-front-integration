'use strict';

const mockDbQuery = jest.fn();
const mockTxQuery = jest.fn();
const mockWithTransaction = jest.fn();
const mockLogLeadContactActivity = jest.fn();
const mockResolveTransition = jest.fn();

jest.mock('../backend/src/db/connection', () => ({
    query: (...args) => mockDbQuery(...args),
    pool: { connect: jest.fn() },
}));
jest.mock('../backend/src/services/transactionService', () => ({
    withTransaction: (...args) => mockWithTransaction(...args),
}));
jest.mock('../backend/src/services/leadContactActivityService', () => ({
    logLeadContactActivity: (...args) => mockLogLeadContactActivity(...args),
}));
jest.mock('../backend/src/services/jobActivityService', () => ({
    logJobActivity: jest.fn(),
}));
jest.mock('../backend/src/services/fsmService', () => ({
    resolveTransition: (...args) => mockResolveTransition(...args),
}));
jest.mock('../backend/src/services/zenbookerClient', () => ({}));
jest.mock('../backend/src/services/eventBus', () => ({ emit: jest.fn(async () => ({ id: 1 })) }));
jest.mock('../backend/src/services/realtimeService', () => ({ broadcast: jest.fn() }));

const leadsService = require('../backend/src/services/leadsService');
const eventBus = require('../backend/src/services/eventBus');

const COMPANY_A = '00000000-0000-4000-8000-000000000001';
const COMPANY_B = '00000000-0000-4000-8000-000000000002';
const ACTOR = {
    id: '10000000-0000-4000-8000-000000000001',
    type: 'user',
    label: null,
    source: 'crm',
};

let lead;
let assignments;
let nextLeadId;

function clone(value) {
    return JSON.parse(JSON.stringify(value));
}

function owned(uuid, companyId) {
    return lead && lead.uuid === uuid && lead.company_id === companyId;
}

beforeEach(() => {
    jest.clearAllMocks();
    lead = {
        id: 42,
        uuid: 'ABC123',
        serial_id: 7001,
        company_id: COMPANY_A,
        first_name: 'Ada',
        status: 'Submitted',
        lead_lost: false,
    };
    assignments = [];
    nextLeadId = 100;
    mockResolveTransition.mockResolvedValue({ valid: true });
    mockLogLeadContactActivity.mockResolvedValue({ ok: true, id: 1 });

    mockTxQuery.mockImplementation(async (sql, params = []) => {
        const text = String(sql);
        if (/FROM company_memberships m/i.test(text)) {
            return params[0] === COMPANY_A && params[1] === 'Sara'
                ? { rows: [{ id: ACTOR.id }] }
                : { rows: [] };
        }
        if (/SELECT api_name FROM lead_custom_fields/i.test(text)) return { rows: [] };
        if (/SELECT 1 FROM leads WHERE uuid/i.test(text)) return { rows: [] };
        if (/INSERT INTO leads/i.test(text)) {
            const created = {
                id: nextLeadId++,
                uuid: params[text.match(/INSERT INTO leads \(([^)]+)/i)[1]
                    .split(',').map(v => v.trim()).indexOf('uuid')],
                serial_id: 9001,
                company_id: COMPANY_A,
                status: 'Submitted',
                lead_lost: false,
            };
            lead = created;
            return { rows: [created], rowCount: 1 };
        }
        if (/SELECT status FROM leads/i.test(text)) {
            return owned(params[0], params[1]) ? { rows: [{ status: lead.status }] } : { rows: [] };
        }
        if (/SELECT id FROM leads WHERE uuid/i.test(text)) {
            return owned(params[0], params[1]) ? { rows: [{ id: lead.id }] } : { rows: [] };
        }
        if (/INSERT INTO lead_team_assignments/i.test(text)) {
            assignments.push({ lead_id: params[0], user_name: params[1] });
            return { rows: [], rowCount: 1 };
        }
        if (/DELETE FROM lead_team_assignments/i.test(text)) {
            assignments = assignments.filter(row => (
                String(row.lead_id) !== String(params[0]) || row.user_name !== params[1]
            ));
            return { rows: [], rowCount: 1 };
        }
        if (/UPDATE leads SET/i.test(text)) {
            const uuidIndex = params.indexOf('ABC123');
            const companyId = params[uuidIndex + 1];
            if (uuidIndex === -1 || !owned('ABC123', companyId)) return { rows: [], rowCount: 0 };
            if (/lead_lost = true/i.test(text)) {
                lead.lead_lost = true;
                lead.status = 'Lost';
            } else if (/lead_lost = false/i.test(text)) {
                lead.lead_lost = false;
                lead.status = 'Submitted';
            } else {
                if (/first_name = \$1/i.test(text)) lead.first_name = params[0];
                if (/status = \$1/i.test(text)) lead.status = params[0];
            }
            return { rows: [{ uuid: lead.uuid, id: lead.id }], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
    });

    mockWithTransaction.mockImplementation(async (work) => {
        const beforeLead = clone(lead);
        const beforeAssignments = clone(assignments);
        try {
            return await work({ query: mockTxQuery });
        } catch (error) {
            lead = beforeLead;
            assignments = beforeAssignments;
            throw error;
        }
    });
});

test('lead.created records the real inserted id with the supplied actor', async () => {
    const result = await leadsService.createLead(
        { FirstName: 'Grace', LastName: 'Hopper', Phone: '6175551234' },
        COMPANY_A,
        { activityActor: ACTOR }
    );

    expect(result.ClientId).toBe('100');
    expect(mockLogLeadContactActivity).toHaveBeenCalledWith({
        companyId: COMPANY_A,
        entityType: 'lead',
        action: 'lead.created',
        entityId: '100',
        actor: ACTOR,
        summary: { status: 'Submitted' },
    }, expect.objectContaining({ client: expect.any(Object) }));
    expect(mockLogLeadContactActivity.mock.calls[0][0].entityId).not.toBe('undefined');
});

test('one field save emits exactly one coarse lead.updated', async () => {
    await leadsService.updateLead('ABC123', { FirstName: 'Augusta' }, COMPANY_A, ACTOR);

    expect(lead.first_name).toBe('Augusta');
    expect(mockLogLeadContactActivity).toHaveBeenCalledTimes(1);
    expect(mockLogLeadContactActivity).toHaveBeenCalledWith({
        companyId: COMPANY_A,
        entityType: 'lead',
        action: 'lead.updated',
        entityId: '42',
        actor: ACTOR,
    }, expect.objectContaining({ client: expect.any(Object) }));
});

test('a status-only save emits lead.status_changed instead of lead.updated', async () => {
    await leadsService.updateLead('ABC123', { Status: 'Review' }, COMPANY_A, ACTOR);

    expect(lead.status).toBe('Review');
    expect(mockLogLeadContactActivity).toHaveBeenCalledTimes(1);
    expect(mockLogLeadContactActivity).toHaveBeenCalledWith({
        companyId: COMPANY_A,
        entityType: 'lead',
        action: 'lead.status_changed',
        entityId: '42',
        actor: ACTOR,
        summary: { status: 'Review' },
    }, expect.objectContaining({ client: expect.any(Object) }));
});

test.each([
    ['lost', () => leadsService.markLost('ABC123', COMPANY_A, ACTOR), 'lead.lost'],
    ['reactivated', () => leadsService.activateLead('ABC123', COMPANY_A, ACTOR), 'lead.reactivated'],
    ['assigned', () => leadsService.assignUser('ABC123', 'Sara', COMPANY_A, ACTOR), 'lead.assigned'],
    ['unassigned', async () => {
        assignments = [{ lead_id: 42, user_name: 'Sara' }];
        return leadsService.unassignUser('ABC123', 'Sara', COMPANY_A, ACTOR);
    }, 'lead.unassigned'],
])('%s resolves the real Lead id and emits %s atomically', async (_label, mutate, action) => {
    const result = await mutate();

    expect(result.ClientId).toBe('42');
    expect(mockLogLeadContactActivity).toHaveBeenCalledWith(
        expect.objectContaining({
            companyId: COMPANY_A,
            entityType: 'lead',
            action,
            entityId: '42',
            actor: ACTOR,
        }),
        expect.objectContaining({ client: expect.any(Object) })
    );
    expect(mockLogLeadContactActivity.mock.calls[0][0].entityId).not.toBe('undefined');
});

test('lead assignment targets a tenant-active crm_users.id, never the display name', async () => {
    const result = await leadsService.assignUser('ABC123', 'Sara', COMPANY_A, ACTOR);

    expect(eventBus.emit).toHaveBeenCalledWith(
        COMPANY_A,
        'lead.assigned',
        {
            lead_id: '42',
            assignee_user_ids: [ACTOR.id],
            record_refs: [{ type: 'lead', id: '42' }],
        },
        expect.objectContaining({
            actorType: 'user',
            actorId: ACTOR.id,
            aggregateType: 'lead',
            aggregateId: '42',
        })
    );
    expect(JSON.stringify(eventBus.emit.mock.calls.at(-1))).not.toContain('Sara');
    expect(result).not.toHaveProperty('assignee_user_id');
    expect(result).not.toHaveProperty('assignment_changed');
});

test('foreign-company mutation is 404, leaves the Lead byte-unchanged, and emits nothing', async () => {
    const before = clone(lead);

    await expect(
        leadsService.markLost('ABC123', COMPANY_B, ACTOR)
    ).rejects.toMatchObject({ code: 'LEAD_NOT_FOUND', httpStatus: 404 });

    expect(lead).toEqual(before);
    expect(mockLogLeadContactActivity).not.toHaveBeenCalled();
});

test('activity failure rolls the Lead mutation back', async () => {
    mockLogLeadContactActivity.mockRejectedValueOnce(new Error('audit insert failed'));

    await expect(
        leadsService.markLost('ABC123', COMPANY_A, ACTOR)
    ).rejects.toThrow('audit insert failed');

    expect(lead.status).toBe('Submitted');
    expect(lead.lead_lost).toBe(false);
});
