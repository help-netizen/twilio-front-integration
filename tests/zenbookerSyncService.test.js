jest.mock('../backend/src/db/connection', () => ({ query: jest.fn() }));
jest.mock('../backend/src/services/zenbookerClient', () => ({}));
jest.mock('../backend/src/services/contactsService', () => ({}));

process.env.FEATURE_ZENBOOKER_SYNC = 'true';

const db = require('../backend/src/db/connection');
const zenbookerSyncService = require('../backend/src/services/zenbookerSyncService');

describe('zenbookerSyncService customer notes', () => {
    beforeEach(() => {
        db.query.mockReset();
    });

    it('merges Zenbooker customer notes into contact structured notes without duplicates', async () => {
        db.query
            .mockResolvedValueOnce({ rows: [{ id: 1851 }] }) // exact linked contact lookup
            .mockResolvedValueOnce({ rows: [] }) // contact master-field update
            .mockResolvedValueOnce({
                rows: [{
                    structured_notes: [{
                        id: '1777258620147x394270109685733300',
                        zb_note_id: '1777258620147x394270109685733300',
                        text: 'CALL Daughter Abigail!!!!',
                        created: '2026-04-27T02:57:00.000Z',
                        author: 'Zenbooker',
                        source: 'zenbooker',
                    }],
                }],
            })
            .mockResolvedValueOnce({ rows: [] }); // structured notes update

        await zenbookerSyncService.handleWebhookPayload({
            event: 'customer.edited',
            account: 'acct-1',
            data: {
                id: '1770406033222x118651343958427580',
                name: 'Yang Yang',
                phone: '6175550100',
                notes: [
                    { id: '1777258620147x394270109685733300', text: 'CALL Daughter Abigail!!!!', files: [], images: [] },
                    { id: '1777258627847x576703551777782800', text: 'Abigail phone: +16176108014', files: [], images: [] },
                    { id: '1777258628318x328191178987143000', text: 'CALL Daughter Abigail!!!!', files: [], images: [] },
                ],
            },
        }, 'company-1');

        const updateCall = db.query.mock.calls.find(call =>
            String(call[0]).includes('structured_notes = $1::jsonb')
        );
        expect(updateCall).toBeTruthy();

        const merged = JSON.parse(updateCall[1][0]);
        expect(merged).toHaveLength(2);
        expect(merged.map(n => n.text)).toEqual([
            'CALL Daughter Abigail!!!!',
            'Abigail phone: +16176108014',
        ]);
        expect(merged[1]).toMatchObject({
            id: '1777258627847x576703551777782800',
            zb_note_id: '1777258627847x576703551777782800',
            author: 'Zenbooker',
            source: 'zenbooker',
        });
    });
});
