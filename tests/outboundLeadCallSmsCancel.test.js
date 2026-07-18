/**
 * OUTBOUND-CALL-CANCEL-001 — inbound SMS routes to the company/phone-scoped
 * cross-scenario cancellation core. The sabotage control lives here: an outbound
 * persisted SMS must never publish sms.inbound for ANY outbound agent.
 */

'use strict';

const mockSubscriptions = [];
const mockEventEmit = jest.fn(async () => {});
jest.mock('../backend/src/services/eventBus', () => ({
    _subscribers: mockSubscriptions,
    subscribe: jest.fn((name, patterns, handler) => {
        mockSubscriptions.push({ name, patterns, handler });
    }),
    emit: mockEventEmit,
}));
jest.mock('../backend/src/services/rulesEngine', () => ({ onEvent: jest.fn() }));

const mockGlobalCancel = jest.fn(async () => ({ canceled: 2, marker: false }));
const mockCompletedCallCancel = jest.fn(async () => ({ canceled: 2, marker: false }));
jest.mock('../backend/src/services/outboundCallCancellationService', () => ({
    CAUSES: {
        DISPATCHER_CALL: 'customer_answered_dispatcher_call',
        INBOUND_CALL: 'customer_called_in',
        INBOUND_SMS: 'customer_replied_by_sms',
    },
    cancel: mockGlobalCancel,
    cancelForCompletedCustomerCall: mockCompletedCallCancel,
}));
jest.mock('../backend/src/services/outboundLeadCallService', () => ({
    onLeadCreated: jest.fn(async () => {}),
}));

const mockNormalizeVoiceEvent = jest.fn();
const mockReconcileParentCall = jest.fn(async () => {});
jest.mock('../backend/src/services/inboxWorker', () => ({
    normalizeVoiceEvent: mockNormalizeVoiceEvent,
    reconcileParentCall: mockReconcileParentCall,
}));
const mockProcessCall = jest.fn();
jest.mock('../backend/src/services/callProcessor', () => ({
    processCall: mockProcessCall,
    extractPhoneFromSIP: jest.fn((phone) => phone),
}));
jest.mock('../backend/src/services/stateMachine', () => ({
    isFinalStatus: jest.fn(() => false),
}));

const mockConvQueries = {
    insertEvent: jest.fn(),
    getConversationBySid: jest.fn(),
    upsertMessage: jest.fn(),
    insertMedia: jest.fn(),
    updateConversationPreview: jest.fn(),
    getConversationById: jest.fn(),
    markEventProcessed: jest.fn(),
};
jest.mock('../backend/src/db/conversationsQueries', () => mockConvQueries);

const mockQueries = {
    findOrCreateTimeline: jest.fn(),
    findContactByPhoneOrSecondary: jest.fn(),
    markContactUnread: jest.fn(),
    markTimelineUnread: jest.fn(),
    setActionRequired: jest.fn(),
    createTask: jest.fn(),
    upsertCall: jest.fn(),
    appendCallEvent: jest.fn(),
};
jest.mock('../backend/src/db/queries', () => mockQueries);
jest.mock('../backend/src/services/realtimeService', () => ({
    publishMessageAdded: jest.fn(),
    publishConversationUpdate: jest.fn(),
    broadcast: jest.fn(),
}));
jest.mock('../backend/src/db/connection', () => ({ query: jest.fn() }));
jest.mock('../backend/src/services/twilioClient', () => ({ getTwilioClient: jest.fn() }));
jest.mock('../backend/src/services/arConfigHelper', () => ({
    getTriggerConfig: jest.fn(async () => ({ enabled: false })),
}));
jest.mock('../backend/src/services/pushService', () => ({
    sendPushToCompany: jest.fn(async () => {}),
}));

const eventSubscribers = require('../backend/src/services/eventSubscribers');
const conversationsService = require('../backend/src/services/conversationsService');
const reconcileService = require('../backend/src/services/reconcileService');

const CO = '00000000-0000-0000-0000-000000000001';
const CUSTOMER = '+16175551234';
const PROXY = '+16175006181';
const CONVERSATION = {
    id: 42,
    twilio_conversation_sid: 'CH1',
    company_id: CO,
    contact_id: 501,
    customer_e164: CUSTOMER,
    proxy_e164: PROXY,
};

function messagePayload(author) {
    return {
        ConversationSid: 'CH1',
        MessageSid: 'IM1',
        Author: author,
        Body: 'Hello',
        Index: '1',
        DateCreated: '2026-07-18T12:00:00.000Z',
    };
}

beforeAll(() => {
    eventSubscribers.registerSubscribers();
});

