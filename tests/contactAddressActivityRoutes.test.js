'use strict';

const express = require('express');
const request = require('supertest');

const mockDbQuery = jest.fn();
const mockTxQuery = jest.fn();
const mockWithTransaction = jest.fn();
const mockLogLeadContactActivity = jest.fn();

jest.mock('../backend/src/db/connection', () => ({
    query: (...args) => mockDbQuery(...args),
    pool: { connect: jest.fn() },
}));
jest.mock('../backend/src/services/transactionService', () => ({
    withTransaction: (...args) => mockWithTransaction(...args),
}));
jest.mock('../backend/src/services/leadContactActivityService', () => ({
    logLeadContactActivity: (...args) => mockLogLeadContactActivity(...args),
    userActor: id => ({ id, type: 'user', label: null, source: 'crm' }),
}));
jest.mock('../backend/src/services/contactsService', () => ({
    getById: jest.fn(),
    getContactById: jest.fn(),
    getContactLeads: jest.fn(async () => []),
    getContactEmails: jest.fn(async () => []),
}));
jest.mock('../backend/src/services/contactAddressService', () => ({
    computeNormalizedHash: jest.fn(() => 'address-hash'),
    getAddressesForContact: jest.fn(async () => []),
    setDefaultAddress: jest.fn(async () => ({ rowCount: 1 })),
    validateAddressBelongsToContact: jest.fn(async () => true),
}));
jest.mock('../backend/src/services/contactDedupeService', () => ({}));
jest.mock('../backend/src/services/contactEmailMergeService', () => ({}));
jest.mock('../backend/src/services/zenbookerSyncService', () => ({ FEATURE_ENABLED: false }));
jest.mock('../backend/src/services/noteAttachmentsService', () => ({
    MAX_FILE_SIZE: 1,
    MAX_FILES_PER_NOTE: 1,
}));
jest.mock('../backend/src/services/notesMutationService', () => ({}));
jest.mock('../backend/src/services/eventService', () => ({}));
jest.mock('../backend/src/services/callMaskingService', () => ({}));

const contactsService = require('../backend/src/services/contactsService');
const contactAddressService = require('../backend/src/services/contactAddressService');
const contactsRouter = require('../backend/src/routes/contacts');

const COMPANY_A = '00000000-0000-4000-8000-000000000001';
const COMPANY_B = '00000000-0000-4000-8000-000000000002';

function app(companyId = COMPANY_A) {
    const instance = express();
    instance.use(express.json());
    instance.use((req, _res, next) => {
        req.user = {
            sub: 'kc-sub',
            crmUser: { id: '10000000-0000-4000-8000-000000000001' },
        };
        req.authz = { permissions: ['contacts.edit'], scopes: {} };
        req.companyFilter = { company_id: companyId };
        next();
    });
    instance.use('/api/contacts', contactsRouter);
    return instance;
}

beforeEach(() => {
    jest.clearAllMocks();
    contactsService.getById.mockImplementation(async (id, companyId) => (
        companyId === COMPANY_A ? { id, company_id: COMPANY_A } : null
    ));
    contactAddressService.validateAddressBelongsToContact.mockResolvedValue(true);
    contactAddressService.setDefaultAddress.mockResolvedValue({ rowCount: 1 });
    contactAddressService.getAddressesForContact.mockResolvedValue([]);
    mockTxQuery.mockImplementation(async (sql) => (
        /UPDATE contact_addresses/i.test(String(sql))
            ? { rows: [], rowCount: 1 }
            : { rows: [], rowCount: 0 }
    ));
    mockWithTransaction.mockImplementation(work => work({ query: mockTxQuery }));
    mockLogLeadContactActivity.mockResolvedValue({ ok: true, id: 1 });
});

test('address save scopes the write by Contact and company and emits one contact.updated', async () => {
    const response = await request(app())
        .patch('/api/contacts/5/addresses/9')
        .send({ street: '1 Main', city: 'Boston', state: 'MA', zip: '02110' });

    expect(response.status).toBe(200);
    expect(contactAddressService.validateAddressBelongsToContact)
        .toHaveBeenCalledWith(9, 5, COMPANY_A);
    const [sql, params] = mockTxQuery.mock.calls.find(([text]) => (
        /UPDATE contact_addresses/i.test(String(text))
    ));
    expect(sql).toContain('c.company_id = $12');
    expect(params).toEqual(expect.arrayContaining([9, 5, COMPANY_A]));
    expect(mockLogLeadContactActivity).toHaveBeenCalledTimes(1);
    expect(mockLogLeadContactActivity).toHaveBeenCalledWith({
        companyId: COMPANY_A,
        entityType: 'contact',
        action: 'contact.updated',
        entityId: 5,
        actor: {
            id: '10000000-0000-4000-8000-000000000001',
            type: 'user',
            label: null,
            source: 'crm',
        },
    }, expect.objectContaining({ client: expect.any(Object) }));
});

test('set-default passes company into the service write and emits contact.address_set', async () => {
    const response = await request(app())
        .put('/api/contacts/5/addresses/9/default')
        .send();

    expect(response.status).toBe(200);
    expect(contactAddressService.setDefaultAddress).toHaveBeenCalledWith(
        5,
        9,
        COMPANY_A,
        expect.objectContaining({ query: mockTxQuery })
    );
    expect(mockLogLeadContactActivity).toHaveBeenCalledWith({
        companyId: COMPANY_A,
        entityType: 'contact',
        action: 'contact.address_set',
        entityId: 5,
        actor: {
            id: '10000000-0000-4000-8000-000000000001',
            type: 'user',
            label: null,
            source: 'crm',
        },
        summary: { contact_address_id: 9 },
    }, expect.objectContaining({ client: expect.any(Object) }));
});

test('foreign Contact returns 404 without mutating or logging', async () => {
    const response = await request(app(COMPANY_B))
        .patch('/api/contacts/5/addresses/9')
        .send({ street: 'Sabotage target' });

    expect(response.status).toBe(404);
    expect(mockWithTransaction).not.toHaveBeenCalled();
    expect(mockTxQuery).not.toHaveBeenCalled();
    expect(mockLogLeadContactActivity).not.toHaveBeenCalled();
});
