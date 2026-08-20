/**
 * OB-71 — the slot-unavailable callback task must be parented to the lead.
 *
 * The task is written the moment the engine reports no window, which is before
 * createLead runs (observed on prod 2026-08-19: task 23:23:13, lead 23:23:38), so
 * it can only land with a thread. tasksQueries derives a task's parent from
 * whichever FK is set, so a thread-only task reads as a task on the conversation —
 * the dispatcher opens a timeline instead of the request they have to act on.
 */

jest.mock('../backend/src/services/tasksService', () => ({}));
jest.mock('../backend/src/services/inboundVoiceRecoveryService', () => ({}));
jest.mock('../backend/src/services/transactionService', () => ({
    withTransaction: jest.fn(),
}));
jest.mock('../backend/src/db/tasksQueries', () => ({
    resolveParentId: jest.fn(),
}));
jest.mock('../backend/src/db/connection', () => ({ query: jest.fn() }));

const tasksQueries = require('../backend/src/db/tasksQueries');
const { withTransaction } = require('../backend/src/services/transactionService');
const svc = require('../backend/src/services/vapiRecommendSlotsAuditService');

const COMPANY = '00000000-0000-0000-0000-000000000001';
const CALL = '01a01c54-8729-700f-add5-8ca328088c29';
const LEAD_UUID = 'Hlo78';

function clientReturning(rows) {
    return { query: jest.fn(async () => ({ rows })) };
}

beforeEach(() => {
    jest.clearAllMocks();
    tasksQueries.resolveParentId.mockResolvedValue(1593);
    withTransaction.mockImplementation(async (fn) => fn(clientReturning([{ id: 2982 }])));
});

describe('attachLeadToCallbackTask', () => {
    test('parents the call\'s callback task to the lead the call produced', async () => {
        const client = clientReturning([{ id: 2982 }]);
        const out = await svc.attachLeadToCallbackTaskWithClient(
            { companyId: COMPANY, providerCallId: CALL, leadRef: LEAD_UUID }, client,
        );
        expect(out).toEqual({ attached: true, taskId: 2982 });
        expect(tasksQueries.resolveParentId).toHaveBeenCalledWith(COMPANY, 'lead', LEAD_UUID, client);
        const [sql, params] = client.query.mock.calls[0];
        expect(params).toEqual([CALL, COMPANY, 1593]);
        // The task is found through THIS call's audit row, never by title or time.
        expect(sql).toContain('vapi_recommend_slots_call_audits');
        expect(sql).toContain('t.id = a.callback_task_id');
    });

    test('is idempotent and never re-parents a task that already has a lead', async () => {
        const client = clientReturning([]);
        const out = await svc.attachLeadToCallbackTaskWithClient(
            { companyId: COMPANY, providerCallId: CALL, leadRef: LEAD_UUID }, client,
        );
        expect(out).toEqual({ attached: false, taskId: null });
        expect(client.query.mock.calls[0][0]).toContain('t.lead_id IS NULL');
    });

    test('stays inside the company on both the audit row and the task', async () => {
        const client = clientReturning([{ id: 2982 }]);
        await svc.attachLeadToCallbackTaskWithClient(
            { companyId: COMPANY, providerCallId: CALL, leadRef: LEAD_UUID }, client,
        );
        const sql = client.query.mock.calls[0][0];
        expect(sql).toContain('a.company_id = $2');
        expect(sql).toContain('t.company_id = $2');
    });

    test('leaves thread_id alone so the recording stays one click away', async () => {
        const client = clientReturning([{ id: 2982 }]);
        await svc.attachLeadToCallbackTaskWithClient(
            { companyId: COMPANY, providerCallId: CALL, leadRef: LEAD_UUID }, client,
        );
        expect(client.query.mock.calls[0][0]).not.toContain('thread_id');
    });

    test('a lead reference that resolves to nothing writes nothing', async () => {
        tasksQueries.resolveParentId.mockResolvedValue(null);
        const client = clientReturning([{ id: 2982 }]);
        const out = await svc.attachLeadToCallbackTaskWithClient(
            { companyId: COMPANY, providerCallId: CALL, leadRef: 'nope' }, client,
        );
        expect(out).toEqual({ attached: false, taskId: null });
        expect(client.query).not.toHaveBeenCalled();
    });

    test.each([
        ['no company', { providerCallId: CALL, leadRef: LEAD_UUID }],
        ['no provider call', { companyId: COMPANY, leadRef: LEAD_UUID }],
        ['no lead', { companyId: COMPANY, providerCallId: CALL }],
    ])('%s → no-op, no resolve, no write', async (_label, input) => {
        const client = clientReturning([{ id: 2982 }]);
        const out = await svc.attachLeadToCallbackTaskWithClient(input, client);
        expect(out).toEqual({ attached: false, taskId: null });
        expect(tasksQueries.resolveParentId).not.toHaveBeenCalled();
        expect(client.query).not.toHaveBeenCalled();
    });

    test('the transactional wrapper runs the same statement', async () => {
        const out = await svc.attachLeadToCallbackTask({
            companyId: COMPANY, providerCallId: CALL, leadRef: LEAD_UUID,
        });
        expect(withTransaction).toHaveBeenCalledTimes(1);
        expect(out).toEqual({ attached: true, taskId: 2982 });
    });
});