beforeEach(() => {
    jest.clearAllMocks();
    mockConvQueries.insertEvent.mockResolvedValue({ id: 900 });
    mockConvQueries.getConversationBySid.mockResolvedValue(CONVERSATION);
    mockConvQueries.upsertMessage.mockResolvedValue({ id: 700, direction: 'inbound' });
    mockConvQueries.updateConversationPreview.mockResolvedValue(undefined);
    mockConvQueries.getConversationById.mockResolvedValue(CONVERSATION);
    mockConvQueries.markEventProcessed.mockResolvedValue(undefined);
    mockQueries.findOrCreateTimeline.mockResolvedValue({ id: 88, contact_id: 501 });
    mockQueries.findContactByPhoneOrSecondary.mockResolvedValue(null);
    mockQueries.upsertCall.mockResolvedValue({
        call_sid: 'CA1', company_id: CO, status: 'completed', is_final: true,
        parent_call_sid: null, duration_sec: 15,
        answered_at: '2026-07-18T11:59:45.000Z',
        ended_at: '2026-07-18T12:00:00.000Z',
        answered_by: 'dana', direction: 'inbound',
        from_number: CUSTOMER, to_number: PROXY,
    });
    mockQueries.appendCallEvent.mockResolvedValue(undefined);
    mockNormalizeVoiceEvent.mockReturnValue({
        callSid: 'CA1',
        parentCallSid: null,
        fromNumber: CUSTOMER,
        toNumber: PROXY,
        direction: 'inbound',
        eventStatus: 'in-progress',
        eventTime: '2026-07-18T12:00:00.000Z',
        durationSec: 15,
        price: null,
        priceUnit: null,
    });
    mockProcessCall.mockReturnValue({
        direction: 'inbound',
        externalParty: { formatted: CUSTOMER },
    });
});

describe('SMS direction invariant at webhook ingestion', () => {
    test('inbound onMessageAdded persists first, then publishes the company/customer sms.inbound event', async () => {
        await conversationsService.processWebhookEvent('onMessageAdded', messagePayload(CUSTOMER));

        expect(mockConvQueries.upsertMessage).toHaveBeenCalledWith(expect.objectContaining({
            company_id: CO,
            author: CUSTOMER,
            author_type: 'external',
            direction: 'inbound',
        }));
        expect(mockEventEmit).toHaveBeenCalledWith(
            CO,
            'sms.inbound',
            expect.objectContaining({
                from: CUSTOMER,
                to: PROXY,
                body: 'Hello',
                contact_id: 501,
                conversation_id: 42,
            }),
            expect.objectContaining({ actorType: 'webhook', aggregateType: 'sms', aggregateId: 42 }),
        );
        expect(mockConvQueries.upsertMessage.mock.invocationCallOrder[0])
            .toBeLessThan(mockEventEmit.mock.invocationCallOrder[0]);
        expect(mockConvQueries.markEventProcessed).toHaveBeenCalledWith(900);
    });

    test('SABOTAGE CONTROL: outbound onMessageAdded persists outbound SMS but never publishes sms.inbound', async () => {
        await conversationsService.processWebhookEvent('onMessageAdded', messagePayload('agent'));

        expect(mockConvQueries.upsertMessage).toHaveBeenCalledWith(expect.objectContaining({
            company_id: CO,
            author: 'agent',
            author_type: 'agent',
            direction: 'outbound',
        }));
        expect(mockEventEmit).not.toHaveBeenCalled();
        expect(mockConvQueries.markEventProcessed).toHaveBeenCalledWith(900);
    });
});

describe('all-outbound-agents sms.inbound subscriber', () => {
    const subscriber = () => mockSubscriptions.find(
        ({ name }) => name === 'outbound-call-cancel-on-sms'
    );

    test('is registered for sms.inbound only and forwards authoritative company + customer phone', async () => {
        const registration = subscriber();
        expect(registration).toBeTruthy();
        expect(registration.patterns).toBe('sms.inbound');

        await registration.handler({
            company_id: CO,
            payload: { from: CUSTOMER, company_id: 'untrusted-payload-company' },
        });

        expect(mockGlobalCancel).toHaveBeenCalledWith({
            companyId: CO,
            rawPhone: CUSTOMER,
            cause: 'customer_replied_by_sms',
        });
    });

    test('missing event company or sender is ignored', async () => {
        const { handler } = subscriber();
        await handler({ company_id: null, payload: { from: CUSTOMER } });
        await handler({ company_id: CO, payload: {} });
        expect(mockGlobalCancel).not.toHaveBeenCalled();
    });
});

describe('reconciliation voice trigger', () => {
    test('passes the persisted call row to the same completed-human-call detector', async () => {
        await reconcileService.reconcileCall({ CallSid: 'CA1' }, 'webhook');

        expect(mockCompletedCallCancel).toHaveBeenCalledWith(expect.objectContaining({
            call_sid: 'CA1',
            company_id: CO,
            direction: 'inbound',
            from_number: CUSTOMER,
        }));
    });
});
