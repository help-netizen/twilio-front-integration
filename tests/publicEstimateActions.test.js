'use strict';

const express = require('express');
const request = require('supertest');

const COMPANY_A = '00000000-0000-0000-0000-00000000000a';
const COMPANY_B = '00000000-0000-0000-0000-00000000000b';
const AUTHOR_ID = '22222222-2222-4222-8222-222222222222';
const ESTIMATE_ID = 42;
const TOKEN = 'public_EST_42';
const USER_AGENT = 'P1 customer browser';

let mockState;
let mockEvents;
let mockIpCounter = 10;

const mockTxClient = { query: jest.fn() };
const mockLockEstimateByPublicToken = jest.fn();
const mockGetEstimateById = jest.fn();
const mockGetEstimateByPublicToken = jest.fn();
const mockGetEstimateItems = jest.fn();
const mockCreateRevision = jest.fn();
const mockUpdateEstimate = jest.fn();
const mockUpdateEstimateStatus = jest.fn();
const mockCreateEvent = jest.fn();
const mockGetDeclineTaskContext = jest.fn();
const mockMarkEstimateViewed = jest.fn();
const mockCreateTask = jest.fn();
const mockLogFinancialActivity = jest.fn();
const mockEmit = jest.fn();
const mockWithTransaction = jest.fn();

jest.mock('../backend/src/db/estimatesQueries', () => ({
    lockEstimateByPublicToken: (...args) => mockLockEstimateByPublicToken(...args),
    getEstimateById: (...args) => mockGetEstimateById(...args),
    getEstimateByPublicToken: (...args) => mockGetEstimateByPublicToken(...args),
    getEstimateItems: (...args) => mockGetEstimateItems(...args),
    createRevision: (...args) => mockCreateRevision(...args),
    updateEstimate: (...args) => mockUpdateEstimate(...args),
    updateEstimateStatus: (...args) => mockUpdateEstimateStatus(...args),
    createEvent: (...args) => mockCreateEvent(...args),
    getDeclineTaskContext: (...args) => mockGetDeclineTaskContext(...args),
    markEstimateViewed: (...args) => mockMarkEstimateViewed(...args),
}));
jest.mock('../backend/src/db/tasksQueries', () => ({
    createTask: (...args) => mockCreateTask(...args),
}));
jest.mock('../backend/src/db/connection', () => ({
    query: jest.fn(),
    pool: { connect: jest.fn() },
}));
jest.mock('../backend/src/services/estimatePdfService', () => ({
    renderEstimatePdf: jest.fn(),
}));
jest.mock('../backend/src/services/financialActivityService', () => ({
    clientActor: jest.fn((label = 'Client', source = 'portal') => ({
        id: null, type: 'client', label, source,
    })),
    logFinancialActivity: (...args) => mockLogFinancialActivity(...args),
}));
jest.mock('../backend/src/services/eventBus', () => ({
    emit: (...args) => mockEmit(...args),
}));
jest.mock('../backend/src/services/transactionService', () => ({
    withTransaction: (...args) => mockWithTransaction(...args),
}));

const publicRouter = require('../backend/src/routes/public-estimates');
const { localDateTimeParts } = require('../backend/src/utils/companyTime');

function estimate(overrides = {}) {
    return {
        id: ESTIMATE_ID,
        company_id: COMPANY_A,
        estimate_number: 'ESTIMATE L-18-1',
        status: 'sent',
        archived_at: null,
        created_by: AUTHOR_ID,
        public_token: TOKEN,
        currency: 'USD',
        company_name: 'Company A',
        contact_name: 'Customer',
        subtotal: '100',
        discount_amount: '0',
        tax_amount: '0',
        total: '100',
        signature_required: false,
        order_list: [],
        ...overrides,
    };
}

function app() {
    const instance = express();
    instance.use(express.json());
    instance.use('/api/public', publicRouter);
    return instance;
}

function post(path, body = {}, ip = `203.0.113.${mockIpCounter++}`) {
    return request(app())
        .post(path)
        .set('x-forwarded-for', ip)
        .set('user-agent', USER_AGENT)
        .send(body);
}

