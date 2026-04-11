/**
 * Bug: Answered inbound call shown as "missed" in timeline
 *
 * Root cause: Race condition between handleDialAction (synchronous DB writes)
 * and inboxWorker (async queue processing). handleDialAction's child UPDATE
 * finds 0 rows (children not yet in DB), then reconcileParentCall runs on
 * partial data and downgrades parent to no-answer. Guard B blocks subsequent
 * reconciliation attempts.
 *
 * Fix: Single-writer architecture — handleDialAction only enqueues to
 * webhook_inbox, all DB writes go through inboxWorker.processDialEvent.
 * Guard B now allows reconciliation when answered children exist.
 */

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockQuery = jest.fn();
jest.mock('../backend/src/db/connection', () => ({ query: mockQuery }));

const mockGetCallByCallSid = jest.fn();
const mockUpsertCall = jest.fn();
const mockAppendCallEvent = jest.fn().mockResolvedValue({});
jest.mock('../backend/src/db/queries', () => ({
    insertInboxEvent: jest.fn().mockResolvedValue({ id: 1 }),
    getCallByCallSid: mockGetCallByCallSid,
    upsertCall: mockUpsertCall,
    appendCallEvent: mockAppendCallEvent,
    claimInboxEvents: jest.fn().mockResolvedValue([]),
    findOrCreateTimeline: jest.fn().mockResolvedValue({ id: 1, contact_id: null }),
    markInboxEventProcessed: jest.fn(),
    markInboxEventFailed: jest.fn(),
}));

const mockTwilioFetch = jest.fn();
jest.mock('twilio', () => {
    const factory = () => ({ calls: jest.fn(() => ({ fetch: mockTwilioFetch })) });
    factory.validateRequest = () => true;
    return factory;
});

const mockPublishCallUpdate = jest.fn();
jest.mock('../backend/src/services/realtimeService', () => ({
    publishCallUpdate: mockPublishCallUpdate,
    broadcast: jest.fn(),
}));

jest.mock('../backend/src/services/reconcileStale', () => ({
    reconcileStaleCalls: jest.fn(),
}));

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

const { processEvent, processDialEvent, reconcileParentCall } = require('../backend/src/services/inboxWorker');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const PARENT_SID = 'CA_parent_race_001';
const CHILD_A_SID = 'CA_child_unanswered_001';
const CHILD_B_SID = 'CA_child_answered_001';

