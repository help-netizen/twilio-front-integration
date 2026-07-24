'use strict';

jest.mock('../backend/src/services/fsmService', () => ({
    getAvailableActions: jest.fn(async () => ({
        fallback: false,
        actions: [{ event: 'advance', targetStatusName: 'Review' }],
    })),
    resolveTransition: jest.fn(async () => ({
        valid: true,
        targetState: 'Wrong role target',
    })),
}));

const fsmService = require('../backend/src/services/fsmService');
const writeService = require('../backend/src/services/chatgptMcpWriteService');

const context = {
    companyId: 'company-a',
    actorId: 'avatar-a',
    actorName: 'Avatar of Provider',
    bindingId: 'binding-a',
    ownerUserId: 'owner-provider',
    ownerRoleKey: 'provider',
};

function transactionFor(keyColumn) {
    return {
        query: jest.fn(async (sql) => {
            if (sql.includes('SELECT id,')) {
                return { rows: [{ id: 9, current_status: 'Submitted' }] };
            }
            if (sql.includes('UPDATE ')) {
                return {
                    rows: [{
                        id: 9,
                        entity_key: keyColumn === 'uuid' ? 'LEAD-A' : 9,
                        status: 'Review',
                    }],
                };
            }
            throw new Error(`Unexpected SQL: ${sql}`);
        }),
    };
}

beforeEach(() => jest.clearAllMocks());

describe('AVATARS-001 Phase B FSM role parity', () => {
    test.each([
        ['transitionJob', 'svc.transition_job', { job_id: 9, action: 'advance' }, 'job', 'id'],
        ['transitionLead', 'svc.transition_lead', { lead_uuid: 'LEAD-A', action: 'advance' }, 'lead', 'uuid'],
    ])('SAB-AVATAR-FSM-ROLE: %s uses the live owner role', async (
        handler,
        toolName,
        args,
        machineKey,
        keyColumn
    ) => {
        const transaction = transactionFor(keyColumn);
        await writeService.execute(
            handler,
            toolName,
            context,
            args,
            transaction
        );
        expect(fsmService.getAvailableActions).toHaveBeenCalledWith(
            'company-a',
            machineKey,
            'Submitted',
            ['provider']
        );
        expect(fsmService.getAvailableActions).not.toHaveBeenCalledWith(
            expect.anything(),
            expect.anything(),
            expect.anything(),
            ['dispatcher']
        );
        expect(fsmService.resolveTransition).not.toHaveBeenCalled();
        expect(transaction.query).toHaveBeenCalledWith(
            expect.stringContaining(`SET ${keyColumn === 'uuid' ? 'status' : 'blanc_status'} = $1`),
            ['Review', keyColumn === 'uuid' ? 'LEAD-A' : 9, 'company-a']
        );
    });
});