beforeEach(() => {
    jest.clearAllMocks();
    mockState = estimate();
    mockEvents = [];
    mockTxClient.query.mockResolvedValue({ rows: [] });
    mockWithTransaction.mockImplementation(work => work(mockTxClient));
    mockLockEstimateByPublicToken.mockImplementation(async (token, action, client) => {
        if (token !== TOKEN || client !== mockTxClient || mockState.archived_at) return null;
        const allowed = action === 'approve'
            ? ['sent', 'viewed', 'approved']
            : ['sent', 'viewed'];
        return allowed.includes(mockState.status) ? { ...mockState } : null;
    });
    mockGetEstimateById.mockImplementation(async (companyId, id) => (
        companyId === COMPANY_A && Number(id) === ESTIMATE_ID ? { ...mockState } : null
    ));
    mockGetEstimateByPublicToken.mockImplementation(async token => (
        token === TOKEN && !mockState.archived_at ? { ...mockState } : null
    ));
    mockGetEstimateItems.mockResolvedValue([
        { id: 7, name: 'Labor', quantity: '1', unit_price: '100', amount: '100' },
    ]);
    mockCreateRevision.mockResolvedValue({ id: 1 });
    mockUpdateEstimate.mockImplementation(async (id, companyId, patch) => {
        if (Number(id) !== ESTIMATE_ID || companyId !== COMPANY_A) return null;
        mockState = { ...mockState, ...patch };
        return { ...mockState };
    });
    mockUpdateEstimateStatus.mockImplementation(async (id, companyId, status) => {
        if (Number(id) !== ESTIMATE_ID || companyId !== COMPANY_A) return null;
        mockState = { ...mockState, status };
        return { ...mockState };
    });
    mockCreateEvent.mockImplementation(async (...args) => {
        mockEvents.push(args);
        return { id: mockEvents.length };
    });
    mockGetDeclineTaskContext.mockResolvedValue({
        timezone: 'America/New_York',
        owner_user_id: AUTHOR_ID,
    });
    mockMarkEstimateViewed.mockResolvedValue(false);
    mockCreateTask.mockResolvedValue({ id: 900 });
    mockLogFinancialActivity.mockResolvedValue({ ok: true });
    mockEmit.mockResolvedValue({ id: 901 });
});

describe('POST /api/public/estimates/:token/approve', () => {
    test('approves from the token-derived company and records private customer evidence', async () => {
        mockState.signature_required = true;
        const response = await post(`/api/public/estimates/${TOKEN}/approve`, {
            company_id: COMPANY_B,
        });

        expect(response.status).toBe(200);
        expect(response.body.data.status).toBe('approved');
        expect(response.body.data).not.toHaveProperty('company_id');
        expect(response.body.data).not.toHaveProperty('public_token');
        expect(JSON.stringify(response.body.data)).not.toContain(USER_AGENT);
        expect(mockUpdateEstimate).toHaveBeenCalledWith(
            ESTIMATE_ID,
            COMPANY_A,
            expect.objectContaining({ status: 'approved' }),
            mockTxClient
        );
        expect(mockCreateEvent).toHaveBeenCalledWith(
            COMPANY_A,
            ESTIMATE_ID,
            'approved',
            'client',
            null,
            expect.objectContaining({
                ip_address: expect.any(String),
                user_agent: USER_AGENT,
            }),
            mockTxClient
        );
    });

    test('a second approval is a no-op returning the same approved state', async () => {
        const first = await post(`/api/public/estimates/${TOKEN}/approve`);
        const second = await post(`/api/public/estimates/${TOKEN}/approve`);

        expect(first.status).toBe(200);
        expect(second.status).toBe(200);
        expect(second.body.data.status).toBe('approved');
        expect(mockUpdateEstimate).toHaveBeenCalledTimes(1);
        expect(mockCreateRevision).toHaveBeenCalledTimes(1);
        expect(mockEvents.filter((event) => event[2] === 'approved')).toHaveLength(1);
        expect(mockEmit).toHaveBeenCalledTimes(2);
    });

    test.each(['draft', 'declined'])(
        '%s does not resolve for approval and returns the same non-leaking 404 as an unknown token',
        async status => {
            mockState.status = status;
            const unavailable = await post(`/api/public/estimates/${TOKEN}/approve`);
            const unknown = await post('/api/public/estimates/unknown_token/approve');

            expect(unavailable.status).toBe(404);
            expect(unavailable.body).toEqual(unknown.body);
            expect(mockUpdateEstimate).not.toHaveBeenCalled();
        }
    );
});

