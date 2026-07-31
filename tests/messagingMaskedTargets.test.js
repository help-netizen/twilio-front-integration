'use strict';

const express = require('express');
const request = require('supertest');

const COMPANY_A = '00000000-0000-4000-8000-00000000000a';
const COMPANY_B = '00000000-0000-4000-8000-00000000000b';
const CUSTOMER = '+15085550100';
const PROXY = '+16175550123';

const mockDbQuery = jest.fn();
const mockGetOrCreateConversation = jest.fn();
const mockSendMessage = jest.fn();
const mockGetActiveSettings = jest.fn();

jest.mock('../backend/src/db/connection', () => ({
    query: (...args) => mockDbQuery(...args),
}));
jest.mock('../backend/src/db/conversationsQueries', () => ({
    getConversationById: jest.fn(),
    isConversationVisibleToProvider: jest.fn(),
}));
jest.mock('../backend/src/services/conversationsService', () => ({
    getOrCreateConversation: (...args) => mockGetOrCreateConversation(...args),
    sendMessage: (...args) => mockSendMessage(...args),
}));
jest.mock('../backend/src/services/callMaskingService', () => ({
    getActiveSettings: (...args) => mockGetActiveSettings(...args),
}));
jest.mock('../backend/src/services/auditService', () => ({ log: jest.fn(async () => {}) }));

const messagingRouter = require('../backend/src/routes/messaging');

function app() {
    const server = express();
    server.use(express.json());
    server.use((req, _res, next) => {
        req.user = { crmUser: { id: 'provider-1' } };
        req.authz = {
            permissions: ['messages.send', 'call_masking.use'],
            scopes: { job_visibility: 'assigned_only' },
        };
        req.companyFilter = { company_id: COMPANY_A };
        next();
    });
    server.use('/api/messaging', messagingRouter);
    return server;
}

beforeEach(() => {
    jest.clearAllMocks();
    mockGetActiveSettings.mockResolvedValue({
        call_masking_enabled: true,
        call_masking_number: PROXY,
    });
    mockDbQuery.mockImplementation(async sql => {
        if (String(sql).includes('FROM contacts c')) {
            return { rows: [{ phone_e164: CUSTOMER, secondary_phone: null }] };
        }
        if (String(sql).includes('FROM sms_conversations')) {
            return { rows: [{ proxy_e164: PROXY }] };
        }
        return { rows: [] };
    });
    mockGetOrCreateConversation.mockResolvedValue({
        id: 'conversation-1',
        company_id: COMPANY_A,
        customer_e164: CUSTOMER,
        proxy_e164: PROXY,
    });
    mockSendMessage.mockResolvedValue({ id: 'message-1', body: 'On my way' });
});

test('masked composer target resolves server-side and response contains no phone digits', async () => {
    const response = await request(app())
        .post('/api/messaging/start')
        .send({
            contactId: 42,
            targetRef: 'contact:primary',
            initialMessage: 'On my way',
            company_id: COMPANY_B,
            customerE164: '+19999999999',
        });

    expect(response.status).toBe(200);
    expect(mockDbQuery.mock.calls[0][1]).toEqual([
        42,
        COMPANY_A,
        JSON.stringify(['provider-1']),
        expect.any(Array),
    ]);
    expect(mockDbQuery.mock.calls[1][1]).toEqual([COMPANY_A, CUSTOMER]);
    expect(mockGetOrCreateConversation).toHaveBeenCalledWith(CUSTOMER, PROXY, COMPANY_A);
    expect(mockSendMessage).toHaveBeenCalledWith('conversation-1', { body: 'On my way' });
    expect(JSON.stringify(response.body)).not.toContain(CUSTOMER);
    expect(JSON.stringify(response.body)).not.toContain(PROXY);
    expect(JSON.stringify(response.body)).not.toContain('+19999999999');
});

test('T-foreign contact target is 404 and no conversation is created', async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [] });

    const response = await request(app())
        .post('/api/messaging/start')
        .send({ contactId: 999, targetRef: 'contact:primary', company_id: COMPANY_B });

    expect(response.status).toBe(404);
    expect(response.body).toEqual({ error: 'Message target not found' });
    expect(mockDbQuery).toHaveBeenCalledTimes(1);
    expect(mockGetOrCreateConversation).not.toHaveBeenCalled();
    expect(mockSendMessage).not.toHaveBeenCalled();
});

test('masked viewer cannot bypass the scoped target resolver with raw phone input', async () => {
    const response = await request(app())
        .post('/api/messaging/start')
        .send({ customerE164: CUSTOMER, proxyE164: PROXY, initialMessage: 'Bypass' });

    expect(response.status).toBe(400);
    expect(response.body).toEqual({ error: 'Opaque message target required' });
    expect(mockDbQuery).not.toHaveBeenCalled();
    expect(mockGetOrCreateConversation).not.toHaveBeenCalled();
    expect(mockSendMessage).not.toHaveBeenCalled();
});
