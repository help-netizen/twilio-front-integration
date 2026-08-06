jest.mock('../backend/src/services/conversationsService', () => ({
    getOrCreateConversation: jest.fn(),
    sendMessage: jest.fn(),
}));
jest.mock('../backend/src/db/companyQueries', () => ({
    getCompanyById: jest.fn(),
}));
jest.mock('../backend/src/services/messagingHelper', () => ({
    resolveCompanyProxyE164: jest.fn(),
}));
jest.mock('../backend/src/services/jobActivityService', () => ({
    logJobActivity: jest.fn(),
}));

const conversationsService = require('../backend/src/services/conversationsService');
const companyQueries = require('../backend/src/db/companyQueries');
const { resolveCompanyProxyE164 } = require('../backend/src/services/messagingHelper');
const { logJobActivity } = require('../backend/src/services/jobActivityService');
const { notifyOnTheWay, validateEtaMinutes } = require('../backend/src/services/jobOnTheWayService');

const COMPANY = '11111111-1111-1111-1111-111111111111';
const JOB = {
    id: 5,
    customer_phone: '+16175551234',
    assigned_techs: [{ name: 'Mike' }],
};

describe('jobOnTheWayService', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        resolveCompanyProxyE164.mockResolvedValue('+16175550000');
        companyQueries.getCompanyById.mockResolvedValue({ name: 'ABC Homes' });
        conversationsService.getOrCreateConversation.mockResolvedValue({ id: 'conversation-1' });
        conversationsService.sendMessage.mockResolvedValue({ id: 'message-1' });
        logJobActivity.mockResolvedValue(undefined);
    });

    test('sends the existing ETA SMS and logs activity with the transaction client', async () => {
        const client = { query: jest.fn() };
        const actor = { id: 'crm-user', type: 'user', label: null, source: 'crm' };

        await notifyOnTheWay({ job: JOB, companyId: COMPANY, etaMinutes: 25, activityActor: actor, client });

        expect(conversationsService.getOrCreateConversation).toHaveBeenCalledWith(
            '+16175551234',
            '+16175550000',
            COMPANY
        );
        expect(conversationsService.sendMessage).toHaveBeenCalledWith('conversation-1', {
            companyId: COMPANY,
            body: 'Hi! Your technician Mike from ABC Homes is on the way and should arrive in about 25 minutes.',
            author: 'agent',
        });
        expect(logJobActivity).toHaveBeenCalledWith(
            expect.objectContaining({
                companyId: COMPANY,
                action: 'job.eta_notified',
                jobId: 5,
                actor,
            }),
            { client }
        );
    });

    test('maps wallet refusal without logging a notification activity', async () => {
        conversationsService.sendMessage.mockRejectedValue(Object.assign(new Error('blocked'), {
            code: 'WALLET_BLOCKED',
            httpStatus: 402,
        }));

        await expect(notifyOnTheWay({
            job: JOB,
            companyId: COMPANY,
            etaMinutes: 25,
            activityActor: { id: 'crm-user', type: 'user' },
        })).rejects.toMatchObject({ code: 'WALLET_BLOCKED', httpStatus: 402 });
        expect(logJobActivity).not.toHaveBeenCalled();
    });

    test.each([0, 25.5, 601, '25', null])('rejects invalid ETA %p', async etaMinutes => {
        expect(validateEtaMinutes(etaMinutes)).toBe(false);
        await expect(notifyOnTheWay({
            job: JOB,
            companyId: COMPANY,
            etaMinutes,
        })).rejects.toMatchObject({ code: 'invalid_eta', httpStatus: 400 });
        expect(conversationsService.sendMessage).not.toHaveBeenCalled();
    });
});
