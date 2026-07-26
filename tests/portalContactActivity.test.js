'use strict';

const mockWithTransaction = jest.fn();
const mockLogLeadContactActivity = jest.fn();

jest.mock('../backend/src/db/portalQueries', () => ({
    getSessionById: jest.fn(),
    touchSession: jest.fn(async () => {}),
    updateContactProfile: jest.fn(),
    logEvent: jest.fn(async () => ({})),
}));
jest.mock('../backend/src/db/estimatesQueries', () => ({}));
jest.mock('../backend/src/db/invoicesQueries', () => ({}));
jest.mock('../backend/src/services/estimatesService', () => ({}));
jest.mock('../backend/src/services/financialActivityService', () => ({
    clientActor: () => ({ id: null, type: 'client', label: 'Client', source: 'portal' }),
    logFinancialActivity: jest.fn(),
}));
jest.mock('../backend/src/services/leadContactActivityService', () => ({
    logLeadContactActivity: (...args) => mockLogLeadContactActivity(...args),
}));
jest.mock('../backend/src/services/transactionService', () => ({
    withTransaction: (...args) => mockWithTransaction(...args),
}));

const portalQueries = require('../backend/src/db/portalQueries');
const portalService = require('../backend/src/services/portalService');

const COMPANY = '00000000-0000-4000-8000-000000000001';
const CONTACT = 42;
const SESSION = {
    id: 'session-1',
    company_id: COMPANY,
    contact_id: CONTACT,
};
const CLIENT = { query: jest.fn() };

beforeEach(() => {
    jest.clearAllMocks();
    portalQueries.getSessionById.mockResolvedValue(SESSION);
    portalQueries.updateContactProfile.mockResolvedValue({
        id: CONTACT,
        company_id: COMPANY,
        name: 'Updated Client',
    });
    mockWithTransaction.mockImplementation(work => work(CLIENT));
    mockLogLeadContactActivity.mockResolvedValue({ ok: true, id: 1 });
});

test('portal profile mutation and client-attributed activity share one transaction', async () => {
    const updated = await portalService.updateProfile('session-1', {
        name: 'Updated Client',
    });

    expect(updated).toMatchObject({ id: CONTACT, company_id: COMPANY });
    expect(portalQueries.updateContactProfile).toHaveBeenCalledWith(
        COMPANY,
        CONTACT,
        { name: 'Updated Client', email: undefined, phone: undefined },
        CLIENT
    );
    expect(mockLogLeadContactActivity).toHaveBeenCalledWith({
        companyId: COMPANY,
        entityType: 'contact',
        action: 'contact.portal_profile_updated',
        entityId: CONTACT,
        actor: { id: null, type: 'client', label: 'Client', source: 'portal' },
    }, { client: CLIENT });
    expect(portalQueries.logEvent).toHaveBeenCalledWith(
        'session-1',
        CONTACT,
        'profile_updated',
        null,
        null,
        { fields: ['name'] },
        CLIENT
    );
});

test('foreign/missing session Contact does not produce an activity row', async () => {
    portalQueries.updateContactProfile.mockResolvedValueOnce(null);

    await expect(portalService.updateProfile('session-1', {
        name: 'Sabotage target',
    })).rejects.toMatchObject({ code: 'CONTACT_NOT_FOUND', httpStatus: 404 });

    expect(mockLogLeadContactActivity).not.toHaveBeenCalled();
});
