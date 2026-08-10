'use strict';

const express = require('express');
const request = require('supertest');

jest.mock('../backend/src/services/leadsService', () => {
    class LeadsServiceError extends Error {}
    return {
        LeadsServiceError,
        markLost: jest.fn(),
        activateLead: jest.fn(),
        assignUser: jest.fn(),
        unassignUser: jest.fn(),
        updateLead: jest.fn(),
        convertLead: jest.fn(),
    };
});
jest.mock('../backend/src/services/eventService', () => ({
    actorName: jest.fn(() => 'Test User'),
    logEvent: jest.fn(),
}));
jest.mock('../backend/src/services/leadContactActivityService', () => ({
    userActor: id => ({ id, type: 'user', label: null, source: 'crm' }),
}));
jest.mock('../backend/src/services/contactDedupeService', () => ({}));
jest.mock('../backend/src/services/contactAddressService', () => ({}));
jest.mock('../backend/src/services/noteAttachmentsService', () => ({
    MAX_FILE_SIZE: 1,
    MAX_FILES_PER_NOTE: 1,
}));
jest.mock('../backend/src/services/notesMutationService', () => ({}));
jest.mock('../backend/src/db/connection', () => ({ query: jest.fn() }));

const leadsService = require('../backend/src/services/leadsService');
const eventService = require('../backend/src/services/eventService');
const leadsRouter = require('../backend/src/routes/leads');

const COMPANY = '00000000-0000-4000-8000-000000000001';
const CRM_USER = '10000000-0000-4000-8000-000000000001';
const ACTOR = { id: CRM_USER, type: 'user', label: null, source: 'crm' };

function app({ crmUserId = CRM_USER } = {}) {
    const instance = express();
    instance.use(express.json());
    instance.use((req, _res, next) => {
        req.user = { sub: 'kc-sub', crmUser: crmUserId ? { id: crmUserId } : null };
        req.authz = {
            permissions: ['leads.edit', 'leads.convert'],
            scopes: {},
        };
        req.companyFilter = { company_id: COMPANY };
        next();
    });
    instance.use('/api/leads', leadsRouter);
    return instance;
}

beforeEach(() => {
    jest.clearAllMocks();
    leadsService.markLost.mockResolvedValue({
        UUID: 'ABC123',
        ClientId: '42',
        message: 'Lead marked as lost',
    });
    leadsService.activateLead.mockResolvedValue({
        UUID: 'ABC123',
        ClientId: '42',
        message: 'Lead activated',
    });
    leadsService.assignUser.mockResolvedValue({
        UUID: 'ABC123',
        LeadId: '42',
        ClientId: '42',
    });
    leadsService.unassignUser.mockResolvedValue({
        UUID: 'ABC123',
        LeadId: '42',
        ClientId: '42',
    });
    leadsService.convertLead.mockResolvedValue({
        UUID: 'ABC123',
        ClientId: '42',
        job_id: 99,
    });
    leadsService.updateLead.mockResolvedValue({ UUID: 'ABC123', ClientId: '42' });
});

test.each([
    ['mark-lost', 'marked_lost', 'markLost', {}],
    ['activate', 'reactivated', 'activateLead', {}],
    ['assign', 'team_assigned', 'assignUser', { User: 'Sara' }],
    ['unassign', 'team_unassigned', 'unassignUser', { User: 'Sara' }],
])('%s threads company + CRM actor and never logs aggregate "undefined"', async (
    path,
    legacyAction,
    method,
    body
) => {
    const response = await request(app())
        .post(`/api/leads/ABC123/${path}`)
        .send(body);

    expect(response.status).toBe(200);
    const serviceCall = leadsService[method].mock.calls[0];
    expect(serviceCall).toContain(COMPANY);
    expect(serviceCall).toContainEqual(ACTOR);
    expect(eventService.logEvent).toHaveBeenCalledWith(
        COMPANY,
        'lead',
        '42',
        legacyAction,
        expect.any(Object),
        'user',
        'kc-sub'
    );
    expect(eventService.logEvent.mock.calls[0][2]).not.toBe('undefined');
});

test('conversion threads the CRM actor and keeps the Lead event on the real Lead id', async () => {
    const response = await request(app())
        .post('/api/leads/ABC123/convert')
        .send({});

    expect(response.status).toBe(200);
    expect(leadsService.convertLead).toHaveBeenCalledWith(
        'ABC123',
        {},
        COMPANY,
        ACTOR
    );
    expect(eventService.logEvent.mock.calls[0][2]).toBe('42');
    expect(eventService.logEvent.mock.calls[0][2]).not.toBe('undefined');
});

test('LEAD-AUTOCONVERT-PATCH-ACTOR: PATCH fails before mutation without a CRM actor', async () => {
    const response = await request(app({ crmUserId: null }))
        .patch('/api/leads/ABC123')
        .send({ FirstName: 'Stale writer' });

    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe('CRM_ACTOR_REQUIRED');
    expect(leadsService.updateLead).not.toHaveBeenCalled();
});
