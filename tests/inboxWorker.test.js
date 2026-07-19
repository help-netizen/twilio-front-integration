// db/connection must be mocked at MODULE scope: a jest.mock() inside beforeEach
// never applies, because inboxWorker below is required (and captures the real db
// handle) before any hook runs. `mockDbQuery` carries the `mock` prefix so the
// factory is allowed to close over it.
const mockDbQuery = jest.fn();
jest.mock('../backend/src/db/connection', () => ({ query: mockDbQuery }));

const {
    normalizeVoiceEvent,
    normalizeRecordingEvent,
    isFinalStatus,
    processEvent
} = require('../backend/src/services/inboxWorker');

describe('Inbox Worker', () => {
    describe('normalizeVoiceEvent', () => {
        it('should normalize Twilio voice webhook payload', () => {
            const payload = {
                CallSid: 'CA1234567890abcdef',
                CallStatus: 'completed',
                Timestamp: '1675000000',
                From: '+15551234567',
                To: '+15559876543',
                Direction: 'outbound-api',
                Duration: '120',
                ParentCallSid: 'CA0987654321fedcba',
                AnsweredBy: 'human',
                QueueTime: '5',
                Price: '-0.0200',
                PriceUnit: 'USD'
            };

            const normalized = normalizeVoiceEvent(payload);

            expect(normalized).toMatchObject({
                callSid: 'CA1234567890abcdef',
                eventType: 'call.status_changed',
                eventStatus: 'completed',
                fromNumber: '+15551234567',
                toNumber: '+15559876543',
                // Twilio's 'outbound-api' is normalized to the internal 'outbound'
                direction: 'outbound',
                durationSec: 120,
                parentCallSid: 'CA0987654321fedcba'
            });

            expect(normalized.eventTime).toBeInstanceOf(Date);
            expect(normalized.metadata.answered_by).toBe('human');
            expect(normalized.metadata.queue_time).toBe('5');
            // price is parsed out of Twilio's string into a real number
            expect(normalized.price).toBe(-0.02);
            expect(normalized.priceUnit).toBe('USD');
        });

        it('should handle missing optional fields', () => {
            const payload = {
                CallSid: 'CA123',
                CallStatus: 'ringing',
                Timestamp: '1675000000',
                From: '+15551234567',
                To: '+15559876543'
            };

            const normalized = normalizeVoiceEvent(payload);

            expect(normalized.direction).toBe('external');
            expect(normalized.durationSec).toBe(0);
            expect(normalized.parentCallSid).toBeNull();
        });
    });

    describe('normalizeRecordingEvent', () => {
        it('should normalize Twilio recording webhook payload', () => {
            const payload = {
                RecordingSid: 'RE1234567890abcdef',
                CallSid: 'CA1234567890abcdef',
                RecordingStatus: 'completed',
                RecordingDuration: '120',
                RecordingUrl: 'https://api.twilio.com/recordings/RE123',
                Timestamp: '1675000000'
            };

            const normalized = normalizeRecordingEvent(payload);

            expect(normalized).toMatchObject({
                callSid: 'CA1234567890abcdef',
                recordingSid: 'RE1234567890abcdef',
                status: 'completed'
            });

            expect(normalized.eventTime).toBeInstanceOf(Date);
            expect(normalized.recordingUrl).toBe('https://api.twilio.com/recordings/RE123');
            // duration is parsed into a number, no longer a raw Twilio string
            expect(normalized.durationSec).toBe(120);
        });
    });

    describe('isFinalStatus', () => {
        it('should return true for final statuses', () => {
            expect(isFinalStatus('completed')).toBe(true);
            expect(isFinalStatus('busy')).toBe(true);
            expect(isFinalStatus('no-answer')).toBe(true);
            expect(isFinalStatus('canceled')).toBe(true);
            expect(isFinalStatus('failed')).toBe(true);
            expect(isFinalStatus('COMPLETED')).toBe(true); // Case insensitive
        });

        it('should return false for non-final statuses', () => {
            expect(isFinalStatus('queued')).toBe(false);
            expect(isFinalStatus('ringing')).toBe(false);
            expect(isFinalStatus('in-progress')).toBe(false);
            expect(isFinalStatus('initiated')).toBe(false);
        });
    });

    // NOTE: the `upsertMessage` suite was removed here, not repaired. That helper
    // ceased to exist in the v3 calls-first migration (0a6c7d0); inboxWorker now
    // persists through `queries.upsertCall`, which owns its own coverage. The two
    // tests asserted against an undefined import, so there was nothing left to assert.

    describe('processEvent', () => {
        let mockDb;

        beforeEach(() => {
            mockDbQuery.mockReset();
            mockDbQuery.mockResolvedValue({ rows: [{ id: 1 }] });
            mockDb = { query: mockDbQuery };
        });

        it('should process voice event successfully', async () => {
            const inboxEvent = {
                id: 123,
                source: 'voice',
                event_type: 'call-status',
                payload: {
                    CallSid: 'CA123',
                    CallStatus: 'completed',
                    Timestamp: '1675000000',
                    From: '+15551234567',
                    To: '+15559876543',
                    Duration: '120'
                }
            };

            const result = await processEvent(inboxEvent);

            expect(result.success).toBe(true);
            expect(mockDb.query).toHaveBeenCalled();
        });

        it('should handle unknown event source', async () => {
            const inboxEvent = {
                id: 123,
                source: 'unknown_source',
                event_type: 'unknown',
                payload: {}
            };

            await expect(processEvent(inboxEvent)).rejects.toThrow(/^Unknown source: unknown_source$/);
        });
    });
});
