jest.mock('../backend/src/db/connection', () => ({
    query: jest.fn(),
    getClient: jest.fn(),
}));
jest.mock('../backend/src/services/fsmService', () => ({
    resolveTransition: jest.fn(),
}));
jest.mock('../backend/src/services/jobsService', () => ({
    getJobById: jest.fn(),
    updateBlancStatus: jest.fn(),
}));
jest.mock('../backend/src/services/eventService', () => ({
    actorName: jest.fn(() => 'Tester'),
    logEvent: jest.fn(),
}));
jest.mock('../backend/src/services/jobActivityService', () => ({
    userActor: jest.fn(id => ({ id, type: 'user', label: null, source: 'crm' })),
    logJobActivity: jest.fn(async () => {}),
}));
jest.mock('../backend/src/services/conversationsService', () => ({
    getOrCreateConversation: jest.fn(),
    sendMessage: jest.fn(),
}));
jest.mock('../backend/src/db/companyQueries', () => ({
    getCompanyById: jest.fn(),
}));
jest.mock('../backend/src/services/messagingHelper', () => ({
    resolveCompanyProxyE164: jest.fn(),
}));
jest.mock('../backend/src/services/fsmTransitionOps', () => {
    const actual = jest.requireActual('../backend/src/services/fsmTransitionOps');
    return { runTransitionOp: jest.fn(actual.runTransitionOp) };
});
jest.mock('../backend/src/services/auditService', () => ({ log: jest.fn(async () => {}) }));

const db = require('../backend/src/db/connection');
const fsmService = require('../backend/src/services/fsmService');
const jobsService = require('../backend/src/services/jobsService');
const conversationsService = require('../backend/src/services/conversationsService');
const companyQueries = require('../backend/src/db/companyQueries');
const { resolveCompanyProxyE164 } = require('../backend/src/services/messagingHelper');
const { runTransitionOp } = require('../backend/src/services/fsmTransitionOps');
const { applyTransitionHandler } = require('../backend/src/routes/fsm');

const COMPANY = '11111111-1111-1111-1111-111111111111';
const JOB = {
    id: 5,
    blanc_status: 'Submitted',
    customer_phone: '+16175551234',
    assigned_techs: [{ name: 'Taylor' }],
};

function request(body, permissions = ['jobs.edit', 'messages.send']) {
    return {
        body,
        params: { machineKey: 'job' },
        companyFilter: { company_id: COMPANY },
        user: { sub: 'kc-user', roles: [], crmUser: { id: 'crm-user' } },
        authz: {
            permissions,
            scopes: {},
            membership: { role_key: 'provider' },
        },
    };
}

function response() {
    return {
        statusCode: 200,
        body: null,
        status(code) {
            this.statusCode = code;
            return this;
        },
        json(body) {
            this.body = body;
            return this;
        },
    };
}