function makeDialEvent(overrides = {}) {
    return {
        id: 100,
        source: 'dial',
        event_type: 'dial.action',
        call_sid: PARENT_SID,
        payload: {
            CallSid: PARENT_SID,
            DialCallStatus: 'completed',
            DialCallDuration: '45',
            From: '+15551112222',
            To: '+15553334444',
            ...overrides,
        },
    };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Answered call shown as missed — single-writer fix', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        process.env.TWILIO_ACCOUNT_SID = 'ACtest';
        process.env.TWILIO_AUTH_TOKEN = 'test_token';
        mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });
    });

    // -----------------------------------------------------------------------
    // processDialEvent tests
    // -----------------------------------------------------------------------

    describe('processDialEvent', () => {
        it('should set parent to completed when DialCallStatus=completed', async () => {
            // Children already processed by inboxWorker
            mockQuery
                // Step 1: child query
                .mockResolvedValueOnce({
                    rows: [
                        { call_sid: CHILD_A_SID, status: 'no-answer', duration_sec: null },
                        { call_sid: CHILD_B_SID, status: 'completed', duration_sec: 45 },
                    ],
                })
                // Step 2: finalize children
                .mockResolvedValueOnce({ rowCount: 0 })
                // Step 3: update parent
                .mockResolvedValueOnce({ rowCount: 1 });

            // Step 4: SSE broadcast
            mockGetCallByCallSid.mockResolvedValue({
                call_sid: PARENT_SID, status: 'completed', is_final: true,
            });

            // Step 5: reconcileParentCall — parent check
            const parentCheckResult = { rows: [{ status: 'completed' }] };
            mockQuery.mockResolvedValueOnce(parentCheckResult);
            // reconcile: child query
            mockQuery.mockResolvedValueOnce({
                rows: [
                    { call_sid: CHILD_B_SID, status: 'completed', duration_sec: 45, started_at: new Date(), ended_at: new Date(), is_final: true, contact_id: null },
                ],
            });
            // reconcile: child from_number query
            mockQuery.mockResolvedValueOnce({ rows: [{ from_number: '+15551112222' }] });
            // reconcile: parent update
            mockQuery.mockResolvedValueOnce({ rowCount: 1 });

            await processDialEvent({
                CallSid: PARENT_SID,
                DialCallStatus: 'completed',
                DialCallDuration: '45',
            }, 'test_trace');

            // Verify parent was set to completed (step 3 query)
            const parentUpdateCall = mockQuery.mock.calls[2];
            expect(parentUpdateCall[0]).toContain('completed');
            expect(parentUpdateCall[1]).toContain(PARENT_SID);
        });

        it('should set parent to voicemail_recording when DialCallStatus=no-answer and no answered children', async () => {
            // No children answered
            mockQuery
                // Step 1: child query — all no-answer
                .mockResolvedValueOnce({
                    rows: [
                        { call_sid: CHILD_A_SID, status: 'no-answer', duration_sec: null },
                        { call_sid: CHILD_B_SID, status: 'no-answer', duration_sec: null },
                    ],
                })
                // Step 2: finalize children
                .mockResolvedValueOnce({ rowCount: 0 })
                // Step 3: update parent to voicemail_recording
                .mockResolvedValueOnce({ rowCount: 1 });

            mockGetCallByCallSid.mockResolvedValue({
                call_sid: PARENT_SID, status: 'voicemail_recording', is_final: false,
            });

            await processDialEvent({
                CallSid: PARENT_SID,
                DialCallStatus: 'no-answer',
                DialCallDuration: '0',
            }, 'test_trace');

            // Verify parent was set to voicemail_recording
            const parentUpdateCall = mockQuery.mock.calls[2];
            expect(parentUpdateCall[0]).toContain('voicemail_recording');
        });

        it('should override DialCallStatus=no-answer when child evidence shows call was answered', async () => {
            // DialCallStatus says no-answer, but child B has completed + duration
            mockQuery
                // Step 1: child query — one child answered
                .mockResolvedValueOnce({
                    rows: [
                        { call_sid: CHILD_B_SID, status: 'completed', duration_sec: 60 },
                        { call_sid: CHILD_A_SID, status: 'no-answer', duration_sec: null },
                    ],
                })
                // Step 2: finalize children
                .mockResolvedValueOnce({ rowCount: 0 })
                // Step 3: update parent to completed (override!)
                .mockResolvedValueOnce({ rowCount: 1 });

            mockGetCallByCallSid.mockResolvedValue({
                call_sid: PARENT_SID, status: 'completed', is_final: true,
            });

            // reconcileParentCall queries
            mockQuery
                .mockResolvedValueOnce({ rows: [{ status: 'completed' }] }) // parent check
                .mockResolvedValueOnce({
                    rows: [{ call_sid: CHILD_B_SID, status: 'completed', duration_sec: 60, started_at: new Date(), ended_at: new Date(), is_final: true, contact_id: null }],
                }) // children
                .mockResolvedValueOnce({ rows: [{ from_number: '+15551112222' }] }) // child from_number
                .mockResolvedValueOnce({ rowCount: 1 }); // parent update

            await processDialEvent({
                CallSid: PARENT_SID,
                DialCallStatus: 'no-answer',
                DialCallDuration: '0',
            }, 'test_trace');

            // Verify parent was set to completed, NOT voicemail_recording
            const parentUpdateCall = mockQuery.mock.calls[2];
            expect(parentUpdateCall[0]).toContain('completed');
            expect(parentUpdateCall[0]).not.toContain('voicemail_recording');
        });
    });

    // -----------------------------------------------------------------------
    // Guard B fix tests
    // -----------------------------------------------------------------------

    describe('Guard B — reconcileParentCall', () => {
        it('should allow reconciliation when parent is no-answer but answered child exists', async () => {
            mockQuery
                // Parent check
                .mockResolvedValueOnce({ rows: [{ status: 'no-answer' }] })
                // Answered child check (Guard B)
                .mockResolvedValueOnce({ rows: [{ 1: 1 }] }) // answered child found
                // Get all children
                .mockResolvedValueOnce({
                    rows: [
                        { call_sid: CHILD_B_SID, status: 'completed', duration_sec: 45, started_at: new Date(), ended_at: new Date(), is_final: true, contact_id: null },
                        { call_sid: CHILD_A_SID, status: 'no-answer', duration_sec: null, started_at: null, ended_at: null, is_final: true, contact_id: null },
                    ],
                })
                // Winner from_number
                .mockResolvedValueOnce({ rows: [{ from_number: '+15551112222' }] })
                // Parent update
                .mockResolvedValueOnce({ rowCount: 1 });

            mockGetCallByCallSid.mockResolvedValue({
                call_sid: PARENT_SID, status: 'completed', is_final: true,
            });

            await reconcileParentCall(PARENT_SID, 'test_trace');

            // Should have reached the parent update (not returned early)
            // The UPDATE calls SET status = $2 query should have been called
            const updateCalls = mockQuery.mock.calls.filter(c =>
                c[0].includes('UPDATE calls SET') && c[0].includes('status = $2')
            );
            expect(updateCalls.length).toBe(1);
            // Verify parent was set to completed
            expect(updateCalls[0][1]).toContain('completed');
        });

        it('should block reconciliation when parent is no-answer and no answered children', async () => {
            mockQuery
                // Parent check
                .mockResolvedValueOnce({ rows: [{ status: 'no-answer' }] })
                // Answered child check (Guard B) — no answered children
                .mockResolvedValueOnce({ rows: [] });

            await reconcileParentCall(PARENT_SID, 'test_trace');

            // Should have returned early — no child query, no parent update
            expect(mockQuery).toHaveBeenCalledTimes(2);
        });
    });

    // -----------------------------------------------------------------------
    // Bug009 preservation
    // -----------------------------------------------------------------------

    describe('Bug009 preservation — Guard A still works', () => {
        it('should NOT overwrite no-answer with completed from voice-status event', async () => {
            mockGetCallByCallSid.mockResolvedValue({
                call_sid: PARENT_SID,
                status: 'no-answer',
                is_final: true,
                direction: 'inbound',
            });

            const event = {
                id: 1,
                source: 'voice',
                event_type: 'call.status_changed',
                call_sid: PARENT_SID,
                payload: {
                    CallSid: PARENT_SID,
                    CallStatus: 'completed',
                    From: '+15551112222',
                    To: '+15553334444',
                    Direction: 'inbound',
                    Timestamp: new Date().toISOString(),
                },
            };
            await processEvent(event);

            expect(mockUpsertCall).not.toHaveBeenCalled();
        });
    });

    // -----------------------------------------------------------------------
    // processEvent dispatcher routing
    // -----------------------------------------------------------------------

    describe('processEvent dispatcher', () => {
        it('should route dial.action events to processDialEvent', async () => {
            // Setup mocks for processDialEvent flow
            mockQuery
                .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // child query
                .mockResolvedValueOnce({ rowCount: 0 }) // finalize children
                .mockResolvedValueOnce({ rowCount: 1 }); // parent update

            mockGetCallByCallSid.mockResolvedValue({
                call_sid: PARENT_SID, status: 'voicemail_recording', is_final: false,
            });

            const dialEvent = makeDialEvent({ DialCallStatus: 'no-answer' });
            await processEvent(dialEvent);

            // Verify the parent was set to voicemail_recording (processDialEvent ran)
            const parentUpdateCall = mockQuery.mock.calls.find(c =>
                c[0].includes('voicemail_recording')
            );
            expect(parentUpdateCall).toBeTruthy();
        });

        it('should NOT route voice events to processDialEvent', async () => {
            mockGetCallByCallSid.mockResolvedValue({
                call_sid: PARENT_SID,
                status: 'ringing',
                is_final: false,
                direction: 'inbound',
            });
            mockUpsertCall.mockResolvedValue({
                call_sid: PARENT_SID, status: 'in-progress',
            });

            const voiceEvent = {
                id: 1,
                source: 'voice',
                event_type: 'call.status_changed',
                call_sid: PARENT_SID,
                payload: {
                    CallSid: PARENT_SID,
                    CallStatus: 'in-progress',
                    From: '+15551112222',
                    To: '+15553334444',
                    Direction: 'inbound',
                    Timestamp: new Date().toISOString(),
                },
            };
            await processEvent(voiceEvent);

            // Should have used upsertCall (processVoiceEvent path), not processDialEvent
            expect(mockUpsertCall).toHaveBeenCalled();
        });
    });
});
