jest.mock('../../backend/src/db/crmNotesQueries', () => ({
    listNotes: jest.fn(),
    createNote: jest.fn(),
}));
jest.mock('../../backend/src/db/crmAccountsQueries', () => ({
    getAccountById: jest.fn(),
}));
jest.mock('../../backend/src/db/crmDealsQueries', () => ({
    getDealById: jest.fn(),
}));
jest.mock('../../backend/src/db/crmContactsQueries', () => ({
    getContactById: jest.fn(),
}));
jest.mock('../../backend/src/db/crmActivitiesQueries', () => ({
    createActivity: jest.fn(),
}));
jest.mock('../../backend/src/services/crmWriteAuditService', () => ({
    logWriteAction: jest.fn(),
}));

const notesQueries = require('../../backend/src/db/crmNotesQueries');
const dealsQueries = require('../../backend/src/db/crmDealsQueries');
const activitiesQueries = require('../../backend/src/db/crmActivitiesQueries');
const writeAuditService = require('../../backend/src/services/crmWriteAuditService');
const notesService = require('../../backend/src/services/crmNotesService');

describe('crmNotesService', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        dealsQueries.getDealById.mockResolvedValue({ id: 9 });
        notesQueries.createNote.mockResolvedValue({ id: 11, entity_type: 'deal', entity_id: 9, text: 'Strategy note' });
        activitiesQueries.createActivity.mockResolvedValue({ id: 12 });
    });

    test('createNote writes audit with confirmation metadata', async () => {
        const result = await notesService.createNote(
            'company-1',
            { entity_type: 'deal', entity_id: 9, text: 'Strategy note', source: 'deal_strategy' },
            {
                actorId: 'user-1',
                actorEmail: 'seller@test.local',
                requestId: 'req-1',
                confirmation: { confirmationId: 'confirm-note', reason: 'Deal strategy update' },
            }
        );

        expect(result).toMatchObject({
            note: { id: 11, entity_type: 'deal', entity_id: 9, text: 'Strategy note' },
            field: 'crm_note',
            before: null,
            after: { id: 11, entity_type: 'deal', entity_id: 9, text: 'Strategy note' },
        });
        expect(writeAuditService.logWriteAction).toHaveBeenCalledWith(expect.objectContaining({
            companyId: 'company-1',
            action: 'crm_note_created',
            entityType: 'crm_note',
            entityId: 11,
            confirmation: { confirmationId: 'confirm-note', reason: 'Deal strategy update' },
        }));
    });
});