describe('FSM apply handler', () => {
    let client;

    beforeEach(() => {
        jest.clearAllMocks();
        client = {
            query: jest.fn(async () => ({ rows: [], rowCount: 1 })),
            release: jest.fn(),
        };
        db.getClient.mockResolvedValue(client);
        jobsService.getJobById.mockResolvedValue(JOB);
        jobsService.updateBlancStatus.mockResolvedValue({ ...JOB, blanc_status: 'On the way' });
        resolveCompanyProxyE164.mockResolvedValue('+16175550000');
        companyQueries.getCompanyById.mockResolvedValue({ name: 'ABC Homes' });
        conversationsService.getOrCreateConversation.mockResolvedValue({ id: 'conversation-1' });
        conversationsService.sendMessage.mockResolvedValue({ id: 'message-1' });
    });

    test('updates status and fires notify_on_the_way before the transaction commits', async () => {
        const transition = {
            event: 'TO_ON_THE_WAY',
            targetStatusName: 'On the way',
            action: true,
            roles: [],
            op: 'notify_on_the_way',
        };
        fsmService.resolveTransition.mockResolvedValue({
            valid: true,
            targetState: 'On the way',
            event: 'TO_ON_THE_WAY',
            transition,
            op: 'notify_on_the_way',
        });
        const res = response();

        await applyTransitionHandler(request({
            entityId: 5,
            event: 'TO_ON_THE_WAY',
            eta_minutes: 20,
        }), res);

        expect(res.statusCode).toBe(200);
        expect(jobsService.updateBlancStatus).toHaveBeenCalledWith(
            5,
            'On the way',
            COMPANY,
            expect.objectContaining({ id: 'crm-user', type: 'user' }),
            expect.objectContaining({ client, job: JOB, resolvedTransition: expect.objectContaining({ transition }) })
        );
        expect(runTransitionOp).toHaveBeenCalledWith(
            'notify_on_the_way',
            expect.objectContaining({ client, companyId: COMPANY, etaMinutes: 20 })
        );
        expect(conversationsService.sendMessage).toHaveBeenCalledWith('conversation-1', {
            companyId: COMPANY,
            body: 'Hi! Your technician Taylor from ABC Homes is on the way and should arrive in about 20 minutes.',
            author: 'agent',
        });
        expect(client.query.mock.calls.map(([sql]) => sql)).toEqual(['BEGIN', 'COMMIT']);
    });

    test.each([
        {
            label: 'Start-equivalent',
            from: 'On the way',
            event: 'TO_VISIT_COMPLETED',
            target: 'Visit completed',
            permissions: ['jobs.edit', 'jobs.done_pending_approval'],
        },
        {
            label: 'Complete-equivalent',
            from: 'Visit completed',
            event: 'TO_JOB_DONE',
            target: 'Job is Done',
            permissions: ['jobs.edit', 'jobs.close'],
        },
    ])('$label forward action changes blanc_status to $target', async ({ from, event, target, permissions }) => {
        const currentJob = { ...JOB, blanc_status: from };
        const transition = {
            event,
            targetStatusName: target,
            action: true,
            roles: [],
            op: null,
        };
        jobsService.getJobById.mockResolvedValue(currentJob);
        jobsService.updateBlancStatus.mockResolvedValue({ ...currentJob, blanc_status: target });
        fsmService.resolveTransition.mockResolvedValue({
            valid: true,
            targetState: target,
            event,
            transition,
            op: null,
        });
        const res = response();

        await applyTransitionHandler(request({ entityId: 5, event }, permissions), res);

        expect(res.statusCode).toBe(200);
        expect(res.body.data).toMatchObject({ previousState: from, newState: target, op: null });
        expect(jobsService.updateBlancStatus).toHaveBeenCalledWith(
            5,
            target,
            COMPANY,
            expect.objectContaining({ id: 'crm-user', type: 'user' }),
            expect.objectContaining({ client, job: currentJob, resolvedTransition: expect.objectContaining({ transition }) })
        );
        expect(runTransitionOp).not.toHaveBeenCalled();
        expect(conversationsService.sendMessage).not.toHaveBeenCalled();
        expect(client.query.mock.calls.map(([sql]) => sql)).toEqual(['BEGIN', 'COMMIT']);
    });

    test('SAB-FSM-BYPASS rejects a forged event and rolls back without a status write', async () => {
        fsmService.resolveTransition.mockResolvedValue({ valid: false, error: 'Transition not allowed' });
        const res = response();

        await applyTransitionHandler(request({ entityId: 5, event: 'TO_JOB_DONE' }), res);

        expect(res.statusCode).toBe(400);
        expect(jobsService.updateBlancStatus).not.toHaveBeenCalled();
        expect(runTransitionOp).not.toHaveBeenCalled();
        expect(client.query.mock.calls.map(([sql]) => sql)).toEqual(['BEGIN', 'ROLLBACK']);
    });

    test('returns 404 for a foreign or provider-hidden job without mutating it', async () => {
        jobsService.getJobById.mockResolvedValue(null);
        const res = response();

        await applyTransitionHandler(request({ entityId: 999, event: 'TO_ON_THE_WAY' }), res);

        expect(res.statusCode).toBe(404);
        expect(jobsService.getJobById).toHaveBeenCalledWith(
            999,
            COMPANY,
            expect.any(Object),
            { client, forUpdate: true }
        );
        expect(fsmService.resolveTransition).not.toHaveBeenCalled();
        expect(jobsService.updateBlancStatus).not.toHaveBeenCalled();
        expect(client.query.mock.calls.map(([sql]) => sql)).toEqual(['BEGIN', 'ROLLBACK']);
    });

    test('uses the hardcoded neutral-action fallback when no graph is published', async () => {
        fsmService.resolveTransition.mockResolvedValue({ valid: null, fallback: true });
        jobsService.updateBlancStatus.mockResolvedValue({ ...JOB, blanc_status: 'Follow Up with Client' });
        const res = response();

        await applyTransitionHandler(request({
            entityId: 5,
            event: 'TO_FOLLOW_UP_WITH_CLIENT',
        }), res);

        expect(res.statusCode).toBe(200);
        expect(res.body.data).toMatchObject({
            newState: 'Follow Up with Client',
            fallback: true,
        });
        expect(jobsService.updateBlancStatus).toHaveBeenCalledTimes(1);
    });

    test('preserves closing permission checks', async () => {
        const transition = {
            event: 'TO_VISIT_COMPLETED',
            targetStatusName: 'Visit completed',
            action: true,
            roles: [],
            op: null,
        };
        fsmService.resolveTransition.mockResolvedValue({
            valid: true,
            targetState: 'Visit completed',
            event: transition.event,
            transition,
            op: null,
        });
        const res = response();

        await applyTransitionHandler(
            request({ entityId: 5, event: transition.event }, ['jobs.edit']),
            res
        );

        expect(res.statusCode).toBe(403);
        expect(jobsService.updateBlancStatus).not.toHaveBeenCalled();
        expect(client.query.mock.calls.map(([sql]) => sql)).toEqual(['BEGIN', 'ROLLBACK']);
    });

    test('enforces transition-level roles from the published graph', async () => {
        const transition = {
            event: 'ADMIN_ONLY',
            targetStatusName: 'Waiting for parts',
            action: true,
            roles: ['company_admin'],
            op: null,
        };
        fsmService.resolveTransition.mockResolvedValue({
            valid: true,
            targetState: 'Waiting for parts',
            event: transition.event,
            transition,
            op: null,
        });
        const res = response();

        await applyTransitionHandler(request({ entityId: 5, event: transition.event }), res);

        expect(res.statusCode).toBe(403);
        expect(jobsService.updateBlancStatus).not.toHaveBeenCalled();
    });

    test('preserves messages.send for the retained ETA-SMS operation', async () => {
        const transition = {
            event: 'TO_ON_THE_WAY',
            targetStatusName: 'On the way',
            action: true,
            roles: [],
            op: 'notify_on_the_way',
        };
        fsmService.resolveTransition.mockResolvedValue({
            valid: true,
            targetState: 'On the way',
            event: transition.event,
            transition,
            op: transition.op,
        });
        const res = response();

        await applyTransitionHandler(
            request({ entityId: 5, event: transition.event, eta_minutes: 20 }, ['jobs.edit']),
            res
        );

        expect(res.statusCode).toBe(403);
        expect(jobsService.updateBlancStatus).not.toHaveBeenCalled();
        expect(runTransitionOp).not.toHaveBeenCalled();
    });
});