describe('POST /api/public/estimates/:token/decline', () => {
    test('declines, stores trimmed untrusted text as audit evidence, and creates the assigned task due today', async () => {
        mockState.status = 'viewed';
        const comment = 'Keep <b>this</b> as text & call next month.\nSecond line.';
        const response = await post(`/api/public/estimates/${TOKEN}/decline`, {
            company_id: COMPANY_B,
            reason: 'price',
            comment: `  ${comment}  `,
        });

        expect(response.status).toBe(200);
        expect(response.body.data.status).toBe('declined');
        expect(JSON.stringify(response.body.data)).not.toContain(comment);
        expect(mockUpdateEstimateStatus).toHaveBeenCalledWith(
            ESTIMATE_ID,
            COMPANY_A,
            'declined',
            'declined_at',
            mockTxClient
        );
        expect(mockCreateEvent).toHaveBeenCalledWith(
            COMPANY_A,
            ESTIMATE_ID,
            'declined',
            'client',
            null,
            expect.objectContaining({
                reason: 'price',
                comment,
                user_agent: USER_AGENT,
            }),
            mockTxClient
        );

        expect(mockCreateTask).toHaveBeenCalledWith(
            COMPANY_A,
            expect.objectContaining({
                parentType: 'estimate',
                parentId: ESTIMATE_ID,
                parentIdIsNumeric: true,
                title: 'Estimate #L-18-1 declined — win it back',
                description: `Reason: price\n\nCustomer comment:\n${comment}`,
                owner_user_id: AUTHOR_ID,
                author_user_id: null,
                created_by: 'system',
            }),
            mockTxClient
        );
        const taskPayload = mockCreateTask.mock.calls[0][1];
        const dueParts = localDateTimeParts(taskPayload.due_at, 'America/New_York');
        const nowParts = localDateTimeParts(new Date(), 'America/New_York');
        expect(dueParts).toMatchObject({
            year: nowParts.year,
            month: nowParts.month,
            day: nowParts.day,
            hour: 17,
            minute: 0,
        });
        expect(mockTxClient.query.mock.calls.map(([sql]) => sql)).toEqual([
            'SAVEPOINT estimate_decline_task',
            'RELEASE SAVEPOINT estimate_decline_task',
        ]);
    });

    test('an inactive or removed author produces an unassigned task', async () => {
        mockGetDeclineTaskContext.mockResolvedValue({
            timezone: 'America/New_York',
            owner_user_id: null,
        });

        const response = await post(`/api/public/estimates/${TOKEN}/decline`, {});

        expect(response.status).toBe(200);
        expect(mockCreateTask.mock.calls[0][1]).toMatchObject({
            owner_user_id: null,
            description: 'Customer did not provide a reason or comment.',
        });
    });

    test('decline kills the token for both writes but keeps the proposal readable', async () => {
        const first = await post(`/api/public/estimates/${TOKEN}/decline`, {
            reason: 'not_now',
        });
        const secondDecline = await post(`/api/public/estimates/${TOKEN}/decline`, {
            reason: 'other',
        });
        const laterApprove = await post(`/api/public/estimates/${TOKEN}/approve`);
        const view = await request(app()).get(`/api/public/estimates/${TOKEN}`);

        expect(first.status).toBe(200);
        expect(secondDecline.status).toBe(404);
        expect(laterApprove.status).toBe(404);
        expect(view.status).toBe(200);
        expect(view.body.data.status).toBe('declined');
        expect(mockCreateTask).toHaveBeenCalledTimes(1);
    });

    test('task failure rolls back only the savepoint and the decline still succeeds', async () => {
        const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
        mockCreateTask.mockRejectedValueOnce(Object.assign(new Error('tasks unavailable'), {
            code: 'TASK_STORE_DOWN',
        }));

        const response = await post(`/api/public/estimates/${TOKEN}/decline`, {
            reason: 'chose_other',
        });

        expect(response.status).toBe(200);
        expect(response.body.data.status).toBe('declined');
        expect(mockTxClient.query.mock.calls.map(([sql]) => sql)).toEqual([
            'SAVEPOINT estimate_decline_task',
            'ROLLBACK TO SAVEPOINT estimate_decline_task',
        ]);
        expect(errorSpy).toHaveBeenCalledWith(
            '[Estimates] DECLINE FOLLOW-UP TASK FAILED; customer answer preserved',
            expect.objectContaining({ company_id: COMPANY_A, estimate_id: ESTIMATE_ID })
        );
        errorSpy.mockRestore();
    });

    test('reason validation is strict and comments are trimmed and capped at 1000 characters', async () => {
        const invalid = await post(`/api/public/estimates/${TOKEN}/decline`, {
            reason: 'freeform',
        });
        expect(invalid.status).toBe(400);
        expect(invalid.body.error.code).toBe('VALIDATION');
        expect(mockUpdateEstimateStatus).not.toHaveBeenCalled();

        const longComment = `  ${'x'.repeat(1100)}  `;
        const capped = await post(`/api/public/estimates/${TOKEN}/decline`, {
            reason: 'other',
            comment: longComment,
        });
        expect(capped.status).toBe(200);
        const declineEvent = mockEvents.find(event => event[2] === 'declined');
        expect(declineEvent[5].comment).toHaveLength(1000);
    });

    test('a non-text comment is rejected before any status write', async () => {
        const response = await post(`/api/public/estimates/${TOKEN}/decline`, {
            comment: { html: '<script>not text</script>' },
        });

        expect(response.status).toBe(400);
        expect(response.body.error.code).toBe('VALIDATION');
        expect(mockUpdateEstimateStatus).not.toHaveBeenCalled();
        expect(mockCreateTask).not.toHaveBeenCalled();
    });
});

test('malformed action tokens return 404 before token lookup', async () => {
    const response = await post('/api/public/estimates/!!bad/approve');
    expect(response.status).toBe(404);
    expect(response.body).toEqual({
        ok: false,
        error: { code: 'NOT_FOUND', message: 'Invalid link' },
    });
    expect(mockLockEstimateByPublicToken).not.toHaveBeenCalled();
});

test('public writes are limited to 10 requests per minute per IP', async () => {
    mockState.status = 'approved';
    const sharedIp = '203.0.113.250';
    for (let requestNumber = 0; requestNumber < 10; requestNumber += 1) {
        const response = await post(
            `/api/public/estimates/${TOKEN}/approve`,
            {},
            sharedIp
        );
        expect(response.status).toBe(200);
    }

    const limited = await post(`/api/public/estimates/${TOKEN}/approve`, {}, sharedIp);
    expect(limited.status).toBe(429);
    expect(limited.body).toEqual({
        ok: false,
        error: { code: 'RATE_LIMITED', message: 'Too many requests' },
    });
});
