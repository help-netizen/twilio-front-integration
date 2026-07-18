/**
 * inboxWorkerHumanContact.test.js — OUTBOUND-PARTS-CALL-CANCEL-001 (CC-03),
 * TC-CC-10: the post-final-upsert human-contact hook in
 * `inboxWorker.processVoiceEvent`.
 *
 * Focused suite (the legacy tests/inboxWorker.test.js predates the current
 * worker API and is red on its own — this file pins ONLY the shared hook with the
 * worker's seams mocked). Drives the REAL processVoiceEvent through the
 * exported `processEvent` router with `queries.upsertCall` returning the row
 * under test, and asserts when `cancelForCompletedCustomerCall` fires:
 *
 *   • final completed PARENT with duration>0 + answered_at + direction
 *     inbound|outbound  → hook fires ONCE with the upserted row;
 *   • skipUpsert (voicemail_left preserved vs Twilio's trailing completed),
 *     zero/absent duration, answered_at NULL, child leg, internal direction,
 *     busy / no-answer / voicemail_left / non-final rows, out-of-order upsert
 *     (undefined)  → hook does NOT fire;
 *   • the shared hook rejecting or throwing synchronously → the voice-event
 *     pipeline is UNAFFECTED (processEvent resolves, appendCallEvent still ran).
 *
 * A mocked jest here proves only the DISPATCH (whether the hook was invoked and
 * with what row) — never that an attempt row actually flipped (that lives in
 * tests/partsCallService.test.js against the cancel core).
 */

'use strict';

const mockQueries = {
    upsertCall: jest.fn(),
    getCallByCallSid: jest.fn(async () => null),
    appendCallEvent: jest.fn(async () => ({})),
    findOrCreateTimeline: jest.fn(async () => ({ id: 1, contact_id: 501 })),
    findOrCreateAnonymousTimeline: jest.fn(async () => ({ id: 2, contact_id: null })),
    markTimelineRead: jest.fn(async () => {}),
    markTimelineUnread: jest.fn(async () => {}),
    markContactRead: jest.fn(async () => {}),
    markContactUnread: jest.fn(async () => {}),
    setActionRequired: jest.fn(async () => {}),
    createTask: jest.fn(async () => ({})),
};
jest.mock('../backend/src/db/queries', () => mockQueries);

const mockDbQuery = jest.fn(async () => ({ rows: [] }));
jest.mock('../backend/src/db/connection', () => ({ query: mockDbQuery }));

// enrichFromTwilioApi is internally try/caught — a throwing client factory
// proves the unit never talks to Twilio.
jest.mock('../backend/src/services/twilioClient', () => ({
    getTwilioClient: jest.fn(() => { throw new Error('no twilio in unit tests'); }),
}));
jest.mock('../backend/src/services/realtimeService', () => ({
    publishCallUpdate: jest.fn(),
    broadcast: jest.fn(),
}));
jest.mock('../backend/src/services/telephonyTenantService', () => ({
    resolveCompanyByAccountSid: jest.fn(async () => '00000000-0000-0000-0000-000000000001'),
}));
jest.mock('../backend/src/services/arConfigHelper', () => ({
    getTriggerConfig: jest.fn(async () => ({ enabled: false })),
}));
jest.mock('../backend/src/services/eventBus', () => ({
    emit: jest.fn(() => Promise.resolve()),
}));
jest.mock('../backend/src/services/reconcileStale', () => ({
    reconcileStaleCalls: jest.fn(async () => {}),
}));
// The seam under test: the hook must lazy-require this and fire-and-forget it.
jest.mock('../backend/src/services/outboundCallCancellationService', () => ({
    cancelForCompletedCustomerCall: jest.fn(async () => ({ canceled: 1, marker: false })),
}));

const cancellationService = require('../backend/src/services/outboundCallCancellationService');
const { processEvent } = require('../backend/src/services/inboxWorker');

const CO = '00000000-0000-0000-0000-000000000001';

const basePayload = (over = {}) => ({
    CallSid: 'CA100',
    AccountSid: 'ACxxxx',
    CallStatus: 'completed',
    Timestamp: '1783000000',
    From: '+16175550100',
    To: '+16175006181',
    Direction: 'inbound',
    CallDuration: '45',
    ...over,
});

// The upsertCall RESULT row (post-COALESCE snapshot) the predicate reads.
const upsertedRow = (over = {}) => ({
    call_sid: 'CA100',
    company_id: CO,
    contact_id: 501,
    direction: 'inbound',
    status: 'completed',
    is_final: true,
    parent_call_sid: null,
    duration_sec: 45,
    answered_at: new Date('2026-07-10T15:40:00.000Z'),
    ended_at: new Date('2026-07-10T15:42:00.000Z'),
    answered_by: 'dana',
    from_number: '+16175550100',
    to_number: '+16175006181',
    ...over,
});

const drive = (payloadOver = {}) => processEvent({
    id: 1,
    source: 'voice',
    event_type: 'call.status_changed',
    payload: basePayload(payloadOver),
});

let logSpy;
let warnSpy;
beforeEach(() => {
    jest.clearAllMocks();
    mockQueries.getCallByCallSid.mockResolvedValue(null);
    mockQueries.appendCallEvent.mockResolvedValue({});
    mockQueries.findOrCreateTimeline.mockResolvedValue({ id: 1, contact_id: 501 });
    mockDbQuery.mockResolvedValue({ rows: [] });
    cancellationService.cancelForCompletedCustomerCall.mockResolvedValue({ canceled: 1, marker: false });
    // The worker narrates every step via console.log/warn (incl. the throwing
    // Twilio-client mock inside enrichFromTwilioApi) — keep the run readable.
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
    logSpy.mockRestore();
    warnSpy.mockRestore();
});

