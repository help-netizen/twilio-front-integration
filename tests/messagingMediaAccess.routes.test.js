'use strict';

const express = require('express');
const request = require('supertest');

const COMPANY_A = '00000000-0000-4000-8000-00000000000a';
const COMPANY_B = '00000000-0000-4000-8000-00000000000b';
const mockIssueMediaAccess = jest.fn();

jest.mock('../backend/src/services/smsMediaAccessService', () => ({
    issueMediaAccess: (...args) => mockIssueMediaAccess(...args),
}));
jest.mock('../backend/src/db/conversationsQueries', () => ({}));
jest.mock('../backend/src/services/conversationsService', () => ({}));
jest.mock('../backend/src/services/auditService', () => ({ log: jest.fn(async () => {}) }));

const messagingRouter = require('../backend/src/routes/messaging');

function app({ permissions = ['messages.view_client'], companyId = COMPANY_A } = {}) {
    const server = express();
    server.use(express.json());
    server.use((req, _res, next) => {
        req.user = { crmUser: { id: 'user-a' } };
        req.authz = { permissions };
        req.companyFilter = companyId ? { company_id: companyId } : undefined;
        next();
    });
    server.use('/api/messaging', messagingRouter);
    return server;
}

beforeEach(() => {
    jest.clearAllMocks();
    mockIssueMediaAccess.mockResolvedValue({
        url: '/api/messaging/media/media-a/temporary-url?cap=signed',
        expiresAt: '2030-01-01T00:00:00.000Z',
    });
});

test.each(['messages.view_client', 'messages.view_internal', 'pulse.view'])(
    'R-allow %s: authenticated reader can mint a media capability',
    async permission => {
        const response = await request(app({ permissions: [permission] }))
            .post('/api/messaging/media/media-a/access-url')
            .send({ companyId: COMPANY_B, tenant_id: COMPANY_B });

        expect(response.status).toBe(200);
        expect(response.headers['cache-control']).toBe('no-store');
        expect(mockIssueMediaAccess).toHaveBeenCalledWith('media-a', COMPANY_A);
        expect(response.body.url).toContain('cap=signed');
    }
);

test('R-deny: a member without a messaging/Pulse read permission cannot mint', async () => {
    const response = await request(app({ permissions: ['contacts.view'] }))
        .post('/api/messaging/media/media-a/access-url');

    expect(response.status).toBe(403);
    expect(mockIssueMediaAccess).not.toHaveBeenCalled();
});

test('T-foreign: unowned media is 404 and no capability is returned', async () => {
    mockIssueMediaAccess.mockResolvedValueOnce(null);
    const response = await request(app({ companyId: COMPANY_B }))
        .post('/api/messaging/media/media-a/access-url');

    expect(response.status).toBe(404);
    expect(response.body).toEqual({ error: 'Media not found' });
    expect(mockIssueMediaAccess).toHaveBeenCalledWith('media-a', COMPANY_B);
});

test('missing tenant context is rejected before minting', async () => {
    const response = await request(app({ companyId: null }))
        .post('/api/messaging/media/media-a/access-url');

    expect(response.status).toBe(403);
    expect(response.body).toEqual({ code: 'TENANT_CONTEXT_REQUIRED' });
    expect(mockIssueMediaAccess).not.toHaveBeenCalled();
});
