'use strict';

const mockDbQuery = jest.fn();
const mockTxQuery = jest.fn();
const mockWithTransaction = jest.fn();
const mockLogLeadContactActivity = jest.fn();

jest.mock('../backend/src/db/connection', () => ({
    query: (...args) => mockDbQuery(...args),
}));
jest.mock('../backend/src/services/transactionService', () => ({
    withTransaction: (...args) => mockWithTransaction(...args),
}));
jest.mock('../backend/src/services/leadContactActivityService', () => ({
    logLeadContactActivity: (...args) => mockLogLeadContactActivity(...args),
}));

const contactDedupeService = require('../backend/src/services/contactDedupeService');

const COMPANY = '00000000-0000-4000-8000-000000000001';
const ACTOR = {
    id: '10000000-0000-4000-8000-000000000001',
    type: 'user',
    label: null,
    source: 'crm',
};

let contacts;

beforeEach(() => {
    jest.clearAllMocks();
    contacts = [];
    mockTxQuery.mockImplementation(async (sql, params = []) => {
        if (/INSERT INTO contacts/i.test(String(sql))) {
            const row = { id: 51, company_id: params[5] };
            contacts.push(row);
            return { rows: [row], rowCount: 1 };
        }
        return { rows: [], rowCount: 1 };
    });
    mockWithTransaction.mockImplementation(async (work) => {
        const before = contacts.slice();
        try {
            return await work({ query: mockTxQuery });
        } catch (error) {
            contacts = before;
            throw error;
        }
    });
    mockLogLeadContactActivity.mockResolvedValue({ ok: true, id: 1 });
});

test('implicit Contact create records contact.created with the human actor and real id', async () => {
    const contactId = await contactDedupeService.createNewContactPublic({
        first_name: 'Ada',
        last_name: 'Lovelace',
        phone: null,
        email: 'ada@example.com',
    }, COMPANY, { activityActor: ACTOR });

    expect(contactId).toBe(51);
    expect(mockLogLeadContactActivity).toHaveBeenCalledWith({
        companyId: COMPANY,
        entityType: 'contact',
        action: 'contact.created',
        entityId: 51,
        actor: ACTOR,
    }, expect.objectContaining({ client: expect.any(Object) }));
    expect(mockLogLeadContactActivity.mock.calls[0][0].entityId).not.toBe('undefined');
});

test('contact.created failure rolls back the Contact insert', async () => {
    mockLogLeadContactActivity.mockRejectedValueOnce(new Error('audit insert failed'));

    await expect(contactDedupeService.createNewContactPublic({
        first_name: 'Ada',
        last_name: 'Lovelace',
        phone: null,
        email: null,
    }, COMPANY, { activityActor: ACTOR })).rejects.toThrow('audit insert failed');

    expect(contacts).toEqual([]);
});