describe('TC-CC-10: processVoiceEvent human-contact hook — fires on a real completed human call', () => {
    test('final completed inbound PARENT with duration>0 + answered_at → onHumanContact ONCE with the upserted row', async () => {
        const row = upsertedRow();
        mockQueries.upsertCall.mockResolvedValue(row);

        const out = await drive();

        expect(out).toEqual({ success: true });
        expect(cancellationService.cancelForCompletedCustomerCall).toHaveBeenCalledTimes(1);
        // The hook hands over the STORED row (company/tenant from the row — S14),
        // not the raw payload.
        expect(cancellationService.cancelForCompletedCustomerCall).toHaveBeenCalledWith(row);
    });

    test('successful outbound (dispatcher) call → fired with the outbound row (external = to_number downstream)', async () => {
        const row = upsertedRow({
            direction: 'outbound',
            from_number: '+16175006181',
            to_number: '+16175550100',
        });
        mockQueries.upsertCall.mockResolvedValue(row);

        await drive({ Direction: 'outbound-api' });

        expect(cancellationService.cancelForCompletedCustomerCall).toHaveBeenCalledTimes(1);
        expect(cancellationService.cancelForCompletedCustomerCall).toHaveBeenCalledWith(
            expect.objectContaining({ direction: 'outbound', to_number: '+16175550100' }),
        );
    });
});

describe('TC-CC-10: guard variants — the hook must NOT fire', () => {
    test('skipUpsert: voicemail_left preserved against Twilio\'s trailing completed → no upsert, no hook', async () => {
        // Existing row is voicemail_left (final) and the event is completed →
        // the preserve guard sets skipUpsert; the hook never sees the row.
        mockQueries.getCallByCallSid.mockResolvedValue(
            upsertedRow({ status: 'voicemail_left', answered_at: null, duration_sec: 20 }),
        );

        const out = await drive();

        expect(out).toEqual({ success: true });
        expect(mockQueries.upsertCall).not.toHaveBeenCalled();
        expect(cancellationService.cancelForCompletedCustomerCall).not.toHaveBeenCalled();
    });

    test.each([
        ['zero duration (IVR hangup)', upsertedRow({ duration_sec: 0 }), {}],
        ['absent duration', upsertedRow({ duration_sec: null }), {}],
        ['answered_at NULL (nobody picked up)', upsertedRow({ answered_at: null }), {}],
        ['child leg (parent_call_sid set)', upsertedRow({ parent_call_sid: 'CA0' }), { ParentCallSid: 'CA0' }],
        ['internal direction', upsertedRow({ direction: 'internal' }), {}],
        ['busy row', upsertedRow({ status: 'busy', answered_at: null, duration_sec: 0 }), { CallStatus: 'busy' }],
        ['no-answer row', upsertedRow({ status: 'no-answer', answered_at: null, duration_sec: 0 }), { CallStatus: 'no-answer' }],
        ['voicemail_left row', upsertedRow({ status: 'voicemail_left', answered_at: null }), {}],
        ['non-final update', upsertedRow({ status: 'in-progress', is_final: false }), { CallStatus: 'in-progress' }],
    ])('%s → NOT fired', async (_label, row, payloadOver) => {
        mockQueries.upsertCall.mockResolvedValue(row);

        const out = await drive(payloadOver);

        expect(out).toEqual({ success: true });
        expect(cancellationService.cancelForCompletedCustomerCall).not.toHaveBeenCalled();
    });

    test('out-of-order event: upsertCall returns undefined → NOT fired', async () => {
        mockQueries.upsertCall.mockResolvedValue(undefined);

        const out = await drive();

        expect(out).toEqual({ success: true });
        expect(cancellationService.cancelForCompletedCustomerCall).not.toHaveBeenCalled();
    });
});

describe('TC-CC-10: non-fatality — the voice-event pipeline never depends on the hook', () => {
    test('shared hook REJECTS → processEvent resolves and the pipeline continued (appendCallEvent ran)', async () => {
        mockQueries.upsertCall.mockResolvedValue(upsertedRow());
        cancellationService.cancelForCompletedCustomerCall.mockRejectedValueOnce(new Error('cancel boom'));

        const out = await drive();

        expect(out).toEqual({ success: true });
        expect(cancellationService.cancelForCompletedCustomerCall).toHaveBeenCalledTimes(1);
        // The pipeline steps AFTER the hook still ran.
        expect(mockQueries.appendCallEvent).toHaveBeenCalled();
        // Let the swallowed rejection settle so no unhandled-rejection escapes.
        await new Promise((r) => setImmediate(r));
        expect(warnSpy.mock.calls.some((c) => /human-contact cancel hook failed/.test(String(c[0]))))
            .toBe(true);
    });

    test('shared hook THROWS synchronously → still non-fatal (double guard)', async () => {
        mockQueries.upsertCall.mockResolvedValue(upsertedRow());
        cancellationService.cancelForCompletedCustomerCall.mockImplementationOnce(() => {
            throw new Error('sync boom');
        });

        const out = await drive();

        expect(out).toEqual({ success: true });
        expect(mockQueries.appendCallEvent).toHaveBeenCalled();
        expect(warnSpy.mock.calls.some((c) => /human-contact cancel hook failed/.test(String(c[0]))))
            .toBe(true);
    });
});
